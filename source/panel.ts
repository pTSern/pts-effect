/**
 * pTS-Effect dockable panel: orchestrates the node-graph editor, node library,
 * inspector, toolbar, and effect file I/O.
 */

import type { EffectGraph, GraphNode, NodeParamDef, NodeTypeDef } from './graph';
import { NODE_TYPES, getNodeType, isImplemented, createDefaultGraph } from './nodes';
import { NodeGraphEditor } from './editor';
import { t, availableLangs } from './i18n';
import type { Lang } from './i18n';

declare const Editor: {
    Message: {
        request(pkg: string, method: string, ...args: unknown[]): Promise<unknown>;
    };
    Selection: {
        getSelected(type: string): string[];
    };
};

export const $ = {
    root: '.pts-effect-root',
    assetSelect: '#pts-effect-asset-select',
    refreshBtn: '#pts-effect-refresh-btn',
    assetName: '#pts-effect-asset-name',
    undoBtn: '#pts-effect-undo',
    redoBtn: '#pts-effect-redo',
    fitBtn: '#pts-effect-fit',
    deleteBtn: '#pts-effect-delete',
    saveBtn: '#pts-effect-save',
    saveAsBtn: '#pts-effect-save-as',
    langSelect: '#pts-effect-lang',
    libSearch: '#pts-effect-lib-search',
    libList: '#pts-effect-lib-list',
    canvas: '#pts-effect-canvas',
    inspector: '#pts-effect-inspector',
    statusLeft: '#pts-effect-status-left',
    statusRight: '#pts-effect-status-right',
};

export const style = `
.pts-effect-root {
    display: flex; flex-direction: column; height: 100%; min-height: 0;
    background: #1e2128; color: #d4dae3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box; font-size: 13px; overflow: hidden;
}
.pts-effect-root * { box-sizing: border-box; }
.pts-effect-toolbar {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px;
    background: #262a33; border-bottom: 1px solid #323844; flex: none; flex-wrap: wrap;
}
.pts-effect-toolbar .title { font-weight: 600; color: #fff; margin-right: 4px; }
.pts-effect-toolbar select, .pts-effect-toolbar input {
    background: #1a1d23; color: #d4dae3; border: 1px solid #3a3f4a; border-radius: 4px;
    padding: 3px 6px; font-size: 12px; outline: none;
}
.pts-effect-toolbar button {
    background: #333a45; color: #d4dae3; border: 1px solid #3a3f4a; border-radius: 4px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.pts-effect-toolbar button:hover { background: #3d4654; }
.pts-effect-toolbar button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.pts-effect-toolbar button:disabled { opacity: 0.45; cursor: default; }
.pts-effect-main { display: flex; flex: 1; min-height: 0; }
.pts-effect-library {
    width: 200px; flex: none; display: flex; flex-direction: column; min-height: 0;
    background: #23272f; border-right: 1px solid #323844;
}
.pts-effect-library input { margin: 8px; padding: 5px 8px; background: #1a1d23; color: #d4dae3; border: 1px solid #3a3f4a; border-radius: 4px; font-size: 12px; outline: none; }
.pts-effect-lib-list { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
.pts-effect-cat { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #7a8494; margin: 10px 0 4px; }
.pts-effect-lib-item {
    display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 4px;
    cursor: pointer; font-size: 12px; color: #c2c9d4;
}
.pts-effect-lib-item:hover { background: #2d333d; }
.pts-effect-lib-item .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.pts-effect-lib-item.disabled { opacity: 0.4; cursor: default; }
.pts-effect-lib-item.disabled:hover { background: transparent; }
.pts-effect-lib-item .soon { font-size: 9px; color: #e0a22e; margin-left: auto; }
.pts-effect-canvas { flex: 1; min-width: 0; position: relative; background: #1a1d23; }
.pts-effect-canvas svg { position: absolute; inset: 0; }
.pts-effect-inspector {
    width: 260px; flex: none; overflow-y: auto; background: #23272f;
    border-left: 1px solid #323844; padding: 10px;
}
.pts-effect-status {
    display: flex; justify-content: space-between; padding: 4px 10px; flex: none;
    background: #262a33; border-top: 1px solid #323844; font-size: 11px; color: #7a8494;
}
.pts-effect-inspector .h { font-weight: 600; color: #fff; margin-bottom: 6px; }
.pts-effect-field { margin-bottom: 10px; }
.pts-effect-field label { display: block; font-size: 11px; color: #8a93a0; margin-bottom: 3px; }
.pts-effect-field input, .pts-effect-field select, .pts-effect-field textarea {
    width: 100%; background: #1a1d23; color: #d4dae3; border: 1px solid #3a3f4a;
    border-radius: 4px; padding: 4px 6px; font-size: 12px; outline: none;
}
.pts-effect-field input[type=color] { height: 28px; padding: 1px; }
.pts-effect-field input[type=checkbox] { width: auto; }
.pts-effect-field .vec { display: flex; gap: 4px; }
.pts-effect-field .vec input { flex: 1; min-width: 0; }
.pts-effect-muted { color: #7a8494; font-size: 12px; }
.pts-effect-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 8px; text-align: center; padding: 20px; }
.pts-effect-empty .icon { font-size: 40px; }
.pts-effect-empty .title { font-weight: 600; color: #fff; font-size: 15px; }
.pts-effect-empty .hint { color: #8a93a0; font-size: 12px; max-width: 360px; }
.pts-effect-empty button { margin-top: 6px; background: #2f6fed; color: #fff; border: none; border-radius: 4px; padding: 7px 16px; cursor: pointer; font-size: 13px; }
`;

