/**
 * Graph -> standard Cocos `.effect` compiler.
 *
 * Pure module (no Node/Editor APIs). Compiles the node graph into a
 * single-pass 2D sprite fragment shader using the same structure as the
 * project's hand-written sprite effects (outline.effect, glow.effect, ...).
 */

import { topoSort, findInputLink, encodeGraphComment } from './graph';
import type { EffectGraph, GraphNode, GraphPort, GraphProperty, PortType, NodeParamDef } from './graph';
import { getNodeType, getNodeTypeForNode, NODE_EMIT, sampleSpriteCode } from './nodes';
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
    private properties: Map<string, GraphProperty>;

    constructor(node: GraphNode, inputs: Map<string, string>, outputs: Map<string, string>, state: CodegenState) {
        this.node = node;
        this.inputs = inputs;
        this.outputs = outputs;
        this.fields = state.fields;
        this.samplers = state.samplers;
        this.helpers = state.helpers;
        this.properties = state.properties;
    }

    uniform(key: string, kind: 'float' | 'vec2' | 'vec3' | 'vec4'): string {
        const def = this.paramDef(key);
        const name = `u_${this.node.id}_${key}`;
        if (this.fields.some((f) => f.name === name && f.nodeId === '')) {
            throw new Error(`Blackboard reference "${name}" collides with a generated uniform.`);
        }
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
        if (Array.from(this.properties.values()).some((p) => p.name === name)) {
            throw new Error(`Blackboard reference "${name}" collides with a generated sampler.`);
        }
        if (!this.samplers.some((s) => s.name === name)) {
            this.samplers.push({ name, value: null });
        }
        return name;
    }

    property(): string {
        const property = this.properties.get(String(this.node.params.propertyId));
        if (!property) throw new Error('Blackboard property is missing.');
        return property.type === 'vec3' ? `${property.name}.xyz` : property.name;
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
    properties: Map<string, GraphProperty>;
}

const DEFAULT_EXPR: Record<PortType, string> = {
    color: 'vec4(1.0)',
    vec3: 'vec3(0.0)',
    vec4: 'vec4(0.0)',
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
        case 'vec3':
            return 'vec3';
        case 'vec4':
            return 'vec4';
        case 'float':
            return 'float';
    }
}

const GLSL_RESERVED = new Set(('attribute const uniform varying buffer shared coherent volatile restrict readonly writeonly ' +
    'layout centroid flat smooth noperspective break continue do for while switch case default if else in out inout ' +
    'float double int void bool true false invariant discard return mat2 mat3 mat4 vec2 vec3 vec4 ivec2 ivec3 ivec4 ' +
    'bvec2 bvec3 bvec4 uint uvec2 uvec3 uvec4 lowp mediump highp precision struct sampler2D sampler3D samplerCube ' +
    'common partition active asm class union enum typedef template this packed resource goto inline noinline public static ' +
    'extern external interface long short half fixed unsigned input output').split(' '));

function validateSignature(inputs: unknown, outputs: unknown, description: string, sharedNames = false): { inputs: GraphPort[]; outputs: GraphPort[] } {
    const names = new Set<string>();
    const validate = (value: unknown): GraphPort[] => {
        if (!Array.isArray(value)) throw new Error(`${description} ports must be arrays.`);
        const ids = new Set<string>();
        for (const port of value) {
            if (!port || typeof port.id !== 'string' || !port.id || ids.has(port.id)) {
                throw new Error(`${description} has an invalid or duplicate port id.`);
            }
            if (typeof port.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(port.name) ||
                port.name.startsWith('gl_') || port.name.includes('__') || GLSL_RESERVED.has(port.name) || names.has(port.name)) {
                throw new Error(`${description} has an invalid or duplicate GLSL port name "${port.name}".`);
            }
            if (!['float', 'vec2', 'vec3', 'vec4', 'color', 'texture'].includes(port.type)) {
                throw new Error(`${description} has an invalid type for "${port.name}".`);
            }
            ids.add(port.id);
            names.add(port.name);
        }
        return value as GraphPort[];
    };
    const validatedInputs = validate(inputs);
    if (!sharedNames) names.clear();
    return { inputs: validatedInputs, outputs: validate(outputs) };
}

function samePorts(a: GraphPort[], b: GraphPort[]): boolean {
    return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.name === b[i].name && p.type === b[i].type);
}

interface ValidatedGraph {
    nodes: Map<string, GraphNode>;
    properties: Map<string, GraphProperty>;
    order: string[];
    output?: GraphNode;
}

