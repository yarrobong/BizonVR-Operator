import http from 'node:http';

function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            totalBytes += Buffer.byteLength(chunk);
            if (totalBytes > maxBytes) { tooLarge = true; chunks.length = 0; return; }
            if (!tooLarge) chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            if (tooLarge) return reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch { reject(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 })); }
        });
        req.on('error', reject);
    });
}

export function createAgentServer({ config, auth, heartbeatStore, routing, cloud, streamDeviceFrames = null, log = () => {} } = {}) {
    function json(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }
    function bodyError(res, error) { json(res, error.statusCode || 400, { error: error.statusCode === 413 ? 'Request body is too large' : 'Malformed JSON body' }); }

    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
        if (req.method === 'GET' && req.url.startsWith('/streams/') && streamDeviceFrames) {
            const streamUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const serial = decodeURIComponent(streamUrl.pathname.replace('/streams/', ''));
            if (!config.DEVICE_SERIAL_REGEX.test(String(serial || ''))) return json(res, 400, { error: 'INVALID_DEVICE_SERIAL', next_step: 'Refresh devices in the panel and retry the cast.' });
            return streamDeviceFrames(req, res, serial, streamUrl.searchParams.get('transport') || config.STREAM_MODE, streamUrl.searchParams.get('profile') || config.STREAM_PROFILE);
        }
        if (req.method !== 'POST' || !['/api/agent/heartbeat', '/api/agent/call_operator'].includes(req.url)) { res.writeHead(404); return res.end('Not Found'); }
        readJsonBody(req, config.AGENT_JSON_BODY_LIMIT).then((data) => {
            const verification = auth.verify(req, data);
            if (!verification.ok) {
                const message = req.url === '/api/agent/heartbeat' ? verification.status === 408 ? 'STALE_HEARTBEAT' : verification.status === 409 ? 'REPLAYED_HEARTBEAT' : 'Invalid Agent credentials' : 'Invalid Agent credentials';
                return json(res, verification.status, { error: message });
            }
            const ip = req.socket.remoteAddress;
            if (req.url === '/api/agent/heartbeat') {
                const id = auth.identity(data);
                if (routing.isIgnoredDevice(data.stable_id || null, data.agent_id || data.pairing_id || null)) return json(res, 200, { success: true, ignored: true });
                if (!id) {
                    log('Heartbeat', 'Rejected heartbeat without stable identity', { ip });
                    return json(res, 400, { error: 'IDENTITY_REQUIRED', message: 'Heartbeat must include agent_id, pairing_id, stable_id, or android_id.' });
                }
                heartbeatStore.record(id, data, ip);
                if (heartbeatStore.shouldLog(id, config.HEARTBEAT_LOG_INTERVAL_MS)) log('Heartbeat', `Agent ${id} heartbeat`, { ip, inSession: Boolean(data.in_session), sessionSeconds: Number(data.session_seconds || 0) });
                return json(res, 200, { success: true });
            }
            const id = auth.identity(data) || 'unknown-agent';
            log('Agent', `Agent ${id} called operator`, { ip });
            void cloud.forwardOperatorCall({ pairing_id: data.pairing_id, hub_id: config.HUB_ID });
            return json(res, 200, { success: true });
        }).catch((error) => bodyError(res, error));
    });
    server.on('error', (error) => log('Local Hub Mini-Server', `Failed to start on port ${config.LOCAL_SERVER_PORT}: ${error.message}`));
    return Object.freeze({ server, readJsonBody });
}
