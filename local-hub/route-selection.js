export function prefersUsbForCommand(commandType, payload = {}) {
  if (commandType === "INSTALL_APP" || commandType === "INSTALL_APK") {
    return true;
  }

  if (commandType === "REFRESH_STATUS" && payload && payload.repair_wireless) {
    return true;
  }

  return false;
}

export function buildHeartbeatIdentity(data = {}) {
  return data.agent_id || data.pairing_id || data.stable_id || data.android_id || null;
}

export function selectPreferredExecutionRoute(route, options = {}) {
  const purpose = options.purpose || "control";
  const usbRoute = route?.usbOnline ? route.usbSerial || null : null;
  const wirelessRoute = route?.wirelessOnline ? route.wirelessSerial || null : null;

  if (purpose === "maintenance") {
    return usbRoute || wirelessRoute || null;
  }

  return wirelessRoute || usbRoute || null;
}
