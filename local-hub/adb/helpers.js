import { isAdbTransportFailure } from '../adb-process-runner.js';

export function createAdbHelpers({ config, runner, log = () => {} } = {}) {
    async function capture(args, options = {}) {
        return runner.capture(args, { timeoutMs: options.timeoutMs || config.ADB_COMMAND_TIMEOUT_MS, maxStdoutBytes: options.maxStdoutBytes, maxStderrBytes: options.maxStderrBytes, spawnOptions: options.spawnOptions });
    }
    async function run(args, options = {}) { return capture(args, options); }
    function spawnAdb(args, onSuccessMessage) {
        return runner.run(args).then((result) => {
            if (result.ok) return { success: true, message: onSuccessMessage || 'Command executed successfully', stdout: result.stdout };
            const error = result.outputLimitExceeded
                ? 'ADB process output exceeded the configured safety limit.'
                : result.timedOut
                    ? `ADB command timed out after ${config.ADB_COMMAND_TIMEOUT_MS}ms.`
                    : result.spawnError?.message || result.stderr || `Process exited with code ${result.code ?? 'unknown'}`;
            log('ADB', 'ADB command failed', { args, error, timedOut: result.timedOut, durationMs: result.durationMs });
            return { success: false, error, errorCode: result.outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : result.timedOut ? 'ADB_PROCESS_TIMEOUT' : result.spawnError ? 'ADB_PROCESS_SPAWN_FAILED' : 'ADB_COMMAND_FAILED', timedOut: result.timedOut, transportFailure: isAdbTransportFailure(result) };
        });
    }
    async function capturePngFrame(deviceSerial) {
        if (!config.DEVICE_SERIAL_REGEX.test(String(deviceSerial || ''))) return { success: false, error: 'Invalid device serial' };
        const result = await runner.run(['-s', deviceSerial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxStdoutBytes: config.MAX_SCREENCAP_BYTES, maxStderrBytes: 256 * 1024 });
        if (result.ok) return { success: true, frame: result.stdout };
        return { success: false, error: result.outputLimitExceeded ? 'ADB screencap exceeded the binary output safety limit.' : result.timedOut ? `ADB screencap timed out after ${config.ADB_COMMAND_TIMEOUT_MS}ms.` : result.stderr || `screencap exited with code ${result.code ?? 'unknown'}`, errorCode: result.outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : undefined, timedOut: result.timedOut, transportFailure: isAdbTransportFailure(result) };
    }
    return Object.freeze({ capture, run, spawnAdb, capturePngFrame, delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
}