export const template = `
<div class="pts-effect-root">
  <div class="pts-effect-toolbar">
    <span class="title">pTS-Effect</span>
    <select id="pts-effect-asset-select" style="min-width: 140px; max-width: 240px;"></select>
    <button id="pts-effect-refresh-btn" title="Refresh">↻</button>
    <span class="pts-effect-muted" id="pts-effect-asset-name"></span>
    <span style="flex:1;"></span>
    <button id="pts-effect-undo">⟲</button>
    <button id="pts-effect-redo">⟳</button>
    <button id="pts-effect-fit">⛶</button>
    <button id="pts-effect-delete">⌫</button>
    <select id="pts-effect-lang" style="width: 88px;"></select>
    <button id="pts-effect-save-as">Save As New</button>
    <button id="pts-effect-save" class="primary">Save</button>
  </div>
  <div class="pts-effect-main">
    <div class="pts-effect-library">
      <input id="pts-effect-lib-search" placeholder="Search nodes..." />
      <div class="pts-effect-lib-list" id="pts-effect-lib-list"></div>
    </div>
    <div class="pts-effect-canvas" id="pts-effect-canvas"></div>
    <div class="pts-effect-inspector" id="pts-effect-inspector"></div>
  </div>
  <div class="pts-effect-status">
    <span id="pts-effect-status-left"></span>
    <span id="pts-effect-status-right"></span>
  </div>
</div>
`;

interface pTS_IDockPanelContext {
    $?: Record<string, Element | null>;
    shadowRoot?: ShadowRoot | null;
}

const pTS_controllers = new WeakMap<object, PanelController>();

export async function ready(this: pTS_IDockPanelContext) {
    const canvas = (this.$?.['canvas'] as HTMLElement | null)
        ?? this.shadowRoot?.querySelector<HTMLElement>($.canvas) ?? null;
    if (!canvas) return;
    pTS_controllers.get(this)?.close();
    const controller = new PanelController(canvas);
    pTS_controllers.set(this, controller);
    await controller.ready();
}

export function close(this: pTS_IDockPanelContext) {
    pTS_controllers.get(this)?.close();
    pTS_controllers.delete(this);
}

export function show(this: pTS_IDockPanelContext) {
    pTS_controllers.get(this)?.onShow();
}

export function hide(this: pTS_IDockPanelContext) {
    pTS_controllers.get(this)?.onHide();
}

interface IEffectAsset { uuid: string; url: string; name: string; }

class PanelController {
    private lang: Lang = 'en';
    private assets: IEffectAsset[] = [];
    private currentUuid = '';
    private currentName = '';
    private graph: EffectGraph = createDefaultGraph();
    private editor: NodeGraphEditor | null = null;
    private dirty = false;
    private closed = false;
    private paused = false;
    private loadVersion = 0;
    private selectVersion = 0;
    private loadError = '';
    private saving = false;

