export function createLifecycle({ server, castManager, scrcpyProcesses, executionStore, clearSyncTimer = () => {}, log = () => {}, config } = {}) {
    let shutdownPromise = null;
    async function shutdown(signal = 'manual') {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            log('Hub', 'Graceful shutdown requested', { signal, activeCasts: castManager.getActiveCount(), activeScrcpy: scrcpyProcesses.size });
            await castManager.stopAll('hub_shutdown');
            await Promise.all([...scrcpyProcesses.values()].map(async ({ process }) => {
                try { process.kill('SIGTERM'); } catch {}
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, config.CAST_KILL_GRACE_MS);
                    process.once?.('close', () => { clearTimeout(timer); resolve(); });
                });
                if (process.exitCode == null) { try { process.kill('SIGKILL'); } catch {} }
            }));
            scrcpyProcesses.clear();
            clearSyncTimer();
            await Promise.race([
                new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }),
                new Promise((resolve) => setTimeout(resolve, config.CAST_TERM_GRACE_MS + config.CAST_KILL_GRACE_MS + 2000)),
            ]);
            executionStore.close?.();
            log('Hub', 'Graceful shutdown complete', { signal });
        })();
        return shutdownPromise;
    }
    return Object.freeze({ shutdown });
}
