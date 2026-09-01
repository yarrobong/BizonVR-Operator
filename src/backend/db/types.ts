import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export type PermissionActor = {
  userId: number;
  organizationId: number;
  role: "owner" | "admin" | "operator" | "technician" | "viewer";
  clubIds?: number[];
};

export type SubscriptionState = {
  status: string;
  deviceLimit: number | null;
  features: Record<string, unknown>;
};

export type CreateOrganizationInput = { name: string; slug: string; status?: string };
export type CreateClubInput = {
  organizationId: number;
  name: string;
  slug: string;
  timezone?: string;
  address?: string;
};
export type CreateZoneInput = { clubId: number; name: string; slug: string; sortOrder?: number };
export type CreateRoomInput = {
  clubId: number;
  zoneId?: number | null;
  name: string;
  slug: string;
  capacity?: number;
  sortOrder?: number;
  mapX?: number;
  mapY?: number;
  mapW?: number;
  mapH?: number;
};
export type CreateHubInput = { clubId: number; name: string; status?: string; host?: string };
export type CreateDeviceInput = {
  clubId: number;
  roomId?: number | null;
  localHubId?: number | null;
  name: string;
  serialNumber: string;
  stableId?: string | null;
  agentId?: string | null;
  androidId?: string | null;
  pairingId?: string | null;
  model?: string;
  status?: string;
  connectionStatus?: string;
  batteryPercent?: number;
};
export type CreateAppInput = {
  organizationId?: number | null;
  name: string;
  slug: string;
  packageName: string;
  visibility?: string;
};
export type CreateAppVersionInput = {
  appId: number;
  versionName: string;
  versionCode?: number | null;
  apkChecksum: string;
  downloadUrl?: string | null;
};
export type UpsertDeviceAppInput = {
  deviceId: number;
  appId?: number | null;
  appVersionId?: number | null;
  packageName: string;
  versionName?: string | null;
  versionCode?: number | null;
  installState?: string;
};
export type CreateCommandInput = {
  deviceId: number;
  localHubId: number;
  type: string;
  payload?: Record<string, unknown>;
  createdByUserId?: number | null;
  sessionId?: number | null;
  actor?: PermissionActor | null;
};
export type CommandStatusOptions = {
  errorCode?: string | null;
  result?: Record<string, unknown> | null;
  outcomeState?: "pending" | "known" | "unknown" | "reconciled";
  hubId?: number | null;
  hubInstanceId?: string | null;
  claimToken?: string | null;
  route?: string | null;
  reconciled?: boolean;
  resultDeliveryAttempt?: number | null;
};
export type CreateSessionInput = {
  title: string;
  roomId?: number | null;
  deviceIds: number[];
  appPackage: string;
  appActivity?: string;
  durationMinutes: number;
  requireScrcpy?: boolean;
  operatorNotes?: string;
  createdByUserId?: number | null;
  actor?: PermissionActor | null;
};
export type SessionActionInput = { idempotencyKey?: string | null };

export type DeviceDetail = {
  serial: string;
  stable_id?: string;
  usb_serial?: string | null;
  agent_id?: string | null;
  android_id?: string | null;
  model?: string;
  battery?: number;
  installed_apps?: Array<{ package: string; name?: string; version_name?: string; version_code?: number }>;
  storage_free_mb?: number;
  storage_total_mb?: number;
  wifi_ssid?: string;
  ip_address?: string;
  previous_ips?: string[];
  active_route?: string | null;
  current_app_package?: string;
  app_version?: string | null;
  is_charging?: boolean;
  adb_status?: "unknown" | "online" | "offline" | "reconnecting" | "unauthorized" | "tcpip_unavailable" | "port_closed" | "different_device" | "unavailable";
  agent_status?: "unknown" | "online" | "offline" | "missing" | "error";
  adb_recovery_status?: string | null;
  adb_recovery_permission?: string | null;
  wifi_ready?: boolean;
  usb_repair_required?: boolean;
  status_reason?: string;
  next_step?: string;
  transport?: string;
  wake_supported?: boolean;
  ip_changed?: boolean;
  connection_status?: string;
};

export type AgentHeartbeat = {
  agent_id?: string;
  pairing_id?: string;
  stable_id?: string;
  android_id?: string;
  model?: string;
  session_seconds?: number;
  remaining_seconds?: number;
  session_id?: number | null;
  session_revision?: number;
  session_status?: string;
  paused?: boolean;
  current_app_package?: string;
  current_app_name?: string;
  in_session?: boolean;
  local_ip?: string;
  app_version?: string;
  battery_level?: number;
  charging_state?: string;
  foreground_state?: string;
  timestamp?: number;
};

export type SyncPayload = {
  active_serials?: string[];
  device_details?: DeviceDetail[];
  hub_host?: string;
  hub_instance_id?: string;
  agent_heartbeats?: AgentHeartbeat[];
};

export type DeviceIdentity = {
  serialNumber?: string | null;
  stableId?: string | null;
  agentId?: string | null;
  androidId?: string | null;
};

export const PACKAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
export const ACTIVE_SESSION_STATUSES = ["preparing", "ready", "starting", "running", "paused", "extended", "finishing"];
export const ACTIVE_SESSION_DEVICE_STATUSES = ["preparing", "ready", "running", "paused"];
export const TERMINAL_SESSION_STATUSES = ["completed", "cancelled", "failed"];
export const SESSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["preparing", "cancelled"],
  preparing: ["ready", "starting", "finishing", "cancelled", "failed"],
  ready: ["starting", "finishing", "cancelled", "failed"],
  starting: ["running", "finishing", "cancelled", "failed"],
  running: ["paused", "extended", "finishing", "failed"],
  paused: ["running", "extended", "finishing", "failed"],
  extended: ["running", "paused", "finishing", "failed"],
  finishing: ["completed", "failed"],
  completed: [], cancelled: [], failed: [],
};
export const TECHNICAL_COMMAND_TYPES = new Set([
  "INSTALL_APP", "INSTALL_APK", "UNINSTALL_APP", "REBOOT_DEVICE", "OPEN_SCRCPY", "CLOSE_SCRCPY",
  "RUN_DIAGNOSTICS", "FORGET_DEVICE", "RECONNECT_ADB", "RELAUNCH_AGENT",
]);
export const SESSION_CONTROL_COMMAND_TYPES = new Set([
  "START_SESSION", "PAUSE_SESSION", "RESUME_SESSION", "EXTEND_SESSION", "SWITCH_SESSION_APP", "END_SESSION",
]);
export const COMMAND_TRANSITIONS: Record<string, string[]> = {
  created: ["sent_to_hub", "accepted_by_hub", "cancelled", "timeout"],
  sent_to_hub: ["accepted_by_hub", "cancelled", "timeout"],
  accepted_by_hub: ["running", "succeeded", "failed", "timeout", "cancelled"],
  running: ["succeeded", "failed", "timeout", "cancelled"],
  succeeded: [], failed: [], timeout: [], cancelled: [],
};
