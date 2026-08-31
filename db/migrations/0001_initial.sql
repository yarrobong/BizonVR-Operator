CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'technician', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'offline', 'archived')),
  address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, slug),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS club_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (club_id, slug),
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS club_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  zone_id INTEGER,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'disabled')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  map_x INTEGER NOT NULL DEFAULT 0,
  map_y INTEGER NOT NULL DEFAULT 0,
  map_w INTEGER NOT NULL DEFAULT 1,
  map_h INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (club_id, slug),
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (zone_id) REFERENCES club_zones(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS local_hubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'degraded')),
  host TEXT,
  agent_version TEXT,
  offline_mode_enabled INTEGER NOT NULL DEFAULT 1 CHECK (offline_mode_enabled IN (0, 1)),
  last_heartbeat_at TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  room_id INTEGER,
  local_hub_id INTEGER,
  name TEXT NOT NULL,
  serial_number TEXT NOT NULL UNIQUE,
  stable_id TEXT UNIQUE,
  agent_id TEXT UNIQUE,
  android_id TEXT UNIQUE,
  pairing_id TEXT UNIQUE,
  model TEXT NOT NULL DEFAULT 'Meta Quest',
  platform TEXT NOT NULL DEFAULT 'meta_quest',
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN (
      'new',
      'pairing_required',
      'online',
      'offline',
      'busy',
      'in_session',
      'installing',
      'updating',
      'maintenance_required',
      'charging_required',
      'error',
      'disabled'
    )
  ),
  connection_status TEXT NOT NULL DEFAULT 'new' CHECK (
    connection_status IN (
      'new',
      'usb_pairing_required',
      'usb_unauthorized',
      'pairing_in_progress',
      'wifi_ready',
      'online',
      'agent_online_adb_offline',
      'adb_online_agent_offline',
      'vpn_or_lan_blocked',
      'usb_repair_required',
      'offline_sleeping',
      'unknown_error'
    )
  ),
  adb_status TEXT NOT NULL DEFAULT 'unknown' CHECK (adb_status IN ('unknown', 'online', 'offline', 'reconnecting', 'unauthorized', 'tcpip_unavailable', 'port_closed', 'different_device', 'unavailable')),
  agent_status TEXT NOT NULL DEFAULT 'unknown' CHECK (agent_status IN ('unknown', 'online', 'offline', 'missing', 'error')),
  battery_percent INTEGER NOT NULL DEFAULT 100,
  is_charging INTEGER NOT NULL DEFAULT 0 CHECK (is_charging IN (0, 1)),
  wifi_ssid TEXT,
  ip_address TEXT,
  last_known_ip TEXT,
  previous_ips TEXT NOT NULL DEFAULT '[]',
  active_route TEXT,
  storage_free_mb INTEGER,
  storage_total_mb INTEGER,
  current_app_package TEXT,
  firmware_version TEXT,
  agent_version TEXT,
  needs_operator_help INTEGER NOT NULL DEFAULT 0 CHECK (needs_operator_help IN (0, 1)),
  maintenance_state TEXT NOT NULL DEFAULT 'ok' CHECK (maintenance_state IN ('ok', 'required', 'in_service')),
  status_reason TEXT,
  next_operator_step TEXT,
  last_diagnostics_at TEXT,
  identity_last_verified_at TEXT,
  last_heartbeat_at TEXT,
  last_adb_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES club_rooms(id) ON DELETE SET NULL,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  package_name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'meta_quest',
  visibility TEXT NOT NULL DEFAULT 'global' CHECK (visibility IN ('global', 'organization')),
  category TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  version_name TEXT NOT NULL,
  version_code INTEGER,
  apk_checksum TEXT NOT NULL,
  apk_size_bytes INTEGER,
  min_os_version TEXT,
  storage_required_mb INTEGER,
  download_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  UNIQUE (app_id, version_name)
);

CREATE TABLE IF NOT EXISTS device_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  app_id INTEGER,
  app_version_id INTEGER,
  package_name TEXT NOT NULL,
  version_name TEXT,
  version_code INTEGER,
  install_state TEXT NOT NULL DEFAULT 'installed' CHECK (install_state IN ('missing', 'installing', 'installed', 'failed', 'uninstalling')),
  installed_at TEXT,
  last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL,
  FOREIGN KEY (app_version_id) REFERENCES app_versions(id) ON DELETE SET NULL,
  UNIQUE (device_id, package_name)
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  max_clubs INTEGER,
  max_devices INTEGER,
  features_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organization_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  club_limit INTEGER,
  device_limit INTEGER,
  features_override_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_period_start TEXT,
  current_period_end TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  room_id INTEGER,
  local_hub_id INTEGER,
  primary_app_id INTEGER,
  primary_app_version_id INTEGER,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'preparing', 'ready', 'starting', 'running', 'paused', 'extended', 'finishing', 'completed', 'cancelled', 'failed')
  ),
  duration_minutes INTEGER NOT NULL,
  extension_minutes INTEGER NOT NULL DEFAULT 0,
  require_scrcpy INTEGER NOT NULL DEFAULT 0 CHECK (require_scrcpy IN (0, 1)),
  operator_notes TEXT,
  scheduled_start_at TEXT,
  started_at TEXT,
  ends_at TEXT,
  finished_at TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES club_rooms(id) ON DELETE SET NULL,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL,
  FOREIGN KEY (primary_app_id) REFERENCES apps(id) ON DELETE SET NULL,
  FOREIGN KEY (primary_app_version_id) REFERENCES app_versions(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS session_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'coach', 'spectator')),
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'ready', 'running', 'paused', 'finished', 'failed', 'replaced')),
  launch_package_name TEXT NOT NULL,
  scrcpy_requested INTEGER NOT NULL DEFAULT 0 CHECK (scrcpy_requested IN (0, 1)),
  scrcpy_required INTEGER NOT NULL DEFAULT 0 CHECK (scrcpy_required IN (0, 1)),
  started_at TEXT,
  finished_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  UNIQUE (session_id, device_id)
);