    constructor(private readonly canvasHost: HTMLElement) {}

    private q<T extends Element>(sel: string): T | null {
        return this.canvasHost.closest('.pts-effect-root')?.querySelector<T>(sel) ?? null;
    }

    async ready(): Promise<void> {
        this.lang = await this.readLang();
        this.renderLangSelect();
        this.renderLibrary('');
        this.bindToolbar();
        this.bindLibrarySearch();
        await this.loadAssets();
        this.renderEmpty();
        if (this.closed) return;
        this.updateStatus();
        const selected = Editor.Selection.getSelected('asset')[0];
        if (selected && this.assets.some((a) => a.uuid === selected)) {
            await this.selectAsset(selected);
        }
    }

    onShow(): void {
        this.paused = false;
    }

    onHide(): void {
        this.paused = true;
    }

    close(): void {
        this.closed = true;
        ++this.loadVersion;
        ++this.selectVersion;
        this.canvasHost.closest('.pts-effect-root')?.removeEventListener('dragover', this.onAssetDragOver as EventListener);
        this.canvasHost.closest('.pts-effect-root')?.removeEventListener('drop', this.onAssetDrop as EventListener);
        document.removeEventListener('keydown', this.onKeyDown);
        this.editor?.dispose();
        this.editor = null;
    }

    // ------------------------------------------------------------------
    // Data loading / saving
    // ------------------------------------------------------------------

    private async loadAssets(): Promise<void> {
        const version = ++this.loadVersion;
        try {
            const result = await Editor.Message.request('asset-db', 'query-assets', { pattern: '**/*.effect' });
            if (this.closed || version !== this.loadVersion) return;
            const list = Array.isArray(result) ? result : [];
            this.assets = list
                .filter((a): a is { uuid: string; url: string } => !!a && typeof a === 'object' && 'uuid' in a && 'url' in a)
                .map((a) => ({ uuid: a.uuid, url: a.url, name: a.url.split('/').pop() ?? a.uuid }));
            const select = this.q<HTMLSelectElement>($.assetSelect);
            if (select) {
                select.replaceChildren();
                const ph = select.ownerDocument.createElement('option');
                ph.value = '';
                ph.textContent = this.tr('empty.title');
                select.appendChild(ph);
                for (const asset of this.assets) {
                    const opt = select.ownerDocument.createElement('option');
                    opt.value = asset.uuid;
                    opt.textContent = asset.name;
                    opt.title = asset.url;
                    select.appendChild(opt);
                }
                select.value = this.currentUuid;
            }
        } catch (e) {
            console.warn('[pts-effect] query-assets failed:', e);
        }
    }

    private async selectAsset(uuid: string): Promise<void> {
        if (this.closed) return;
        const select = this.q<HTMLSelectElement>($.assetSelect);
        if (uuid === this.currentUuid) {
            ++this.selectVersion;
            if (select) select.value = this.currentUuid;
            return;
        }
        if (this.saving || (this.dirty && !window.confirm(this.tr('drop.discardChanges')))) {
            ++this.selectVersion;
            if (select) select.value = this.currentUuid;
            return;
        }
        const version = ++this.selectVersion;
        const previousGraph = JSON.stringify(this.graph);
        let graph: EffectGraph | null = null;
        let name = '';
        let error = '';
        if (uuid) {
            try {
                const loaded = (await Editor.Message.request('pts-effect', 'load-effect', uuid)) as {
                    graph?: EffectGraph | null;
                    name?: string;
                    error?: string;
                } | null;
                graph = loaded?.graph ?? null;
                name = loaded?.name ?? '';
                error = loaded?.error ?? (!graph ? this.tr('load.noGraph') : '');
            } catch (e) {
                error = `${this.tr('load.failed')} ${String(e)}`;
            }
        }
        if (this.closed || version !== this.selectVersion) return;
        if (this.saving || JSON.stringify(this.graph) !== previousGraph) {
            if (select) select.value = this.currentUuid;
            this.updateStatus(this.tr('load.changed'));
            return;
        }
        this.currentUuid = uuid;
        this.currentName = name || this.assets.find((asset) => asset.uuid === uuid)?.name || '';
        this.loadError = error;
        this.dirty = false;
        if (select) select.value = uuid;
        this.editor?.dispose();
        this.editor = null;
        this.canvasHost.innerHTML = '';
        if (graph && !error) {
            this.graph = graph;
            this.mountEditor();
        } else {
            this.renderEmpty();
        }
        this.renderInspector(null);
        this.updateStatus();
    }

