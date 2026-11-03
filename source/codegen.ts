/**
 * Graph -> standard Cocos `.effect` compiler.
 *
 * Pure module (no Node/Editor APIs). Compiles the node graph into a
 * single-pass 2D sprite fragment shader using the same structure as the
 * project's hand-written sprite effects (outline.effect, glow.effect, ...).
 */

import { topoSort, findInputLink, encodeGraphComment } from './graph';
import type { EffectGraph, GraphNode, PortType, NodeParamDef } from './graph';
import { getNodeType, NODE_EMIT, sampleSpriteCode } from './nodes';
import type { EmitCtx } from './nodes';

export interface CompileResult {
    effect: string;
    error: string | null;
    warnings: string[];
}

interface UboField {
    name: string;
    glslType: string;
    param: NodeParamDef;
    value: unknown;
    nodeId: string;
}

interface SamplerField {
    name: string;
    value: unknown;
}

class CodegenContext implements EmitCtx {
    node: GraphNode;
    inputs: Map<string, string>;
    outputs: Map<string, string>;
    private fields: UboField[];
    private samplers: SamplerField[];
    private helpers: Map<string, string>;

    constructor(node: GraphNode, inputs: Map<string, string>, outputs: Map<string, string>, state: CodegenState) {
        this.node = node;
        this.inputs = inputs;
        this.outputs = outputs;
        this.fields = state.fields;
        this.samplers = state.samplers;
        this.helpers = state.helpers;
    }

    uniform(key: string, kind: 'float' | 'vec2' | 'vec3' | 'vec4'): string {
        const def = this.paramDef(key);
        const name = `u_${this.node.id}_${key}`;
        if (!this.fields.some((f) => f.name === name)) {
            this.fields.push({
                name,
                glslType: kind,
                param: def,
                value: this.node.params[key],
                nodeId: this.node.id,
            });
        }
        return name;
    }

    sampler(key: string): string {
        const name = `s_${this.node.id}_${key}`;
        if (!this.samplers.some((s) => s.name === name)) {
            this.samplers.push({ name, value: this.node.params[key] ?? null });
        }
        return name;
    }

    helper(name: string, code: string): void {
        if (!this.helpers.has(name)) this.helpers.set(name, code);
    }

    private paramDef(key: string): NodeParamDef {
        const type = getNodeType(this.node.type);
        const found = type?.params.find((p) => p.key === key);
        if (!found) {
            // Fallback for params without explicit def: assume float.
            return { key, labelKey: key, kind: 'float', default: 0 };
        }
        return found;
    }
}

interface CodegenState {
    fields: UboField[];
    samplers: SamplerField[];
    helpers: Map<string, string>;
}

const DEFAULT_EXPR: Record<PortType, string> = {
    color: 'vec4(1.0)',
    vec2: 'uv0',
    float: '0.0',
    texture: 'vec4(1.0)',
};

function portGlslType(type: PortType): string {
    switch (type) {
        case 'color':
        case 'texture':
            return 'vec4';
        case 'vec2':
            return 'vec2';
        case 'float':
            return 'float';
    }
}

