import {
  CAST_QUALITY_PROFILES,
  DEFAULT_CAST_PROFILE,
  DEFAULT_CAST_TRANSPORT,
  isValidCastProfile,
  isValidCastTransport,
  resolveCastProfile,
  resolveCastTransport,
} from "../src/shared/cast-config.js";

export function resolveStreamRequest(requestedTransport, requestedProfile) {
  if (requestedTransport && !isValidCastTransport(requestedTransport)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `UNKNOWN_TRANSPORT`,
        message: `Unknown cast transport "${requestedTransport}"`,
        supported_transports: ["fmp4", "mpjpeg", "screencap"],
      },
    };
  }

  if (requestedProfile && !isValidCastProfile(requestedProfile)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `UNKNOWN_PROFILE`,
        message: `Unknown cast quality profile "${requestedProfile}"`,
        supported_profiles: Object.keys(CAST_QUALITY_PROFILES),
      },
    };
  }

  return {
    ok: true,
    transport: resolveCastTransport(requestedTransport, DEFAULT_CAST_TRANSPORT),
    profileKey: resolveCastProfile(requestedProfile, DEFAULT_CAST_PROFILE),
  };
}

export function getStreamProfile(profileKey) {
  return CAST_QUALITY_PROFILES[resolveCastProfile(profileKey, DEFAULT_CAST_PROFILE)];
}

export function buildAdbScreenrecordArgs(executionSerial, profile, displayArgs = []) {
  return [
    "-s",
    executionSerial,
    "exec-out",
    "screenrecord",
    "--output-format=h264",
    ...displayArgs,
    "--size",
    profile.size,
    "--bit-rate",
    profile.bitrate,
    "--time-limit",
    "0",
    "-",
  ];
}

export function buildFfmpegArgs(transport, profile) {
  if (transport === "fmp4") {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-f",
      "h264",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      "50000",
      "-min_frag_duration",
      "50000",
      "-f",
      "mp4",
      "pipe:1",
    ];
  }

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-f",
    "h264",
    "-i",
    "pipe:0",
    "-vf",
    `fps=${profile.fps}`,
    "-pix_fmt",
    "yuvj420p",
    "-an",
    "-c:v",
    "mjpeg",
    "-strict",
    "unofficial",
    "-q:v",
    "5",
    "-threads",
    "1",
    "-f",
    "mpjpeg",
    "pipe:1",
  ];
}

export function stopChildProcess(proc, signal = "SIGTERM") {
  if (!proc || proc.killed) {
    return false;
  }

  try {
    proc.kill(signal);
    return true;
  } catch {
    return false;
  }
}

export function createStreamStopper({ adbProc, ffmpegProc, clearBootTimer, onStop }) {
  let stopped = false;

  return {
    stop(reason = "client_disconnect") {
      if (stopped) {
        return false;
      }

      stopped = true;
      clearBootTimer?.();
      stopChildProcess(adbProc);
      stopChildProcess(ffmpegProc);
      onStop?.(reason);
      return true;
    },
  };
}

export function isResponseWritable(res) {
  return Boolean(res) && !res.destroyed && !res.writableEnded;
}

export function safeWriteHead(res, statusCode, headers = {}) {
  if (!isResponseWritable(res) || res.headersSent) {
    return false;
  }

  try {
    res.writeHead(statusCode, headers);
    return true;
  } catch {
    return false;
  }
}

export function safeWrite(res, chunk) {
  if (!isResponseWritable(res)) {
    return false;
  }

  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export function safeEnd(res, chunk) {
  if (!res || res.destroyed || res.writableEnded) {
    return false;
  }

  try {
    if (chunk !== undefined) {
      res.end(chunk);
    } else {
      res.end();
    }
    return true;
  } catch {
    return false;
  }
}

export function getFallbackResponseStrategy(res) {
  if (!isResponseWritable(res)) {
    return "abandon";
  }

  if (res.headersSent) {
    return "close";
  }

  return "inline";
}