    private async save(): Promise<void> {
        if (!this.currentUuid || this.closed || !this.editor || this.saving) return;
        if (!this.graph.nodes.some((n) => n.type === 'output')) {
            this.updateStatus('Graph has no Output node.');
            return;
        }
        this.saving = true;
        const savedGraph = JSON.stringify(this.graph);
        this.updateToolbarState();
        try {
            const res = (await Editor.Message.request('pts-effect', 'save-effect', this.currentUuid, this.graph, this.currentName)) as {
                ok?: boolean;
                error?: string | null;
                warnings?: string[];
            };
            if (res?.ok) {
                this.dirty = JSON.stringify(this.graph) !== savedGraph;
                this.updateStatus();
            } else {
                this.updateStatus(res?.error ?? 'Save failed.');
            }
        } catch (e) {
            this.updateStatus(`Save failed: ${String(e)}`);
        }
        finally {
            this.saving = false;
            this.updateToolbarState();
        }
    }

    private async saveAs(): Promise<void> {
        if (!this.editor || this.saving || this.closed) return;
        this.saving = true;
        this.updateToolbarState();
        const asset = this.assets.find((item) => item.uuid === this.currentUuid);
        try {
            const graph = JSON.parse(JSON.stringify(this.graph)) as EffectGraph;
            const res = await Editor.Message.request('pts-effect', 'create-effect',
                asset ? { url: asset.url, isDirectory: false } : undefined, graph) as {
                    ok?: boolean; url?: string; error?: string;
                };
            if (res?.ok) {
                await this.loadAssets();
                this.updateStatus(`${this.tr('load.copySaved')} ${res.url ?? ''}`);
            } else {
                this.updateStatus(res?.error ?? this.tr('load.createFailed'));
            }
        } catch (e) {
            this.updateStatus(`${this.tr('load.createFailed')} ${String(e)}`);
        } finally {
            this.saving = false;
            this.updateToolbarState();
        }
    }

    // ------------------------------------------------------------------
    // Editor / library / inspector
    // ------------------------------------------------------------------

    private mountEditor(): void {
        this.editor?.dispose();
        this.canvasHost.innerHTML = '';
        this.editor = new NodeGraphEditor(this.canvasHost, {
            graph: this.graph,
            lang: this.lang,
            onChange: () => {
                this.dirty = true;
                this.updateStatus();
            },
            onSelect: (nodeId) => this.renderInspector(nodeId),
        });
    }

    private renderEmpty(): void {
        if (this.editor || this.canvasHost.querySelector('.pts-effect-empty')) return;
        const div = this.canvasHost.ownerDocument.createElement('div');
        div.className = 'pts-effect-empty';
        const title = this.canvasHost.ownerDocument.createElement('div');
        title.className = 'title';
        title.textContent = this.loadError ? this.tr('load.title') : this.tr('empty.title');
        const hint = this.canvasHost.ownerDocument.createElement('div');
        hint.className = 'hint';
        hint.textContent = this.loadError ? `${this.loadError} ${this.tr('load.preserved')}` : this.tr('empty.hint');
        const button = this.canvasHost.ownerDocument.createElement('button');
        button.textContent = this.tr('empty.create');
        button.addEventListener('click', () => void this.createEmpty());
        div.append(title, hint, button);
        this.canvasHost.appendChild(div);
    }

    private async createEmpty(): Promise<void> {
        try {
            const asset = this.assets.find((item) => item.uuid === this.currentUuid);
            const res = (await Editor.Message.request('pts-effect', 'create-effect',
                asset ? { url: asset.url, isDirectory: false } : undefined)) as { ok?: boolean; uuid?: string; error?: string };
            if (res?.ok && res.uuid) {
                await this.loadAssets();
                await this.selectAsset(res.uuid);
            }
            else this.updateStatus(res?.error ?? this.tr('load.createFailed'));
        } catch (e) {
            this.updateStatus(`${this.tr('load.createFailed')} ${String(e)}`);
        }
    }

