'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-effect-safety-'));
    const file = path.join(dir, 'asset.effect');
    global.Editor = {
        Message: {
            request: async (_pkg, method) => method === 'query-asset-info'
                ? { uuid: 'asset', file, url: 'db://assets/asset.effect' } : null,
            send: () => {},
        },
    };
    const { loadEffect, saveEffect } = require('../dist/main');
    const { createDefaultGraph } = require('../dist/nodes');
    const { compileEffect } = require('../dist/codegen');
    try {
        const original = 'CCEffect %{\n  techniques: []\n}%\n';
        fs.writeFileSync(file, original);
        assert.equal((await loadEffect('asset')).hasGraph, false);
        assert.equal((await saveEffect('asset', createDefaultGraph())).ok, false);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        const valid = compileEffect(createDefaultGraph()).effect;
        fs.writeFileSync(file, valid);
        const loaded = await loadEffect('asset');
        assert.equal(loaded.hasGraph, true);
        assert.equal((await saveEffect('asset', loaded.graph)).ok, true);
        assert.equal((await loadEffect('asset')).hasGraph, true);
        console.log('Effect safety: handwritten file preserved; embedded graph saves and reloads.');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
