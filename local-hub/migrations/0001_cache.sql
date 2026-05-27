CREATE TABLE IF NOT EXISTS hub_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  local_hub_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  cloud_base_url TEXT NOT NULL,
  hub_token TEXT,
  last_successful_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_devices (
  device_id INTEGER PRIMARY KEY,
  serial_number TEXT NOT NULL,
  name TEXT NOT NULL,
  room_id INTEGER,
  room_name TEXT,
  status TEXT NOT NULL,
  adb_status TEXT NOT NULL,
  agent_status TEXT NOT NULL,
  battery_percent INTEGER,
  current_app_package TEXT,
  last_cloud_snapshot_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_device_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  package_name TEXT NOT NULL,
  app_name TEXT,
  version_name TEXT,
  install_state TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  UNIQUE (device_id, package_name)
);

CREATE TABLE IF NOT EXISTS cached_commands (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL,
  session_id INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_sessions (
  id INTEGER PRIMARY KEY,
  room_id INTEGER,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  extension_minutes INTEGER NOT NULL DEFAULT 0,
  require_scrcpy INTEGER NOT NULL DEFAULT 0,
  ends_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_session_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  launch_package_name TEXT NOT NULL,
  status TEXT NOT NULL,
  scrcpy_required INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, device_id)
);

CREATE TABLE IF NOT EXISTS cached_scrcpy_streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_stream_id INTEGER,
  device_id INTEGER NOT NULL,
  session_id INTEGER,
  status TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cached_commands_status ON cached_commands (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_outbound_events_status ON outbound_events (sync_status, created_at);
