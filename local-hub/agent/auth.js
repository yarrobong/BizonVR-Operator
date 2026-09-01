import { buildHeartbeatIdentity } from '../route-selection.js';

export function createAgentAuthenticator({ credentials, heartbeatMaxAgeMs, heartbeatStore, clock = () => Date.now() } = {}) {
    function verify(req, data = {}) {
        const presented = /^Bearer (.+)$/.exec(String(req.headers.authorization || '').trim())?.[1] || '';
        if (!presented) return { ok: false, status: 401 };
        const record = credentials.findMatching(data);
        if (!record || !credentials.verifyToken(record, presented)) return { ok: false, status: 401 };
        if (data.timestamp === undefined) return { ok: false, status: 408 };
        const timestamp = Number(data.timestamp);
        if (!Number.isFinite(timestamp) || Math.abs(clock() - timestamp) > heartbeatMaxAgeMs) return { ok: false, status: 408 };
        if (Number(record.lastTimestamp || 0) >= timestamp) return { ok: false, status: 409 };
        credentials.markTimestamp(record, timestamp);
        return { ok: true, record };
    }

    return Object.freeze({ verify, identity: buildHeartbeatIdentity });
}
