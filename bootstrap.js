const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pTSRootDir = __dirname;
const pTSNodeModulesPath = path.join(pTSRootDir, 'node_modules');
const pTSMainJsPath = path.join(pTSRootDir, 'dist/main.js');

function pTS_runCmd(cmd, args) {
    const isWin = process.platform === 'win32';
    const resolvedCmd = isWin ? `${cmd}.cmd` : cmd;
    console.log(`[pTS-Effect Bootstrap] Running: ${cmd} ${args.join(' ')}`);
    const result = spawnSync(resolvedCmd, args, { cwd: pTSRootDir, shell: true, stdio: 'inherit' });
    return result.status === 0;
}

if (!fs.existsSync(pTSNodeModulesPath)) {
    const fallbackModules = path.join(pTSRootDir, '../pts-asset/node_modules');
    if (fs.existsSync(fallbackModules)) {
        try {
            fs.symlinkSync(fallbackModules, pTSNodeModulesPath, 'junction');
            console.log('[pTS-Effect Bootstrap] Linked node_modules from pts-asset.');
        } catch (e) {
            pTS_runCmd('npm', ['install']);
        }
    } else {
        pTS_runCmd('npm', ['install']);
    }
}

if (!fs.existsSync(pTSMainJsPath)) {
    console.log('[pTS-Effect Bootstrap] dist/main.js not found. Auto-building...');
    const tscBin = path.join(pTSRootDir, 'node_modules/typescript/bin/tsc');
    if (fs.existsSync(tscBin)) {
        spawnSync(process.execPath, [tscBin, '--project', 'tsconfig.json'], { cwd: pTSRootDir, stdio: 'inherit' });
    } else {
        pTS_runCmd('npm', ['run', 'build']);
    }
}

let pTSMainModule = null;

function pTS_loadMain() {
    if (fs.existsSync(pTSMainJsPath)) {
        try {
            pTSMainModule = require(pTSMainJsPath);
        } catch (err) {
            console.error('[pTS-Effect Bootstrap] Failed to require dist/main.js:', err);
        }
    }
}

function pTS_reloadMain() {
    console.log('[pTS-Effect Bootstrap] Hot-reloading dist/main.js...');
    try {
        if (pTSMainModule && typeof pTSMainModule.unload === 'function') {
            pTSMainModule.unload();
        }
    } catch (e) {}
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes('pts-effect')) {
                delete require.cache[key];
            }
        }
        pTS_loadMain();
        if (pTSMainModule && typeof pTSMainModule.load === 'function') {
            pTSMainModule.load();
        }
        console.log('[pTS-Effect Bootstrap] Hot-reload complete!');
    } catch (err) {
        console.error('[pTS-Effect Bootstrap] Failed to reload dist/main.js:', err);
    }
}

pTS_loadMain();

exports.load = function() {
    if (pTSMainModule && typeof pTSMainModule.load === 'function') {
        return pTSMainModule.load();
    }
};

exports.unload = function() {
    if (pTSMainModule && typeof pTSMainModule.unload === 'function') {
        return pTSMainModule.unload();
    }
};

exports.methods = new Proxy({}, {
    get(target, prop) {
        if (prop === 'reload') {
            return async function(...args) {
                pTS_reloadMain();
                if (pTSMainModule && pTSMainModule.methods && pTSMainModule.methods.reload) {
                    return pTSMainModule.methods.reload(...args);
                }
            };
        }
        if (pTSMainModule && pTSMainModule.methods && pTSMainModule.methods[prop]) {
            return pTSMainModule.methods[prop];
        }
        return undefined;
    },
    has(target, prop) {
        return prop === 'reload' || !!(pTSMainModule && pTSMainModule.methods && prop in pTSMainModule.methods);
    }
});
