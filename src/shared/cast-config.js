export const CAST_TRANSPORTS = ["fmp4", "mpjpeg", "screencap"];
export const DEFAULT_CAST_TRANSPORT = "fmp4";
export const PREVIEW_CAST_TRANSPORT = "mpjpeg";
export const DIAGNOSTIC_CAST_TRANSPORT = "screencap";

export const CAST_QUALITY_PROFILES = {
  "low-latency": {
    key: "low-latency",
    label: "Low Latency",
    description: "720p target with tighter buffering for operator control.",
    width: 1280,
    height: 720,
    size: "1280x720",
    bitrate: "10000000",
    bitrateLabel: "10 Mbps",
    fps: 30,
  },
  balanced: {
    key: "balanced",
    label: "Balanced",
    description: "Higher detail while keeping the stream responsive.",
    width: 1600,
    height: 900,
    size: "1600x900",
    bitrate: "14000000",
    bitrateLabel: "14 Mbps",
    fps: 30,
  },
  performance: {
    key: "performance",
    label: "Performance",
    description: "Fallback profile for weaker hosts or unstable Wi-Fi.",
    width: 1024,
    height: 576,
    size: "1024x576",
    bitrate: "4000000",
    bitrateLabel: "4 Mbps",
    fps: 15,
  },
};

export const DEFAULT_CAST_PROFILE = "low-latency";
export const PREVIEW_CAST_PROFILE = "performance";

export function isValidCastTransport(value) {
  return CAST_TRANSPORTS.includes(String(value || ""));
}

export function isValidCastProfile(value) {
  return Object.prototype.hasOwnProperty.call(CAST_QUALITY_PROFILES, String(value || ""));
}

export function resolveCastTransport(value, fallback = DEFAULT_CAST_TRANSPORT) {
  return isValidCastTransport(value) ? String(value) : fallback;
}

export function resolveCastProfile(value, fallback = DEFAULT_CAST_PROFILE) {
  return isValidCastProfile(value) ? String(value) : fallback;
}

export function buildStreamUrl({
  host,
  port,
  serial,
  transport = DEFAULT_CAST_TRANSPORT,
  profile = DEFAULT_CAST_PROFILE,
  ts = Date.now(),
}) {
  const params = new URLSearchParams({
    transport,
    profile,
    ts: String(ts),
  });
  return `http://${host}:${port}/streams/${encodeURIComponent(String(serial))}?${params.toString()}`;
}

export function buildCastPageUrl({
  deviceId,
  transport = DEFAULT_CAST_TRANSPORT,
  profile = DEFAULT_CAST_PROFILE,
}) {
  const params = new URLSearchParams({
    transport,
    profile,
  });
  return `/cast/${deviceId}?${params.toString()}`;
}
