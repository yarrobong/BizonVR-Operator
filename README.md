# BizonVR Club Control

This repository combines the MVP requirements for the BizonVR Meta Quest management system.
We utilize a full-stack Node.js + Express + React architecture configured to run on a single cloud service to ease deployment and meet AI Studio runtime requirements, while splitting out the local components.


scrcpy -b 25M --max-size=1600 --crop=1600:1000:116:460 --no-audio

## Directory Structure

*   \`/src/server/\` and \`server.ts\` - **Cloud Backend** (Express, standard REST API + SQLite mock for MVP)
*   \`/src/components/\` and \`/src/pages/\` - **Web Operator Panel** (React, Tailwind, TanStack Query)
*   \`/local-hub/\` - **Local Hub** (Node.js script polling the backend for device commands)
*   \`/quest-agent-spatial-spike/\` - **Quest Agent** production Android/Kotlin app for Meta Quest
*   \`/docs/\` - Documentation files

## Running the Architecture

1.  The cloud backend and web UI run via \`npm run dev\`.
2.  The local hub runs via \`npm run hub:dev\`.

## Local Development Notes

- The backend uses port \`3000\`.
- The Local Hub mini-server should use \`3001\` locally so it does not conflict with the backend.
- When the Quest Agent is launched by Local Hub, the hub passes its IP and port to the headset automatically and opens the agent through the Quest VR launcher entry, not by directly starting the raw activity.
- Device casting now opens inside the web operator panel. The browser requests the stream URL from the cloud API, then connects to the Local Hub mini-server on \`HUB_PORT\`.
- To make \`INSTALL_APK\` work, first build the Android app so the APK exists at \`quest-agent-spatial-spike/app/build/outputs/apk/debug/app-debug.apk\`, or override \`QUEST_AGENT_APK_PATH\`.
- To keep Quest control stable over Wi-Fi, enable \`ENABLE_WIRELESS_ADB=1\` on Local Hub after the first trusted USB connection. The hub caches the stable USB serial and reconnects to the remembered \`ip:5555\` route on later sync cycles.

## Debugging Logs

- Web/backend logs: run \`npm run dev\` and watch the terminal for API errors and command status updates.
- Local Hub logs: run \`ENABLE_WIRELESS_ADB=1 npm run hub:dev\` and watch for \`[Routing]\`, \`[Command]\`, \`[Wake]\`, \`[Heartbeat]\`, and \`[Agent]\` lines.
- Quest Agent logs on the headset: use \`adb logcat | grep BizonVRQuestAgent\` to see received intents, heartbeat success/failure, and package launch errors.
- If launches are flaky, compare the serial in \`[Routing]\` logs. If the route flips between a USB serial and \`ip:5555\`, the wake path is the first place to inspect.

## Constraints Addressed
- Command chain: Web -> Cloud API -> DeviceCommand DB -> Local Hub Sync.
- No direct cloud-to-device ADB.
- Safe process runners for ADB commands.

## Quest connection stability model

- First trusted Quest connection is done over USB. The operator must accept USB debugging in the headset.
- After first trust, Local Hub may enable and use Wi-Fi ADB with `ENABLE_WIRELESS_ADB=1`.
- ADB is not the production online status. ADB is used for install, start, recovery, and debug.
- The primary online signal is Quest Agent heartbeat from `quest-agent-spatial-spike`.
- Device identity is `stable_id`, `agent_id`, and `android_id`; IP is only a route hint.
- When Quest IP changes, update `last_known_ip` and `previous_ips`; do not create a duplicate device.
- Local Hub must pass a real LAN `HUB_HOST` and `HUB_PORT` to Quest Agent. Do not use `127.0.0.1` for production Wi-Fi heartbeat.
- `HUB_HOST`/`HUB_PORT` must be reachable from the headset on the same Wi-Fi/LAN.
- If the headset is powered off, deeply asleep, or on another network, Local Hub cannot guarantee ADB recovery without operator action.

## ADB limitations

- Wi-Fi ADB can drop after reboot, sleep, OS update, network change, or USB debugging reset.
- A powered-off or deeply sleeping Quest cannot be reliably woken only through ADB.
- First USB debugging trust requires a human confirmation inside the headset.
- If the same Quest is visible over USB and Wi-Fi, every command must use `adb -s <route>`.
- Cloud Backend/Web must not connect to Quest or run ADB directly.
- Local Hub must be on the same network as Quest and is the only component allowed to run ADB/scrcpy.

## Operator recovery checklist

1. Ensure Quest is powered on and connected to the same Wi-Fi as Local Hub.
2. If Agent is online but ADB is degraded, click Reconnect ADB.
3. If ADB is online but Agent is offline, click Relaunch Agent.
4. If both are offline, connect USB and click Repair via USB.
5. If after reboot heartbeat goes to `127.0.0.1`, treat it as a bug in HUB_IP persistence.
