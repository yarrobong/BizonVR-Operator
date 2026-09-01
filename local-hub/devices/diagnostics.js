export function createDeviceDiagnostics({ runAdbCapture, config } = {}) {
    async function getCurrentForegroundPackage(serial) {
        try {
            const output = await runAdbCapture(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
            const matches = [...String(output).matchAll(/(?:mResumedActivity|mFocusedApp|topResumedActivity).*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9.$_]+/g)];
            return matches.at(-1)?.[1] || null;
        } catch { return null; }
    }
    async function getScreenrecordDisplayArgs(deviceSerial) {
        if (config.STREAM_DISPLAY_ID) return ['--display-id', config.STREAM_DISPLAY_ID];
        try {
            const output = await runAdbCapture(['-s', deviceSerial, 'shell', 'dumpsys', 'SurfaceFlinger', '--display-id']);
            const match = output.match(/Display\s+(\d+)\s+\(HWC display 0\)/);
            return match ? ['--display-id', match[1]] : [];
        } catch (error) {
            return [];
        }
    }
    async function getBattery(serial) {
        try {
            const output = await runAdbCapture(['-s', serial, 'shell', 'dumpsys', 'battery']);
            const match = output.match(/level:\s*(\d+)/);
            return match ? parseInt(match[1], 10) : 85;
        } catch { return 85; }
    }
    return Object.freeze({ getCurrentForegroundPackage, getScreenrecordDisplayArgs, getBattery });
}
