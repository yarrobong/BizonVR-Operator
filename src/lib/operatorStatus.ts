export type OperatorDeviceLike = {
  status?: string | null;
  connection_status?: string | null;
  adb_status?: string | null;
  agent_status?: string | null;
  wifi_ready?: boolean | null;
  usb_repair_required?: boolean | null;
  transport?: string | null;
  active_route?: string | null;
  serial_number?: string | null;
  status_reason?: string | null;
  next_operator_step?: string | null;
  needs_help?: number | boolean | null;
};

export type OperatorStatus = {
  chip: string;
  title: string;
  message: string;
  secondary?: string;
  tone: string;
  showRepair: boolean;
};

export function getResolvedConnectionStatus(device: OperatorDeviceLike) {
  if (device.connection_status) {
    return device.connection_status;
  }
  if (device.adb_status === "unauthorized") {
    return "usb_unauthorized";
  }
  if (device.adb_status === "online" && device.agent_status === "online") {
    return "online";
  }
  if (device.adb_status === "online" && device.wifi_ready) {
    return "wifi_ready";
  }
  if (device.adb_status === "online") {
    return "adb_online_agent_offline";
  }
  if (device.agent_status === "online") {
    return "agent_online_adb_offline";
  }
  if (device.usb_repair_required) {
    return "usb_repair_required";
  }
  return device.status ?? "unknown_error";
}

export function getAdbDegradedLabel(device: OperatorDeviceLike) {
  switch (device.adb_status) {
    case "reconnecting":
      return "Online, ADB reconnecting";
    case "tcpip_unavailable":
      return "Online, wireless ADB off";
    case "port_closed":
      return "Online, port 5555 closed";
    case "different_device":
      return "ADB route mismatch";
    case "unauthorized":
      return "USB Authorize";
    default:
      return "Online, ADB degraded";
  }
}

export function getConnectivityLabel(device: OperatorDeviceLike) {
  switch (getResolvedConnectionStatus(device)) {
    case "online":
      return "Online";
    case "wifi_ready":
      return "Wi-Fi Ready";
    case "usb_unauthorized":
      return "USB Authorize";
    case "usb_repair_required":
      return "USB Repair";
    case "vpn_or_lan_blocked":
      return "VPN/LAN Blocked";
    case "agent_online_adb_offline":
      return getAdbDegradedLabel(device);
    case "adb_online_agent_offline":
      return "Agent offline, relaunching";
    case "offline_sleeping":
      return "Sleeping or unreachable";
    case "pairing_in_progress":
      return "Pairing";
    case "new":
      return "New Quest";
    default:
      return device.usb_repair_required ? "USB Repair" : "Checking";
  }
}

export function hasUsbRoute(device: OperatorDeviceLike) {
  return device.transport === "usb" || (!!device.active_route && device.active_route === device.serial_number);
}

export function isReadyForWirelessControl(device: OperatorDeviceLike) {
  return device.agent_status === "online" && device.adb_status === "online" && device.transport === "wifi";
}

export function canRepairWireless(device: OperatorDeviceLike) {
  return Boolean(device.usb_repair_required) || ["port_closed", "tcpip_unavailable"].includes(String(device.adb_status || ""));
}

export function isOperatorReachable(device: OperatorDeviceLike) {
  return device.agent_status === "online" || device.adb_status === "online";
}

export function getOperatorStatus(device: OperatorDeviceLike, options: { repairPending: boolean; recentlyRecovered: boolean }): OperatorStatus {
  if (Boolean(device.needs_help)) {
    return {
      chip: "Help",
      title: "Игрок вызвал оператора",
      message: "На шлеме нажали кнопку вызова. Подойдите к игроку или подтвердите помощь из панели.",
      secondary: "После помощи снимите алерт кнопкой Dismiss.",
      tone: "border-red-500/30 bg-red-500/10 text-red-100",
      showRepair: false,
    };
  }

  if (options.repairPending) {
    return {
      chip: "Recovery",
      title: "Восстановление...",
      message: "Включаем Wi-Fi ADB. Не отключайте USB.",
      tone: "border-blue-500/30 bg-blue-500/10 text-blue-100",
      showRepair: false,
    };
  }

  if (options.recentlyRecovered && isReadyForWirelessControl(device)) {
    return {
      chip: "Recovered",
      title: "Можно отключить USB",
      message: "Wi-Fi ADB восстановлен. Теперь можно отключить USB.",
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
      showRepair: false,
    };
  }

  if (isReadyForWirelessControl(device)) {
    return {
      chip: "Ready",
      title: "Готов к работе",
      message: "Шлем готов. Управление и трансляция доступны.",
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
      showRepair: false,
    };
  }

  if (device.agent_status === "online" && ["port_closed", "tcpip_unavailable"].includes(String(device.adb_status || "")) && canRepairWireless(device)) {
    if (hasUsbRoute(device)) {
      return {
        chip: "USB",
        title: "USB подключён, можно восстановить",
        message: "Шлем включён и виден в системе, но Quest закрыл Wi-Fi ADB после перезагрузки.",
        secondary: "Нажмите «Восстановить Wi-Fi ADB», чтобы вернуть управление без кабеля.",
        tone: "border-amber-500/30 bg-amber-500/10 text-amber-100",
        showRepair: true,
      };
    }

    return {
      chip: "Repair",
      title: "Шлем online, нужна USB-починка",
      message: "Шлем включён и виден в системе, но Quest закрыл Wi-Fi ADB после перезагрузки.",
      secondary: "Подключите USB и нажмите «Восстановить Wi-Fi ADB».",
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-100",
      showRepair: false,
    };
  }

  if (device.usb_repair_required && !hasUsbRoute(device)) {
    return {
      chip: "USB",
      title: "Подключите USB",
      message: "Подключите Quest по USB и разбудите шлем.",
      secondary: "После этого появится кнопка «Восстановить Wi-Fi ADB».",
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-100",
      showRepair: false,
    };
  }

  if (device.agent_status !== "online" && device.adb_status !== "online") {
    return {
      chip: "Offline",
      title: "Шлем не в сети",
      message: "Шлем не отвечает. Проверьте, включён ли он и находится ли в той же сети.",
      tone: "border-red-500/30 bg-red-500/10 text-red-100",
      showRepair: false,
    };
  }

  return {
    chip: "Check",
    title: getConnectivityLabel(device),
    message: device.status_reason || "Проверьте состояние шлема и Local Hub.",
    secondary: device.next_operator_step || undefined,
    tone: "border-blue-500/30 bg-blue-500/10 text-blue-100",
    showRepair: canRepairWireless(device) && hasUsbRoute(device),
  };
}

export function getCastAvailability(device: OperatorDeviceLike) {
  if (isReadyForWirelessControl(device)) {
    return { enabled: true, reason: "Открыть трансляцию в панели" };
  }
  if (device.agent_status === "online" && canRepairWireless(device)) {
    return { enabled: false, reason: "Трансляция появится после восстановления Wi-Fi ADB." };
  }
  return { enabled: false, reason: "Трансляция доступна, когда шлем готов к работе." };
}

export function getSessionAvailability(device: OperatorDeviceLike) {
  if (isReadyForWirelessControl(device)) {
    return { enabled: true, reason: "Запустить или переключить сессию" };
  }
  if (device.agent_status === "online" && canRepairWireless(device)) {
    return { enabled: false, reason: "Сначала восстановите Wi-Fi ADB, затем можно запускать сессию." };
  }
  return { enabled: false, reason: "Сессия доступна, когда шлем готов к работе." };
}