CREATE TABLE IF NOT EXISTS device_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  local_hub_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  session_id INTEGER,
  type TEXT NOT NULL CHECK (
    type IN (
      'PING',
      'REFRESH_STATUS',
      'INSTALL_APP',
      'INSTALL_APK',
      'UNINSTALL_APP',
      'LAUNCH_APP',
      'STOP_APP',
      'REBOOT_DEVICE',
      'OPEN_SCRCPY',
      'CLOSE_SCRCPY',
      'SHOW_MESSAGE',
      'START_SESSION',
      'END_SESSION',
      'OPEN_LAUNCHER',
      'RUN_DIAGNOSTICS',
      'FORGET_DEVICE'
    )
  ),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'sent_to_hub', 'accepted_by_hub', 'running', 'succeeded', 'failed', 'timeout', 'cancelled')
  ),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  session_device_id INTEGER,
  device_id INTEGER,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (session_device_id) REFERENCES session_devices(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS device_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  local_hub_id INTEGER,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  battery_percent INTEGER,
  is_charging INTEGER CHECK (is_charging IN (0, 1)),
  storage_free_mb INTEGER,
  storage_total_mb INTEGER,
  wifi_ssid TEXT,
  current_app_package TEXT,
  session_seconds INTEGER,
  agent_status TEXT,
  adb_status TEXT,
  connection_status TEXT,
  raw_payload TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  local_hub_id INTEGER,
  session_id INTEGER,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical', 'blocker')),
  message TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS monitoring_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  local_hub_id INTEGER,
  device_id INTEGER,
  session_id INTEGER,
  type TEXT NOT NULL CHECK (
    type IN (
      'battery_low',
      'storage_low',
      'device_offline',
      'ADB_unavailable',
      'Agent_unavailable',
      'scrcpy_failed',
      'install_failed',
      'app_missing',
      'local_hub_offline'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical', 'blocker')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TEXT,
  resolved_at TEXT,
  acknowledged_by_user_id INTEGER,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (acknowledged_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scrcpy_streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_hub_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  session_id INTEGER,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'starting', 'running', 'stopped', 'failed')),
  window_title TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT,
  last_heartbeat_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  club_id INTEGER,
  user_id INTEGER,
  local_hub_id INTEGER,
  device_id INTEGER,
  session_id INTEGER,
  command_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (local_hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (command_id) REFERENCES device_commands(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users (organization_id);
CREATE INDEX IF NOT EXISTS idx_clubs_org ON clubs (organization_id);
CREATE INDEX IF NOT EXISTS idx_zones_club ON club_zones (club_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rooms_club ON club_rooms (club_id, zone_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_local_hubs_club_status ON local_hubs (club_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_club_room ON devices (club_id, room_id);
CREATE INDEX IF NOT EXISTS idx_devices_hub_status ON devices (local_hub_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_stable_id ON devices (stable_id);
CREATE INDEX IF NOT EXISTS idx_devices_agent_id ON devices (agent_id);
CREATE INDEX IF NOT EXISTS idx_devices_android_id ON devices (android_id);
CREATE INDEX IF NOT EXISTS idx_device_apps_device ON device_apps (device_id, install_state);
CREATE INDEX IF NOT EXISTS idx_app_versions_app ON app_versions (app_id, is_active);
CREATE INDEX IF NOT EXISTS idx_commands_hub_status_created ON device_commands (local_hub_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_commands_device_created ON device_commands (device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_club_status ON sessions (club_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_session_devices_session_status ON session_devices (session_id, status);
CREATE INDEX IF NOT EXISTS idx_session_events_session_created ON session_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_captured ON device_telemetry (device_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_events_device_created ON device_events (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status_severity ON monitoring_alerts (status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrcpy_streams_device_status ON scrcpy_streams (device_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_subscriptions_org_status ON organization_subscriptions (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs (organization_id, created_at DESC);
