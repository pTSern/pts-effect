/**
 * Codegen regression tests for generated text and graph validation.
 * These checks do not compile or import shaders in Cocos.
 *
 * Run: node scripts/test-codegen.js
 */
const path = require('path');
const { createGraph, addNode, genId, decodeGraphComment } = require('../dist/graph.js');
const { getNodeType, NODE_TYPES, isImplemented, createDefaultGraph } = require('../dist/nodes.js');
const { compileEffect, validateSubgraph } = require('../dist/codegen.js');

let failures = 0;

function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failures += 1;
        console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
}

function node(g, type, x, y) { return addNode(g, type, x, y, getNodeType(type)); }
function link(g, a, ap, b, bp) { g.links.push({ id: genId('l'), from: { node: a.id, port: ap }, to: { node: b.id, port: bp } }); }

function validate(name, graph) {
    const res = compileEffect(graph, name);
    if (res.error) {
        check(`${name}: compile error null`, false, res.error);
        return;
    }
    check(`${name}: compile error null`, true);

    const fs = res.effect.split('CCProgram sprite-fs %{')[1] || '';

    const assigned = new Set([...fs.matchAll(/(pTS_v_\d+)\s*=/g)].map((m) => m[1]));
    const declared = new Set([...fs.matchAll(/(?:vec4|vec3|vec2|float)\s+(pTS_v_\d+)\s*;/g)].map((m) => m[1]));
    const missingDecl = [...assigned].filter((v) => !declared.has(v));
    check(`${name}: output vars declared`, missingDecl.length === 0, missingDecl.join(', '));

    const calls = new Set([...fs.matchAll(/pTS_(\w+)\s*\(/g)].map((m) => m[1]));
    const missingHelper = [...calls].filter((n) => !new RegExp('(vec[234]|float|void|int)\\s+pTS_' + n + '\\s*\\(').test(fs));
    check(`${name}: helpers defined`, missingHelper.length === 0, missingHelper.join(', '));

    // std140: every vec4/vec3 member must precede every vec2/float member.
    const ubo = fs.match(/uniform pTS_EffectParams \{([\s\S]*?)\n  \};/);
    if (ubo) {
        const types = [...ubo[1].matchAll(/^\s*(vec4|vec3|vec2|float)\s+\w+;/gm)].map((m) => m[1]);
        let lastLarge = -1;
        let firstSmall = types.length;
        types.forEach((t, i) => {
            if (t === 'vec4' || t === 'vec3') lastLarge = Math.max(lastLarge, i);
            else if (firstSmall === types.length) firstSmall = i;
        });
        check(`${name}: UBO std140 ordered`, lastLarge < firstSmall, types.join(','));
    }

    // Round-trip the embedded graph.
    const back = decodeGraphComment(res.effect);
    check(`${name}: graph round-trip`, !!back && back.nodes.length === graph.nodes.length && back.links.length === graph.links.length);
}

console.log('pTS-Effect codegen regression test');
console.log('==================================');

validate('default', createDefaultGraph());

const connected = createGraph();
const tex = node(connected, 'texture', 60, 60);
const solid = node(connected, 'solid_color', 60, 200);
const mix = node(connected, 'mixer', 320, 120);
const out = node(connected, 'output', 600, 120);
link(connected, tex, 'color', mix, 'colorA');
link(connected, solid, 'color', mix, 'colorB');
link(connected, mix, 'color', out, 'color');
validate('connected', connected);

const all = createGraph();
let i = 0;
for (const t of NODE_TYPES) {
    if (!isImplemented(t.id) || t.id === 'output' || t.id.startsWith('property_') ||
        ['subgraph', 'subgraph_input', 'subgraph_output', 'custom_function'].includes(t.id)) continue;
    node(all, t.id, 60 + (i % 6) * 260, 60 + Math.floor(i / 6) * 220);
    i++;
}
node(all, 'output', 60, 1600);
validate('all-nodes', all);

// Missing output node must produce a clear error.
const noOut = createGraph();
node(noOut, 'texture', 60, 60);
const errRes = compileEffect(noOut, 'no-output');
check('missing output: error reported', !!errRes.error, errRes.error);

const twoOutputs = createGraph();
node(twoOutputs, 'output', 0, 0);
node(twoOutputs, 'output', 0, 0);
check('multiple outputs rejected', /exactly one Output.*2/.test(compileEffect(twoOutputs).error || ''));

const scoped = createGraph();
const gradientA = node(scoped, 'gradient', 0, 0);
const gradientB = node(scoped, 'gradient', 0, 0);
const blend = node(scoped, 'mixer', 0, 0);
const scopedOut = node(scoped, 'output', 0, 0);
const unused = node(scoped, 'code', 0, 0);
unused.params.code = 'invalid disconnected shader code';
link(scoped, gradientA, 'color', blend, 'colorA');
link(scoped, gradientB, 'color', blend, 'colorB');
link(scoped, blend, 'color', scopedOut, 'color');
const scopedResult = compileEffect(scoped);
check('reachable graph generates', !scopedResult.error, scopedResult.error);
const fragment = (scopedResult.effect.split('CCProgram sprite-fs %{')[1] || '');
const gradientBlocks = [...fragment.matchAll(/\{\s*float t = [\s\S]*?(pTS_v_\d+) = mix\([\s\S]*?\n\s*\}/g)];
check('same-named temporaries have separate node scopes', gradientBlocks.length === 2 &&
    new Set(gradientBlocks.map((m) => m[1])).size === 2);
check('disconnected code is not emitted', !fragment.includes('invalid disconnected shader code'));
check('disconnected output variable is not declared', !fragment.includes(`p_${unused.id}_color`));
check('full graph remains embedded', JSON.stringify(decodeGraphComment(scopedResult.effect)) === JSON.stringify(scoped));

function expectInvalid(name, graph, pattern) {
    const result = compileEffect(graph);
    check(name, !!result.error && pattern.test(result.error) && result.effect === '', result.error);
}
function linkGraph() {
    const graph = createGraph();
    const source = node(graph, 'gradient', 0, 0);
    const target = node(graph, 'output', 0, 0);
    link(graph, source, 'color', target, 'color');
    return { graph, source, target };
}
{
    const { graph } = linkGraph();
    graph.links[0].from.node = 'missing';
    expectInvalid('missing link node rejected', graph, /missing.*node not found/i);
}
{
    const { graph } = linkGraph();
    graph.links[0].from.port = 'missing';
    expectInvalid('missing link port rejected', graph, /missing.*port not found/i);
}
{
    const { graph } = linkGraph();
    const uv = node(graph, 'uv_offset', 0, 0);
    graph.links[0].from = { node: uv.id, port: 'uv' };
    expectInvalid('mismatched port types rejected', graph, /type mismatch.*vec2.*color/i);
}
{
    const { graph, target } = linkGraph();
    const extra = node(graph, 'gradient', 0, 0);
    link(graph, extra, 'color', target, 'color');
    expectInvalid('duplicate input links rejected', graph, /input already connected/i);
}
{
    const graph = createGraph();
    node(graph, 'output', 0, 0);
    const a = node(graph, 'uv_offset', 0, 0);
    const b = node(graph, 'uv_remap', 0, 0);
    link(graph, a, 'uv', b, 'uv');
    link(graph, b, 'uv', a, 'uv');
    expectInvalid('disconnected cycle rejected', graph, /cycle.*node/i);
}
{
    const { graph, source } = linkGraph();
    source.type = 'not-a-real-node';
    expectInvalid('unknown connected node rejected', graph, /unknown or unsupported type.*not-a-real-node/i);
}
{
    const { graph, source } = linkGraph();
    node(graph, 'gradient', 0, 0).id = source.id;
    expectInvalid('duplicate node ids rejected', graph, /duplicate node id/i);
}
{
    const { graph } = linkGraph();
    graph.links.push(null);
    expectInvalid('malformed link rejected', graph, /invalid link/i);
}

{
    const graph = createGraph();
    graph.properties = [{ id: 'shared', name: 'u_bb_Tint', type: 'color', value: [1, 0, 0, 1] }];
    const first = node(graph, 'property_color', 0, 0);
    const second = node(graph, 'property_color', 0, 0);
    first.params.propertyId = second.params.propertyId = 'shared';
    const mixer = node(graph, 'mixer', 0, 0);
    const output = node(graph, 'output', 0, 0);
    link(graph, first, 'value', mixer, 'colorA');
    link(graph, second, 'value', mixer, 'colorB');
    link(graph, mixer, 'color', output, 'color');
    const result = compileEffect(graph);
    check('shared property generates', !result.error, result.error);
    check('shared property has stable material reference', /u_bb_Tint:\s*\{\s*value:\s*\[1\.0,\s*0\.0,\s*0\.0,\s*1\.0\]/.test(result.effect));
    check('shared property survives round-trip', JSON.stringify(decodeGraphComment(result.effect)?.properties) === JSON.stringify(graph.properties));
    graph.properties.push({ ...graph.properties[0], id: 'duplicate' });
    check('duplicate property references rejected', /duplicate blackboard reference/i.test(compileEffect(graph).error || ''));
}

{
    const sub = createGraph();
    sub.interface = {
        inputs: [{ id: 'inColor', name: 'sourceColor', type: 'color' }],
        outputs: [{ id: 'outColor', name: 'resultColor', type: 'color' }],
    };
    const input = node(sub, 'subgraph_input', 0, 0);
    input.params.portId = 'inColor';
    const custom = node(sub, 'custom_function', 0, 0);
    custom.params.inputs = [{ id: 'input', name: 'src', type: 'color' }];
    custom.params.outputs = [{ id: 'output', name: 'dst', type: 'color' }];
    custom.params.code = 'dst = src * 0.5;';
    const output = node(sub, 'subgraph_output', 0, 0);
    output.params.portId = 'outColor';
    link(sub, input, 'inColor', custom, 'input');
    link(sub, custom, 'output', output, 'outColor');
    check('standalone subgraph validates', !validateSubgraph(sub, {}));

    const graph = createGraph();
    const source = node(graph, 'solid_color', 0, 0);
    const first = node(graph, 'subgraph', 0, 0);
    const second = node(graph, 'subgraph', 0, 0);
    for (const instance of [first, second]) {
        instance.params.assetUuid = 'asset-1';
        instance.params.inputs = sub.interface.inputs;
        instance.params.outputs = sub.interface.outputs;
        link(graph, source, 'color', instance, 'inColor');
    }
    const mixer = node(graph, 'mixer', 0, 0);
    const root = node(graph, 'output', 0, 0);
    link(graph, first, 'outColor', mixer, 'colorA');
    link(graph, second, 'outColor', mixer, 'colorB');
    link(graph, mixer, 'color', root, 'color');
    const compiled = compileEffect(graph, 'subgraphs', { 'asset-1': sub });
    check('repeated subgraph instances compile', !compiled.error, compiled.error);
    check('custom functions have distinct namespaced definitions',
        (compiled.effect.match(/void pTS_custom_\d+\(/g) || []).length === 2);
    check('missing subgraph is rejected', /missing subgraph/i.test(compileEffect(graph).error || ''));
    const changed = JSON.parse(JSON.stringify(sub));
    changed.interface.inputs[0].type = 'vec2';
    check('changed subgraph signature is rejected', /signature/i.test(compileEffect(graph, '', { 'asset-1': changed }).error || ''));
    const cyclic = JSON.parse(JSON.stringify(sub));
    const recursive = node(cyclic, 'subgraph', 0, 0);
    recursive.params.assetUuid = 'asset-1';
    recursive.params.inputs = cyclic.interface.inputs;
    recursive.params.outputs = cyclic.interface.outputs;
    check('recursive dependencies are rejected', /cycle/i.test(validateSubgraph(cyclic, { 'asset-1': cyclic }, 'asset-1') || ''));
}

console.log('==================================');
if (failures) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
}
console.log('All codegen checks passed.');
