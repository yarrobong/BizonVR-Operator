ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'none' CHECK (recovery_state IN ('none', 'reconciliation_required', 'operator_required'));
ALTER TABLE sessions ADD COLUMN auto_end_requested_at TEXT;

ALTER TABLE session_devices ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_devices ADD COLUMN operation_state TEXT NOT NULL DEFAULT 'idle' CHECK (
  operation_state IN ('idle', 'start_pending', 'pause_pending', 'resume_pending', 'extend_pending', 'switch_pending', 'finish_pending', 'reconciliation_required')
);
ALTER TABLE session_devices ADD COLUMN desired_app_package TEXT;
ALTER TABLE session_devices ADD COLUMN desired_app_activity TEXT;
ALTER TABLE session_devices ADD COLUMN last_command_id INTEGER;
ALTER TABLE session_devices ADD COLUMN last_agent_heartbeat_at TEXT;
ALTER TABLE session_devices ADD COLUMN last_agent_timestamp_ms INTEGER;
ALTER TABLE session_devices ADD COLUMN agent_session_id INTEGER;

CREATE TABLE IF NOT EXISTS session_action_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id INTEGER,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, device_id, action, idempotency_key),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES device_commands(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_action_requests_lookup
  ON session_action_requests (session_id, device_id, action, created_at);

-- `finishing` remains a session-level state while the per-device row stays in
-- its last physical state until END_SESSION is confirmed. This keeps the
-- device occupied throughout cleanup and makes the invariant enforceable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_devices_one_active_per_device
  ON session_devices (device_id)
  WHERE status IN ('preparing', 'ready', 'running', 'paused');

CREATE INDEX IF NOT EXISTS idx_session_devices_operation
  ON session_devices (device_id, operation_state, revision);
