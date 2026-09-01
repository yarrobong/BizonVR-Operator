const SENSITIVE_KEY = /token|secret|credential|password|authorization|bearer/i;

function redact(value, key = '') {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) {
        let redactNext = false;
        return value.map((item) => {
            if (redactNext) { redactNext = false; return '[REDACTED]'; }
            if (typeof item === 'string' && /^(AGENT_TOKEN|HUB_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(item)) {
                redactNext = true;
                return item;
            }
            return redact(item);
        });
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]));
    }
    if (typeof value === 'string' && /^Bearer\s+/i.test(value)) return 'Bearer [REDACTED]';
    return value;
}

export function redactSensitive(value) {
    return redact(value);
}

export function createLogger({ clock = () => new Date() } = {}) {
    function log(scope, message, extra = null) {
        const prefix = `[${clock().toISOString()}] [${scope}] ${message}`;
        if (extra === null || extra === undefined) console.log(prefix);
        else console.log(prefix, redactSensitive(extra));
    }

    function error(message, extra = null) {
        if (extra === null || extra === undefined) console.error(message);
        else console.error(message, redactSensitive(extra));
    }

    function warn(message, extra = null) {
        if (extra === null || extra === undefined) console.warn(message);
        else console.warn(message, redactSensitive(extra));
    }

    return Object.freeze({ log, error, warn, redact: redactSensitive });
}
