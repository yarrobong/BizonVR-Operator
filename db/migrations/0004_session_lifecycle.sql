ALTER TABLE session_devices ADD COLUMN paused_at TEXT;
ALTER TABLE session_devices ADD COLUMN total_paused_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_devices ADD COLUMN paused_remaining_seconds INTEGER;
ALTER TABLE session_devices ADD COLUMN current_app_package TEXT;
ALTER TABLE session_devices ADD COLUMN current_app_name TEXT;
ALTER TABLE session_devices ADD COLUMN last_app_switch_at TEXT;

UPDATE session_devices
SET current_app_package = COALESCE(current_app_package, launch_package_name)
WHERE current_app_package IS NULL;

CREATE TABLE device_commands_new (
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
      'PAUSE_SESSION',
      'RESUME_SESSION',
      'SWITCH_SESSION_APP',
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

INSERT INTO device_commands_new (
  id, organization_id, club_id, local_hub_id, device_id, session_id, type, payload, status,
  created_by_user_id, created_at, accepted_at, started_at, finished_at, error_code, error_message, retry_count
)
SELECT
  id, organization_id, club_id, local_hub_id, device_id, session_id, type, payload, status,
  created_by_user_id, created_at, accepted_at, started_at, finished_at, error_code, error_message, retry_count
FROM device_commands;

DROP TABLE device_commands;
ALTER TABLE device_commands_new RENAME TO device_commands;

CREATE INDEX IF NOT EXISTS idx_device_commands_hub_status_created ON device_commands (local_hub_id, status, created_at);
