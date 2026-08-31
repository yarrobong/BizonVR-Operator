import crypto from 'node:crypto';

const AGENT_TOKEN_BYTES = 32;

export function hashAgentCredential(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createAgentCredential() {
    const token = crypto.randomBytes(AGENT_TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: hashAgentCredential(token) };
}

export function buildAgentCredentialRecord(stableSerial, payload, credential, previous = {}) {
    return {
        token: credential.token,
        tokenHash: credential.tokenHash,
        pairingId: payload?.pairing_id || previous.pairingId || null,
        agentId: payload?.agent_id || previous.agentId || null,
        stableId: stableSerial,
        androidId: payload?.android_id || previous.androidId || null,
        lastTimestamp: 0,
    };
}

export function buildAgentProvisioningResult(credential) {
    return { success: true, agent_token_hash: credential.tokenHash };
}