function validateGraph(graph: EffectGraph, standalone: boolean, dependencies: Record<string, EffectGraph>,
    stack: Set<string>, allProperties: Map<string, GraphProperty>, validated: Map<EffectGraph, ValidatedGraph>): ValidatedGraph {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
        throw new Error('Invalid graph: nodes and links must be arrays.');
    }
    if (graph.properties !== undefined && !Array.isArray(graph.properties)) throw new Error('Invalid blackboard: properties must be an array.');
    if (standalone && !graph.interface) throw new Error('Subgraph interface is missing.');
    if (graph.interface !== undefined && (!graph.interface || typeof graph.interface !== 'object')) throw new Error('Invalid subgraph interface.');
    const signature = graph.interface && validateSignature(graph.interface.inputs, graph.interface.outputs, 'Subgraph interface');
    const properties = new Map<string, GraphProperty>();
    const propertyNames = new Set<string>();
    for (const property of graph.properties ?? []) {
        if (!property || typeof property.id !== 'string' || !property.id || properties.has(property.id)) throw new Error('Invalid or duplicate blackboard property id.');
        if (typeof property.name !== 'string' || !/^u_bb_[A-Za-z][A-Za-z0-9_]*$/.test(property.name)) throw new Error(`Invalid blackboard reference "${property.name}".`);
        if (propertyNames.has(property.name)) throw new Error(`Duplicate blackboard reference "${property.name}".`);
        const lengths: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4, color: 4 };
        if (property.type === 'float') {
            if (typeof property.value !== 'number' || !Number.isFinite(property.value)) throw new Error(`Invalid default for "${property.name}".`);
        } else if (property.type === 'texture') {
            if (!['white', 'grey'].includes(property.value as string)) throw new Error(`Invalid texture default for "${property.name}".`);
        } else if (!(property.type in lengths) || !Array.isArray(property.value) || property.value.length !== lengths[property.type] ||
            !property.value.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`Invalid type or default for "${property.name}".`);
        const previous = allProperties.get(property.name);
        if (previous && (previous.type !== property.type || JSON.stringify(previous.value) !== JSON.stringify(property.value))) {
            throw new Error(`Conflicting blackboard property "${property.name}" in subgraph.`);
        }
        allProperties.set(property.name, property);
        properties.set(property.id, property);
        propertyNames.add(property.name);
    }
    const nodes = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
        if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(node.id) ||
            typeof node.type !== 'string' || !node.type || !node.params || typeof node.params !== 'object' || Array.isArray(node.params)) {
            throw new Error('Invalid graph node: each node needs a shader-safe id, type, and params object.');
        }
        if (nodes.has(node.id)) throw new Error(`Duplicate node id "${node.id}".`);
        nodes.set(node.id, node);
        if (!getNodeTypeForNode(node, graph) || (!NODE_EMIT[node.type] &&
            !['subgraph', 'subgraph_input', 'subgraph_output', 'custom_function'].includes(node.type))) {
            throw new Error(`Node "${node.id}" has unknown or unsupported type "${node.type}".`);
        }
        if (node.type.startsWith('property_')) {
            const property = properties.get(String(node.params.propertyId));
            if (!property) throw new Error(`Node "${node.id}" references a missing blackboard property.`);
            if (node.type !== `property_${property.type}`) throw new Error(`Node "${node.id}" has the wrong type for "${property.name}".`);
        }
        if (node.type === 'subgraph_input' || node.type === 'subgraph_output') {
            if (!standalone || !signature) throw new Error(`Node "${node.id}" is only valid in a subgraph.`);
            const ports = node.type === 'subgraph_input' ? signature.inputs : signature.outputs;
            if (!ports.some((p) => p.id === node.params.portId)) throw new Error(`Node "${node.id}" references a missing interface port.`);
        }
        if (node.type === 'custom_function') {
            validateSignature(node.params.inputs, node.params.outputs, `Custom function "${node.id}"`, true);
            if (typeof node.params.code !== 'string') throw new Error(`Custom function "${node.id}" requires a GLSL body.`);
        }
        if (node.type === 'subgraph') {
            const snapshot = validateSignature(node.params.inputs, node.params.outputs, `Subgraph node "${node.id}"`);
            const uuid = node.params.assetUuid;
            if (typeof uuid !== 'string' || !uuid || !Object.prototype.hasOwnProperty.call(dependencies, uuid) || !dependencies[uuid]) {
                throw new Error(`Node "${node.id}" references missing subgraph dependency "${String(uuid)}".`);
            }
            if (stack.has(uuid)) throw new Error(`Subgraph dependency cycle detected at "${uuid}".`);
            const dependency = dependencies[uuid];
            if (!dependency.interface) throw new Error(`Subgraph dependency "${uuid}" has no interface.`);
            const actual = validateSignature(dependency.interface.inputs, dependency.interface.outputs, `Subgraph "${uuid}" interface`);
            if (!samePorts(snapshot.inputs, actual.inputs) || !samePorts(snapshot.outputs, actual.outputs)) throw new Error(`Subgraph node "${node.id}" signature does not match dependency "${uuid}".`);
            stack.add(uuid);
            validateGraph(dependency, true, dependencies, stack, allProperties, validated);
            stack.delete(uuid);
        }
    }
    const outputs = graph.nodes.filter((n) => n.type === 'output');
    if (standalone) {
        if (outputs.length) throw new Error('A subgraph cannot contain an Output node.');
        for (const port of signature!.outputs) {
            const count = graph.nodes.filter((n) => n.type === 'subgraph_output' && n.params.portId === port.id).length;
            if (count !== 1) throw new Error(`Subgraph output "${port.name}" requires exactly one output node; found ${count}.`);
        }
    } else if (outputs.length !== 1) throw new Error(`Graph must have exactly one Output node; found ${outputs.length}.`);
    const connectedInputs = new Set<string>();
    for (const link of graph.links) {
        if (!link || !link.from || !link.to || typeof link.from.node !== 'string' || typeof link.from.port !== 'string' ||
            typeof link.to.node !== 'string' || typeof link.to.port !== 'string') throw new Error('Invalid link: each link needs source and destination node and port ids.');
        const description = `${link.from.node}.${link.from.port} -> ${link.to.node}.${link.to.port}`;
        const source = nodes.get(link.from.node);
        const target = nodes.get(link.to.node);
        if (!source || !target) throw new Error(`Invalid link ${description}: node not found.`);
        const from = getNodeTypeForNode(source, graph)!.outputs.find((p) => p.id === link.from.port);
        const to = getNodeTypeForNode(target, graph)!.inputs.find((p) => p.id === link.to.port);
        if (!from || !to) throw new Error(`Invalid link ${description}: output or input port not found.`);
        if (from.type !== to.type) throw new Error(`Invalid link ${description}: type mismatch (${from.type} -> ${to.type}).`);
        const key = JSON.stringify([link.to.node, link.to.port]);
        if (connectedInputs.has(key)) throw new Error(`Invalid link ${description}: input already connected.`);
        connectedInputs.add(key);
    }
    const result = { nodes, properties, order: topoSort(graph), output: outputs[0] };
    validated.set(graph, result);
    return result;
}

