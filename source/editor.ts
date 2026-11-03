/**
 * SVG node-graph editor: render + interaction (pan/zoom/select/connect/delete).
 *
 * Pure DOM/SVG module (runs in the panel renderer). No Node APIs.
 */

import { genId, addNode, removeNode, getNode, findInputLink } from './graph';
import type { EffectGraph, GraphNode, Link, NodeTypeDef } from './graph';
import { getNodeType, isImplemented } from './nodes';
import { t } from './i18n';
import type { Lang } from './i18n';

const NODE_W = 172;
const HEADER_H = 26;
const ROW_H = 20;
const PAD_Y = 10;
const PORT_R = 5;

export interface NodeGraphEditorOptions {
    graph: EffectGraph;
    lang: Lang;
    onChange: () => void;
    onSelect: (nodeId: string | null) => void;
}

interface NodeGeometry {
    node: GraphNode;
    type: NodeTypeDef;
    width: number;
    height: number;
}

type DragMode =
    | { kind: 'idle' }
    | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
    | { kind: 'boxselect'; startX: number; startY: number; curX: number; curY: number }
    | { kind: 'node'; moved: boolean }
    | { kind: 'connect-out'; fromNode: string; fromPort: string; curX: number; curY: number }
    | { kind: 'connect-in'; toNode: string; toPort: string; curX: number; curY: number };

export class NodeGraphEditor {
    private container: HTMLElement;
    private svg: SVGSVGElement;
    private world: SVGGElement;
    private wiresLayer: SVGGElement;
    private nodesLayer: SVGGElement;
    private tempLayer: SVGGElement;

    private graph: EffectGraph;
    private lang: Lang;
    private onChange: () => void;
    private onSelect: (nodeId: string | null) => void;

    private panX = 60;
    private panY = 40;
    private zoom = 1;
    private selection = new Set<string>();
    private drag: DragMode = { kind: 'idle' };
    private isSpaceHeld = false;
    private nodeDragLastX = 0;
    private nodeDragLastY = 0;
    private clipboard: { nodes: GraphNode[]; links: Link[] } | null = null;
    private pasteCount = 0;

    // History (undo/redo): serialized graph snapshots.
    private history: string[] = [];
    private historyIndex = -1;

    constructor(container: HTMLElement, opts: NodeGraphEditorOptions) {
        this.container = container;
        this.graph = opts.graph;
        this.lang = opts.lang;
        this.onChange = opts.onChange;
        this.onSelect = opts.onSelect;

        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.setAttribute('width', '100%');
        this.svg.setAttribute('height', '100%');
        this.svg.style.display = 'block';
        this.svg.setAttribute('tabindex', '0');
        this.svg.style.outline = 'none';

        this.world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.wiresLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.nodesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.tempLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        this.world.appendChild(this.wiresLayer);
        this.world.appendChild(this.nodesLayer);
        this.world.appendChild(this.tempLayer);
        this.svg.appendChild(this.world);
        this.container.appendChild(this.svg);

        this.svg.addEventListener('pointerdown', this.onPointerDown);
        this.svg.addEventListener('pointermove', this.onPointerMove);
        this.svg.addEventListener('pointerup', this.onPointerUp);
        this.svg.addEventListener('wheel', this.onWheel, { passive: false });
        this.svg.addEventListener('dblclick', this.onDoubleClick);
        this.svg.addEventListener('keydown', this.onKeyDown);

        this.pushHistory();
        this.render();
    }

    dispose(): void {
        this.svg.removeEventListener('pointerdown', this.onPointerDown);
        this.svg.removeEventListener('pointermove', this.onPointerMove);
        this.svg.removeEventListener('pointerup', this.onPointerUp);
        this.svg.removeEventListener('wheel', this.onWheel);
        this.svg.removeEventListener('dblclick', this.onDoubleClick);
        this.svg.removeEventListener('keydown', this.onKeyDown);
        this.container.removeChild(this.svg);
    }

    setLang(lang: Lang): void {
        this.lang = lang;
        this.render();
    }

    setGraph(graph: EffectGraph): void {
        this.graph = graph;
        this.selection.clear();
        this.history = [];
        this.historyIndex = -1;
        this.pushHistory();
        this.render();
    }

