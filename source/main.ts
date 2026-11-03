/**
 * pTS-Effect main process: menu, panel open, effect file I/O.
 */

import fs from 'fs';
import path from 'path';
import { decodeGraphComment, isEffectGraph } from './graph';
import type { EffectGraph } from './graph';
import { createDefaultGraph } from './nodes';
import { compileEffect, validateSubgraph } from './codegen';
import type { CompileResult } from './codegen';

/** Precise view of the external Editor API boundary used here (no `any`). */
interface pTSEditorApi {
    Project: { path: string };
    Panel: { open(name: string): Promise<boolean> };
    Message: {
        request(pkg: string, method: string, ...args: unknown[]): Promise<unknown>;
        send(pkg: string, method: string, ...args: unknown[]): void;
    };
    Profile: {
        getProject(name: string, key?: string): Promise<unknown>;
        setProject(name: string, key: string, value: unknown): Promise<void>;
    };
}
declare const Editor: pTSEditorApi;

const PKG_NAME = 'pts-effect';

export interface ILoadEffectResult {
    uuid: string;
    name: string;
    url: string;
    file: string;
    content: string;
    graph: EffectGraph | null;
    hasGraph: boolean;
    error?: string;
}

export interface ISaveEffectResult extends CompileResult {
    ok: boolean;
    uuid?: string;
}

interface IAssetInfo {
    uuid: string | null;
    name: string | null;
    url: string | null;
    file: string | null;
    imported: boolean | null;
    invalid: boolean | null;
}

function toAssetInfo(v: unknown): IAssetInfo | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const file = typeof o.file === 'string' ? o.file : typeof o.path === 'string' ? o.path : null;
    return {
        uuid: typeof o.uuid === 'string' ? o.uuid : null,
        name: typeof o.name === 'string' ? o.name : null,
        url: typeof o.url === 'string' ? o.url : null,
        imported: typeof o.imported === 'boolean' ? o.imported : null,
        invalid: typeof o.invalid === 'boolean' ? o.invalid : null,
        file,
    };
}

function importError(info: IAssetInfo | null, location: string): string | null {
    if (!info) return `AssetDB could not find ${location} after import.`;
    if (info.invalid === true) return `AssetDB reports that import failed for ${location}. Check the Cocos Editor console for effect compiler diagnostics.`;
    if (info.imported === false) return `AssetDB has not completed import for ${location}. Check the Cocos Editor console and refresh the asset.`;
    return null;
}

function hasUsableGraph(content: string): boolean {
    const graph = decodeGraphComment(content);
    if (!graph) return false;
    return graph.nodes.every((node) => node && typeof node.id === 'string' &&
        typeof node.type === 'string' && typeof node.name === 'string' &&
        typeof node.x === 'number' && Number.isFinite(node.x) &&
        typeof node.y === 'number' && Number.isFinite(node.y) &&
        !!node.params && typeof node.params === 'object' && !Array.isArray(node.params)) &&
        graph.links.every((link) => link && typeof link.id === 'string' &&
            link.from && typeof link.from.node === 'string' && typeof link.from.port === 'string' &&
            link.to && typeof link.to.node === 'string' && typeof link.to.port === 'string');
}

interface IMenuAssetInfo {
    url: string | null;
    isDirectory: boolean;
}

function toMenuAssetInfo(v: unknown): IMenuAssetInfo {
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return { url: typeof o.url === 'string' ? o.url : null, isDirectory: o.isDirectory === true };
    }
    return { url: null, isDirectory: false };
}

export async function loadEffect(uuidOrUrl: unknown): Promise<ILoadEffectResult> {
    const id = String(uuidOrUrl ?? '');
    const empty: ILoadEffectResult = {
        uuid: id, name: '', url: '', file: '', content: '', graph: null, hasGraph: false,
    };
    if (!id) return { ...empty, error: 'No asset uuid/url provided.' };

    let info: IAssetInfo | null = null;
    try {
        info = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', id));
    } catch (e) {
        return { ...empty, error: `Failed to query asset-db: ${String(e)}` };
    }
    if (!info) return { ...empty, error: `Asset not found: ${id}` };

    const file = info.file;
    if (!file || !fs.existsSync(file)) {
        return { ...empty, error: `Cannot resolve file for asset: ${id}` };
    }

    let content = '';
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { ...empty, error: `Failed to read file: ${String(e)}` };
    }

    const graph = hasUsableGraph(content) ? decodeGraphComment(content) : null;
    return {
        uuid: info.uuid ?? id,
        name: info.name ?? path.basename(file, path.extname(file)),
        url: info.url ?? '',
        file,
        content,
        graph,
        hasGraph: !!graph,
    };
}

