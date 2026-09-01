import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { buildAdbScreenrecordArgs, buildFfmpegArgs, getStreamProfile, resolveStreamRequest } from '../streaming.js';
import { safeEnd, safeWrite, safeWriteHead } from '../streaming.js';

export function createCastService({ config, routing, runner, diagnostics, castManager, wakeDevice, scrcpyProcesses, log = () => {}, spawnImpl = spawn } = {}) {
    let screencapFallbackCount = 0;
    const activeCastStreams = castManager.getRegistry();

    function createScreencapProducer(route) {
        const output = new EventEmitter();
        let timer = null;
        let stopped = false;
        const sendFrame = async () => {
            if (stopped) return;
            const result = await runner.capturePngFrame(route);
            if (stopped) return;
            if (!result.success) { const error = new Error(result.error || 'screencap failed'); error.code = 'STREAM_CAPTURE_FAILED'; output.emit('error', error); return; }
            const frame = result.frame;
            output.emit('data', Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from('\r\n')]));
            timer = setTimeout(sendFrame, config.STREAM_FRAME_INTERVAL_MS);
        };
        void sendFrame();
        return { name: 'screencap-fallback', output, processes: [], detach() { stopped = true; clearTimeout(timer); }, stop() { stopped = true; clearTimeout(timer); } };
    }

    function createVideoProducer(route, profile, transport, displayArgs) {
        const adbArgs = buildAdbScreenrecordArgs(route, profile, displayArgs);
        const ffmpegArgs = buildFfmpegArgs(transport, profile);
        const adbProc = spawnImpl(config.ADB_EXECUTABLE, adbArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        const ffmpegProc = spawnImpl(config.FFMPEG_EXECUTABLE, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        if (adbProc.stdout && ffmpegProc.stdin) adbProc.stdout.pipe(ffmpegProc.stdin);
        const appendDiagnostic = (name, chunk) => log('Cast', `${name} diagnostic`, { route, transport, profile: profile.key, stderr: String(chunk).slice(-2048) });
        adbProc.stderr?.on('data', (chunk) => appendDiagnostic('adb screenrecord', chunk));
        ffmpegProc.stderr?.on('data', (chunk) => appendDiagnostic('ffmpeg', chunk));
        ffmpegProc.stdin?.on('error', (error) => log('Cast', 'ffmpeg stdin closed', { route, message: error.message, errorCode: 'CAST_PIPE_BROKEN' }));
        return { name: 'adb-screenrecord+ffmpeg', output: ffmpegProc.stdout, processes: [adbProc, ffmpegProc], detach() { adbProc.stdout?.unpipe?.(ffmpegProc.stdin); ffmpegProc.stdin?.destroy?.(); }, adbArgs, ffmpegArgs };
    }

    async function streamDeviceFrames(req, res, deviceSerial, requestedTransport = config.STREAM_MODE, requestedProfile = config.STREAM_PROFILE) {
        const streamRequest = resolveStreamRequest(requestedTransport, requestedProfile);
        if (!streamRequest.ok) { safeWriteHead(res, streamRequest.status, { 'Content-Type': 'application/json' }); return safeEnd(res, JSON.stringify(streamRequest.body)); }
        const streamMode = streamRequest.transport;
        const profile = getStreamProfile(streamRequest.profileKey);
        const stableSerial = routing.resolveStableSerial(deviceSerial);
        const executionSerial = await routing.resolveExecutionSerial(stableSerial) || deviceSerial;
        if (!config.DEVICE_SERIAL_REGEX.test(String(executionSerial || ''))) { safeWriteHead(res, 409, { 'Content-Type': 'application/json' }); return safeEnd(res, JSON.stringify({ error: 'DEVICE_ROUTE_UNAVAILABLE', next_step: 'Reconnect ADB and retry the cast.' })); }
        const displayArgs = streamMode === 'screencap' ? [] : await diagnostics.getScreenrecordDisplayArgs(executionSerial);
        const responseHeaders = streamMode === 'screencap' ? { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Connection: 'close', 'X-BizonVR-Cast-Transport': 'screencap' } : { 'Content-Type': streamMode === 'fmp4' ? 'video/mp4' : 'multipart/x-mixed-replace; boundary=ffmpeg', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Accept-Ranges': 'none', Connection: 'close', 'X-BizonVR-Cast-Transport': streamMode, 'X-BizonVR-Cast-Profile': profile.key };
        const fallbackResponseHeaders = { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Connection: 'close', 'X-BizonVR-Cast-Transport': 'screencap', 'X-BizonVR-Cast-Profile': profile.key };
        wakeDevice(executionSerial).catch((error) => log('Cast', 'Could not wake device before cast', { error: error.message }));
        if (scrcpyProcesses.has(stableSerial)) { safeWriteHead(res, 409, { 'Content-Type': 'application/json' }); return safeEnd(res, JSON.stringify({ error: 'SCRCPY_ALREADY_ACTIVE', message: 'A managed scrcpy window already owns this Quest capture route.', next_step: 'Close the scrcpy session before opening browser cast.' })); }
        const primary = ({ record }) => createVideoProducer(record.route, profile, streamMode, record.route === executionSerial ? displayArgs : []);
        const fallback = ({ record }) => { screencapFallbackCount += 1; log('Cast', 'Starting screencap fallback', { castId: record.castId, stableSerial, route: record.route, fallback_count: screencapFallbackCount, diagnostic: 'fallback_started' }); return createScreencapProducer(record.route); };
        const result = castManager.attachViewer({ key: stableSerial, route: executionSerial, transport: streamMode, profile: profile.key, responseHeaders, fallbackResponseHeaders, req, res, startProducer: streamMode === 'screencap' ? fallback : primary, fallbackProducer: streamMode === 'screencap' ? null : fallback });
        if (!result.ok) { safeWriteHead(res, result.status, { 'Content-Type': 'application/json' }); return safeEnd(res, JSON.stringify(result.body)); }
        log('Cast', 'Viewer attached to cast producer', { castId: result.record.castId, generation: result.record.generation, stableSerial, route: executionSerial, transport: streamMode, profile: profile.key, viewerCount: result.record.viewers.size });
    }

    return Object.freeze({ streamDeviceFrames, activeCastStreams, getFallbackCount: () => screencapFallbackCount });
}