    fitView(): void {
        const bbox = this.computeBounds();
        const rect = this.container.getBoundingClientRect();
        const w = Math.max(rect.width, 1);
        const h = Math.max(rect.height, 1);
        const gw = Math.max(bbox.maxX - bbox.minX, 200);
        const gh = Math.max(bbox.maxY - bbox.minY, 200);
        this.zoom = Math.max(0.2, Math.min(Math.min(w / gw, h / gh), 1.25));
        this.panX = (w - (bbox.minX + bbox.maxX) * this.zoom) / 2;
        this.panY = (h - (bbox.minY + bbox.maxY) * this.zoom) / 2;
        this.applyTransform();
    }

    addNode(typeId: string, x: number, y: number): void {
        const type = getNodeType(typeId);
        if (!type || !isImplemented(typeId)) return;
        const world = this.screenToWorld(x, y);
        addNode(this.graph, typeId, world.x, world.y, type);
        this.commit();
    }

    getSelectedIds(): string[] {
        return Array.from(this.selection);
    }

    selectNode(nodeId: string | null): void {
        this.selection.clear();
        if (nodeId) this.selection.add(nodeId);
        this.onSelect(nodeId);
        this.render();
    }

    deleteSelection(): void {
        if (this.selection.size === 0) return;
        for (const id of this.selection) removeNode(this.graph, id);
        this.selection.clear();
        this.onSelect(null);
        this.commit();
    }

    private copySelection(): void {
        const nodes = this.graph.nodes.filter((node) => this.selection.has(node.id));
        if (nodes.length === 0) return;
        const ids = new Set(nodes.map((node) => node.id));
        const links = this.graph.links.filter((link) => ids.has(link.from.node) && ids.has(link.to.node));
        this.clipboard = JSON.parse(JSON.stringify({ nodes, links }));
        this.pasteCount = 0;
    }

    private pasteSelection(): void {
        if (!this.clipboard) return;
        this.pasteCount += 1;
        this.insertCopy(this.clipboard, this.pasteCount * 30);
    }

    private duplicateSelection(): void {
        const nodes = this.graph.nodes.filter((node) => this.selection.has(node.id));
        if (nodes.length === 0) return;
        const ids = new Set(nodes.map((node) => node.id));
        const links = this.graph.links.filter((link) => ids.has(link.from.node) && ids.has(link.to.node));
        this.insertCopy({ nodes, links }, 30);
    }

    private insertCopy(source: { nodes: GraphNode[]; links: Link[] }, offset: number): void {
        // A graph's first output is authoritative, so never introduce another one.
        const hasOutput = this.graph.nodes.some((node) => node.type === 'output');
        let copiedOutput = false;
        const nodes = source.nodes.filter((node) => {
            if (node.type !== 'output') return true;
            if (hasOutput || copiedOutput) return false;
            copiedOutput = true;
            return true;
        });
        if (nodes.length === 0) return;

        const usedIds = new Set([...this.graph.nodes.map((node) => node.id), ...this.graph.links.map((link) => link.id)]);
        const uniqueId = (prefix: string): string => {
            let id: string;
            do { id = genId(prefix); } while (usedIds.has(id));
            usedIds.add(id);
            return id;
        };
        const idMap = new Map<string, string>();
        for (const node of nodes) {
            const copy = JSON.parse(JSON.stringify(node)) as GraphNode;
            copy.id = uniqueId('n');
            copy.x += offset;
            copy.y += offset;
            idMap.set(node.id, copy.id);
            this.graph.nodes.push(copy);
        }
        for (const link of source.links) {
            const from = idMap.get(link.from.node);
            const to = idMap.get(link.to.node);
            if (!from || !to) continue;
            this.graph.links.push({
                id: uniqueId('l'),
                from: { node: from, port: link.from.port },
                to: { node: to, port: link.to.port },
            });
        }
        this.selection = new Set(idMap.values());
        this.onSelect(this.selection.size === 1 ? Array.from(this.selection)[0] : null);
        this.commit();
    }

    undo(): void {
        if (this.historyIndex <= 0) return;
        this.historyIndex -= 1;
        this.restore(this.history[this.historyIndex]);
    }

    redo(): void {
        if (this.historyIndex >= this.history.length - 1) return;
        this.historyIndex += 1;
        this.restore(this.history[this.historyIndex]);
    }

    canUndo(): boolean {
        return this.historyIndex > 0;
    }

    canRedo(): boolean {
        return this.historyIndex < this.history.length - 1;
    }

    get nodeCount(): number {
        return this.graph.nodes.length;
    }

