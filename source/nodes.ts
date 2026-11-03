/**
 * Node catalog (26 types) + GLSL codegen for each implemented node.
 *
 * Pure module: no Node/Editor APIs. Shared by main and panel.
 *
 * A node's emit() returns GLSL statements that assign its OUTPUT port
 * variables (see EmitCtx.outputs). Inputs resolve to either a wired
 * output variable or a type-appropriate default expression.
 */

import { createGraph, addNode } from './graph';
import type { EffectGraph, GraphNode, NodeTypeDef } from './graph';

// ---------------------------------------------------------------------------
// Codegen context
// ---------------------------------------------------------------------------

export interface EmitCtx {
    node: GraphNode;
    /** input port id -> GLSL expression */
    inputs: Map<string, string>;
    /** output port id -> variable name */
    outputs: Map<string, string>;
    /** request a UBO field for a scalar/vector param; returns the field name */
    uniform(key: string, kind: 'float' | 'vec2' | 'vec3' | 'vec4'): string;
    /** request a sampler2D uniform for a texture param; returns the uniform name */
    sampler(key: string): string;
    /** register a shared helper function (deduped by name) */
    helper(name: string, code: string): void;
}

export type EmitFn = (ctx: EmitCtx) => string[];

// ---------------------------------------------------------------------------
// Blend mode enum (subset of the 30 Photoshop-style modes; PLAN.md lists all 30)
// ---------------------------------------------------------------------------

export const BLEND_MODES: string[] = [
    'normal',
    'multiply',
    'screen',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'add',
    'difference',
    'exclusion',
    'soft-light',
    'hard-light',
    'overlay',
    'plus-lighter',
    'subtract',
    'divide',
];

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

interface RawNodeDef extends NodeTypeDef {
    emit?: EmitFn;
}

const C_TEXTURE = '#5b8def';
const C_INPUT = '#7b61ff';
const C_UV = '#22b8a6';
const C_EFFECTS = '#e0553a';
const C_OUTPUT = '#e0a22e';

const pColor: RawNodeDef['params'][number] = { key: 'color', labelKey: 'p.color', kind: 'color', default: [1, 1, 1, 1] };
const pResolution: RawNodeDef['params'][number] = { key: 'resolution', labelKey: 'p.resolution', kind: 'vec2', default: [512, 512] };

