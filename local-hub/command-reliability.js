import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * Command delivery is at-least-once. The store makes execution idempotent for
 * commands whose effect can be observed and makes ambiguous effects explicit
 * instead of retrying them blindly after a process crash.
 */
export const COMMAND_POLICIES = Object.freeze({
    PING: { timeoutMs: 5000, retryable: true, idempotent: true, reconciliable: false, dangerous: false, cancellable: true },
    REFRESH_STATUS: { timeoutMs: 10000, retryable: true, idempotent: true, reconciliable: false, dangerous: false, cancellable: true },
    RUN_DIAGNOSTICS: { timeoutMs: 30000, retryable: true, idempotent: true, reconciliable: false, dangerous: false, cancellable: true },
    OPEN_LAUNCHER: { timeoutMs: 15000, retryable: true, idempotent: true, reconciliable: true, dangerous: false, cancellable: true },
    LAUNCH_APP: { timeoutMs: 15000, retryable: false, idempotent: true, reconciliable: true, dangerous: false, cancellable: true },
    STOP_APP: { timeoutMs: 10000, retryable: false, idempotent: true, reconciliable: true, dangerous: false, cancellable: true },
    OPEN_SCRCPY: { timeoutMs: 10000, retryable: true, idempotent: true, reconciliable: true, dangerous: false, cancellable: true },
    CLOSE_SCRCPY: { timeoutMs: 10000, retryable: true, idempotent: true, reconciliable: true, dangerous: false, cancellable: true },
    RECONNECT_ADB: { timeoutMs: 30000, retryable: true, idempotent: true, reconciliable: false, dangerous: false, cancellable: true },
    SHOW_MESSAGE: { timeoutMs: 10000, retryable: false, idempotent: true, reconciliable: false, dangerous: false, cancellable: true },
    START_SESSION: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    PAUSE_SESSION: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    RESUME_SESSION: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    EXTEND_SESSION: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    SWITCH_SESSION_APP: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    END_SESSION: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    INSTALL_APP: { timeoutMs: 120000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    INSTALL_APK: { timeoutMs: 120000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    UNINSTALL_APP: { timeoutMs: 30000, retryable: false, idempotent: true, reconciliable: true, dangerous: true, cancellable: false },
    FORGET_DEVICE: { timeoutMs: 15000, retryable: false, idempotent: true, reconciliable: false, dangerous: true, cancellable: false },
    REBOOT_DEVICE: { timeoutMs: 15000, retryable: false, idempotent: true, reconciliable: false, dangerous: true, cancellable: false },
});

export const DEFAULT_COMMAND_POLICY = Object.freeze({
    timeoutMs: 30000, retryable: false, idempotent: false, reconciliable: false, dangerous: true, cancellable: false,
});

export function getCommandPolicy(type) {
    const policy = COMMAND_POLICIES[String(type)] || DEFAULT_COMMAND_POLICY;
    return { ...policy, maxAttempts: policy.retryable ? 3 : 1 };
}

function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
    }
    return value;
}

export function canonicalPayload(payload) {
    let value = payload;
    if (typeof payload === 'string') {
        try { value = JSON.parse(payload || '{}'); } catch { value = {}; }
    }
    return JSON.stringify(normalize(value || {}));
}

export function hashPayload(payload) {
    return crypto.createHash('sha256').update(canonicalPayload(payload)).digest('hex');
}

