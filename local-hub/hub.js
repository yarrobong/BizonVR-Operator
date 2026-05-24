const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');

const HUB_ID = 1;
const API_URL = process.env.APP_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 5000;
const LOCAL_SERVER_PORT = process.env.HUB_PORT || 3000;

console.log(`Starting Local Hub (${HUB_ID}) connecting to ${API_URL}`);

// Local Heartbeat Tracking
let agentHeartbeats = {};

// Keep track of running scrcpy processes
const scrcpyProcesses = {};

// Regex for safe package name validation
const PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

const wirelessSetupAttempted = new Set();

function getDeviceIp(serial) {
    try {
        const out = execSync(`adb -s ${serial} shell ip addr show wlan0`, { encoding: 'utf-8' });
        const match = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) return match[1];
    } catch(e) {}
    return null;
}

function setupWirelessAdb(serial) {
    if (wirelessSetupAttempted.has(serial)) return;
    wirelessSetupAttempted.add(serial);
    
    console.log(`[Wireless ADB] Attempting to set up USB device ${serial} for Wi-Fi ADB...`);
    try {
        const ip = getDeviceIp(serial);
        if (ip) {
            console.log(`[Wireless ADB] Found IP ${ip} for ${serial}. Enabling tcpip 5555...`);
            execSync(`adb -s ${serial} tcpip 5555`);
            
            // Wait for tcpip to restart adbd, then connect
            setTimeout(() => {
                try {
                    console.log(`[Wireless ADB] Connecting to ${ip}:5555...`);
                    execSync(`adb connect ${ip}:5555`);
                    console.log(`[Wireless ADB] Successfully connected ${ip}:5555! You can unplug USB.`);
                } catch(e) {
                    console.error(`[Wireless ADB] Failed to connect:`, e.message);
                }
            }, 3000);
        } else {
            console.warn(`[Wireless ADB] Could not find wlan0 IP for ${serial}. Ensure dev kit is on Wi-Fi.`);
        }
    } catch(e) {
        console.error(`[Wireless ADB] Setup failed:`, e.message);
    }
}

function isValidPackage(pkg) {
    return pkg && PACKAGE_NAME_REGEX.test(pkg);
}

// Safely execute ADB
function getAdbDevices() {
    try {
        const output = execSync('adb devices', { encoding: 'utf-8' });
        const lines = output.split('\n');
        const devices = [];
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split('\t');
            if (parts.length === 2 && parts[1] === 'device') {
                const serial = parts[0];
                devices.push(serial);
                
                // If it's a USB connection (no colon) and not an emulator, try wireless setup
                if (!serial.includes(':') && !serial.startsWith('emulator-') && serial !== '1G0YK01234') {
                    setupWirelessAdb(serial);
                }
            }
        }
        return devices;
    } catch (e) {
        console.warn('[WARN] ADB not found or errored. Using mock device "1G0YK01234" for testing.');
        return ['1G0YK01234'];
    }
}

function spawnAdb(args, onSuccessMessage) {
    return new Promise((resolve) => {
        const proc = spawn('adb', args);
        let errorOutput = '';
        proc.stderr.on('data', data => errorOutput += data.toString());
        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true, message: onSuccessMessage || "Command executed successfully" });
            } else {
                resolve({ success: false, error: errorOutput || `Process exited with code ${code}` });
            }
        });
        proc.on('error', (err) => resolve({ success: false, error: err.message }));
    });
}

