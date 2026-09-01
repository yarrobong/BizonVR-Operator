import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function loadJson(filename, fallback = {}) {
    try {
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch {
        return fallback;
    }
}

export function saveJson(filename, value, options = {}) {
    ensureDir(path.dirname(filename));
    fs.writeFileSync(filename, JSON.stringify(value, null, 2), options);
}

export function createJsonStore(filename, { fallback = {}, mode = null } = {}) {
    let value = loadJson(filename, fallback);
    const save = () => {
        saveJson(filename, value, mode == null ? {} : { mode });
        if (mode != null) {
            try { fs.chmodSync(filename, mode); } catch {}
        }
    };
    return {
        get() { return value; },
        replace(next) { value = next; save(); return value; },
        save,
        path: filename,
    };
}