function compileGraph(graph: EffectGraph, assetName: string, dependencies: Record<string, EffectGraph>, standalone: boolean, assetUuid?: string): CompileResult {
    const warnings: string[] = [];
    try {
        const allProperties = new Map<string, GraphProperty>();
        const validated = new Map<EffectGraph, ValidatedGraph>();
        const root = validateGraph(graph, standalone, dependencies, new Set(assetUuid ? [assetUuid] : []), allProperties, validated);
        const state: CodegenState = { fields: [], samplers: [], helpers: new Map(), properties: root.properties };
        for (const property of allProperties.values()) {
            if (property.type === 'texture') state.samplers.push({ name: property.name, value: property.value });
            else state.fields.push({
                name: property.name, glslType: property.type === 'color' || property.type === 'vec3' ? 'vec4' : property.type,
                param: { key: property.name, labelKey: property.name, kind: property.type, default: property.value },
                value: property.value, nodeId: '',
            });
        }
        state.helpers.set('pTS_sampleSprite', sampleSpriteCode);
        const usedIds = new Set(graph.nodes.map((n) => n.id));
        let nodeCounter = 0;
        let variableCounter = 0;
        let functionCounter = 0;
        const emitGraph = (current: EffectGraph, info: ValidatedGraph, bindings: Map<string, string>, results: Map<string, string>, nested: boolean): string[] => {
            const roots = current.nodes.filter((n) => n.type === (info.output ? 'output' : 'subgraph_output'));
            const reachable = new Set<string>();
            const visit = (id: string): void => {
                if (reachable.has(id)) return;
                reachable.add(id);
                for (const link of current.links) if (link.to.node === id) visit(link.from.node);
            };
            for (const rootNode of roots) visit(rootNode.id);
            const order = info.order.filter((id) => reachable.has(id));
            const vars = new Map<string, Map<string, string>>();
            const lines: string[] = [];
            for (const id of order) {
                const node = info.nodes.get(id)!;
                const ports = new Map<string, string>();
                for (const port of getNodeTypeForNode(node, current)!.outputs) {
                    const name = `pTS_v_${variableCounter++}`;
                    ports.set(port.id, name);
                    lines.push(`${portGlslType(port.type)} ${name};`);
                }
                vars.set(id, ports);
            }
            for (const id of order) {
                const original = info.nodes.get(id)!;
                const type = getNodeTypeForNode(original, current)!;
                const inputs = new Map<string, string>();
                for (const port of type.inputs) {
                    const link = findInputLink(current, id, port.id);
                    inputs.set(port.id, link ? vars.get(link.from.node)!.get(link.from.port)! : defaultInput(original, port.id, port.type));
                }
                const outputs = vars.get(id)!;
                if (original.type === 'subgraph_input') {
                    const port = String(original.params.portId);
                    lines.push(`${outputs.get(port)} = ${bindings.get(port) ?? DEFAULT_EXPR[type.outputs[0].type]};`);
                } else if (original.type === 'subgraph_output') {
                    const port = String(original.params.portId);
                    const result = results.get(port);
                    if (result) lines.push(`${result} = ${inputs.get(port)};`);
                } else if (original.type === 'subgraph') {
                    const child = dependencies[String(original.params.assetUuid)];
                    const childInfo = validated.get(child)!;
                    lines.push('{', ...emitGraph(child, childInfo, inputs, outputs, true).map((line) => `  ${line}`), '}');
                } else if (original.type === 'custom_function') {
                    const signature = validateSignature(original.params.inputs, original.params.outputs, `Custom function "${id}"`, true);
                    const name = `pTS_custom_${functionCounter++}`;
                    const params = [...signature.inputs.map((p) => `in ${portGlslType(p.type)} ${p.name}`),
                        ...signature.outputs.map((p) => `out ${portGlslType(p.type)} ${p.name}`)];
                    state.helpers.set(name, `void ${name}(${params.join(', ')}) {\n${original.params.code}\n}`);
                    lines.push(`${name}(${[...signature.inputs.map((p) => inputs.get(p.id)!), ...signature.outputs.map((p) => outputs.get(p.id)!)].join(', ')});`);
                } else {
                    let node = original;
                    if (nested) {
                        let synthetic: string;
                        do { synthetic = `sg${nodeCounter++}`; } while (usedIds.has(synthetic));
                        usedIds.add(synthetic);
                        node = { ...original, id: synthetic };
                    }
                    state.properties = info.properties;
                    const ctx = new CodegenContext(node, inputs, outputs, state);
                    try {
                        const emitted = NODE_EMIT[node.type]!(ctx).filter(Boolean);
                        if (emitted.length) lines.push('{', ...emitted.map((line) => `  ${line}`), '}');
                    } catch (e) {
                        throw new Error(`Node "${id}" (${node.type}) failed to generate code: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
            return lines;
        };
        const lines = emitGraph(graph, root, new Map(), new Map(), false);
        return { effect: standalone ? '' : assembleEffect(graph, root.output!, lines, state, warnings, assetName), error: null, warnings };
    } catch (e) {
        return { effect: '', error: e instanceof Error ? e.message : String(e), warnings };
    }
}

export function compileEffect(graph: EffectGraph, assetName = 'effect', dependencies: Record<string, EffectGraph> = {}): CompileResult {
    return compileGraph(graph, assetName, dependencies, false);
}

export function validateSubgraph(graph: EffectGraph, dependencies: Record<string, EffectGraph> = {}, assetUuid?: string): string | null {
    return compileGraph(graph, '', dependencies, true, assetUuid).error;
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
        lines.push(`        ${f.name}: { value: ${formatValue(f)}${f.param.kind === 'vec3' && f.nodeId === '' ? `, target: ${f.name}.xyz` : ''}${formatEditor(f)} }`);
    }
    for (const s of state.samplers) {
        const value = typeof s.value === 'string' && ['white', 'grey'].includes(s.value) ? s.value : 'white';
        lines.push(`        ${s.name}: { value: ${value} }`);
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
export function compileEffectOrThrow(graph: EffectGraph, assetName = 'effect', dependencies: Record<string, EffectGraph> = {}): string {
    const res = compileEffect(graph, assetName, dependencies);
    if (res.error) throw new Error(res.error);
    return res.effect;
}