    private renderLibrary(filter: string): void {
        const list = this.q<HTMLElement>($.libList);
        if (!list) return;
        list.innerHTML = '';
        const q = filter.trim().toLowerCase();
        const byCategory = new Map<string, NodeTypeDef[]>();
        for (const type of NODE_TYPES) {
            const name = t(this.lang, type.nameKey).toLowerCase();
            if (q && !name.includes(q)) continue;
            const arr = byCategory.get(type.categoryKey) ?? [];
            arr.push(type);
            byCategory.set(type.categoryKey, arr);
        }
        for (const [catKey, types] of byCategory) {
            const catEl = list.ownerDocument.createElement('div');
            catEl.className = 'pts-effect-cat';
            catEl.textContent = t(this.lang, catKey);
            list.appendChild(catEl);
            for (const type of types) {
                const item = list.ownerDocument.createElement('div');
                const implemented = isImplemented(type.id);
                item.className = 'pts-effect-lib-item' + (implemented ? '' : ' disabled');
                item.innerHTML = `<span class="dot" style="background:${type.color}"></span><span>${t(this.lang, type.nameKey)}</span>${implemented ? '' : '<span class="soon">soon</span>'}`;
                if (implemented) {
                    item.setAttribute('draggable', 'true');
                    item.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', type.id));
                    item.addEventListener('click', () => {
                        const rect = this.canvasHost.getBoundingClientRect();
                        this.editor?.addNode(type.id, rect.left + rect.width / 2, rect.top + rect.height / 2);
                    });
                }
                list.appendChild(item);
            }
        }
        if (byCategory.size === 0) {
            const empty = list.ownerDocument.createElement('div');
            empty.className = 'pts-effect-muted';
            empty.style.padding = '8px 4px';
            empty.textContent = this.tr('lib.empty');
            list.appendChild(empty);
        }
    }

    private renderInspector(nodeId: string | null): void {
        const insp = this.q<HTMLElement>($.inspector);
        if (!insp) return;
        insp.innerHTML = '';
        if (!nodeId) {
            insp.innerHTML = `<div class="pts-effect-muted">${this.tr('insp.none')}</div>`;
            return;
        }
        const node = this.graph.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const type = getNodeType(node.type);
        if (!type) return;

        const h = insp.ownerDocument.createElement('div');
        h.className = 'h';
        h.textContent = t(this.lang, type.nameKey);
        insp.appendChild(h);

        // Name field
        this.field(insp, this.tr('insp.name'), this.textInput(node.name, (v) => { node.name = v; this.markDirty(); }));
        this.field(insp, this.tr('insp.type'), this.staticText(type.id));

        // Params
        for (const param of type.params) {
            this.field(insp, t(this.lang, param.labelKey), this.paramControl(node, param));
        }
    }

    private field(parent: HTMLElement, label: string, control: HTMLElement): void {
        const wrap = parent.ownerDocument.createElement('div');
        wrap.className = 'pts-effect-field';
        const lab = parent.ownerDocument.createElement('label');
        lab.textContent = label;
        wrap.appendChild(lab);
        wrap.appendChild(control);
        parent.appendChild(wrap);
    }

    private staticText(value: string): HTMLElement {
        const span = document.createElement('span');
        span.className = 'pts-effect-muted';
        span.textContent = value;
        return span;
    }

