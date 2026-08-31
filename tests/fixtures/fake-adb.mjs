import fs from 'node:fs';

const statePath = process.env.FAKE_ADB_STATE;
const state = statePath && fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : {};
const args = process.argv.slice(2);
const key = args.join(' ');
const delay = Number(state.delays?.[key] || state.delayMs || 0);

if (state.hangs?.includes(key)) {
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    let code = 0;
    let stdout = '';
    let stderr = '';
    const serial = args[0] === '-s' ? args[1] : null;
    const commandArgs = args[0] === '-s' ? args.slice(2) : args;
    const command = commandArgs.join(' ');
    const device = (state.devices || []).find((entry) => entry.serial === serial);

    if (command === 'devices -l' && state.commands?.[command]) {
      const result = state.commands[command];
      code = Number(result.code || 0);
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } else if (command === 'devices -l') {
      stdout = `List of devices attached\n${(state.devices || []).map((entry) => `${entry.serial}\t${entry.status}${entry.transportId ? ` transport_id:${entry.transportId}` : ''}`).join('\n')}\n`;
    } else if (commandArgs[0] === 'connect') {
      const target = commandArgs[1];
      const result = state.connect?.[target] || { status: 'success' };
      if (result.status === 'hang') setInterval(() => {}, 1000);
      else if (result.status === 'failure') { code = 1; stderr = result.message || `failed to connect to ${target}`; }
      else stdout = result.message || `connected to ${target}`;
    } else if (commandArgs[0] === 'disconnect') {
      stdout = `disconnected ${commandArgs[1] || ''}`;
    } else if (!device && serial) {
      code = 1;
      stderr = 'error: device not found';
    } else if (command === 'get-state') {
      stdout = device?.state || device?.status || 'unknown';
      if (stdout !== 'device') code = 1;
    } else if (command === 'shell getprop ro.serialno') {
      stdout = `${device?.stableId || device?.serial || serial}\n`;
    } else if (command === 'shell settings get secure android_id') {
      stdout = `${device?.androidId || ''}\n`;
    } else if (command === 'shell echo probe' || command === 'shell echo BIZONVR_HEALTH') {
      stdout = command.endsWith('BIZONVR_HEALTH') ? 'BIZONVR_HEALTH\n' : 'probe\n';
    } else if (command === 'shell ip addr show wlan0') {
      stdout = device?.ip ? `inet ${device.ip}/24 scope global wlan0\n` : '';
    } else if (command === 'shell cmd wifi status') {
      stdout = device?.wifiSsid ? `SSID: "${device.wifiSsid}"\n` : '';
    } else if (commandArgs[0] === 'crash') {
      process.kill(process.pid, 'SIGTERM');
    } else if (state.commands?.[command]) {
      const result = state.commands[command];
      code = Number(result.code || 0);
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    }

    process.stdout.write(stdout);
    process.stderr.write(stderr);
    // Let stdout/stderr flush before the child exits. This also makes daemon
    // failure output deterministic for the reliability tests.
    process.exitCode = code;
  }, delay);
}