export function compileEffect(graph: EffectGraph, assetName = 'effect'): CompileResult {
    const warnings: string[] = [];
    try {
        if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
            throw new Error('Invalid graph: nodes and links must be arrays.');
        }
        const nodes = new Map<string, GraphNode>();
        for (const node of graph.nodes) {
            if (!node || typeof node.id !== 'string' || !node.id ||
                typeof node.type !== 'string' || !node.type ||
                !node.params || typeof node.params !== 'object' || Array.isArray(node.params)) {
                throw new Error('Invalid graph node: each node needs an id, type, and params object.');
            }
            if (nodes.has(node.id)) throw new Error(`Duplicate node id "${node.id}".`);
            nodes.set(node.id, node);
        }

        const outputs = graph.nodes.filter((n) => n.type === 'output');
        if (outputs.length !== 1) {
            throw new Error(`Graph must have exactly one Output node; found ${outputs.length}.`);
        }
        const outputNode = outputs[0];
        const connectedInputs = new Set<string>();
        for (const link of graph.links) {
            if (!link || !link.from || !link.to ||
                typeof link.from.node !== 'string' || typeof link.from.port !== 'string' ||
                typeof link.to.node !== 'string' || typeof link.to.port !== 'string') {
                throw new Error('Invalid link: each link needs source and destination node and port ids.');
            }
            const description = `${link.from.node}.${link.from.port} -> ${link.to.node}.${link.to.port}`;
            const source = nodes.get(link.from.node);
            const target = nodes.get(link.to.node);
            if (!source || !target) throw new Error(`Invalid link ${description}: node not found.`);
            const sourceType = getNodeType(source.type);
            const targetType = getNodeType(target.type);
            if (!sourceType || !targetType) {
                throw new Error(`Invalid link ${description}: unknown node type "${!sourceType ? source.type : target.type}".`);
            }
            const fromPort = sourceType.outputs.find((p) => p.id === link.from.port);
            const toPort = targetType.inputs.find((p) => p.id === link.to.port);
            if (!fromPort || !toPort) throw new Error(`Invalid link ${description}: output or input port not found.`);
            if (fromPort.type !== toPort.type) {
                throw new Error(`Invalid link ${description}: type mismatch (${fromPort.type} -> ${toPort.type}).`);
            }
            const inputKey = JSON.stringify([link.to.node, link.to.port]);
            if (connectedInputs.has(inputKey)) throw new Error(`Invalid link ${description}: input already connected.`);
            connectedInputs.add(inputKey);
        }

        // Validate cycles throughout the graph, but only emit the output's dependencies.
        const sorted = topoSort(graph);
        const reachable = new Set<string>();
        const visit = (id: string): void => {
            if (reachable.has(id)) return;
            reachable.add(id);
            for (const link of graph.links) if (link.to.node === id) visit(link.from.node);
        };
        visit(outputNode.id);
        const order = sorted.filter((id) => reachable.has(id));
        const state: CodegenState = { fields: [], samplers: [], helpers: new Map() };
        state.helpers.set('pTS_sampleSprite', sampleSpriteCode);

        const outputVars = new Map<string, Map<string, string>>();
        const declarations: string[] = [];
        for (const nodeId of order) {
            const node = nodes.get(nodeId)!;
            const type = getNodeType(node.type);
            if (!type || !NODE_EMIT[node.type]) {
                throw new Error(`Node "${node.id}" has unknown or unsupported type "${node.type}".`);
            }
            if (!/^[A-Za-z0-9_]+$/.test(node.id)) {
                throw new Error(`Node id "${node.id}" cannot be used in shader identifiers; use letters, digits, and underscores.`);
            }
            const vars = new Map<string, string>();
            for (const port of type.outputs) {
                const name = `p_${node.id}_${port.id}`;
                vars.set(port.id, name);
                declarations.push(`${portGlslType(port.type)} ${name};`);
            }
            outputVars.set(node.id, vars);
        }

        const bodyLines: string[] = [...declarations];
        for (const nodeId of order) {
            const node = nodes.get(nodeId)!;
            const type = getNodeType(node.type)!;
            const inputs = new Map<string, string>();
            for (const port of type.inputs) {
                const link = findInputLink(graph, node.id, port.id);
                inputs.set(port.id, link
                    ? outputVars.get(link.from.node)!.get(link.from.port)!
                    : defaultInput(node, port.id, port.type));
            }
            const ctx = new CodegenContext(node, inputs, outputVars.get(node.id)!, state);
            let lines: string[];
            try {
                lines = NODE_EMIT[node.type]!(ctx).filter(Boolean);
            } catch (e) {
                throw new Error(`Node "${node.id}" (${node.type}) failed to generate code: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (lines.length) bodyLines.push('{', ...lines.map((line) => `  ${line}`), '}');
        }

        const effect = assembleEffect(graph, outputNode, bodyLines, state, warnings, assetName);
        return { effect, error: null, warnings };
    } catch (e) {
        return { effect: '', error: e instanceof Error ? e.message : String(e), warnings };
    }
}

function defaultInput(node: GraphNode, portId: string, type: PortType): string {
    // The Output node's color input defaults to the sprite texture sample.
    if (node.type === 'output' && portId === 'color') {
        return 'pTS_sampleSprite(uv0)';
    }
    return DEFAULT_EXPR[type];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function assembleEffect(
    graph: EffectGraph,
    outputNode: GraphNode,
    bodyLines: string[],
    state: CodegenState,
    warnings: string[],
    assetName: string,
): string {
    const properties = buildProperties(state);
    const ubo = buildUbo(state);
    const samplers = state.samplers.map((s) => `uniform sampler2D ${s.name};`).join('\n  ');
    const helpers = Array.from(state.helpers.values()).join('\n');

    const effectHeader = `CCEffect %{
  techniques:
  - passes:
    - vert: sprite-vs:vert
      frag: sprite-fs:frag
      depthStencilState:
        depthTest: false
        depthWrite: false
      blendState:
        targets:
        - blend: true
          blendSrc: src_alpha
          blendDst: one_minus_src_alpha
          blendDstAlpha: one_minus_src_alpha
      rasterizerState:
        cullMode: none${properties ? `\n      properties:${properties}` : ''}
}%`;

    const vs = `CCProgram sprite-vs %{
  precision highp float;
  #include <builtin/uniforms/cc-global>
  #if USE_LOCAL
    #include <builtin/uniforms/cc-local>
  #endif

  in vec3 a_position;
  in vec2 a_texCoord;
  in vec4 a_color;

  out vec4 color;
  out vec2 uv0;

  vec4 vert () {
    vec4 pos = vec4(a_position, 1);

    #if USE_LOCAL
      pos = cc_matWorld * pos;
    #endif

    #if USE_PIXEL_ALIGNMENT
      pos = cc_matView * pos;
      pos.xyz = floor(pos.xyz);
      pos = cc_matProj * pos;
    #else
      pos = cc_matViewProj * pos;
    #endif

    uv0 = a_texCoord;
    color = a_color;

    return pos;
  }
}%`;

    const fs = `CCProgram sprite-fs %{
  precision highp float;
  #include <builtin/uniforms/cc-global>
  #include <builtin/internal/embedded-alpha>
  #include <builtin/internal/alpha-test>

  in vec4 color;
  in vec2 uv0;

  #pragma builtin(local)
  layout(set = 2, binding = 12) uniform sampler2D cc_spriteTexture;
${ubo ? `\n  ${ubo}\n` : ''}${samplers ? `\n  ${samplers}\n` : ''}${helpers ? `\n  ${helpers}\n` : ''}
  vec4 frag () {
    vec4 o = vec4(1.0);
${bodyLines.map((l) => `    ${l}`).join('\n')}
    o *= color;
    ALPHA_TEST(o);
    return o;
  }
}%`;

    // The graph comment must be the very first line for round-trip editing.
    const comment = encodeGraphComment(graph);
    return `${comment}\n${effectHeader}\n\n${vs}\n\n${fs}\n`;
}

function buildProperties(state: CodegenState): string {
    const lines: string[] = [];
    for (const f of state.fields) {
        lines.push(`        ${f.name}: { value: ${formatValue(f)}${formatEditor(f)} }`);
    }
    for (const s of state.samplers) {
        lines.push(`        ${s.name}: { value: white }`);
    }
    return lines.length ? `\n${lines.join('\n')}` : '';
}

// std140 requires each member to be naturally aligned; sorting by alignment
// (largest first) guarantees no implicit padding, which the Cocos effect
// compiler (EFX2205) rejects.
const UBO_ALIGN_PRIORITY: Record<string, number> = { vec4: 0, vec3: 1, vec2: 2, float: 3 };

function buildUbo(state: CodegenState): string {
    if (state.fields.length === 0) return '';
    const sorted = [...state.fields].sort(
        (a, b) => (UBO_ALIGN_PRIORITY[a.glslType] ?? 4) - (UBO_ALIGN_PRIORITY[b.glslType] ?? 4),
    );
    const lines = sorted.map((f) => `    ${f.glslType} ${f.name};`);
    return `uniform pTS_EffectParams {\n${lines.join('\n')}\n  };`;
}

function formatValue(f: UboField): string {
    const v = f.value;
    switch (f.param.kind) {
        case 'color':
            return arrayLiteral(v);
        case 'vec2':
        case 'vec3':
        case 'vec4':
            return arrayLiteral(v);
        case 'enum': {
            const options = f.param.options ?? [];
            const idx = options.indexOf(String(v));
            return idx < 0 ? '0' : String(idx);
        }
        case 'bool':
            return v ? '1.0' : '0.0';
        case 'float':
            return fmtNumber(Number(v) || 0);
        default:
            return '0';
    }
}

function formatEditor(f: UboField): string {
    if (f.param.kind === 'color') return ', editor: { type: color }';
    if (f.param.kind === 'float' && (f.param.min !== undefined || f.param.max !== undefined)) {
        const min = f.param.min ?? 0;
        const max = f.param.max ?? 1;
        const step = f.param.step ?? 0.01;
        return `, editor: { range: [${min}, ${max}], step: ${step} }`;
    }
    return '';
}

function arrayLiteral(v: unknown): string {
    if (!Array.isArray(v)) return '[0.0, 0.0, 0.0, 0.0]';
    return `[${v.map((n) => fmtNumber(Number(n) || 0)).join(', ')}]`;
}

function fmtNumber(n: number): string {
    return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** Convenience: compile and return just the effect text (throws on error). */
export function compileEffectOrThrow(graph: EffectGraph, assetName = 'effect'): string {
    const res = compileEffect(graph, assetName);
    if (res.error) throw new Error(res.error);
    return res.effect;
}