/** Load the saved graph asset, never an embedded copy from a referencing node. */
export async function loadSubgraph(uuidOrUrl: unknown): Promise<ILoadEffectResult> {
    const id = String(uuidOrUrl ?? '');
    const empty: ILoadEffectResult = { uuid: id, name: '', url: '', file: '', content: '', graph: null, hasGraph: false };
    try {
        const info = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', id));
        if (!info?.file || !info.file.toLowerCase().endsWith('.ptsgraph.json') || !fs.existsSync(info.file)) {
            return { ...empty, error: `Subgraph asset not found: ${id}` };
        }
        const content = fs.readFileSync(info.file, 'utf8');
        const value: unknown = JSON.parse(content);
        if (!isEffectGraph(value) || !value.interface || !Array.isArray(value.interface.inputs) || !Array.isArray(value.interface.outputs)) {
            return { ...empty, error: `Invalid subgraph asset: ${id}` };
        }
        return {
            uuid: info.uuid ?? id, name: info.name ?? path.basename(info.file, '.ptsgraph.json'),
            url: info.url ?? '', file: info.file, content, graph: value, hasGraph: true,
        };
    } catch (e) {
        return { ...empty, error: `Cannot load subgraph "${id}": ${String(e)}` };
    }
}

/** Resolve the whole dependency tree through AssetDB on every compile/save. */
async function resolveDependencies(graph: EffectGraph, rootUuid = ''): Promise<Record<string, EffectGraph>> {
    const dependencies: Record<string, EffectGraph> = Object.create(null) as Record<string, EffectGraph>;
    const active = new Set<string>();
    if (rootUuid) active.add(rootUuid);
    const visit = async (current: EffectGraph): Promise<void> => {
        for (const node of current.nodes) {
            if (node.type !== 'subgraph') continue;
            const id = node.params.assetUuid;
            if (typeof id !== 'string' || !id) throw new Error(`Subgraph node "${node.id}" has no asset UUID.`);
            if (active.has(id)) throw new Error(`Subgraph dependency cycle involving "${id}".`);
            if (Object.prototype.hasOwnProperty.call(dependencies, id)) continue;
            active.add(id);
            const result = await loadSubgraph(id);
            if (!result.graph) throw new Error(result.error ?? `Subgraph asset "${id}" is unavailable.`);
            if (rootUuid && result.uuid === rootUuid) throw new Error(`Subgraph dependency cycle involving "${id}".`);
            dependencies[id] = result.graph;
            await visit(result.graph);
            active.delete(id);
        }
    };
    await visit(graph);
    return dependencies;
}

async function compileResolved(graph: EffectGraph, name: string): Promise<CompileResult> {
    try {
        return compileEffect(graph, name, await resolveDependencies(graph));
    } catch (e) {
        return { effect: '', warnings: [], error: e instanceof Error ? e.message : String(e) };
    }
}

