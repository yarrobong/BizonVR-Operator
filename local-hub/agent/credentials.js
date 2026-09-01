import crypto from 'node:crypto';
import { buildAgentCredentialRecord, buildAgentProvisioningResult, createAgentCredential, hashAgentCredential } from '../agent-credentials.js';
import { createJsonStore } from '../storage.js';

export function createAgentCredentialStore(filename) {
    const store = createJsonStore(filename, { fallback: {}, mode: 0o600 });

    function records() {
        return store.get();
    }

    function activate(stableSerial, payload, credential) {
        const current = records();
        current[stableSerial] = buildAgentCredentialRecord(stableSerial, payload, credential, current[stableSerial] || {});
        store.save();
        return current[stableSerial];
    }

    function findMatching(data = {}) {
        const candidates = [data.pairing_id, data.agent_id, data.stable_id, data.android_id].filter(Boolean).map(String);
        if (candidates.length === 0) return null;
        return Object.values(records()).find((entry) => {
            const known = new Set([entry.pairingId, entry.agentId, entry.stableId, entry.androidId].filter(Boolean).map(String));
            return candidates.every((candidate) => known.has(candidate));
        }) || null;
    }

    function verifyToken(record, presented) {
        if (!record || !presented) return false;
        const actual = Buffer.from(hashAgentCredential(presented));
        const expected = Buffer.from(String(record.tokenHash || ''));
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    function markTimestamp(record, timestamp) {
        record.lastTimestamp = timestamp;
        store.save();
    }

    return Object.freeze({
        records,
        create: createAgentCredential,
        activate,
        findMatching,
        verifyToken,
        markTimestamp,
        provisioningResult: buildAgentProvisioningResult,
        getToken(stableSerial) { return records()[stableSerial]?.token || null; },
        getPath() { return store.path; },
    });
}
