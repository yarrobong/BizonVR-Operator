import { buildAgentComponent, isLoopbackHubHost } from '../config.js';

export function createAgentProvisioning({ config, credentialStore, runAdb, resolveStableSerial, log = () => {} } = {}) {
    async function prepareConnection(deviceSerial) {
        if (isLoopbackHubHost(config.HUB_HOST)) throw new Error('Refusing to pass loopback HUB_HOST to Quest Agent. Set HUB_HOST to a LAN IP reachable from the headset.');
        try {
            await runAdb(['-s', deviceSerial, 'reverse', `tcp:${config.LOCAL_SERVER_PORT}`, `tcp:${config.LOCAL_SERVER_PORT}`]);
            log('ADB', `Reverse tunnel active for ${deviceSerial} on tcp:${config.LOCAL_SERVER_PORT}; using LAN callback ${config.HUB_HOST}:${config.LOCAL_SERVER_PORT}`);
        } catch {
            log('ADB', `Reverse tunnel unavailable for ${deviceSerial}, falling back to hub host ${config.HUB_HOST}:${config.LOCAL_SERVER_PORT}`);
        }
        return { host: config.HUB_HOST, port: Number(config.LOCAL_SERVER_PORT) };
    }

    function buildStartArgs(deviceSerial, options = {}) {
        void prepareConnection(deviceSerial);
        const args = ['-s', deviceSerial, 'shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'com.oculus.intent.category.VR', '-n', buildAgentComponent(config), '--es', 'HUB_IP', config.HUB_HOST, '--ei', 'HUB_PORT', Number(config.LOCAL_SERVER_PORT)];
        const stableSerial = resolveStableSerial(deviceSerial);
        const agentToken = options.agentToken || credentialStore.getToken(stableSerial);
        if (agentToken) args.push('--es', 'AGENT_TOKEN', String(agentToken));
        if (options.action) args.push('--es', 'SESSION_ACTION', options.action);
        if (options.pkg) args.push('--es', 'PACKAGE', options.pkg);
        if (options.activity) args.push('--es', 'ACTIVITY', options.activity);
        if (options.duration !== undefined) args.push('--ei', 'DURATION', Number(options.duration));
        if (options.sessionState && typeof options.sessionState === 'object') {
            const state = options.sessionState;
            if (state.session_id !== undefined && state.session_id !== null) args.push('--ei', 'SESSION_ID', Number(state.session_id));
            if (state.revision !== undefined && state.revision !== null) args.push('--el', 'SESSION_REVISION', Number(state.revision));
            if (state.remaining_seconds !== undefined && state.remaining_seconds !== null) args.push('--ei', 'REMAINING_SECONDS', Number(state.remaining_seconds));
            if (state.duration_seconds !== undefined && state.duration_seconds !== null) args.push('--ei', 'DURATION_SECONDS', Number(state.duration_seconds));
            if (state.current_app_package) args.push('--es', 'CURRENT_APP_PACKAGE', String(state.current_app_package));
            if (state.current_app_name) args.push('--es', 'CURRENT_APP_NAME', String(state.current_app_name));
            if (state.app_name) args.push('--es', 'APP_NAME', String(state.app_name));
            if (state.session_status) args.push('--es', 'SESSION_STATUS', String(state.session_status));
            if (state.paused !== undefined) args.push('--ez', 'PAUSED', Boolean(state.paused));
        }
        if (options.autoLaunch !== undefined) args.push('--ez', 'AUTO_LAUNCH', Boolean(options.autoLaunch));
        return args;
    }

    return Object.freeze({ prepareConnection, buildStartArgs });
}
