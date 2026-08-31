ALTER TABLE device_commands ADD COLUMN payload_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE device_commands ADD COLUMN claimed_by TEXT;
ALTER TABLE device_commands ADD COLUMN claim_token TEXT;
ALTER TABLE device_commands ADD COLUMN lease_until TEXT;
ALTER TABLE device_commands ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_commands ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE device_commands ADD COLUMN next_retry_at TEXT;
ALTER TABLE device_commands ADD COLUMN outcome_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE device_commands ADD COLUMN result_json TEXT;
ALTER TABLE device_commands ADD COLUMN result_sha256 TEXT;
ALTER TABLE device_commands ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE device_commands ADD COLUMN last_transition_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE device_commands ADD COLUMN target_stable_id TEXT;
ALTER TABLE device_commands ADD COLUMN target_android_id TEXT;
ALTER TABLE device_commands ADD COLUMN target_agent_id TEXT;

CREATE TABLE IF NOT EXISTS device_command_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id INTEGER NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  hub_id INTEGER,
  hub_instance_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  route TEXT,
  elapsed_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  result_delivery_attempt INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (command_id) REFERENCES device_commands(id) ON DELETE CASCADE,
  FOREIGN KEY (hub_id) REFERENCES local_hubs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS device_command_tombstones (
  command_id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  result_sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_commands_hub_claim
  ON device_commands (local_hub_id, status, lease_until, created_at, id);
CREATE INDEX IF NOT EXISTS idx_device_commands_device_status
  ON device_commands (device_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_device_commands_retry
  ON device_commands (status, next_retry_at, lease_until);
CREATE INDEX IF NOT EXISTS idx_device_command_events_command
  ON device_command_events (command_id, created_at, id);
