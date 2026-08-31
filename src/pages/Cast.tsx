import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { MonitorSmartphone, RefreshCw, TriangleAlert, Wifi } from "lucide-react";
import { DEFAULT_CAST_PROFILE, DEFAULT_CAST_TRANSPORT } from "../shared/cast-config.js";

type CastProfile = {
  key: string;
  label: string;
  description: string;
  size: string;
  bitrateLabel: string;
  fps: number;
};

type CastInfo = {
  stream_url: string;
  preview_url: string;
  diagnostic_url: string;
  cast_page_url: string;
  transport: string;
  profile: string;
  default_transport: string;
  default_profile: string;
  available_transports: string[];
  available_profiles: CastProfile[];
  device: {
    id: number;
    name: string;
    status: string;
    serial_number: string;
  };
  hub: {
    id: number;
    name: string;
    status: string;
    host: string;
    port: number;
  };
};

type StreamStatus = "idle" | "connecting" | "playing" | "error";

const CODEC_CANDIDATES = [
  'video/mp4; codecs="avc1.64001F"',
  'video/mp4; codecs="avc1.4D401F"',
  'video/mp4; codecs="avc1.42E01E"',
  "video/mp4",
];

async function readApiResponse(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.next_step || data.message || data.error || "Request failed");
  }
  return data;
}

function pickCodec() {
  if (typeof window === "undefined" || typeof MediaSource === "undefined") {
    return null;
  }
  return CODEC_CANDIDATES.find((candidate) => MediaSource.isTypeSupported(candidate)) || null;
}

function useFmp4Player(url: string | null, enabled: boolean, reloadToken: number) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!enabled || !url || !video) {
      setStatus("idle");
      setError(null);
      return;
    }

    if (typeof MediaSource === "undefined") {
      setStatus("error");
      setError("This browser does not support MediaSource playback for live Quest cast.");
      return;
    }

    const codec = pickCodec();
    if (!codec) {
      setStatus("error");
      setError("Browser H.264 fMP4 playback is unavailable. Open MJPEG preview mode as a fallback.");
      return;
    }

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const abortController = new AbortController();
    const queue: Uint8Array[] = [];
    let sourceBuffer: SourceBuffer | null = null;
    let ended = false;
    let sourceOpen = false;
    let disposed = false;
    let markedPlaying = false;

    const syncLiveEdge = () => {
      if (!video.buffered.length) return;
      const end = video.buffered.end(video.buffered.length - 1);
      const lag = end - video.currentTime;
      if (lag > 0.6) {
        video.currentTime = Math.max(end - 0.15, 0);
      } else if (lag > 0.3) {
        video.playbackRate = 1.03;
      } else {
        video.playbackRate = 1;
      }
    };

    const flushQueue = () => {
      if (!sourceBuffer || sourceBuffer.updating || queue.length === 0 || disposed) {
        return;
      }
      try {
        sourceBuffer.appendBuffer(queue.shift()!);
      } catch (appendError) {
        const message = appendError instanceof Error ? appendError.message : "appendBuffer failed";
        setStatus("error");
        setError(`Live video pipeline failed: ${message}`);
        abortController.abort();
      }
    };

    const handleSourceOpen = async () => {
      sourceOpen = true;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(codec);
        sourceBuffer.mode = "segments";
        sourceBuffer.addEventListener("updateend", () => {
          syncLiveEdge();
          flushQueue();
        });

        setStatus("connecting");
        const response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "");
          throw new Error(text || `Stream request failed with ${response.status}`);
        }

        const reader = response.body.getReader();
        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            if (mediaSource.readyState === "open") {
              mediaSource.endOfStream();
            }
            break;
          }

          if (!value || value.byteLength === 0) {
            continue;
          }

          queue.push(value);
          flushQueue();
          if (!markedPlaying) {
            markedPlaying = true;
            setStatus("playing");
            setError(null);
          }
          void video.play().catch(() => {});
        }
      } catch (streamError) {
        if (abortController.signal.aborted || disposed) {
          return;
        }
        setStatus("error");
        setError(streamError instanceof Error ? streamError.message : "Live video stream failed");
      }
    };

    mediaSource.addEventListener("sourceopen", handleSourceOpen);
    video.src = objectUrl;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    return () => {
      disposed = true;
      abortController.abort();
      if (sourceOpen && mediaSource.readyState === "open" && !ended) {
        try {
          mediaSource.endOfStream();
        } catch {}
      }
      mediaSource.removeEventListener("sourceopen", handleSourceOpen);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, reloadToken, url]);

  return { videoRef, status, error, setStatus, setError };
}