function runCommand(deviceSerial, commandType, payloadStr) {
  return new Promise((resolve) => {
     console.log(`[ADB ${deviceSerial}] EXECUTING: ${commandType}`);
     
     let payload = {};
     try { payload = JSON.parse(payloadStr || '{}'); } catch(e) {}

     if (commandType === 'OPEN_SCRCPY') {
        if (scrcpyProcesses[deviceSerial]) {
             return resolve({ success: true, message: "scrcpy already running" });
        }
        const scrcpy = spawn('scrcpy', ['-s', deviceSerial, '--max-size', '1440', '--video-bit-rate', '8M']);
        scrcpyProcesses[deviceSerial] = scrcpy;
        scrcpy.on('error', (err) => {
           console.log(`[scrcpy error] ${err.message}`);
           delete scrcpyProcesses[deviceSerial];
        });
        scrcpy.on('close', () => {
           delete scrcpyProcesses[deviceSerial];
        });
        resolve({ success: true, message: "scrcpy spawned" });

     } else if (commandType === 'CLOSE_SCRCPY') {
        if (scrcpyProcesses[deviceSerial]) {
             scrcpyProcesses[deviceSerial].kill();
             delete scrcpyProcesses[deviceSerial];
             resolve({ success: true, message: "scrcpy closed" });
        } else {
             resolve({ success: true, message: "scrcpy not running" });
        }

     } else if (commandType === 'START_SESSION') {
        const pkg = payload.package || 'com.bizonvr.questagent';
        const duration = payload.duration_minutes || 30;
        
        console.log(`[ADB] Notifying Agent to start session for: ${pkg}`);
        spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', 'com.bizonvr.questagent/.MainActivity', '--es', 'SESSION_ACTION', 'START', '--es', 'PACKAGE', pkg, '--ei', 'DURATION', duration.toString()], `Agent notified for ${pkg}`)
            .then(resolve);

     } else if (commandType === 'END_SESSION') {
        const pkg = payload.package;
        if (!isValidPackage(pkg)) return resolve({ success: false, error: "Invalid package name" });
        
        console.log(`[ADB] Stopping package: ${pkg}`);
        
        const stop = spawn('adb', ['-s', deviceSerial, 'shell', 'am', 'force-stop', pkg]);
        stop.on('close', () => {
           // Wait a second then launch the club launcher setting the intent action to stop
           setTimeout(() => {
               spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', 'com.bizonvr.questagent/.MainActivity', '--es', 'SESSION_ACTION', 'STOP'], "Session ended, launcher started")
                  .then(resolve);
           }, 1000);
        });
        stop.on('error', (err) => resolve({ success: false, error: err.message }));

     } else if (commandType === 'INSTALL_APP') {
        const apkPath = payload.apkPath;
        if (!apkPath) return resolve({ success: false, error: "Missing apkPath" });
        console.log(`[ADB] Installing APK: ${apkPath}`);
        spawnAdb(['-s', deviceSerial, 'install', '-r', apkPath], "APK Installed")
            .then(resolve);

     } else if (commandType === 'INSTALL_APK') {
        const agentPkg = 'com.bizonvr.questagent';
        console.log(`[ADB] Installing Quest Agent on ${deviceSerial}...`);
        spawnAdb(['-s', deviceSerial, 'install', '-r', './quest-agent.apk'], `Installed Agent`)
            .then((res) => {
                if(res.success) {
                    console.log(`[ADB] Starting Quest Agent on ${deviceSerial}...`);
                    spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', `${agentPkg}/.MainActivity`], `Started Agent installed`)
                       .then(resolve);
                } else {
                    resolve(res);
                }
            })

     } else if (commandType === 'UNINSTALL_APP') {
        const pkg = payload.package;
        if (!isValidPackage(pkg)) return resolve({ success: false, error: "Invalid package name" });
        console.log(`[ADB] Uninstalling package: ${pkg}`);
        spawnAdb(['-s', deviceSerial, 'uninstall', pkg], `Uninstalled ${pkg}`)
            .then(resolve);

     } else if (commandType === 'OPEN_LAUNCHER') {
        spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', 'com.bizonvr.questagent/.MainActivity'], "Launcher started")
            .then(resolve);

     } else if (commandType === 'REBOOT_DEVICE') {
        spawnAdb(['-s', deviceSerial, 'reboot'], "Device rebooting")
            .then(resolve);

     } else if (commandType === 'REFRESH_STATUS') {
        setTimeout(() => resolve({ success: true, message: "status refreshed" }), 1000);

     } else {
        resolve({ success: false, error: "unknown command" });
     }
  });
}