export async function saveSubgraph(uuidOrUrl: unknown, graphRaw: unknown): Promise<ISaveEffectResult> {
    const id = String(uuidOrUrl ?? '');
    const fail = (error: string): ISaveEffectResult => ({ effect: '', warnings: [], ok: false, error });
    if (!id || !isEffectGraph(graphRaw) || !graphRaw.interface) return fail('Invalid subgraph payload or target.');
    const current = await loadSubgraph(id);
    if (!current.graph || !current.file) return fail(current.error ?? 'Cannot resolve subgraph target.');
    try {
        const dependencies = await resolveDependencies(graphRaw, current.uuid);
        const error = validateSubgraph(graphRaw, dependencies, current.uuid);
        if (error) return fail(error);
        fs.writeFileSync(current.file, JSON.stringify(graphRaw, null, 2) + '\n', 'utf8');
        try {
            await Editor.Message.request('asset-db', 'refresh-asset', current.uuid);
            const info = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', current.uuid));
            const importFailure = importError(info, current.file);
            if (importFailure) return fail(`${importFailure} The subgraph source remains saved.`);
        } catch (e) {
            return fail(`Subgraph was saved, but AssetDB refresh failed: ${String(e)}`);
        }
        return { effect: '', warnings: [], error: null, ok: true, uuid: current.uuid };
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
}

export async function createSubgraph(assetInfoRaw?: unknown, graphRaw?: unknown): Promise<{ ok: boolean; uuid?: string; url?: string; error?: string }> {
    const assetInfo = toMenuAssetInfo(assetInfoRaw);
    const graph: EffectGraph = graphRaw === undefined
        ? { version: 1, nodes: [], links: [], interface: { inputs: [], outputs: [] } }
        : graphRaw as EffectGraph;
    if (!isEffectGraph(graph) || !graph.interface) return { ok: false, error: 'Invalid subgraph payload.' };
    try {
        if (graphRaw !== undefined) {
            const error = validateSubgraph(graph, await resolveDependencies(graph));
            if (error) return { ok: false, error };
        }
        const dir = assetInfo.url ? (assetInfo.isDirectory ? assetInfo.url : path.posix.dirname(assetInfo.url)) : 'db://assets';
        let url = `${dir}/new-subgraph.ptsgraph.json`;
        let n = 1;
        while (await Editor.Message.request('asset-db', 'query-asset-info', url)) {
            url = `${dir}/new-subgraph-${String(n++).padStart(3, '0')}.ptsgraph.json`;
        }
        const created = toAssetInfo(await Editor.Message.request('asset-db', 'create-asset', url, JSON.stringify(graph, null, 2) + '\n', { overwrite: false, rename: false }));
        if (!created?.uuid) return { ok: false, url, error: `AssetDB did not confirm creation of ${url}. Check the asset before retrying.` };
        const status = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', created.uuid));
        const error = importError(status, url);
        if (error) return { ok: false, uuid: created.uuid, url, error: `${error} The source may already exist.` };
        return { ok: true, uuid: created.uuid, url };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export async function saveEffect(uuidOrUrl: unknown, graphRaw: unknown, assetNameRaw?: unknown): Promise<ISaveEffectResult> {
    const id = String(uuidOrUrl ?? '');
    const assetName = String(assetNameRaw ?? 'effect');
    if (!id) return { effect: '', error: 'No asset uuid/url provided.', warnings: [], ok: false };
    if (!isEffectGraph(graphRaw)) {
        return { effect: '', error: 'Invalid graph payload.', warnings: [], ok: false };
    }

    const compiled = await compileResolved(graphRaw, assetName);
    if (compiled.error) return { ...compiled, ok: false };

    try {
        const info = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', id));
        const file = info?.file;
        if (!file || !fs.existsSync(file)) {
            return { ...compiled, ok: false, error: 'Cannot resolve target file.' };
        }
        const currentContent = fs.readFileSync(file, 'utf8');
        if (!hasUsableGraph(currentContent)) {
            return { ...compiled, ok: false, error: 'Save refused: the target no longer contains a valid pTS-Effect graph. The original file was not changed; use Save As New to preserve your graph.' };
        }
        fs.writeFileSync(file, compiled.effect, 'utf8');
        const uuid = info?.uuid ?? id;
        try {
            await Editor.Message.request('asset-db', 'refresh-asset', uuid);
            const refreshed = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', uuid));
            const error = importError(refreshed, file);
            if (error) return { ...compiled, ok: false, uuid, error: `${error} The generated source and graph remain saved at ${file}.` };
        } catch (e) {
            return { ...compiled, ok: false, uuid, error: `AssetDB refresh or import status query failed for ${file}: ${String(e)}. The generated source and graph remain saved; check the Editor console and refresh the asset.` };
        }
        return { ...compiled, ok: true, uuid };
    } catch (e) {
        return { ...compiled, ok: false, error: String(e) };
    }
}

export async function createEffect(assetInfoRaw?: unknown, graphRaw?: unknown): Promise<{ ok: boolean; uuid?: string; url?: string; error?: string }> {
    const assetInfo = toMenuAssetInfo(assetInfoRaw);
    if (graphRaw !== undefined && !isEffectGraph(graphRaw)) {
        return { ok: false, error: 'Invalid graph payload.' };
    }
    try {
        let targetDir = 'db://assets';
        if (assetInfo.url) {
            targetDir = assetInfo.isDirectory ? assetInfo.url : path.posix.dirname(assetInfo.url);
        }

        const baseName = 'new-effect';
        let fileName = `${baseName}.effect`;
        let targetUrl = `${targetDir}/${fileName}`;
        let counter = 1;
        while (await Editor.Message.request('asset-db', 'query-asset-info', targetUrl)) {
            const suffix = String(counter).padStart(3, '0');
            fileName = `${baseName}-${suffix}.effect`;
            targetUrl = `${targetDir}/${fileName}`;
            counter++;
        }

        const graph = graphRaw === undefined ? createDefaultGraph() : graphRaw as EffectGraph;
        const compiled = await compileResolved(graph, path.basename(fileName, '.effect'));
        if (compiled.error) return { ok: false, error: compiled.error };

        let created: unknown;
        try {
            created = await Editor.Message.request('asset-db', 'create-asset', targetUrl, compiled.effect, {
                overwrite: false,
                rename: false,
            });
        } catch (e) {
            return { ok: false, url: targetUrl, error: `AssetDB could not create or import ${targetUrl}: ${String(e)}. The source may already exist; check the asset and Editor console before retrying.` };
        }
        const createdInfo = toAssetInfo(created);
        if (!createdInfo?.uuid) return { ok: false, url: targetUrl, error: `AssetDB did not confirm creation of ${targetUrl}. The source may already exist; check the asset and Editor console before retrying.` };
        const uuid = createdInfo.uuid;
        let queried: IAssetInfo | null;
        try {
            queried = toAssetInfo(await Editor.Message.request('asset-db', 'query-asset-info', uuid));
        } catch (e) {
            return { ok: false, uuid, url: targetUrl, error: `AssetDB could not query import status for ${targetUrl}: ${String(e)}. The generated source and graph may already exist; check the asset and Editor console.` };
        }
        const error = importError(queried, targetUrl);
        if (error) return { ok: false, uuid, url: targetUrl, error: `${error} The generated source and graph may already exist; they have not been deleted.` };

        try {
            await Editor.Message.request('selection:select', 'asset', [uuid]);
            Editor.Message.send('assets', 'twinkle', uuid);
        } catch {}

        return { ok: true, uuid, url: targetUrl };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

export async function getLanguage(): Promise<string> {
    try {
        const v = await Editor.Profile.getProject(PKG_NAME, 'language');
        if (v === 'zh' || v === 'en') return v;
    } catch {}
    return 'en';
}

export async function setLanguage(langRaw: unknown): Promise<string> {
    const lang = langRaw === 'zh' ? 'zh' : 'en';
    try {
        await Editor.Profile.setProject(PKG_NAME, 'language', lang);
    } catch (e) {
        console.warn('[pts-effect] setProject failed:', e);
    }
    return lang;
}

export const methods: Record<string, (...args: unknown[]) => unknown> = {
    openPanel() {
        void Editor.Panel.open(PKG_NAME);
    },

    reload() {
        console.log('[pts-effect] Reload requested.');
    },

    loadEffect,

    saveEffect,

    createEffect,
    loadSubgraph,

    saveSubgraph,

    createSubgraph,


    async compileEffect(graphRaw: unknown, assetNameRaw?: unknown) {
        if (!isEffectGraph(graphRaw)) {
            return { effect: '', error: 'Invalid graph payload.', warnings: [] as string[] };
        }
        return compileResolved(graphRaw, String(assetNameRaw ?? 'effect'));
    },

    getLanguage,

    setLanguage,

    async 'profile::project::changed_language'(key: unknown, value: unknown) {
        console.log('[pts-effect] Project profile language changed:', key, value);
    },
};

export async function load() {
    console.log('[pts-effect] Extension loaded.');
}

export function unload() {
    console.log('[pts-effect] Extension unloaded.');
}