export function createExecutionStore(filename = path.resolve(process.cwd(), '.cache', 'local-hub', 'command-state.sqlite')) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new Database(filename);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS command_execution (
            command_id INTEGER PRIMARY KEY,
            device_stable_id TEXT NOT NULL,
            type TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT,
            effect_applied_at TEXT,
            completed_at TEXT,
            state TEXT NOT NULL CHECK (state IN ('received', 'running', 'effect_applied', 'completed', 'unknown_outcome', 'cancelled')),
            attempt INTEGER NOT NULL DEFAULT 0,
            result_json TEXT,
            result_hash TEXT,
            error_code TEXT,
            error_message TEXT,
            UNIQUE(command_id, payload_hash)
        );
        CREATE TABLE IF NOT EXISTS result_outbox (
            command_id INTEGER PRIMARY KEY,
            claim_token TEXT,
            status TEXT NOT NULL,
            result_json TEXT NOT NULL,
            result_hash TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_command_execution_state ON command_execution(state, completed_at);
        CREATE INDEX IF NOT EXISTS idx_result_outbox_pending ON result_outbox(delivered_at, next_attempt_at);
    `);

    const get = db.prepare('SELECT * FROM command_execution WHERE command_id = ?');
    const receive = db.prepare(`
        INSERT INTO command_execution (command_id, device_stable_id, type, payload_hash, state)
        VALUES (?, ?, ?, ?, 'received')
        ON CONFLICT(command_id) DO NOTHING
    `);

    function recordReceived(command) {
        const commandId = Number(command.id);
        const computedPayloadHash = hashPayload(command.payload);
        if (command.payload_hash && String(command.payload_hash) !== computedPayloadHash) {
            return { kind: 'integrity_violation', entry: get.get(commandId), payloadHash: computedPayloadHash, reason: 'Cloud payload hash does not match payload' };
        }
        const payloadHash = computedPayloadHash;
        receive.run(commandId, String(command.device_stable_id || command.target_stable_id || command.device_serial_number || command.device_id), String(command.type), payloadHash);
        const existing = get.get(commandId);
        if (!existing) throw new Error(`Execution journal could not record command ${commandId}`);
        if (existing.payload_hash !== payloadHash || existing.type !== String(command.type) || existing.device_stable_id !== String(command.device_stable_id || command.target_stable_id || command.device_serial_number || command.device_id)) {
            return { kind: 'integrity_violation', entry: existing, payloadHash };
        }
        return { kind: 'recorded', entry: existing, payloadHash };
    }

    function claim(command, options = {}) {
        const journal = recordReceived(command);
        if (journal.kind === 'integrity_violation') return journal;
        const current = get.get(Number(command.id));
        const policy = getCommandPolicy(command.type);
        if (current.state === 'completed' || current.state === 'effect_applied') return { kind: 'already_done', entry: current };
        if (current.state === 'unknown_outcome') return { kind: 'reconciliation_required', entry: current, policy };
        if (current.state === 'running') return { kind: 'in_flight', entry: current };
        if (command.cancel_requested || current.state === 'cancelled') return { kind: 'cancelled', entry: current };
        const result = db.prepare(`
            UPDATE command_execution
            SET state = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), attempt = attempt + 1
            WHERE command_id = ? AND state IN ('received', 'cancelled')
        `).run(Number(command.id));
        if (result.changes !== 1) return { kind: 'in_flight', entry: get.get(Number(command.id)) };
        return { kind: 'claimed', entry: get.get(Number(command.id)), policy };
    }

    function markEffectApplied(commandId, result) {
        const resultJson = JSON.stringify(result || {});
        const resultHash = hashPayload(result || {});
        const updated = db.prepare(`
            UPDATE command_execution
            SET state = 'effect_applied', effect_applied_at = COALESCE(effect_applied_at, CURRENT_TIMESTAMP), result_json = ?, result_hash = ?
            WHERE command_id = ? AND state = 'running'
        `).run(resultJson, resultHash, Number(commandId));
        if (updated.changes !== 1 && get.get(Number(commandId))?.result_hash !== resultHash) {
            throw new Error(`Command ${commandId} effect journal conflict`);
        }
        return get.get(Number(commandId));
    }

    function complete(commandId, result, options = {}) {
        const resultJson = JSON.stringify(result || {});
        const resultHash = hashPayload(result || {});
        const current = get.get(Number(commandId));
        if (!current) throw new Error(`Command ${commandId} is not in execution journal`);
        if (current.result_hash && current.result_hash !== resultHash) throw new Error(`Command ${commandId} completed with incompatible result`);
        const tx = db.transaction(() => {
        db.prepare(`
            UPDATE command_execution
            SET state = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), result_json = ?, result_hash = ?, error_code = NULL, error_message = NULL
            WHERE command_id = ? AND state IN ('running', 'effect_applied', 'received', 'unknown_outcome')
        `).run(resultJson, resultHash, Number(commandId));
            db.prepare(`
                INSERT INTO result_outbox (command_id, claim_token, status, result_json, result_hash)
                VALUES (?, ?, 'succeeded', ?, ?)
                ON CONFLICT(command_id) DO UPDATE SET
                    claim_token = COALESCE(excluded.claim_token, result_outbox.claim_token),
                    status = CASE WHEN result_outbox.result_hash = excluded.result_hash OR (result_outbox.status = 'timeout' AND excluded.status = 'succeeded') THEN excluded.status ELSE result_outbox.status END,
                    result_json = CASE WHEN result_outbox.result_hash = excluded.result_hash OR (result_outbox.status = 'timeout' AND excluded.status = 'succeeded') THEN excluded.result_json ELSE result_outbox.result_json END,
                    result_hash = CASE WHEN result_outbox.result_hash = excluded.result_hash OR (result_outbox.status = 'timeout' AND excluded.status = 'succeeded') THEN excluded.result_hash ELSE result_outbox.result_hash END,
                    delivered_at = CASE WHEN excluded.status = 'succeeded' AND result_outbox.status = 'timeout' THEN NULL ELSE result_outbox.delivered_at END
            `).run(Number(commandId), options.claimToken || null, resultJson, resultHash);
        });
        tx();
        return get.get(Number(commandId));
    }

    function fail(commandId, error, options = {}) {
        const errorCode = options.errorCode || 'COMMAND_EXECUTION_FAILED';
        const message = error instanceof Error ? error.message : String(error || 'Command failed');
        const current = get.get(Number(commandId));
        if (!current) throw new Error(`Command ${commandId} is not in execution journal`);
        db.prepare(`
            UPDATE command_execution SET state = 'completed', completed_at = CURRENT_TIMESTAMP, error_code = ?, error_message = ?, result_json = ?, result_hash = ?
            WHERE command_id = ? AND state IN ('running', 'received')
        `).run(errorCode, message, JSON.stringify({ success: false, error: message, error_code: errorCode }), hashPayload({ success: false, error: message, error_code: errorCode }), Number(commandId));
        const result = { success: false, error: message, error_code: errorCode };
        const resultJson = JSON.stringify(result);
        db.prepare(`
            INSERT INTO result_outbox (command_id, claim_token, status, result_json, result_hash)
            VALUES (?, ?, 'failed', ?, ?)
            ON CONFLICT(command_id) DO NOTHING
        `).run(Number(commandId), options.claimToken || null, resultJson, hashPayload(result));
        return get.get(Number(commandId));
    }

    function markUnknown(commandId, error, options = {}) {
        const message = error instanceof Error ? error.message : String(error || 'Command outcome is unknown');
        db.prepare(`
            UPDATE command_execution SET state = 'unknown_outcome', error_code = ?, error_message = ?
            WHERE command_id = ? AND state IN ('running', 'effect_applied')
        `).run(options.errorCode || 'COMMAND_OUTCOME_UNKNOWN', message, Number(commandId));
        return get.get(Number(commandId));
    }

    function enqueue(commandId, status, result, options = {}) {
        const resultJson = JSON.stringify(result || {});
        const resultHash = hashPayload(result || {});
        const existing = db.prepare('SELECT result_hash, status FROM result_outbox WHERE command_id = ?').get(Number(commandId));
        if (existing && existing.result_hash !== resultHash && !(existing.status === 'timeout' && status === 'succeeded')) throw new Error(`Result outbox conflict for command ${commandId}`);
        db.prepare(`
            INSERT INTO result_outbox (command_id, claim_token, status, result_json, result_hash)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(command_id) DO UPDATE SET
                status = CASE WHEN result_outbox.status = 'timeout' AND excluded.status = 'succeeded' THEN excluded.status ELSE result_outbox.status END,
                result_json = CASE WHEN result_outbox.status = 'timeout' AND excluded.status = 'succeeded' THEN excluded.result_json ELSE result_outbox.result_json END,
                result_hash = CASE WHEN result_outbox.status = 'timeout' AND excluded.status = 'succeeded' THEN excluded.result_hash ELSE result_outbox.result_hash END,
                delivered_at = CASE WHEN result_outbox.status = 'timeout' AND excluded.status = 'succeeded' THEN NULL ELSE result_outbox.delivered_at END
        `).run(Number(commandId), options.claimToken || null, status, resultJson, resultHash);
    }

    function pendingOutbox(limit = 100) {
        return db.prepare(`SELECT * FROM result_outbox WHERE delivered_at IS NULL AND attempt < 8 AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP) ORDER BY command_id ASC LIMIT ?`).all(Math.max(1, Math.min(1000, Number(limit))));
    }

    function resetExhaustedOutbox() {
        db.prepare(`UPDATE result_outbox SET attempt = 0, next_attempt_at = NULL WHERE delivered_at IS NULL AND attempt >= 8 AND next_attempt_at <= CURRENT_TIMESTAMP`).run();
    }

    function markOutboxDelivered(commandId) {
        db.prepare('UPDATE result_outbox SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP) WHERE command_id = ?').run(Number(commandId));
    }

    function markOutboxAttempt(commandId, error, backoffMs = 1000) {
        db.prepare(`
            UPDATE result_outbox SET attempt = attempt + 1, last_error = ?, next_attempt_at = datetime('now', '+' || ? || ' seconds') WHERE command_id = ?
        `).run(String(error || 'delivery failed'), Math.max(1, Math.ceil(backoffMs / 1000)), Number(commandId));
    }

    function prune(options = {}) {
        const days = Math.max(1, Number(options.retentionDays || 30));
        const maxRows = Math.max(100, Number(options.maxRows || 10000));
        db.prepare(`DELETE FROM result_outbox WHERE delivered_at IS NOT NULL AND delivered_at < datetime('now', '-' || ? || ' days')`).run(days);
        db.prepare(`DELETE FROM command_execution WHERE state = 'completed' AND completed_at < datetime('now', '-' || ? || ' days') AND command_id NOT IN (SELECT command_id FROM result_outbox)`).run(days);
        const count = db.prepare(`SELECT COUNT(*) AS count FROM command_execution`).get() || { count: 0 };
        if (Number(count.count) > maxRows) {
            db.prepare(`DELETE FROM command_execution WHERE state = 'completed' AND command_id IN (SELECT command_id FROM command_execution WHERE state = 'completed' ORDER BY completed_at ASC LIMIT ?)` ).run(Number(count.count) - maxRows);
        }
    }

    function recoverAfterRestart(command) {
        const hadLocalJournal = Boolean(get.get(Number(command.id)));
        const current = get.get(Number(command.id));
        const policy = getCommandPolicy(command.type);
        if (!current) {
            const recorded = recordReceived(command);
            if (recorded.kind === 'integrity_violation') return recorded;
        }
        const recoveredEntry = get.get(Number(command.id));
        if (!recoveredEntry) return { kind: 'integrity_violation', reason: 'Missing execution journal entry after recovery' };
        if (recoveredEntry.payload_hash !== (command.payload_hash || hashPayload(command.payload))) return { kind: 'integrity_violation', entry: recoveredEntry };
        if (command.recovery_required && !hadLocalJournal) {
            if (policy.reconciliable || policy.dangerous) {
                db.prepare(`UPDATE command_execution SET state = 'unknown_outcome', error_code = 'COMMAND_OUTCOME_UNKNOWN', error_message = 'Cloud lease was recovered but this Hub has no local execution journal' WHERE command_id = ?`).run(Number(command.id));
                return { kind: policy.reconciliable ? 'reconciliation_required' : 'unknown_outcome', entry: get.get(Number(command.id)), policy };
            }
            return claim(command);
        }
        if (recoveredEntry.state === 'running' || recoveredEntry.state === 'effect_applied') {
            if (policy.reconciliable) return { kind: 'reconciliation_required', entry: recoveredEntry, policy };
            db.prepare(`UPDATE command_execution SET state = 'unknown_outcome', error_code = 'COMMAND_OUTCOME_UNKNOWN', error_message = 'Hub restarted while the side effect was in progress' WHERE command_id = ?`).run(Number(command.id));
            return { kind: 'unknown_outcome', entry: get.get(Number(command.id)), policy };
        }
        return claim(command);
    }

    function close() { db.close(); }
    return { db, recordReceived, claim, markEffectApplied, complete, fail, markUnknown, enqueue, pendingOutbox, resetExhaustedOutbox, markOutboxDelivered, markOutboxAttempt, recoverAfterRestart, prune, get: (id) => get.get(Number(id)), close };
}