function syncWithCloud() {
   const protocol = API_URL.startsWith('https') ? https : http;
   const activeSerials = getAdbDevices();
   
   const deviceDetails = activeSerials.map(serial => {
       let battery = 85; // default fallback if real device fails
       if (serial !== '1G0YK01234') { // Don't run ADB on the mock device
           try {
               const batteryOut = execSync(`adb -s ${serial} shell dumpsys battery`, { encoding: 'utf-8' });
               const match = batteryOut.match(/level:\s*(\d+)/);
               if (match) battery = parseInt(match[1], 10);
           } catch(e) {
               console.warn(`[WARN] ADB dumpsys failed for ${serial}`);
           }
       }
       return { serial, battery };
   });

   // Cleanup old heartbeats (older than 30s)
   const now = Date.now();
   for (const key in agentHeartbeats) {
       if (now - agentHeartbeats[key].last_seen > 30000) {
           delete agentHeartbeats[key];
       }
   }

   const requestData = JSON.stringify({ 
       active_serials: activeSerials, 
       device_details: deviceDetails,
       agent_heartbeats: Object.values(agentHeartbeats)
   });

   const req = protocol.request(`${API_URL}/api/hubs/${HUB_ID}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': requestData.length
      }
   }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
         try {
            const json = JSON.parse(data);
            const commands = json.commands || [];
            
            for (const cmd of commands) {
               console.log(`Received command: ${cmd.type} for device ${cmd.device_id}`);
               
               // Mock finding the target serial (for MVP we'll just proxy the primary active one if missing)
               // In a real product, we map the ID to the serial from our local sqlite cache
               const mockSerial = activeSerials.length > 0 ? activeSerials[0] : '1G0YK01234'; 
               
               const result = await runCommand(mockSerial, cmd.type, cmd.payload);
               
               // Report success/fail back to API
               await reportCommandStatus(cmd.id, result.success ? 'succeeded' : 'failed', result.error);
            }
         } catch(e) {
            console.error('Failed to parse sync response', e.message);
         }
      });
   });
   
   req.on('error', (e) => {
      console.error('Local Hub sync error:', e.message);
   });
   
   req.write(requestData);
   req.end();
}

function reportCommandStatus(cmdId, status, errorMsg) {
   return new Promise((resolve) => {
      const protocol = API_URL.startsWith('https') ? https : http;
      const data = JSON.stringify({ status, error_message: errorMsg });
      
      const req = protocol.request(`${API_URL}/api/commands/${cmdId}/status`, {
         method: 'POST',
         headers: { 
           'Content-Type': 'application/json',
           'Content-Length': Buffer.byteLength(data)
         }
      });
      req.write(data);
      req.on('close', resolve);
      req.on('error', resolve);
      req.end();
   });
}

// Start polling
setInterval(syncWithCloud, POLL_INTERVAL_MS);
syncWithCloud();

// --- Local Hub Mini-Server ---
const localServer = http.createServer((req, res) => {
    // CORS headers for local network just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    if (req.method === 'POST' && req.url === '/api/agent/heartbeat') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const ip = req.socket.remoteAddress;
                const id = data.pairing_id || ip;
                
                // console.log(`[Local Hub] Received heartbeat from agent ${id}`);
                agentHeartbeats[id] = {
                    ...data,
                    ip,
                    last_seen: Date.now()
                };
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Bad Request' }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/agent/call_operator') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const ip = req.socket.remoteAddress;
                const id = data.pairing_id || ip;
                console.log(`[Local Hub] Agent ${id} calling operator!`);
                
                // Forward to cloud
                const protocol = API_URL.startsWith('https') ? require('https') : require('http');
                const reqOption = {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${HUB_TOKEN}`
                    }
                };
                const cloudReq = protocol.request(`${API_URL}/api/hub/call_operator`, reqOption, (cloudRes) => {});
                cloudReq.on('error', (err) => console.error('[Local Hub] Error forwarding call_operator:', err.message));
                cloudReq.write(JSON.stringify({ pairing_id: data.pairing_id }));
                cloudReq.end();
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Bad Request' }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

localServer.listen(LOCAL_SERVER_PORT, '0.0.0.0', () => {
    console.log(`[Local Hub Mini-Server] Listening for Agent heartbeats on port ${LOCAL_SERVER_PORT}`);
});
