export function createCommandReconciler({ config, runAdbCapture, getCurrentForegroundPackage, findAgentHeartbeatForRoute, isValidPackage } = {}) {
    async function reconcile(command, executionSerial, stableSerial) {
        const type = String(command.type);
        let payload = command.payload || {};
        try { payload = typeof payload === 'string' ? JSON.parse(payload || '{}') : payload; }
        catch { return { success: false, unknown: true, error: 'Command payload cannot be parsed during reconciliation', errorCode: 'COMMAND_INTEGRITY_VIOLATION' }; }
        const packageName = payload.package || payload.package_name || payload.current_app_package || null;
        if (['LAUNCH_APP', 'START_SESSION', 'RESUME_SESSION', 'SWITCH_SESSION_APP'].includes(type)) {
            const foreground = await getCurrentForegroundPackage(executionSerial);
            return foreground && packageName && foreground === packageName
                ? { success: true, reconciled: true, message: `Reconciled: ${packageName} is already foreground` }
                : { success: false, unknown: true, error: `Expected ${packageName || 'requested app'} is not foreground`, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
        }
        if (type === 'END_SESSION') {
            const foreground = await getCurrentForegroundPackage(executionSerial);
            const heartbeat = findAgentHeartbeatForRoute({ stableSerial });
            return foreground === config.QUEST_AGENT_PACKAGE && heartbeat && heartbeat.in_session === false && !heartbeat.session_id
                ? { success: true, reconciled: true, cleanup_confirmed: true, foreground_package: foreground, agent_confirmed: true, message: 'Reconciled: launcher foreground and Agent confirmed session cleanup' }
                : { success: false, unknown: true, error: 'Session cleanup could not be confirmed by launcher foreground and Agent signals', errorCode: 'SESSION_CLEANUP_NOT_CONFIRMED' };
        }
        if (type === 'STOP_APP') {
            const foreground = await getCurrentForegroundPackage(executionSerial);
            return !foreground || !packageName || foreground !== packageName
                ? { success: true, reconciled: true, message: 'Reconciled: requested app is no longer foreground' }
                : { success: false, unknown: true, error: `App ${packageName} is still foreground`, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
        }
        if (['INSTALL_APP', 'INSTALL_APK'].includes(type)) {
            if (!packageName || !isValidPackage(packageName)) return { success: false, unknown: true, error: 'Cannot reconcile install without a valid package', errorCode: 'COMMAND_RECONCILIATION_FAILED' };
            try {
                const installed = await runAdbCapture(['-s', executionSerial, 'shell', 'pm', 'path', packageName]);
                if (!String(installed).includes('package:')) throw new Error('package is not installed');
                const expectedVersion = payload.version_code == null ? null : String(payload.version_code);
                if (expectedVersion) {
                    const details = await runAdbCapture(['-s', executionSerial, 'shell', 'dumpsys', 'package', packageName]);
                    if (!new RegExp(`versionCode=${expectedVersion}(?:\\D|$)`).test(String(details))) throw new Error('installed version does not match');
                }
                return { success: true, reconciled: true, message: `Reconciled: ${packageName} is installed` };
            } catch (error) {
                return { success: false, unknown: true, error: error.message, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
            }
        }
        if (type === 'UNINSTALL_APP') {
            try {
                await runAdbCapture(['-s', executionSerial, 'shell', 'pm', 'path', packageName]);
                return { success: false, unknown: true, error: `${packageName} is still installed`, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
            } catch {
                return { success: true, reconciled: true, message: `Reconciled: ${packageName} is absent` };
            }
        }
        if (type === 'CLOSE_SCRCPY') return { success: true, reconciled: true, message: 'Reconciled: no local scrcpy process remains' };
        return { success: false, unknown: true, error: 'No safe reconciliation probe exists for this command', errorCode: 'COMMAND_RECONCILIATION_FAILED' };
    }
    return Object.freeze({ reconcile });
}
