export function createHeartbeatStore({ clock = () => Date.now(), staleAfterMs = 30000 } = {}) {
    const heartbeats = {};
    const lastLoggedAtByAgent = {};

    function findForRoute(route = {}) {
        return Object.values(heartbeats).find((heartbeat) => {
            if (route.agentId && (heartbeat.agent_id === route.agentId || heartbeat.pairing_id === route.agentId)) return true;
            if (!route.agentId && route.stableSerial && heartbeat.stable_id === route.stableSerial) return true;
            if (!route.agentId && route.androidId && heartbeat.android_id === route.androidId) return true;
            return false;
        }) || null;
    }

    function record(id, data, ip) {
        heartbeats[id] = {
            ...data,
            agent_id: data.agent_id || data.pairing_id || null,
            ip,
            local_ip: data.local_ip || null,
            app_version: data.app_version || null,
            last_seen: clock(),
        };
        return heartbeats[id];
    }

    function prune() {
        const now = clock();
        for (const [key, heartbeat] of Object.entries(heartbeats)) {
            if (now - heartbeat.last_seen > staleAfterMs) delete heartbeats[key];
        }
    }

    function forget(id) {
        delete heartbeats[id];
        delete lastLoggedAtByAgent[id];
    }

    return Object.freeze({
        all() { return heartbeats; },
        values() { return Object.values(heartbeats); },
        findForRoute,
        record,
        prune,
        forget,
        shouldLog(id, intervalMs) {
            const last = Number(lastLoggedAtByAgent[id] || 0);
            const now = clock();
            if ((now - last) < intervalMs) return false;
            lastLoggedAtByAgent[id] = now;
            return true;
        },
    });
}