    get linkCount(): number {
        return this.graph.links.length;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private commit(): void {
        this.onChange();
        this.pushHistory();
        this.render();
    }

    private pushHistory(): void {
        const snap = JSON.stringify(this.graph);
        if (this.history[this.historyIndex] === snap) return;
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(snap);
        if (this.history.length > 100) this.history.shift();
        this.historyIndex = this.history.length - 1;
    }

    private restore(snap: string): void {
        try {
            const parsed = JSON.parse(snap) as EffectGraph;
            if (!parsed || !Array.isArray(parsed.nodes)) return;
            this.graph.nodes = parsed.nodes;
            this.graph.links = parsed.links;
            this.selection.clear();
            this.onSelect(null);
            this.onChange();
            this.render();
        } catch {}
    }

    private screenToWorld(sx: number, sy: number): { x: number; y: number } {
        const rect = this.container.getBoundingClientRect();
        return { x: (sx - rect.left - this.panX) / this.zoom, y: (sy - rect.top - this.panY) / this.zoom };
    }

    private applyTransform(): void {
        this.world.setAttribute('transform', `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`);
    }

    private computeBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const node of this.graph.nodes) {
            const g = this.geometry(node);
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + g.width);
            maxY = Math.max(maxY, node.y + g.height);
        }
        if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
        return { minX, minY, maxX, maxY };
    }

    private geometry(node: GraphNode): NodeGeometry {
        const type = getNodeType(node.type);
        const rows = Math.max(type?.inputs.length ?? 0, type?.outputs.length ?? 0, 1);
        return {
            node,
            type: type ?? { id: node.type, nameKey: node.type, categoryKey: 'cat.output', color: '#999', inputs: [], outputs: [], params: [] },
            width: NODE_W,
            height: HEADER_H + PAD_Y * 2 + rows * ROW_H,
        };
    }

    private portPosition(node: GraphNode, portId: string, isInput: boolean): { x: number; y: number } {
        const g = this.geometry(node);
        const ports = isInput ? g.type.inputs : g.type.outputs;
        const index = Math.max(ports.findIndex((p) => p.id === portId), 0);
        const x = isInput ? 0 : g.width;
        const y = HEADER_H + PAD_Y + index * ROW_H + ROW_H / 2;
        return { x: node.x + x, y: node.y + y };
    }

    private render(): void {
        this.applyTransform();
        this.renderWires();
        this.renderNodes();
        this.renderTemp();
    }

    private renderWires(): void {
        this.wiresLayer.innerHTML = '';
        for (const link of this.graph.links) {
            const fromNode = getNode(this.graph, link.from.node);
            const toNode = getNode(this.graph, link.to.node);
            if (!fromNode || !toNode) continue;
            const a = this.portPosition(fromNode, link.from.port, false);
            const b = this.portPosition(toNode, link.to.port, true);
            this.wiresLayer.appendChild(this.wirePath(a, b, false, link.id));
        }
    }

    private renderNodes(): void {
        this.nodesLayer.innerHTML = '';
        for (const node of this.graph.nodes) {
            this.nodesLayer.appendChild(this.renderNode(node));
        }
    }

    private renderTemp(): void {
        this.tempLayer.innerHTML = '';
        if (this.drag.kind === 'connect-out') {
            const fromNode = getNode(this.graph, this.drag.fromNode);
            if (!fromNode) return;
            const a = this.portPosition(fromNode, this.drag.fromPort, false);
            const b = this.screenToWorld(this.drag.curX, this.drag.curY);
            this.tempLayer.appendChild(this.wirePath(a, b, true, '__temp'));
        } else if (this.drag.kind === 'connect-in') {
            const toNode = getNode(this.graph, this.drag.toNode);
            if (!toNode) return;
            const b = this.portPosition(toNode, this.drag.toPort, true);
            const a = this.screenToWorld(this.drag.curX, this.drag.curY);
            this.tempLayer.appendChild(this.wirePath(a, b, true, '__temp'));
        } else if (this.drag.kind === 'boxselect') {
            const a = this.screenToWorld(this.drag.startX, this.drag.startY);
            const b = this.screenToWorld(this.drag.curX, this.drag.curY);
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(Math.min(a.x, b.x)));
            rect.setAttribute('y', String(Math.min(a.y, b.y)));
            rect.setAttribute('width', String(Math.abs(a.x - b.x)));
            rect.setAttribute('height', String(Math.abs(a.y - b.y)));
            rect.setAttribute('fill', 'rgba(90,140,255,0.12)');
            rect.setAttribute('stroke', 'rgba(90,140,255,0.6)');
            rect.setAttribute('stroke-dasharray', '4 3');
            this.tempLayer.appendChild(rect);
        }
    }

    private wirePath(a: { x: number; y: number }, b: { x: number; y: number }, temp: boolean, id: string): SVGPathElement {
        const dx = Math.max(Math.abs(b.x - a.x) * 0.5, 40);
        const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', temp ? '#5a8cff' : '#9aa4b2');
        path.setAttribute('stroke-width', '2');
        if (!temp) {
            path.setAttribute('data-link-id', id);
            path.style.cursor = 'pointer';
            path.style.pointerEvents = 'stroke';
        } else {
            path.style.pointerEvents = 'none';
        }
        return path;
    }

    private renderNode(node: GraphNode): SVGGElement {
        const g = this.geometry(node);
        const selected = this.selection.has(node.id);
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('data-node-id', node.id);
        group.setAttribute('transform', `translate(${node.x}, ${node.y})`);

        const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        body.setAttribute('width', String(g.width));
        body.setAttribute('height', String(g.height));
        body.setAttribute('rx', '6');
        body.setAttribute('fill', '#262a33');
        body.setAttribute('stroke', selected ? '#5a8cff' : '#3a3f4a');
        body.setAttribute('stroke-width', selected ? '2' : '1');
        group.appendChild(body);

        const header = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        header.setAttribute('width', String(g.width));
        header.setAttribute('height', String(HEADER_H));
        header.setAttribute('rx', '6');
        header.setAttribute('fill', g.type.color);
        header.setAttribute('opacity', '0.9');
        group.appendChild(header);

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        title.setAttribute('x', '8');
        title.setAttribute('y', '17');
        title.setAttribute('fill', '#fff');
        title.setAttribute('font-size', '12');
        title.setAttribute('font-weight', '600');
        title.textContent = t(this.lang, g.type.nameKey);
        group.appendChild(title);

        const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        sub.setAttribute('x', '8');
        sub.setAttribute('y', String(HEADER_H + PAD_Y + 4));
        sub.setAttribute('fill', '#8a93a0');
        sub.setAttribute('font-size', '10');
        sub.textContent = node.name;
        group.appendChild(sub);

        const rows = Math.max(g.type.inputs.length, g.type.outputs.length, 1);
        for (let i = 0; i < rows; i++) {
            const y = HEADER_H + PAD_Y + i * ROW_H + ROW_H / 2;
            const input = g.type.inputs[i];
            if (input) group.appendChild(this.renderPort(node, input.id, true, 0, y));
            const output = g.type.outputs[i];
            if (output) group.appendChild(this.renderPort(node, output.id, false, g.width, y));
        }

        return group;
    }

    private renderPort(node: GraphNode, portId: string, isInput: boolean, x: number, y: number): SVGGElement {
        const g = this.geometry(node);
        const port = isInput ? g.type.inputs.find((p) => p.id === portId) : g.type.outputs.find((p) => p.id === portId);
        const portType = port?.type ?? 'color';
        const portLabel = port ? t(this.lang, port.labelKey) : '';

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('data-node-id', node.id);
        group.setAttribute('data-port-id', portId);
        group.setAttribute('data-port-dir', isInput ? 'in' : 'out');
        group.style.cursor = 'crosshair';

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(x));
        circle.setAttribute('cy', String(y));
        circle.setAttribute('r', String(PORT_R));
        circle.setAttribute('fill', this.portColor(portType));
        circle.setAttribute('stroke', '#0d0f13');
        circle.setAttribute('stroke-width', '1.5');
        group.appendChild(circle);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', isInput ? '10' : String(g.width - 10));
        label.setAttribute('y', String(y + 3.5));
        label.setAttribute('fill', '#c2c9d4');
        label.setAttribute('font-size', '10');
        label.setAttribute('text-anchor', isInput ? 'start' : 'end');
        label.textContent = portLabel;
        group.appendChild(label);

        return group;
    }

    private portColor(type: string): string {
        switch (type) {
            case 'color': return '#e0553a';
            case 'vec2': return '#22b8a6';
            case 'float': return '#e0a22e';
            default: return '#5b8def';
        }
    }

    // ------------------------------------------------------------------
    // Event handlers
    // ------------------------------------------------------------------

    private onKeyDown = (e: KeyboardEvent): void => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return;
        switch (e.key.toLowerCase()) {
            case 'c': this.copySelection(); break;
            case 'v': this.pasteSelection(); break;
            case 'd': this.duplicateSelection(); break;
            default: return;
        }
        e.preventDefault();
    };

    private onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0 && e.button !== 1) return;
        this.svg.focus();
        const target = e.target as Element | null;

        const port = target?.closest?.('[data-port-id]') as Element | null;
        if (port) {
            const nodeId = port.getAttribute('data-node-id') ?? '';
            const portId = port.getAttribute('data-port-id') ?? '';
            const dir = port.getAttribute('data-port-dir');
            this.svg.setPointerCapture(e.pointerId);
            if (dir === 'out') {
                this.drag = { kind: 'connect-out', fromNode: nodeId, fromPort: portId, curX: e.clientX, curY: e.clientY };
            } else if (e.altKey) {
                const link = findInputLink(this.graph, nodeId, portId);
                if (link) this.removeLink(link.id);
            } else {
                const link = findInputLink(this.graph, nodeId, portId);
                if (link) {
                    this.drag = { kind: 'connect-out', fromNode: link.from.node, fromPort: link.from.port, curX: e.clientX, curY: e.clientY };
                } else {
                    this.drag = { kind: 'connect-in', toNode: nodeId, toPort: portId, curX: e.clientX, curY: e.clientY };
                }
            }
            this.render();
            return;
        }

        const wireEl = target?.closest?.('[data-link-id]') as Element | null;
        if (wireEl) {
            if (e.altKey) this.removeLink(wireEl.getAttribute('data-link-id') ?? '');
            return;
        }

        const nodeEl = target?.closest?.('[data-node-id]') as Element | null;
        if (nodeEl) {
            const nodeId = nodeEl.getAttribute('data-node-id') ?? '';
            if (e.ctrlKey || e.metaKey) {
                if (this.selection.has(nodeId)) this.selection.delete(nodeId);
                else this.selection.add(nodeId);
                this.onSelect(this.selection.size === 1 ? Array.from(this.selection)[0] : null);
                this.render();
                return;
            }
            if (!this.selection.has(nodeId)) {
                this.selection.clear();
                this.selection.add(nodeId);
                this.onSelect(nodeId);
                this.render();
            }
            this.svg.setPointerCapture(e.pointerId);
            this.nodeDragLastX = (e.clientX - this.container.getBoundingClientRect().left) / this.zoom;
            this.nodeDragLastY = (e.clientY - this.container.getBoundingClientRect().top) / this.zoom;
            this.drag = { kind: 'node', moved: false };
            return;
        }

        if (e.button === 1 || e.ctrlKey || e.shiftKey || this.isSpaceHeld) {
            this.svg.setPointerCapture(e.pointerId);
            this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, panX: this.panX, panY: this.panY };
            this.container.style.cursor = 'grabbing';
        } else {
            this.svg.setPointerCapture(e.pointerId);
            this.drag = { kind: 'boxselect', startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY };
            this.selection.clear();
            this.onSelect(null);
        }
        this.render();
    };

    private onPointerMove = (e: PointerEvent): void => {
        const rect = this.container.getBoundingClientRect();
        if (this.drag.kind === 'pan') {
            this.panX = this.drag.panX + (e.clientX - this.drag.startX);
            this.panY = this.drag.panY + (e.clientY - this.drag.startY);
            this.render();
        } else if (this.drag.kind === 'boxselect') {
            this.drag.curX = e.clientX;
            this.drag.curY = e.clientY;
            this.render();
        } else if (this.drag.kind === 'connect-out' || this.drag.kind === 'connect-in') {
            this.drag.curX = e.clientX;
            this.drag.curY = e.clientY;
            this.render();
        } else if (this.drag.kind === 'node') {
            const dx = (e.clientX - rect.left) / this.zoom;
            const dy = (e.clientY - rect.top) / this.zoom;
            const moveX = dx - this.nodeDragLastX;
            const moveY = dy - this.nodeDragLastY;
            if (moveX === 0 && moveY === 0) return;
            for (const node of this.graph.nodes) {
                if (!this.selection.has(node.id)) continue;
                node.x += moveX;
                node.y += moveY;
            }
            this.nodeDragLastX = dx;
            this.nodeDragLastY = dy;
            this.drag.moved = true;
            this.render();
        }
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (this.drag.kind === 'boxselect') {
            const a = this.screenToWorld(this.drag.startX, this.drag.startY);
            const b = this.screenToWorld(this.drag.curX, this.drag.curY);
            const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
            const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
            this.selection.clear();
            for (const node of this.graph.nodes) {
                const g = this.geometry(node);
                if (node.x < maxX && node.x + g.width > minX && node.y < maxY && node.y + g.height > minY) {
                    this.selection.add(node.id);
                }
            }
            this.onSelect(this.selection.size === 1 ? Array.from(this.selection)[0] : null);
            this.drag = { kind: 'idle' };
            this.render();
            return;
        }

        if (this.drag.kind === 'connect-out' || this.drag.kind === 'connect-in') {
            // With pointer capture, `e.target` is the SVG (capture target), not the
            // element under the cursor. Hit-test the real drop target against the
            // container's root (shadow root in Cocos panels, document otherwise).
            const root = this.container.getRootNode() as Document | ShadowRoot;
            const el = root.elementFromPoint(e.clientX, e.clientY) as Element | null;
            const port = el?.closest?.('[data-port-id]') as Element | null;
            if (port) {
                const toNode = port.getAttribute('data-node-id') ?? '';
                const toPort = port.getAttribute('data-port-id') ?? '';
                const dir = port.getAttribute('data-port-dir');
                if (this.drag.kind === 'connect-out' && dir === 'in') {
                    this.connect(this.drag.fromNode, this.drag.fromPort, toNode, toPort);
                } else if (this.drag.kind === 'connect-in' && dir === 'out') {
                    this.connect(toNode, toPort, this.drag.toNode, this.drag.toPort);
                }
            }
            this.drag = { kind: 'idle' };
            this.render();
            return;
        }

        if (this.drag.kind === 'pan') {
            this.drag = { kind: 'idle' };
            this.container.style.cursor = 'default';
            return;
        }

        if (this.drag.kind === 'node') {
            if (this.drag.moved) this.commit();
            this.drag = { kind: 'idle' };
            return;
        }

        this.drag = { kind: 'idle' };
        this.render();
    };

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const rect = this.container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newZoom = Math.max(0.1, Math.min(this.zoom * factor, 4));
        const worldX = (mx - this.panX) / this.zoom;
        const worldY = (my - this.panY) / this.zoom;
        this.panX = mx - worldX * newZoom;
        this.panY = my - worldY * newZoom;
        this.zoom = newZoom;
        this.render();
    };

    private onDoubleClick = (e: MouseEvent): void => {
        const target = e.target as Element | null;
        if (target?.closest?.('[data-node-id]') || target?.closest?.('[data-port-id]')) return;
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.addNode('output', w.x, w.y);
    };

    private connect(fromNode: string, fromPort: string, toNode: string, toPort: string): boolean {
        if (!fromNode || !toNode || fromNode === toNode) return false;
        const fromType = getNodeType(getNode(this.graph, fromNode)?.type ?? '');
        const toType = getNodeType(getNode(this.graph, toNode)?.type ?? '');
        const outPort = fromType?.outputs.find((p) => p.id === fromPort);
        const inPort = toType?.inputs.find((p) => p.id === toPort);
        if (!outPort || !inPort) return false;
        if (outPort.type !== inPort.type) {
            console.warn(`[pts-effect] Cannot connect ${outPort.type} -> ${inPort.type} (type mismatch).`);
            return false;
        }
        if (this.wouldCreateCycle(fromNode, toNode)) {
            console.warn('[pts-effect] Cannot connect: would create a cycle.');
            return false;
        }

        const existing = findInputLink(this.graph, toNode, toPort);
        if (existing) this.graph.links = this.graph.links.filter((l) => l.id !== existing.id);

        this.graph.links.push({ id: genId('l'), from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } });
        this.commit();
        return true;
    }

    private removeLink(linkId: string): void {
        this.graph.links = this.graph.links.filter((l) => l.id !== linkId);
        this.commit();
    }

    private wouldCreateCycle(fromNode: string, toNode: string): boolean {
        const visited = new Set<string>();
        const stack = [toNode];
        while (stack.length) {
            const cur = stack.pop()!;
            if (cur === fromNode) return true;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const link of this.graph.links) {
                if (link.from.node === cur) stack.push(link.to.node);
            }
        }
        return false;
    }
}
