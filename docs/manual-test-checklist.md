# Manual Quest acceptance checklist

These checks require a real Meta Quest headset and Local Hub on the same LAN.

## A. First pair via USB

1. Start backend with `npm run dev`.
2. Start Local Hub with `ENABLE_WIRELESS_ADB=1 HUB_HOST=<local-lan-ip> npm run hub:dev`.
3. Build the production agent APK with `cd quest-agent-spatial-spike && ./gradlew :app:assembleDebug`.
4. Connect Quest over USB and accept USB debugging in headset.
5. Install `quest-agent-spatial-spike` APK.
6. Launch `com.bizonvr.spatialspike/.SpatialSpikeActivity` with `HUB_IP`/`HUB_PORT`.
7. Verify device appears as available/new, pairs into inventory, and has `agent_status=online`, `adb_status=online`.
8. Watch Local Hub logs and verify heartbeat POSTs are not duplicated in the same second after launch.

## B. Switch to Wi-Fi

1. Enable `adb tcpip 5555`.
2. Connect to `<quest-ip>:5555`.
3. Unplug USB.
4. Verify no duplicate device is created, `active_route` changes to `<quest-ip>:5555`, heartbeat continues, and `device_status` remains online.
5. Verify heartbeat `local_ip` matches the active Quest Wi-Fi LAN IP instead of an unrelated interface.

## C. ADB disconnect recovery

1. Run `adb disconnect <quest-ip>:5555`.
2. Verify Local Hub tries remembered `last_known_ip` and `previous_ips`.
3. If Quest is awake and reachable, `adb_status` returns online.
4. Verify heartbeat does not depend on `adb reverse`.

## D. Reboot Quest

1. Reboot headset.
2. Open or autostart Quest Agent.
3. Verify persisted `HUB_IP`/`HUB_PORT` are used and heartbeat does not go to `127.0.0.1`.
4. Verify the same device returns online without a duplicate.

## E. IP change

1. Change Quest IP or reconnect Wi-Fi.
2. Verify heartbeat includes new `local_ip`.
3. Verify Local Hub updates `last_known_ip` and `previous_ips`.
4. Verify inventory still has one device.
5. Verify `local_ip` tracks the active Wi-Fi network and does not jump to `192.168.107.x` unless that is the real Quest LAN.

## F. USB and Wi-Fi together

1. Connect the same Quest by USB while Wi-Fi ADB is connected.
2. Verify commands use `adb -s <route>`.
3. Verify install/repair uses intended route and does not run on another headset.
4. Verify normal control keeps using Wi-Fi after reconnect, and does not fall back to a stale USB serial once the cable is unplugged.

## G. Degraded states

1. Agent online + ADB offline: UI says Online, ADB degraded.
2. ADB online + Agent offline: Local Hub relaunches Agent and UI says Agent offline, relaunching.
3. Both offline: UI says Need USB repair / Sleeping or unreachable.

## H. Route stability after forced reconnect

1. While Wi-Fi ADB is active, run `adb disconnect <quest-ip>:5555`.
2. Verify Local Hub attempts remembered routes and re-establishes Wi-Fi ADB.
3. Watch Local Hub logs and verify the selected execution route passes `adb -s <route> get-state` before it is reused.
4. Verify no `adb: device ... not found` error appears because of a stale USB execution route.
