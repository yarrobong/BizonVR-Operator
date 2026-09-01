import http from 'node:http';
import https from 'node:https';

export function createCloudClient({ apiUrl, hubId, hubToken, hubInstanceId = null, timeoutMs = 5000, log = () => {} } = {}) {
    const protocol = apiUrl.startsWith('https') ? https : http;
    const maxResponseBytes = 8 * 1024 * 1024;

    function request(path, { method = 'GET', body = undefined, headers = {}, timeout = timeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
            const requestHeaders = {
                ...(data == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
                ...(hubToken ? { Authorization: `Bearer ${hubToken}` } : {}),
                ...headers,
            };
            const req = protocol.request(`${apiUrl}${path}`, { method, timeout, headers: requestHeaders }, (res) => {
                let response = '';
                let responseBytes = 0;
                let tooLarge = false;
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    responseBytes += Buffer.byteLength(chunk);
                    if (responseBytes > maxResponseBytes) {
                        tooLarge = true;
                        res.destroy(new Error('Cloud response exceeded limit'));
                        return;
                    }
                    response += chunk;
                });
                res.on('end', () => {
                    if (!tooLarge) resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: response });
                });
                res.on('error', (error) => reject(error));
            });
            req.on('timeout', () => req.destroy(new Error('Cloud request timeout')));
            req.on('error', reject);
            if (data != null) req.write(data);
            req.end();
        });
    }

    async function requestJson(path, options = {}) {
        const response = await request(path, options);
        let json = null;
        try { json = JSON.parse(response.body || '{}'); } catch (error) {
            log('Cloud', 'Cloud response was not valid JSON', { path, status: response.statusCode, error: error.message });
        }
        return { ...response, json };
    }

    async function getDevices() {
        return requestJson('/api/devices', { headers: { 'x-hub-id': String(hubId) } });
    }

    async function sync(payload) {
        return requestJson(`/api/hubs/${hubId}/sync`, { method: 'POST', body: payload });
    }

    async function sendCommandStatus(commandId, status, body = {}) {
        try {
            const response = await requestJson(`/api/commands/${commandId}/status`, { method: 'POST', body: { status, ...body, hub_id: hubId, ...(hubInstanceId ? { hub_instance_id: hubInstanceId } : {}) } });
            return response.statusCode >= 200 && response.statusCode < 300;
        } catch (error) {
            log('ResultDelivery', `Cloud status request failed for command ${commandId}`, { error: error.message, status });
            return false;
        }
    }

    async function forwardOperatorCall(data) {
        try {
            await request('/api/hub/call_operator', { method: 'POST', body: data });
        } catch (error) {
            log('Agent', 'Error forwarding call_operator', { error: error.message });
        }
    }

    return Object.freeze({ request, requestJson, getDevices, sync, sendCommandStatus, forwardOperatorCall });
}