export function Cast() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const deviceId = Number(params.deviceId);
  const [reloadToken, setReloadToken] = useState(0);

  const transport = searchParams.get("transport") || DEFAULT_CAST_TRANSPORT;
  const profile = searchParams.get("profile") || DEFAULT_CAST_PROFILE;
  const isVideoMode = transport === "fmp4";
  const isPreviewMode = transport !== "fmp4";

  const castQuery = useQuery<CastInfo>({
    queryKey: ["cast-page", deviceId, transport, profile, reloadToken],
    retry: false,
    enabled: Number.isFinite(deviceId) && deviceId > 0,
    queryFn: async () => {
      const res = await fetch(`/api/devices/${deviceId}/cast?transport=${encodeURIComponent(transport)}&profile=${encodeURIComponent(profile)}`);
      return readApiResponse(res);
    },
  });

  const streamUrl = castQuery.data?.stream_url || null;
  const { videoRef, status, error, setStatus, setError } = useFmp4Player(streamUrl, Boolean(streamUrl && isVideoMode), reloadToken);

  useEffect(() => {
    if (!isVideoMode && castQuery.data?.stream_url) {
      setStatus("playing");
      setError(null);
    }
  }, [castQuery.data?.stream_url, isVideoMode, setError, setStatus]);

  const activeProfile = useMemo(
    () => castQuery.data?.available_profiles.find((item) => item.key === profile) || null,
    [castQuery.data?.available_profiles, profile],
  );

  const reconnect = () => {
    setStatus("connecting");
    setError(null);
    setReloadToken((value) => value + 1);
    castQuery.refetch();
  };

  const setMode = (nextTransport: string, nextProfile: string) => {
    setSearchParams({
      transport: nextTransport,
      profile: nextProfile,
    });
    setReloadToken((value) => value + 1);
  };

  return (
    <div className="min-h-screen bg-[#0B0F14] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-6 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link to="/map" className="text-[11px] font-bold uppercase tracking-[0.3em] text-slate-500 transition-colors hover:text-slate-300">
              Back To Map
            </Link>
            <h1 className="mt-3 text-3xl font-black uppercase tracking-tight">
              Browser Cast
              <span className="ml-3 text-slate-500">/ Quest</span>
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400">
              Low-latency cast runs through Local Hub and ADB. Use MJPEG only for preview or diagnostics when video transport fails.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={reconnect}
              className="inline-flex items-center gap-2 border border-blue-400/30 bg-blue-500/10 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-blue-100 transition-colors hover:bg-blue-500/20"
            >
              <RefreshCw className="h-4 w-4" />
              Reconnect
            </button>
            {castQuery.data && (
              <a
                href={castQuery.data.preview_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 border border-slate-500/30 bg-slate-500/10 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-100 transition-colors hover:bg-slate-500/20"
              >
                MJPEG Preview
              </a>
            )}
          </div>
        </div>

        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-hidden border border-[#1E2733] bg-black">
            {castQuery.isLoading && (
              <div className="flex aspect-video items-center justify-center text-sm text-slate-400">
                Connecting to Local Hub cast...
              </div>
            )}

            {castQuery.isError && (
              <div className="flex aspect-video flex-col items-center justify-center px-6 text-center">
                <TriangleAlert className="mb-4 h-10 w-10 text-red-300" />
                <p className="text-sm font-bold uppercase tracking-[0.25em] text-red-100">Cast unavailable</p>
                <p className="mt-3 max-w-xl text-sm leading-6 text-red-100/80">
                  {castQuery.error instanceof Error ? castQuery.error.message : "Local Hub did not provide a live cast."}
                </p>
              </div>
            )}

            {castQuery.data && isVideoMode && (
              <div className="relative aspect-video bg-black">
                <video ref={videoRef} className="h-full w-full bg-black object-contain" controls={false} autoPlay muted playsInline />
                {status !== "playing" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-slate-300">
                    {status === "error" ? error || "Live video failed" : "Buffering fMP4 stream..."}
                  </div>
                )}
              </div>
            )}

            {castQuery.data && isPreviewMode && (
              <div className="relative aspect-video bg-black">
                <img
                  src={castQuery.data.stream_url}
                  alt={`Cast preview for ${castQuery.data.device.name}`}
                  className="h-full w-full object-contain"
                  onLoad={() => {
                    setStatus("playing");
                    setError(null);
                  }}
                  onError={() => {
                    setStatus("error");
                    setError("Preview stream failed. Reconnect or switch back to live video mode.");
                  }}
                />
                {status === "error" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center text-sm text-red-100">
                    {error}
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="space-y-4">
            <div className="border border-[#1E2733] bg-[#10161F] p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Connection</div>
              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center border border-emerald-400/20 bg-emerald-500/10">
                  <Wifi className="h-5 w-5 text-emerald-300" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">
                    {castQuery.data?.device.name || `Quest #${deviceId}`}
                  </p>
                  <p className="text-xs text-slate-400">
                    {status === "playing" ? "Live video flowing" : status === "connecting" ? "Connecting to Local Hub" : status === "error" ? "Stream error" : "Idle"}
                  </p>
                </div>
              </div>
              {error && (
                <p className="mt-3 border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100">
                  {error}
                </p>
              )}
            </div>

            <div className="border border-[#1E2733] bg-[#10161F] p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Mode</div>
              <div className="mt-3 grid gap-3">
                <label className="grid gap-2 text-xs text-slate-300">
                  <span>Transport</span>
                  <select
                    value={transport}
                    onChange={(event) => setMode(event.target.value, profile)}
                    className="border border-[#2B3848] bg-[#0B1118] px-3 py-2 text-sm text-white outline-none"
                  >
                    <option value="fmp4">Live Video (fMP4)</option>
                    <option value="mpjpeg">Preview (MJPEG)</option>
                    <option value="screencap">Diagnostic (PNG)</option>
                  </select>
                </label>
                <label className="grid gap-2 text-xs text-slate-300">
                  <span>Quality Profile</span>
                  <select
                    value={profile}
                    onChange={(event) => setMode(transport, event.target.value)}
                    className="border border-[#2B3848] bg-[#0B1118] px-3 py-2 text-sm text-white outline-none"
                  >
                    {(castQuery.data?.available_profiles || []).map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="border border-[#1E2733] bg-[#10161F] p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Profile</div>
              <div className="mt-3 space-y-3 text-sm text-slate-300">
                <p className="font-semibold text-white">{activeProfile?.label || profile}</p>
                <p>{activeProfile?.description || "Profile metadata is unavailable."}</p>
                <div className="grid gap-1 text-xs text-slate-400">
                  <span>Resolution target: {activeProfile?.size || "unknown"}</span>
                  <span>Bitrate target: {activeProfile?.bitrateLabel || "unknown"}</span>
                  <span>FPS target: {activeProfile?.fps || "unknown"}</span>
                </div>
              </div>
            </div>

            <div className="border border-[#1E2733] bg-[#10161F] p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Local Hub</div>
              <div className="mt-3 grid gap-2 text-xs text-slate-300">
                <span className="inline-flex items-center gap-2">
                  <MonitorSmartphone className="h-4 w-4 text-slate-500" />
                  Serial: <span className="font-mono">{castQuery.data?.device.serial_number || "unknown"}</span>
                </span>
                <span>Host: <span className="font-mono">{castQuery.data ? `${castQuery.data.hub.host}:${castQuery.data.hub.port}` : "unknown"}</span></span>
                <span>Transport: <span className="font-mono">{transport}</span></span>
                <span>Profile: <span className="font-mono">{profile}</span></span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