    private textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.addEventListener('input', () => onInput(input.value));
        return input;
    }

    private paramControl(node: GraphNode, param: NodeParamDef): HTMLElement {
        const current = node.params[param.key];
        switch (param.kind) {
            case 'float': {
                const input = document.createElement('input');
                input.type = 'number';
                input.value = String(current ?? param.default ?? 0);
                input.step = String(param.step ?? 0.01);
                if (param.min !== undefined) input.min = String(param.min);
                if (param.max !== undefined) input.max = String(param.max);
                input.addEventListener('input', () => { node.params[param.key] = Number(input.value); this.markDirty(); });
                return input;
            }
            case 'vec2': case 'vec3': case 'vec4': {
                const wrap = document.createElement('div');
                wrap.className = 'vec';
                const len = param.kind === 'vec2' ? 2 : param.kind === 'vec3' ? 3 : 4;
                const arr = Array.isArray(current) ? current : Array.isArray(param.default) ? param.default : new Array(len).fill(0);
                for (let i = 0; i < len; i++) {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.step = '0.01';
                    input.value = String(Number(arr[i]) || 0);
                    const idx = i;
                    input.addEventListener('input', () => {
                        const val = Array.isArray(node.params[param.key]) ? (node.params[param.key] as number[]).slice() : new Array(len).fill(0);
                        val[idx] = Number(input.value);
                        node.params[param.key] = val;
                        this.markDirty();
                    });
                    wrap.appendChild(input);
                }
                return wrap;
            }
            case 'color': {
                const wrap = document.createElement('div');
                wrap.style.display = 'flex';
                wrap.style.gap = '4px';
                const arr = Array.isArray(current) ? current : Array.isArray(param.default) ? param.default : [1, 1, 1, 1];
                const color = document.createElement('input');
                color.type = 'color';
                color.value = rgbToHex(arr[0] as number, arr[1] as number, arr[2] as number);
                const alpha = document.createElement('input');
                alpha.type = 'number';
                alpha.min = '0';
                alpha.max = '1';
                alpha.step = '0.01';
                alpha.value = String(arr[3] ?? 1);
                const update = () => {
                    const [r, g, b] = hexToRgb(color.value);
                    node.params[param.key] = [r, g, b, Number(alpha.value) || 0];
                    this.markDirty();
                };
                color.addEventListener('input', update);
                alpha.addEventListener('input', update);
                wrap.appendChild(color);
                wrap.appendChild(alpha);
                return wrap;
            }
            case 'enum': {
                const select = document.createElement('select');
                for (const opt of param.options ?? []) {
                    const o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt;
                    select.appendChild(o);
                }
                select.value = String(current ?? param.default ?? (param.options?.[0] ?? ''));
                select.addEventListener('change', () => { node.params[param.key] = select.value; this.markDirty(); });
                return select;
            }
            case 'bool': {
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = !!current;
                input.addEventListener('change', () => { node.params[param.key] = input.checked; this.markDirty(); });
                return input;
            }
            case 'string': {
                const ta = document.createElement('textarea');
                ta.rows = 4;
                ta.value = String(current ?? '');
                ta.addEventListener('input', () => { node.params[param.key] = ta.value; this.markDirty(); });
                return ta;
            }
            case 'texture': {
                const input = document.createElement('input');
                input.type = 'text';
                input.value = typeof current === 'string' ? current : '';
                input.placeholder = 'texture uuid (assigned via material)';
                input.addEventListener('input', () => { node.params[param.key] = input.value; this.markDirty(); });
                return input;
            }
            default: return this.staticText(String(current ?? ''));
        }
    }

    // ------------------------------------------------------------------
    // Toolbar / status
    // ------------------------------------------------------------------

    private bindToolbar(): void {
        this.q($.refreshBtn)?.addEventListener('click', () => void this.loadAssets());
        this.q($.assetSelect)?.addEventListener('change', (e) => void this.selectAsset((e.target as HTMLSelectElement).value));
        this.q($.undoBtn)?.addEventListener('click', () => this.editor?.undo());
        this.q($.redoBtn)?.addEventListener('click', () => this.editor?.redo());
        this.q($.fitBtn)?.addEventListener('click', () => this.editor?.fitView());
        this.q($.deleteBtn)?.addEventListener('click', () => this.editor?.deleteSelection());
        this.q($.saveBtn)?.addEventListener('click', () => void this.save());
        this.q($.saveAsBtn)?.addEventListener('click', () => void this.saveAs());
        this.q($.langSelect)?.addEventListener('change', (e) => void this.setLang((e.target as HTMLSelectElement).value as Lang));
        const root = this.canvasHost.closest('.pts-effect-root');
        root?.addEventListener('dragover', this.onAssetDragOver as EventListener);
        root?.addEventListener('drop', this.onAssetDrop as EventListener);
        this.canvasHost.addEventListener('dragover', (e) => e.preventDefault());
        this.canvasHost.addEventListener('drop', (e) => {
            e.preventDefault();
            const typeId = e.dataTransfer?.getData('text/plain');
            if (typeId) this.editor?.addNode(typeId, e.clientX, e.clientY);
        });
        document.addEventListener('keydown', this.onKeyDown);
    }
    private onAssetDragOver = (event: DragEvent): void => {
        if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('value')) {
            event.preventDefault();
        }
    };

    private onAssetDrop = (event: DragEvent): void => {
        const uuid = event.dataTransfer?.getData('value');
        if (!uuid) return;
        event.preventDefault();
        void this.openDroppedAsset(uuid);
    };

    private async openDroppedAsset(uuid: string): Promise<void> {
        try {
            const info = await Editor.Message.request('asset-db', 'query-asset-info', uuid);
            if (this.closed || !info || typeof info !== 'object' || !('url' in info) ||
                typeof info.url !== 'string' || !/\.effect$/i.test(info.url)) return;
            if (uuid === this.currentUuid) return;
            if (!this.assets.some((asset) => asset.uuid === uuid)) await this.loadAssets();
            if (!this.closed) await this.selectAsset(uuid);
        } catch (error) {
            console.warn('[pts-effect] Unable to open dropped effect:', error);
        }
    }


    private bindLibrarySearch(): void {
        this.q<HTMLInputElement>($.libSearch)?.addEventListener('input', (e) => this.renderLibrary((e.target as HTMLInputElement).value));
    }

    private onKeyDown = (e: KeyboardEvent): void => {
        const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
        if (inField) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this.editor?.deleteSelection();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) this.editor?.redo(); else this.editor?.undo();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void this.save();
        } else if (e.key === 'Escape') {
            this.editor?.selectNode(null);
        }
    };

    private async setLang(lang: Lang): Promise<void> {
        this.lang = lang;
        this.editor?.setLang(lang);
        this.renderLibrary(this.q<HTMLInputElement>($.libSearch)?.value ?? '');
        this.renderInspector(this.editor?.getSelectedIds()[0] ?? null);
        this.updateStatus();
        try {
            await Editor.Message.request('pts-effect', 'set-language', lang);
        } catch {}
        this.renderLangSelect();
    }

    private async readLang(): Promise<Lang> {
        try {
            const v = await Editor.Message.request('pts-effect', 'get-language');
            return v === 'zh' ? 'zh' : 'en';
        } catch {
            return 'en';
        }
    }

    private renderLangSelect(): void {
        const select = this.q<HTMLSelectElement>($.langSelect);
        if (!select) return;
        select.replaceChildren();
        for (const l of availableLangs()) {
            const o = select.ownerDocument.createElement('option');
            o.value = l.id;
            o.textContent = l.label;
            select.appendChild(o);
        }
        select.value = this.lang;
    }

    private markDirty(): void {
        this.dirty = true;
        this.updateStatus();
    }

    private updateStatus(message?: string): void {
        const left = this.q<HTMLElement>($.statusLeft);
        const right = this.q<HTMLElement>($.statusRight);
        if (left) left.textContent = this.editor ? `${this.tr('status.nodes')} ${this.graph.nodes.length}  ${this.tr('status.links')} ${this.graph.links.length}` : '';
        if (right) {
            right.textContent = message ?? (this.loadError || (this.editor ? (this.dirty ? this.tr('status.unsaved') : this.tr('status.saved')) : ''));
        }
        const nameEl = this.q<HTMLElement>($.assetName);
        if (nameEl) nameEl.textContent = this.currentName;
        this.updateToolbarState();
    }

    private updateToolbarState(): void {
        const undo = this.q<HTMLButtonElement>($.undoBtn);
        const redo = this.q<HTMLButtonElement>($.redoBtn);
        const save = this.q<HTMLButtonElement>($.saveBtn);
        const saveAs = this.q<HTMLButtonElement>($.saveAsBtn);
        if (undo) undo.disabled = !this.editor?.canUndo();
        if (redo) redo.disabled = !this.editor?.canRedo();
        if (save) {
            save.textContent = this.tr('tool.save');
            save.disabled = !this.editor || this.saving;
        }
        if (saveAs) {
            saveAs.textContent = this.tr('tool.saveAs');
            saveAs.disabled = !this.editor || this.saving;
        }
    }

    private tr(key: string): string {
        return t(this.lang, key);
    }
}

function rgbToHex(r: number, g: number, b: number): string {
    const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((ch) => ch + ch).join('') : m;
    const n = parseInt(full, 16);
    if (isNaN(n)) return [1, 1, 1];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
