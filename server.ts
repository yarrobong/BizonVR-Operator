import express from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import Database from 'better-sqlite3';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize SQLite database
const db = new Database(':memory:');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS clubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subscription_tier TEXT DEFAULT 'Start'
  );

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER,
    name TEXT NOT NULL,
    FOREIGN KEY(club_id) REFERENCES clubs(id)
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER,
    name TEXT NOT NULL,
    FOREIGN KEY(branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS local_hubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'offline',
    last_heartbeat DATETIME,
    FOREIGN KEY(branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER,
    room_id INTEGER,
    name TEXT NOT NULL,
    serial_number TEXT UNIQUE NOT NULL,
    pairing_id TEXT,
    status TEXT DEFAULT 'new',
    battery INTEGER DEFAULT 100,
    session_seconds INTEGER DEFAULT 0,
    needs_help BOOLEAN DEFAULT 0,
    last_heartbeat DATETIME,
    FOREIGN KEY(branch_id) REFERENCES branches(id),
    FOREIGN KEY(room_id) REFERENCES rooms(id)
  );

  CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_hub_id INTEGER,
    device_id INTEGER,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT 'created',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(local_hub_id) REFERENCES local_hubs(id),
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER,
    app_package TEXT NOT NULL,
    duration_minutes INTEGER,
    status TEXT DEFAULT 'running',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed initial data
db.exec(`
  INSERT INTO clubs (name) VALUES ('BizonVR Main');
  INSERT INTO branches (club_id, name) VALUES (1, 'Downtown Branch');
  INSERT INTO rooms (branch_id, name) VALUES (1, 'Main Arena');
  INSERT INTO rooms (branch_id, name) VALUES (1, 'Private Room A');
  INSERT INTO local_hubs (branch_id, name, status, last_heartbeat) VALUES (1, 'Hub 1', 'online', datetime('now'));
  INSERT INTO devices (branch_id, room_id, name, serial_number, pairing_id, status, battery, last_heartbeat) 
  VALUES (1, 1, 'Quest 3 - 01', '1G0YK01234', '1234', 'online', 90, datetime('now'));
`);


// --- API Routes ---

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Clubs
app.get("/api/clubs", (req, res) => {
  const clubs = db.prepare('SELECT * FROM clubs').all();
  res.json(clubs);
});

// Branches
app.get("/api/branches", (req, res) => {
  const branches = db.prepare('SELECT * FROM branches').all();
  res.json(branches);
});

// Rooms
app.get("/api/rooms", (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms').all();
  res.json(rooms);
});

// Local Hubs
app.get("/api/hubs", (req, res) => {
  const hubs = db.prepare('SELECT * FROM local_hubs').all();
  res.json(hubs);
});

// Devices
app.get("/api/devices", (req, res) => {
  const devices = db.prepare('SELECT * FROM devices').all();
  res.json(devices);
});

// Assign Device to Room
app.post("/api/devices/:id/assign", (req, res) => {
  const deviceId = req.params.id;
  const { room_id } = req.body;
  if (!room_id) {
      return res.status(400).json({ error: "room_id is required" });
  }
  db.prepare(`UPDATE devices SET room_id = ?, status = 'online' WHERE id = ?`).run(room_id, deviceId);
  res.json({ success: true });
});

// Start Scrcpy
app.post("/api/devices/:id/scrcpy", (req, res) => {
  const deviceId = req.params.id;
  const device = db.prepare('SELECT id, branch_id FROM devices WHERE id = ?').get(deviceId) as any;
  if (!device) return res.status(404).json({ error: "Device not found" });

  const hub = db.prepare('SELECT id FROM local_hubs WHERE branch_id = ?').get(device.branch_id) as any;
  if (!hub) return res.status(404).json({ error: "No Local Hub found for this branch" });

  db.prepare(`INSERT INTO device_commands (local_hub_id, device_id, type, payload) VALUES (?, ?, ?, ?)`).run(hub.id, deviceId, 'OPEN_SCRCPY', JSON.stringify({}));
  
  res.json({ success: true });
});

// Install Agent
app.post("/api/devices/:id/install_agent", (req, res) => {
  const deviceId = req.params.id;
  const device = db.prepare('SELECT id, branch_id FROM devices WHERE id = ?').get(deviceId) as any;
  if (!device) return res.status(404).json({ error: "Device not found" });

  const hub = db.prepare('SELECT id FROM local_hubs WHERE branch_id = ?').get(device.branch_id) as any;
  if (!hub) return res.status(404).json({ error: "No Local Hub found for this branch" });

  db.prepare(`INSERT INTO device_commands (local_hub_id, device_id, type, payload) VALUES (?, ?, ?, ?)`).run(hub.id, deviceId, 'INSTALL_APK', JSON.stringify({}));
  
  res.json({ success: true });
});

// Commands
app.get("/api/commands", (req, res) => {
  const commands = db.prepare('SELECT * FROM device_commands ORDER BY created_at DESC').all();
  res.json(commands);
});

app.post("/api/commands", (req, res) => {
  const { local_hub_id, device_id, type, payload } = req.body;
  if (!local_hub_id || !device_id || !type) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const result = db.prepare(`
    INSERT INTO device_commands (local_hub_id, device_id, type, payload) 
    VALUES (?, ?, ?, ?)
  `).run(local_hub_id, device_id, type, JSON.stringify(payload));

  db.prepare(`INSERT INTO audit_logs (action, details) VALUES (?, ?)`).run('CREATE_COMMAND', JSON.stringify({ type, device_id }));

  res.json({ id: result.lastInsertRowid, status: 'created' });
});

// Sessions
app.get("/api/sessions", (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
  res.json(sessions);
});

app.post("/api/sessions/start", (req, res) => {
  const { device_id, app_package, duration_minutes } = req.body;
  const device = db.prepare('SELECT id, branch_id FROM devices WHERE id = ?').get(device_id) as any;
  if (!device) return res.status(404).json({ error: "Device not found" });

  const hub = db.prepare('SELECT id FROM local_hubs WHERE branch_id = ?').get(device.branch_id) as any;
  if (!hub) return res.status(404).json({ error: "No Local Hub found for this branch" });
  
  const sessionResult = db.prepare(`INSERT INTO sessions (device_id, app_package, duration_minutes) VALUES (?, ?, ?)`).run(device_id, app_package, duration_minutes);
  
  const payload = {
     session_id: sessionResult.lastInsertRowid,
     package: app_package,
     duration_minutes: duration_minutes
  };
  
  db.prepare(`INSERT INTO device_commands (local_hub_id, device_id, type, payload) VALUES (?, ?, ?, ?)`).run(hub.id, device_id, 'START_SESSION', JSON.stringify(payload));
  db.prepare(`UPDATE devices SET status = 'in_session' WHERE id = ?`).run(device_id);

  res.json({ success: true, session_id: sessionResult.lastInsertRowid });
});

// Help calls
app.post("/api/hub/call_operator", (req, res) => {
  const { pairing_id } = req.body;
  if (!pairing_id) return res.status(400).json({ error: "Missing pairing_id" });
  
  db.prepare(`UPDATE devices SET needs_help = 1 WHERE pairing_id = ?`).run(pairing_id);
  res.json({ success: true });
});

app.post("/api/devices/:id/dismiss_help", (req, res) => {
  const deviceId = req.params.id;
  db.prepare(`UPDATE devices SET needs_help = 0 WHERE id = ?`).run(deviceId);
  res.json({ success: true });
});

app.post("/api/sessions/:device_id/stop", (req, res) => {
  const device_id = req.params.device_id;
  
  const session = db.prepare('SELECT * FROM sessions WHERE device_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(device_id, 'running') as any;
  const app_package = session ? session.app_package : 'com.bizonvr.questagent';

  if (session) {
     db.prepare(`UPDATE sessions SET status = 'completed' WHERE id = ?`).run(session.id);
  }
  db.prepare(`UPDATE devices SET status = 'online' WHERE id = ?`).run(device_id);

  const device = db.prepare('SELECT id, branch_id FROM devices WHERE id = ?').get(device_id) as any;
  if (device) {
    const hub = db.prepare('SELECT id FROM local_hubs WHERE branch_id = ?').get(device.branch_id) as any;
    if (hub) {
      db.prepare(`INSERT INTO device_commands (local_hub_id, device_id, type, payload) VALUES (?, ?, ?, ?)`).run(hub.id, device_id, 'END_SESSION', JSON.stringify({ package: app_package }));
    }
  }
  
  res.json({ success: true });
});

// Agent Heartbeat
app.post("/api/agent/heartbeat", (req, res) => {
  // In MVP, we just receive this, but don't strictly require it matching to update devices, 
  // since Local Hub ADB poll acts as the source of truth for "online" status.
  // But we could use this for agent-specific data (timer, in_session).
  res.json({ success: true });
});

// Local Hub Poll / Sync
app.post("/api/hubs/:id/sync", (req, res) => {
  const hubId = req.params.id;
  const { active_serials, device_details, agent_heartbeats } = req.body;
  
  // Update heartbeat
  db.prepare(`UPDATE local_hubs SET last_heartbeat = datetime('now'), status = 'online' WHERE id = ?`).run(hubId);
  
  // Update devices status, battery, and auto-register new ones
  const detailsArray = device_details || (active_serials ? active_serials.map((s: string) => ({ serial: s })) : []);
  
  if (detailsArray.length > 0) {
      const hub = db.prepare(`SELECT branch_id FROM local_hubs WHERE id = ?`).get(hubId) as any;
      
      db.transaction(() => {
          for (const d of detailsArray) {
              const existing = db.prepare(`SELECT id FROM devices WHERE serial_number = ?`).get(d.serial) as any;
              
              if (existing) {
                  // Update existing device
                  if (d.battery !== undefined) {
                      db.prepare(`UPDATE devices SET battery = ?, last_heartbeat = datetime('now') WHERE serial_number = ?`).run(d.battery, d.serial);
                  }
                  // We only set online if it was offline. If 'new', 'in_session' we probably shouldn't override 'in_session' with 'online'
                  db.prepare(`UPDATE devices SET status = 'online' WHERE serial_number = ? AND (status = 'offline' OR status = 'new')`).run(d.serial);
              } else if (hub) {
                  // Auto-register new device
                  db.prepare(`
                      INSERT INTO devices (branch_id, room_id, name, serial_number, status, battery, last_heartbeat) 
                      VALUES (?, NULL, ?, ?, 'new', ?, datetime('now'))
                  `).run(hub.branch_id, `New Quest - ${d.serial.substring(0, 4)}`, d.serial, d.battery || 100);
              }
          }
      })();
  }

  // Process Agent Heartbeats (forwarded by Local Hub)
  if (agent_heartbeats && Array.isArray(agent_heartbeats)) {
      const updateStmt = db.prepare(`UPDATE devices SET session_seconds = ?, status = CASE WHEN ? = 1 THEN 'in_session' ELSE status END WHERE pairing_id = ?`);
      db.transaction(() => {
          for (const hb of agent_heartbeats) {
              if (hb.pairing_id) {
                  updateStmt.run(hb.session_seconds || 0, hb.in_session ? 1 : 0, hb.pairing_id);
              }
          }
      })();
  }
  
  // Fetch pending commands for this hub
  const pendingCommands = db.prepare(`
    SELECT * FROM device_commands 
    WHERE local_hub_id = ? AND status = 'created'
  `).all(hubId) as any[];

  // Mark pending commands as accepted_by_hub
  if (pendingCommands.length > 0) {
    const ids = pendingCommands.map(c => c.id).join(',');
    db.prepare(`UPDATE device_commands SET status = 'accepted_by_hub', updated_at = datetime('now') WHERE id IN (${ids})`).run();
  }

  res.json({ commands: pendingCommands });
});

app.post("/api/commands/:id/status", (req, res) => {
  const cmdId = req.params.id;
  const { status, error_message } = req.body;
  
  const result = db.prepare(`UPDATE device_commands SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?`).run(status, error_message, cmdId);
  
  res.json({ success: result.changes > 0 });
});

// Audit Logs
app.get("/api/audit-logs", (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50').all();
  res.json(logs);
});


// Vite middleware for development or fallback for production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
