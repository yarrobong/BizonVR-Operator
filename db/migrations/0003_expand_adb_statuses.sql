CREATE TABLE IF NOT EXISTS devices_v2 (
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
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN (
      'new',
      'pairing_required',
      'online',
      'offline',
      'busy',
      'in_session',
      'maintenance',
      'warning',
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
  adb_status TEXT NOT NULL DEFAULT 'unknown' CHECK (adb_status IN ('unknown', 'online', 'offline', 'reconnecting', 'unauthorized', 'tcpip_unavailable', 'port_closed', 'unavailable')),
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

INSERT INTO devices_v2 (
  id, club_id, room_id, local_hub_id, name, serial_number, stable_id, agent_id, android_id, pairing_id, model,
  status, connection_status, adb_status, agent_status, battery_percent, is_charging, wifi_ssid, ip_address,
  last_known_ip, previous_ips, active_route, storage_free_mb, storage_total_mb, current_app_package,
  firmware_version, agent_version, needs_operator_help, maintenance_state, status_reason, next_operator_step,
  last_diagnostics_at, identity_last_verified_at, last_heartbeat_at, last_adb_seen_at, last_seen_at, created_at, updated_at
)
SELECT
  id, club_id, room_id, local_hub_id, name, serial_number, stable_id, agent_id, android_id, pairing_id, model,
  status, connection_status, adb_status, agent_status, battery_percent, is_charging, wifi_ssid, ip_address,
  last_known_ip, previous_ips, active_route, storage_free_mb, storage_total_mb, current_app_package,
  firmware_version, agent_version, needs_operator_help, maintenance_state, status_reason, next_operator_step,
  last_diagnostics_at, identity_last_verified_at, last_heartbeat_at, last_adb_seen_at, last_seen_at, created_at, updated_at
FROM devices;

DROP TABLE devices;
ALTER TABLE devices_v2 RENAME TO devices;

CREATE INDEX IF NOT EXISTS idx_devices_club_status ON devices (club_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_local_hub ON devices (local_hub_id);
CREATE INDEX IF NOT EXISTS idx_devices_stable_id ON devices (stable_id);
CREATE INDEX IF NOT EXISTS idx_devices_agent_id ON devices (agent_id);
CREATE INDEX IF NOT EXISTS idx_devices_android_id ON devices (android_id);
