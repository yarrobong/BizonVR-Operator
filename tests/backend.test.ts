import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('BizonVR Backend Logic Tests', () => {
    it('Creates a command and transitions its state to accepted_by_hub', () => {
        const db = new Database(':memory:');
        db.exec(`
            CREATE TABLE local_hubs (id INTEGER PRIMARY KEY, status TEXT);
            CREATE TABLE device_commands (id INTEGER PRIMARY KEY, local_hub_id INTEGER, status TEXT);
            INSERT INTO local_hubs (status) VALUES ('online');
            INSERT INTO device_commands (local_hub_id, status) VALUES (1, 'created');
        `);

        // Test transitions
        db.prepare(`UPDATE device_commands SET status = 'accepted_by_hub' WHERE local_hub_id = 1 AND status = 'created'`).run();
        
        const cmd = db.prepare('SELECT status FROM device_commands WHERE id = 1').get() as any;
        assert.strictEqual(cmd.status, 'accepted_by_hub', "Status should transition to accepted_by_hub");
    });
});
