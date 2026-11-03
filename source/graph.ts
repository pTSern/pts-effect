/**
 * Graph data model + (de)serialization.
 *
 * Pure module: no Node APIs, no Editor APIs. Shared by the main process
 * (file I/O) and the panel (editor UI).
 */

export type PortType = 'color' | 'vec2' | 'vec3' | 'vec4' | 'float' | 'texture';

export interface GraphPort {
    id: string;
    name: string;
    type: PortType;
}

export interface PortDef {
    id: string;
    type: PortType;
    labelKey: string;
}

export type ParamKind =
    | 'float'
    | 'vec2'
    | 'vec3'
    | 'vec4'
    | 'color'
    | 'texture'
    | 'enum'
    | 'bool'
    | 'string';

export interface NodeParamDef {
    key: string;
    labelKey: string;
    kind: ParamKind;
    default: unknown;
    /** enum options (raw values) */
    options?: string[];
    /** float slider bounds */
    min?: number;
    max?: number;
    step?: number;
}

export interface NodeTypeDef {
    id: string;
    nameKey: string;
    categoryKey: string;
    /** accent color used in the node library and node header */
    color: string;
    inputs: PortDef[];
    outputs: PortDef[];
    params: NodeParamDef[];
}

export interface GraphNode {
    id: string;
    type: string;
    name: string;
    x: number;
    y: number;
    params: Record<string, unknown>;
}

export interface LinkEndpoint {
    node: string;
    port: string;
}

export interface Link {
    id: string;
    from: LinkEndpoint;
    to: LinkEndpoint;
}

export type GraphPropertyType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'texture';

export interface GraphProperty {
    id: string;
    name: string;
    type: GraphPropertyType;
    /** Texture defaults are built-in effect defaults, not asset bindings. */
    value: number | number[] | 'white' | 'grey';
}

export interface EffectGraph {
    version: number;
    nodes: GraphNode[];
    links: Link[];
    properties?: GraphProperty[];
    interface?: { inputs: GraphPort[]; outputs: GraphPort[] };
}

export const GRAPH_VERSION = 1;

/** First-line comment marker used to embed graph data in a generated .effect. */
export const GRAPH_MARKER = 'pTS-Effect';

export function createGraph(): EffectGraph {
    return { version: GRAPH_VERSION, nodes: [], links: [] };
}

export function addNode(graph: EffectGraph, typeId: string, x: number, y: number, typeDef: NodeTypeDef): GraphNode {
    const node: GraphNode = {
        id: genId('n'),
        type: typeId,
        name: `${typeId}_${graph.nodes.length + 1}`,
        x,
        y,
        params: {},
    };
    for (const p of typeDef.params) {
        node.params[p.key] = cloneDefault(p.default);
    }
    graph.nodes.push(node);
    return node;
}

export function removeNode(graph: EffectGraph, nodeId: string): void {
    graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
    graph.links = graph.links.filter((l) => l.from.node !== nodeId && l.to.node !== nodeId);
}

export function getNode(graph: EffectGraph, nodeId: string): GraphNode | undefined {
    return graph.nodes.find((n) => n.id === nodeId);
}

export function findInputLink(graph: EffectGraph, nodeId: string, portId: string): Link | undefined {
    return graph.links.find((l) => l.to.node === nodeId && l.to.port === portId);
}

export function findOutputLinks(graph: EffectGraph, nodeId: string, portId: string): Link[] {
    return graph.links.filter((l) => l.from.node === nodeId && l.from.port === portId);
}

/** Topological order of node ids; throws if the graph has a cycle. */
export function topoSort(graph: EffectGraph): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (nodeId: string): void => {
        if (visited.has(nodeId)) return;
        if (visiting.has(nodeId)) {
            throw new Error(`Cycle detected in node graph at node "${nodeId}".`);
        }
        visiting.add(nodeId);
        for (const link of graph.links) {
            if (link.to.node === nodeId && graph.nodes.some((n) => n.id === link.from.node)) {
                visit(link.from.node);
            }
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        order.push(nodeId);
    };

    for (const node of graph.nodes) visit(node.id);
    return order;
}

export function serializeGraph(graph: EffectGraph): string {
    return JSON.stringify(graph);
}

/** Runtime shape check for graph payloads crossing the main/panel IPC boundary. */
export function isEffectGraph(value: unknown): value is EffectGraph {
    if (!value || typeof value !== 'object') return false;
    const o = value as Record<string, unknown>;
    return Array.isArray(o.nodes) && Array.isArray(o.links);
}

export function deserializeGraph(json: string): EffectGraph | null {
    try {
        const data = JSON.parse(json) as EffectGraph;
        if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) {
            return null;
        }
        return {
            version: data.version ?? GRAPH_VERSION,
            nodes: data.nodes,
            links: data.links,
            ...(Object.prototype.hasOwnProperty.call(data, 'properties') ? { properties: data.properties } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'interface') ? { interface: data.interface } : {}),
        };
    } catch {
        return null;
    }
}

/** Encode a graph into the first-line comment payload embedded in an .effect file. */
export function encodeGraphComment(graph: EffectGraph): string {
    const json = serializeGraph(graph);
    const b64 = toBase64(json);
    return `// ${GRAPH_MARKER} ${b64}`;
}

/** Extract and decode a graph from a generated .effect text body; null if absent. */
export function decodeGraphComment(effectText: string): EffectGraph | null {
    const firstLine = effectText.split(/\r?\n/, 1)[0] ?? '';
    const match = firstLine.match(new RegExp(`^\\/\\/\\s*${GRAPH_MARKER}\\s+(.+)$`));
    if (!match) return null;
    const json = fromBase64(match[1].trim());
    if (!json) return null;
    return deserializeGraph(json);
}

export function stripGraphComment(effectText: string): string {
    const lines = effectText.split(/\r?\n/);
    while (lines.length && /^\/\/\s*pTS-Effect\s/.test(lines[0])) {
        lines.shift();
    }
    return lines.join('\n');
}

function toBase64(text: string): string {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(text)));
    return Buffer.from(text, 'utf8').toString('base64');
}

function fromBase64(b64: string): string | null {
    try {
        if (typeof atob === 'function') return decodeURIComponent(escape(atob(b64)));
        return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
        return null;
    }
}

let idCounter = 0;
export function genId(prefix: string): string {
    idCounter += 1;
    return `${prefix}${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

function cloneDefault(value: unknown): unknown {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === 'object') return { ...(value as Record<string, unknown>) };
    return value;
}