const rawDefs: RawNodeDef[] = [
    // ---------------- Texture ----------------
    {
        id: 'texture',
        nameKey: 'node.texture',
        categoryKey: 'cat.texture',
        color: C_TEXTURE,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [{ key: 'texture', labelKey: 'p.texture', kind: 'texture', default: null }],
        emit: (c) => {
            const s = c.sampler('texture');
            return [`${c.outputs.get('color')} = texture(${s}, ${c.inputs.get('uv')});`];
        },
    },
    {
        id: 'gradient',
        nameKey: 'node.gradient',
        categoryKey: 'cat.texture',
        color: C_TEXTURE,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'start', labelKey: 'p.start', kind: 'color', default: [0, 0, 0, 1] },
            { key: 'end', labelKey: 'p.end', kind: 'color', default: [1, 1, 1, 1] },
            { key: 'axis', labelKey: 'p.axis', kind: 'enum', default: 'horizontal', options: ['horizontal', 'vertical', 'radial'] },
        ],
        emit: (c) => {
            const start = c.uniform('start', 'vec4');
            const end = c.uniform('end', 'vec4');
            const axis = c.uniform('axis', 'float');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`float t = ${uv}.x;`);
            lines.push(`if (${axis} > 0.5 && ${axis} < 1.5) { t = ${uv}.y; }`);
            lines.push(`else if (${axis} > 1.5) { t = length(${uv} - vec2(0.5)); }`);
            lines.push(`${out} = mix(${start}, ${end}, clamp(t, 0.0, 1.0));`);
            return lines;
        },
    },
    {
        id: 'noise',
        nameKey: 'node.noise',
        categoryKey: 'cat.texture',
        color: C_TEXTURE,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'scale', labelKey: 'p.scale', kind: 'float', default: 10, min: 0.1, max: 200 },
            { key: 'seed', labelKey: 'p.seed', kind: 'float', default: 0, min: 0, max: 1000 },
        ],
        emit: (c) => {
            c.helper('pTS_noise2', noise2Code);
            const scale = c.uniform('scale', 'float');
            const seed = c.uniform('seed', 'float');
            const out = c.outputs.get('color');
            return [
                `float n = pTS_noise2(${c.inputs.get('uv')} * ${scale} + ${seed});`,
                `${out} = vec4(vec3(n), 1.0);`,
            ];
        },
    },
    {
        id: 'refraction',
        nameKey: 'node.refraction',
        categoryKey: 'cat.texture',
        color: C_TEXTURE,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'amount', labelKey: 'p.refraction_amount', kind: 'float', default: 0.05, min: 0, max: 0.5 },
            { key: 'frequency', labelKey: 'p.frequency', kind: 'float', default: 8, min: 1, max: 64 },
        ],
        emit: (c) => {
            c.helper('pTS_noise2', noise2Code);
            const amount = c.uniform('amount', 'float');
            const freq = c.uniform('frequency', 'float');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            return [
                `vec2 rn = vec2(pTS_noise2(${uv} * ${freq}), pTS_noise2(${uv} * ${freq} + 5.2));`,
                `${out} = pTS_sampleSprite(${uv} + (rn - 0.5) * ${amount});`,
            ];
        },
    },
    {
        id: 'reflection',
        nameKey: 'node.reflection',
        categoryKey: 'cat.texture',
        color: C_TEXTURE,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'strength', labelKey: 'p.strength', kind: 'float', default: 0.6, min: 0, max: 1 },
            { key: 'flip', labelKey: 'p.reflection_flip', kind: 'bool', default: true },
        ],
        emit: (c) => {
            const strength = c.uniform('strength', 'float');
            const flip = c.uniform('flip', 'float');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            return [
                `vec2 ruv = ${uv};`,
                `if (${flip} > 0.5) { ruv.y = 1.0 - ruv.y; }`,
                `vec4 rc = pTS_sampleSprite(ruv);`,
                `${out} = vec4(rc.rgb, rc.a * clamp(1.0 - ruv.y, 0.0, 1.0) * ${strength});`,
            ];
        },
    },
    {
        id: 'shadow',
        nameKey: 'node.shadow',
        categoryKey: 'cat.texture',
        color: C_TEXTURE,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'offset', labelKey: 'p.offset', kind: 'vec2', default: [0.01, -0.01] },
            { key: 'color', labelKey: 'p.color', kind: 'color', default: [0, 0, 0, 0.6] },
            { key: 'radius', labelKey: 'p.radius', kind: 'float', default: 2, min: 0, max: 20 },
            pResolution,
        ],
        emit: (c) => {
            const offset = c.uniform('offset', 'vec2');
            const scolor = c.uniform('color', 'vec4');
            const radius = c.uniform('radius', 'float');
            const res = c.uniform('resolution', 'vec2');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`vec2 stexel = ${radius} / ${res};`);
            lines.push(`float sa = 0.0;`);
            lines.push(`for (int x = -2; x <= 2; x++) {`);
            lines.push(`  for (int y = -2; y <= 2; y++) {`);
            lines.push(`    sa += pTS_sampleSprite(${uv} + ${offset} + vec2(float(x), float(y)) * stexel).a;`);
            lines.push(`  }`);
            lines.push(`}`);
            lines.push(`sa /= 25.0;`);
            lines.push(`${out} = vec4(${scolor}.rgb, ${scolor}.a * sa);`);
            return lines;
        },
    },

    // ---------------- Input ----------------
    {
        id: 'solid_color',
        nameKey: 'node.solid_color',
        categoryKey: 'cat.input',
        color: C_INPUT,
        inputs: [],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [pColor],
        emit: (c) => {
            const col = c.uniform('color', 'vec4');
            return [`${c.outputs.get('color')} = ${col};`];
        },
    },
    {
        id: 'coordinate',
        nameKey: 'node.coordinate',
        categoryKey: 'cat.input',
        color: C_INPUT,
        inputs: [],
        outputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        params: [],
        emit: (c) => [`${c.outputs.get('uv')} = uv0;`],
    },
    {
        id: 'time',
        nameKey: 'node.time',
        categoryKey: 'cat.input',
        color: C_INPUT,
        inputs: [],
        outputs: [{ id: 'value', type: 'float', labelKey: 'port.value' }],
        params: [],
        emit: (c) => [`${c.outputs.get('value')} = cc_time.x;`],
    },
    {
        id: 'constant',
        nameKey: 'node.constant',
        categoryKey: 'cat.input',
        color: C_INPUT,
        inputs: [],
        outputs: [{ id: 'value', type: 'float', labelKey: 'port.value' }],
        params: [{ key: 'value', labelKey: 'p.value', kind: 'float', default: 0, min: -100, max: 100 }],
        emit: (c) => {
            const v = c.uniform('value', 'float');
            return [`${c.outputs.get('value')} = ${v};`];
        },
    },
    {
        id: 'param_relay',
        nameKey: 'node.param_relay',
        categoryKey: 'cat.input',
        color: C_INPUT,
        inputs: [],
        outputs: [{ id: 'value', type: 'float', labelKey: 'port.value' }],
        params: [{ key: 'value', labelKey: 'p.value', kind: 'float', default: 0, min: -100, max: 100 }],
        emit: (c) => {
            const v = c.uniform('value', 'float');
            return [`${c.outputs.get('value')} = ${v};`];
        },
    },

    // ---------------- UV ----------------
    {
        id: 'uv_offset',
        nameKey: 'node.uv_offset',
        categoryKey: 'cat.uv',
        color: C_UV,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        params: [
            { key: 'offset', labelKey: 'p.offset', kind: 'vec2', default: [0, 0] },
            { key: 'speed', labelKey: 'p.speed', kind: 'vec2', default: [0, 0] },
        ],
        emit: (c) => {
            const off = c.uniform('offset', 'vec2');
            const speed = c.uniform('speed', 'vec2');
            return [`${c.outputs.get('uv')} = ${c.inputs.get('uv')} + ${off} + cc_time.w * ${speed};`];
        },
    },
    {
        id: 'uv_remap',
        nameKey: 'node.uv_remap',
        categoryKey: 'cat.uv',
        color: C_UV,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        params: [
            { key: 'scale', labelKey: 'p.scale', kind: 'vec2', default: [1, 1] },
            { key: 'offset', labelKey: 'p.offset', kind: 'vec2', default: [0, 0] },
        ],
        emit: (c) => {
            const scale = c.uniform('scale', 'vec2');
            const off = c.uniform('offset', 'vec2');
            return [`${c.outputs.get('uv')} = ${c.inputs.get('uv')} * ${scale} + ${off};`];
        },
    },
    {
        id: 'distort',
        nameKey: 'node.distort',
        categoryKey: 'cat.uv',
        color: C_UV,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        params: [
            { key: 'strength', labelKey: 'p.strength', kind: 'float', default: 0.1, min: 0, max: 1 },
            { key: 'frequency', labelKey: 'p.frequency', kind: 'float', default: 5, min: 0, max: 100 },
            { key: 'speed', labelKey: 'p.speed', kind: 'float', default: 0, min: 0, max: 20 },
        ],
        emit: (c) => {
            c.helper('pTS_noise2', noise2Code);
            const strength = c.uniform('strength', 'float');
            const freq = c.uniform('frequency', 'float');
            const speed = c.uniform('speed', 'float');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('uv');
            return [
                `vec2 d = vec2(pTS_noise2(${uv} * ${freq} + cc_time.w * ${speed}), pTS_noise2(${uv} * ${freq} + 7.13 + cc_time.w * ${speed}));`,
                `${out} = ${uv} + (d - 0.5) * ${strength};`,
            ];
        },
    },

    // ---------------- Effects ----------------
    {
        id: 'alpha_anim',
        nameKey: 'node.alpha_anim',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [{ key: 'speed', labelKey: 'p.speed', kind: 'float', default: 2, min: 0, max: 20 }],
        emit: (c) => {
            const speed = c.uniform('speed', 'float');
            return [`${c.outputs.get('color')} = vec4(${c.inputs.get('color')}.rgb, ${c.inputs.get('color')}.a * (0.5 + 0.5 * sin(cc_time.x * ${speed})));`];
        },
    },
    {
        id: 'mask',
        nameKey: 'node.mask',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [
            { id: 'color', type: 'color', labelKey: 'port.color' },
            { id: 'mask', type: 'color', labelKey: 'port.mask' },
        ],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [{ key: 'invert', labelKey: 'p.invert', kind: 'bool', default: false }],
        emit: (c) => {
            const inv = c.uniform('invert', 'float');
            const color = c.inputs.get('color');
            const mask = c.inputs.get('mask');
            const out = c.outputs.get('color');
            return [
                `float m = ${inv} > 0.5 ? 1.0 - ${mask}.a : ${mask}.a;`,
                `${out} = vec4(${color}.rgb, ${color}.a * m);`,
            ];
        },
    },
    {
        id: 'blur',
        nameKey: 'node.blur',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'radius', labelKey: 'p.radius', kind: 'float', default: 2, min: 0, max: 20 },
            pResolution,
        ],
        emit: (c) => {
            c.helper('pTS_sampleSprite', sampleSpriteCode);
            const radius = c.uniform('radius', 'float');
            const res = c.uniform('resolution', 'vec2');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`vec2 texel = ${radius} / ${res};`);
            lines.push(`vec4 sum = vec4(0.0); float wsum = 0.0;`);
            lines.push(`for (int x = -2; x <= 2; x++) {`);
            lines.push(`  for (int y = -2; y <= 2; y++) {`);
            lines.push(`    sum += pTS_sampleSprite(${uv} + vec2(float(x), float(y)) * texel); wsum += 1.0;`);
            lines.push(`  }`);
            lines.push(`}`);
            lines.push(`${out} = sum / wsum;`);
            return lines;
        },
    },
    {
        id: 'pixelate',
        nameKey: 'node.pixelate',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        params: [{ key: 'grid', labelKey: 'p.grid', kind: 'float', default: 16, min: 1, max: 256 }],
        emit: (c) => {
            const grid = c.uniform('grid', 'float');
            const uv = c.inputs.get('uv');
            return [`${c.outputs.get('uv')} = floor(${uv} * ${grid}) / ${grid} + (0.5 / ${grid});`];
        },
    },
    {
        id: 'sprite_sheet',
        nameKey: 'node.sprite_sheet',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        params: [
            { key: 'columns', labelKey: 'p.columns', kind: 'float', default: 4, min: 1, max: 32 },
            { key: 'rows', labelKey: 'p.rows', kind: 'float', default: 4, min: 1, max: 32 },
            { key: 'fps', labelKey: 'p.fps', kind: 'float', default: 12, min: 0, max: 60 },
            { key: 'loop', labelKey: 'p.wrap', kind: 'bool', default: true },
        ],
        emit: (c) => {
            const cols = c.uniform('columns', 'float');
            const rows = c.uniform('rows', 'float');
            const fps = c.uniform('fps', 'float');
            const loop = c.uniform('loop', 'float');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('uv');
            const lines: string[] = [];
            lines.push(`float totalFrames = ${cols} * ${rows};`);
            lines.push(`float frame = ${loop} > 0.5 ? mod(floor(cc_time.x * ${fps}), totalFrames) : min(floor(cc_time.x * ${fps}), totalFrames - 1.0);`);
            lines.push(`float cx = mod(frame, ${cols});`);
            lines.push(`float cy = floor(frame / ${cols});`);
            lines.push(`${out} = (${uv} + vec2(cx, cy)) / vec2(${cols}, ${rows});`);
            return lines;
        },
    },
    {
        id: 'mixer',
        nameKey: 'node.mixer',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [
            { id: 'colorA', type: 'color', labelKey: 'port.colorA' },
            { id: 'colorB', type: 'color', labelKey: 'port.colorB' },
        ],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'blend', labelKey: 'p.blend', kind: 'enum', default: 'normal', options: BLEND_MODES },
            { key: 'amount', labelKey: 'p.amount', kind: 'float', default: 1, min: 0, max: 1 },
        ],
        emit: (c) => {
            c.helper('pTS_blendColor', blendColorCode);
            const blend = c.uniform('blend', 'float');
            const amount = c.uniform('amount', 'float');
            const a = c.inputs.get('colorA');
            const b = c.inputs.get('colorB');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`vec3 bc = pTS_blendColor(${blend}, ${a}.rgb, ${b}.rgb);`);
            lines.push(`${out} = vec4(mix(${a}.rgb, bc, ${amount}), mix(${a}.a, ${b}.a, ${amount}));`);
            return lines;
        },
    },
    {
        id: 'dissolve',
        nameKey: 'node.dissolve',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'threshold', labelKey: 'p.threshold', kind: 'float', default: 0.5, min: 0, max: 1 },
            { key: 'softness', labelKey: 'p.softness', kind: 'float', default: 0.1, min: 0, max: 1 },
            { key: 'seed', labelKey: 'p.seed', kind: 'float', default: 0, min: 0, max: 1000 },
        ],
        emit: (c) => {
            c.helper('pTS_noise2', noise2Code);
            const th = c.uniform('threshold', 'float');
            const soft = c.uniform('softness', 'float');
            const seed = c.uniform('seed', 'float');
            const color = c.inputs.get('color');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`float dn = pTS_noise2(uv0 * 5.0 + ${seed});`);
            lines.push(`float df = smoothstep(${th} - ${soft}, ${th} + ${soft}, dn);`);
            lines.push(`${out} = vec4(${color}.rgb, ${color}.a * df);`);
            return lines;
        },
    },
    {
        id: 'glow',
        nameKey: 'node.glow',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'radius', labelKey: 'p.radius', kind: 'float', default: 4, min: 0, max: 20 },
            { key: 'intensity', labelKey: 'p.intensity', kind: 'float', default: 1, min: 0, max: 5 },
            pResolution,
        ],
        emit: (c) => {
            c.helper('pTS_sampleSprite', sampleSpriteCode);
            const radius = c.uniform('radius', 'float');
            const intensity = c.uniform('intensity', 'float');
            const res = c.uniform('resolution', 'vec2');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`vec2 gtexel = ${radius} / ${res};`);
            lines.push(`vec4 gsum = vec4(0.0);`);
            lines.push(`for (int x = -3; x <= 3; x++) {`);
            lines.push(`  for (int y = -3; y <= 3; y++) {`);
            lines.push(`    gsum += pTS_sampleSprite(${uv} + vec2(float(x), float(y)) * gtexel);`);
            lines.push(`  }`);
            lines.push(`}`);
            lines.push(`${out} = pTS_sampleSprite(${uv}) + (gsum / 49.0) * ${intensity};`);
            return lines;
        },
    },
    {
        id: 'outline',
        nameKey: 'node.outline',
        categoryKey: 'cat.effects',
        color: C_EFFECTS,
        inputs: [{ id: 'uv', type: 'vec2', labelKey: 'port.uv' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'width', labelKey: 'p.width', kind: 'float', default: 2, min: 0, max: 20 },
            { key: 'color', labelKey: 'p.color', kind: 'color', default: [0, 0, 0, 1] },
            pResolution,
        ],
        emit: (c) => {
            c.helper('pTS_sampleSprite', sampleSpriteCode);
            const width = c.uniform('width', 'float');
            const ocolor = c.uniform('color', 'vec4');
            const res = c.uniform('resolution', 'vec2');
            const uv = c.inputs.get('uv');
            const out = c.outputs.get('color');
            const lines: string[] = [];
            lines.push(`vec2 otexel = ${width} / ${res};`);
            lines.push(`float ca = pTS_sampleSprite(${uv}).a;`);
            lines.push(`float oa = ca;`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(1.0, 0.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(-1.0, 0.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(0.0, 1.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(0.0, -1.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(1.0, 1.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(-1.0, 1.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(1.0, -1.0) * otexel).a);`);
            lines.push(`oa = max(oa, pTS_sampleSprite(${uv} + vec2(-1.0, -1.0) * otexel).a);`);
            lines.push(`float of = clamp(oa - ca, 0.0, 1.0);`);
            lines.push(`${out} = mix(pTS_sampleSprite(${uv}), ${ocolor}, of);`);
            return lines;
        },
    },

    // ---------------- Output ----------------
    {
        id: 'output',
        nameKey: 'node.output',
        categoryKey: 'cat.output',
        color: C_OUTPUT,
        inputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        outputs: [],
        params: [{ key: 'alpha', labelKey: 'p.alpha', kind: 'float', default: 1, min: 0, max: 1 }],
        emit: (c) => {
            const alpha = c.uniform('alpha', 'float');
            return [`o = ${c.inputs.get('color')} * ${alpha};`];
        },
    },
    {
        id: 'code',
        nameKey: 'node.code',
        categoryKey: 'cat.output',
        color: C_OUTPUT,
        inputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [{ key: 'code', labelKey: 'p.code', kind: 'string', default: '' }],
        emit: (c) => {
            const code = String(c.node.params.code ?? '').trim();
            const out = c.outputs.get('color');
            // Block scope avoids `_in` collisions across multiple Code nodes.
            return [
                `{`,
                `  vec4 _in = ${c.inputs.get('color')};`,
                code ? `  ${out} = (${code});` : `  ${out} = _in;`,
                `}`,
            ];
        },
    },
    {
        id: 'parallax',
        nameKey: 'node.parallax',
        categoryKey: 'cat.output',
        color: C_OUTPUT,
        inputs: [
            { id: 'uv', type: 'vec2', labelKey: 'port.uv' },
            { id: 'depth', type: 'float', labelKey: 'port.depth' },
        ],
        outputs: [{ id: 'color', type: 'color', labelKey: 'port.color' }],
        params: [
            { key: 'tilt', labelKey: 'p.tilt', kind: 'float', default: 0.05, min: 0, max: 0.5 },
            { key: 'strength', labelKey: 'p.strength', kind: 'float', default: 1, min: 0, max: 2 },
        ],
        emit: (c) => {
            const tilt = c.uniform('tilt', 'float');
            const strength = c.uniform('strength', 'float');
            const uv = c.inputs.get('uv');
            const depth = c.inputs.get('depth');
            const out = c.outputs.get('color');
            return [
                `vec2 pdir = vec2(1.0, 0.0);`,
                `${out} = pTS_sampleSprite(${uv} + pdir * ${depth} * ${tilt} * ${strength});`,
            ];
        },
    },
];

// ---------------------------------------------------------------------------
// Shared GLSL helpers
// ---------------------------------------------------------------------------

export const sampleSpriteCode = `vec4 pTS_sampleSprite(vec2 uv) {
  vec4 col = CCSampleWithAlphaSeparated(cc_spriteTexture, uv);
  #if CC_USE_ALPHA_ATLAS_TEXTURE
    col.a *= CCSampleWithAlphaSeparated(cc_spriteTexture, uv + vec2(0.0, 0.5)).r;
  #endif
  return col;
}`;

const noise2Code = `float pTS_hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float pTS_noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = pTS_hash(i);
  float b = pTS_hash(i + vec2(1.0, 0.0));
  float c = pTS_hash(i + vec2(0.0, 1.0));
  float d = pTS_hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

const blendColorCode = `vec3 pTS_blendColor(float mode, vec3 a, vec3 b) {
  if (mode < 0.5) return a;                                  // normal
  if (mode < 1.5) return a * b;                              // multiply
  if (mode < 2.5) return 1.0 - (1.0 - a) * (1.0 - b);        // screen
  if (mode < 3.5) return min(a, b);                          // darken
  if (mode < 4.5) return max(a, b);                          // lighten
  if (mode < 5.5) return b / max(1.0 - a, 0.001);            // color-dodge
  if (mode < 6.5) return 1.0 - (1.0 - b) / max(a, 0.001);    // color-burn
  if (mode < 7.5) return a + b;                              // add
  if (mode < 8.5) return abs(a - b);                         // difference
  if (mode < 9.5) return a + b - 2.0 * a * b;                // exclusion
  if (mode < 10.5) return (1.0 - 2.0 * b) * a * a + 2.0 * b * a;  // soft-light
  if (mode < 11.5) return mix(a * 2.0 * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, b)); // hard-light
  if (mode < 12.5) return mix(a * 2.0 * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); // overlay
  if (mode < 13.5) return min(a + b, 1.0);                   // plus-lighter
  if (mode < 14.5) return max(b - a, 0.0);                   // subtract
  return b / max(a, 0.001);                                  // divide
}`;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const NODE_TYPES: NodeTypeDef[] = rawDefs.map(({ emit, ...def }) => def);

export const NODE_EMIT: Record<string, EmitFn | undefined> = {};
for (const def of rawDefs) {
    NODE_EMIT[def.id] = def.emit;
}

const typeMap = new Map<string, NodeTypeDef>();
for (const def of NODE_TYPES) typeMap.set(def.id, def);

export function getNodeType(id: string): NodeTypeDef | undefined {
    return typeMap.get(id);
}

export function isImplemented(id: string): boolean {
    return typeof NODE_EMIT[id] === 'function';
}

/** Blend mode enum string -> float index (matching pTS_blendColor thresholds). */
export function blendModeIndex(mode: string): number {
    const idx = BLEND_MODES.indexOf(mode);
    return idx < 0 ? 0 : idx;
}

/** A fresh graph containing a single Output node (the safe starting point). */
export function createDefaultGraph(): EffectGraph {
    const graph = createGraph();
    const outputDef = getNodeType('output');
    if (outputDef) addNode(graph, 'output', 480, 320, outputDef);
    return graph;
}
