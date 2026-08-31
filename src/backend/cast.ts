import {
  CAST_QUALITY_PROFILES,
  CAST_TRANSPORTS,
  DEFAULT_CAST_PROFILE,
  DEFAULT_CAST_TRANSPORT,
  DIAGNOSTIC_CAST_TRANSPORT,
  PREVIEW_CAST_PROFILE,
  PREVIEW_CAST_TRANSPORT,
  buildCastPageUrl,
  buildStreamUrl,
  isValidCastProfile,
  isValidCastTransport,
} from "../shared/cast-config.js";

type CastDevice = {
  id: number;
  name: string;
  status: string;
  serial_number: string;
  adb_status?: string | null;
  local_hub_id?: number | null;
  wake_supported?: boolean | null;
  wifi_ip?: string | null;
  next_operator_step?: string | null;
};

type CastHub = {
  id: number;
  name: string;
  status: string;
  host: string | null;
};

type CastRequestOptions = {
  transport?: string | null;
  profile?: string | null;
  now?: number;
};

type CastResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409; body: Record<string, unknown> };

export function buildCastResponse(
  device: CastDevice | undefined,
  hub: CastHub | undefined,
  port: number,
  options: CastRequestOptions = {},
): CastResult {
  if (!device) {
    return { status: 404, body: { error: "Device not found" } };
  }

  if (options.transport && !isValidCastTransport(options.transport)) {
    return {
      status: 400,
      body: {
        error: `Unknown cast transport "${options.transport}"`,
        supported_transports: CAST_TRANSPORTS,
        next_step: "Choose video, preview, or diagnostic mode and retry.",
      },
    };
  }

  if (options.profile && !isValidCastProfile(options.profile)) {
    return {
      status: 400,
      body: {
        error: `Unknown cast quality profile "${options.profile}"`,
        supported_profiles: Object.keys(CAST_QUALITY_PROFILES),
        next_step: "Choose low-latency, balanced, or performance and retry.",
      },
    };
  }

  if (!device.local_hub_id) {
    return {
      status: 409,
      body: {
        error: "No Local Hub assigned to this device",
        next_step: "Assign the headset to an online Local Hub before opening the cast.",
      },
    };
  }

  const canWakeOverWifi = Boolean(device.wake_supported || device.wifi_ip);
  if (device.status === "offline" && !canWakeOverWifi) {
    return {
      status: 409,
      body: {
        error: "Device is offline",
        next_step: "Reconnect the Quest through Local Hub and ADB before opening the cast.",
      },
    };
  }

  if (device.adb_status !== "online") {
    return {
      status: 409,
      body: {
        error: `ADB is ${String(device.adb_status || "offline").replace(/_/g, " ")}`,
        state: "partial_offline",
        next_step: String(device.next_operator_step || "Wait for Local Hub to restore ADB, or run USB Repair before opening the cast."),
      },
    };
  }

  if (!hub) {
    return {
      status: 404,
      body: {
        error: "Local Hub not found",
        next_step: "Reconnect the branch Local Hub and try again.",
      },
    };
  }

  if (hub.status !== "online" || !hub.host) {
    return {
      status: 409,
      body: {
        error: "Local Hub is offline",
        next_step: "Bring the Local Hub online so the operator can open the device cast in the browser.",
      },
    };
  }

  const transport = options.transport || DEFAULT_CAST_TRANSPORT;
  const profile = options.profile || DEFAULT_CAST_PROFILE;
  const now = options.now ?? Date.now();

  return {
    status: 200,
    body: {
      success: true,
      device: {
        id: device.id,
        name: device.name,
        status: device.status,
        serial_number: device.serial_number,
      },
      hub: {
        id: hub.id,
        name: hub.name,
        status: hub.status,
        host: hub.host,
        port,
      },
      transport,
      profile,
      default_transport: DEFAULT_CAST_TRANSPORT,
      default_profile: DEFAULT_CAST_PROFILE,
      available_transports: CAST_TRANSPORTS,
      available_profiles: Object.values(CAST_QUALITY_PROFILES),
      stream_url: buildStreamUrl({
        host: hub.host,
        port,
        serial: device.serial_number,
        transport,
        profile,
        ts: now,
      }),
      preview_url: buildStreamUrl({
        host: hub.host,
        port,
        serial: device.serial_number,
        transport: PREVIEW_CAST_TRANSPORT,
        profile: PREVIEW_CAST_PROFILE,
        ts: now,
      }),
      diagnostic_url: buildStreamUrl({
        host: hub.host,
        port,
        serial: device.serial_number,
        transport: DIAGNOSTIC_CAST_TRANSPORT,
        profile: PREVIEW_CAST_PROFILE,
        ts: now,
      }),
      cast_page_url: buildCastPageUrl({
        deviceId: device.id,
        transport,
        profile,
      }),
      wake_on_open: canWakeOverWifi,
    },
  };
}
