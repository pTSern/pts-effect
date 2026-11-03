'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-effect-safety-'));
    const file = path.join(dir, 'asset.effect');
    let refreshError = null;
    let importState = { imported: true, invalid: false };
    let createMode = 'success';
    let createdContent = null;
    global.Editor = {
        Message: {
            request: async (_pkg, method, target, content) => {
                if (method === 'refresh-asset' && refreshError) throw new Error(refreshError);
                if (method === 'create-asset') {
                    if (createMode === 'throw') throw new Error('import failed');
                    if (createMode === 'null') return null;
                    createdContent = content;
                    return { uuid: 'created', url: target, ...importState };
                }
                if (method === 'query-asset-info') {
                    if (target === 'db://assets/new-effect.effect') return null;
                    if (target === 'created') return { uuid: 'created', ...importState };
                    return { uuid: 'asset', file, url: 'db://assets/asset.effect', ...importState };
                }
                return null;
            },
            send: () => {},
        },
    };
    const { loadEffect, saveEffect, createEffect } = require('../dist/main');
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
        refreshError = 'refresh failed';
        const refreshFailure = await saveEffect('asset', loaded.graph);
        assert.equal(refreshFailure.ok, false);
        assert.match(refreshFailure.error, /refresh failed/);
        assert.equal(fs.readFileSync(file, 'utf8'), refreshFailure.effect);
        refreshError = null;
        importState = { imported: true, invalid: true };
        const invalidSave = await saveEffect('asset', loaded.graph);
        assert.equal(invalidSave.ok, false);
        assert.match(invalidSave.error, /import failed/);
        assert.equal(fs.readFileSync(file, 'utf8'), invalidSave.effect);
        importState = { imported: false, invalid: false };
        assert.equal((await saveEffect('asset', loaded.graph)).ok, false);
        importState = { imported: true, invalid: false };
        createMode = 'throw';
        assert.match((await createEffect()).error, /import failed/);
        createMode = 'null';
        assert.equal((await createEffect()).ok, false);
        createMode = 'success';
        importState = { imported: true, invalid: true };
        const invalidCreate = await createEffect(undefined, loaded.graph);
        assert.equal(invalidCreate.ok, false);
        assert.match(invalidCreate.error, /import failed/);
        assert.ok(createdContent.includes('CCEffect'));
        importState = { imported: true, invalid: false };
        assert.equal((await createEffect()).ok, true);
        console.log('Effect safety: handwritten file preserved; embedded graph saves and reloads.');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
