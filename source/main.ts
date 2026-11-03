/**
 * pTS-Effect main process: menu, panel open, effect file I/O.
 */

import fs from 'fs';
import path from 'path';
import { decodeGraphComment, isEffectGraph } from './graph';
import type { EffectGraph } from './graph';
import { createDefaultGraph } from './nodes';
import { compileEffect } from './codegen';
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
}

function toAssetInfo(v: unknown): IAssetInfo | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const file = typeof o.file === 'string' ? o.file : typeof o.path === 'string' ? o.path : null;
    return {
        uuid: typeof o.uuid === 'string' ? o.uuid : null,
        name: typeof o.name === 'string' ? o.name : null,
        url: typeof o.url === 'string' ? o.url : null,
        file,
    };
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

export async function saveEffect(uuidOrUrl: unknown, graphRaw: unknown, assetNameRaw?: unknown): Promise<ISaveEffectResult> {
    const id = String(uuidOrUrl ?? '');
    const assetName = String(assetNameRaw ?? 'effect');
    if (!id) return { effect: '', error: 'No asset uuid/url provided.', warnings: [], ok: false };
    if (!isEffectGraph(graphRaw)) {
        return { effect: '', error: 'Invalid graph payload.', warnings: [], ok: false };
    }

    const compiled = compileEffect(graphRaw, assetName);
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
        try {
            await Editor.Message.request('asset-db', 'refresh-asset', info?.uuid ?? id);
        } catch (e) {
            console.warn('[pts-effect] refresh-asset failed:', e);
        }
        return { ...compiled, ok: true, uuid: info?.uuid ?? id };
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
        const compiled = compileEffect(graph, path.basename(fileName, '.effect'));
        if (compiled.error) return { ok: false, error: compiled.error };

        const created = await Editor.Message.request('asset-db', 'create-asset', targetUrl, compiled.effect, {
            overwrite: false,
            rename: false,
        });
        const queried = await Editor.Message.request('asset-db', 'query-asset-info', targetUrl);
        const createdInfo = toAssetInfo(created);
        const uuid = createdInfo?.uuid ?? toAssetInfo(queried)?.uuid ?? undefined;
        if (!uuid) return { ok: false, error: `Failed to create asset at ${targetUrl}` };

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

    compileEffect(graphRaw: unknown, assetNameRaw?: unknown) {
        if (!isEffectGraph(graphRaw)) {
            return { effect: '', error: 'Invalid graph payload.', warnings: [] as string[] };
        }
        return compileEffect(graphRaw, String(assetNameRaw ?? 'effect'));
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
