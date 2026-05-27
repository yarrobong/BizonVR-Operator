import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Battery, Play, MonitorSmartphone, Square, X, AlertTriangle, PhoneCall, Sparkles, Gamepad2, Wifi, Cable } from "lucide-react";

type DeviceApp = {
  package: string;
  name: string;
  activity: string;
  icon_url?: string | null;
};

type DeviceCastInfo = {
  stream_url: string;
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

const KNOWN_APP_LABELS: Record<string, string> = {
  'com.bigscreenvr.bigscreen': 'Bigscreen',
  'com.activ8.kizunaaivr': 'Kizuna AI VR',
  'com.google.android.apps.youtube.vr.oculus': 'YouTube VR',
};

function getAppDisplayName(app: DeviceApp) {
  if (KNOWN_APP_LABELS[app.package]) {
    return KNOWN_APP_LABELS[app.package];
  }

  if (app.name && !app.name.includes('.')) {
    return app.name;
  }

  const base = app.package.split('.').pop() || app.package;
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getAppIconSrc(app: DeviceApp) {
  if (app.icon_url && !KNOWN_APP_LABELS[app.package]) {
    return app.icon_url;
  }

  const iconMap: Record<string, string> = {
    'com.bigscreenvr.bigscreen': '/app-icons/com.bigscreenvr.bigscreen.png',
    'com.google.android.apps.youtube.vr.oculus': '/app-icons/com.google.android.apps.youtube.vr.oculus.webp',
  };

  return iconMap[app.package] || null;
}

function AppIconBadge({ app, selected = false }: { app: DeviceApp; selected?: boolean }) {
  const iconClass = "w-5 h-5";
  const iconSrc = getAppIconSrc(app);
  const displayName = getAppDisplayName(app);

  if (iconSrc) {
    return (
      <div className={`w-11 h-11 shrink-0 overflow-hidden border flex items-center justify-center p-1 ${selected ? 'border-blue-300 bg-white' : 'border-slate-600 bg-white/90'}`}>
        <img src={iconSrc} alt={displayName} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (app.package === 'com.bigscreenvr.bigscreen') {
    return (
      <div className={`w-11 h-11 shrink-0 flex items-center justify-center border ${selected ? 'border-cyan-300 bg-cyan-400/20' : 'border-cyan-500/30 bg-cyan-500/10'}`}>
        <MonitorSmartphone className={`${iconClass} text-cyan-300`} />
      </div>
    );
  }

  if (app.package === 'com.google.android.apps.youtube.vr.oculus') {
    return (
      <div className={`w-11 h-11 shrink-0 flex items-center justify-center border ${selected ? 'border-red-300 bg-red-400/20' : 'border-red-500/30 bg-red-500/10'}`}>
        <Play className={`${iconClass} text-red-300 fill-red-300`} />
      </div>
    );
  }

  if (app.package === 'com.activ8.kizunaaivr') {
    return (
      <div className={`w-11 h-11 shrink-0 flex items-center justify-center border ${selected ? 'border-fuchsia-300 bg-fuchsia-400/20' : 'border-fuchsia-500/30 bg-fuchsia-500/10'}`}>
        <Sparkles className={`${iconClass} text-fuchsia-300`} />
      </div>
    );
  }

  return (
    <div className={`w-11 h-11 shrink-0 flex items-center justify-center border ${selected ? 'border-blue-300 bg-blue-400/20' : 'border-slate-600 bg-slate-800'}`}>
      <Gamepad2 className={`${iconClass} text-slate-200`} />
    </div>
  );
}

function getResolvedConnectionStatus(device: any) {
  if (device.connection_status) {
    return device.connection_status;
  }
  if (device.adb_status === "unauthorized") {
    return "usb_unauthorized";
  }
  if (device.adb_status === "online" && device.agent_status === "online") {
    return "online";
  }
  if (device.adb_status === "online" && device.wifi_ready) {
    return "wifi_ready";
  }
  if (device.adb_status === "online") {
    return "adb_online_agent_offline";
  }
  if (device.agent_status === "online") {
    return "agent_online_adb_offline";
  }
  if (device.usb_repair_required) {
    return "usb_repair_required";
  }
  return device.status ?? "unknown_error";
}

function getAdbDegradedLabel(device: any) {
  switch (device.adb_status) {
    case "reconnecting":
      return "Online, ADB reconnecting";
    case "tcpip_unavailable":
      return "Online, wireless ADB off";
    case "port_closed":
      return "Online, port 5555 closed";
    default:
      return "Online, ADB degraded";
  }
}

function getConnectivityBadge(device: any) {
  const connectionStatus = getResolvedConnectionStatus(device);
  if (connectionStatus === "online" || connectionStatus === "wifi_ready" || device.wifi_ready) {
    return {
      label: connectionStatus === "online" ? 'Online' : 'Wi-Fi Ready',
      icon: Wifi,
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    };
  }

  if (connectionStatus === "vpn_or_lan_blocked") {
    return {
      label: 'VPN/LAN Blocked',
      icon: Cable,
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    };
  }

  if (connectionStatus === "agent_online_adb_offline") {
    return {
      label: getAdbDegradedLabel(device),
      icon: Cable,
      className: 'border-orange-500/30 bg-orange-500/10 text-orange-200',
    };
  }

  if (connectionStatus === "adb_online_agent_offline") {
    return {
      label: 'Agent offline, relaunching',
      icon: Cable,
      className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
    };
  }

  if (device.wake_supported) {
    return {
      label: 'Wake via Wi-Fi',
      icon: Wifi,
      className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
    };
  }

  if (device.usb_repair_required || connectionStatus === "usb_repair_required") {
    return {
      label: 'Need USB repair',
      icon: Cable,
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    };
  }

  return {
    label: connectionStatus === "offline_sleeping" ? 'Sleeping or unreachable' : 'USB Sync',
    icon: Cable,
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-200',
  };
}

type ApiState = "permission_denied" | "subscription_blocked" | "partial_offline" | "command_failed" | "preflight_failed";

type ActionNotice = {
  state: ApiState;
  message: string;
};

async function readApiResponse(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.next_step || data.error || 'Request failed') as Error & { state?: ApiState };
    error.state = data.state || (res.status === 403 ? "permission_denied" : res.status === 402 ? "subscription_blocked" : "command_failed");
    throw error;
  }
  return data;
}

function noticeFromError(error: unknown, fallback: string): ActionNotice {
  if (error instanceof Error) {
    return {
      state: (error as Error & { state?: ApiState }).state ?? "command_failed",
      message: error.message,
    };
  }
  return { state: "command_failed", message: fallback };
}

function getNoticeTone(state: ApiState) {
  if (state === "subscription_blocked") return "border-amber-400/40 bg-amber-500/10 text-amber-100";
  if (state === "permission_denied") return "border-red-400/40 bg-red-500/10 text-red-100";
  if (state === "partial_offline") return "border-blue-400/40 bg-blue-500/10 text-blue-100";
  if (state === "preflight_failed") return "border-orange-400/40 bg-orange-500/10 text-orange-100";
  return "border-red-400/40 bg-red-500/10 text-red-100";
}

export function Map() {
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [selectedApp, setSelectedApp] = useState<string>('');
  const [duration, setDuration] = useState<number>(30);
  const [castDeviceId, setCastDeviceId] = useState<number | null>(null);
  const [castDeviceSnapshot, setCastDeviceSnapshot] = useState<any | null>(null);
  const [castState, setCastState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [castError, setCastError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);

  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const fetchDevices = async () => {
    const res = await fetch('/api/devices');
    return readApiResponse(res);
  };
  const waitForDeviceState = async (deviceId: number, predicate: (device: any) => boolean, timeoutMs = 20000) => {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      const latestDevices = await fetchDevices();
      const device = Array.isArray(latestDevices) ? latestDevices.find((item: any) => item.id === deviceId) : null;
      if (device && predicate(device)) {
        return device;
      }
      await wait(1000);
    }

    throw Object.assign(new Error('Device did not reach the expected state in time. Check Local Hub and retry.'), {
      state: 'command_failed' as ApiState,
    });
  };

  const { data: devices, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      return readApiResponse(res);
    },
    refetchInterval: 3000,
  });

  const { data: rooms } = useQuery({
    queryKey: ['rooms'],
    queryFn: async () => {
      const res = await fetch('/api/rooms');
      return readApiResponse(res);
    },
    refetchInterval: 10000,
  });

  const startSession = useMutation({
    mutationFn: async ({ deviceId, appPackage, appActivity, durationMinutes }: { deviceId: number, appPackage: string, appActivity?: string, durationMinutes: number }) => {
      const res = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId,
          app_package: appPackage,
          app_activity: appActivity,
          duration_minutes: durationMinutes
        })
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Session preflight failed"));
    }
  });

  const switchApp = useMutation({
    mutationFn: async ({ deviceId, appPackage, appActivity, durationMinutes }: { deviceId: number, appPackage: string, appActivity?: string, durationMinutes: number }) => {
      const stopRes = await fetch(`/api/sessions/${deviceId}/stop`, { method: 'POST' });
      await readApiResponse(stopRes);

      await waitForDeviceState(deviceId, (device) => device.status === 'online');

      const startRes = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId,
          app_package: appPackage,
          app_activity: appActivity,
          duration_minutes: durationMinutes,
        }),
      });
      return readApiResponse(startRes);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, 'App switch failed'));
    }
  });

  const stopSession = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/sessions/${deviceId}/stop`, {
        method: 'POST'
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Session stop failed"));
    }
  });

  const installAgent = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/install_agent`, {
        method: 'POST'
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Agent install failed"));
    }
  });

  const dismissHelp = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/dismiss_help`, {
        method: 'POST'
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Dismiss help request failed"));
    }
  });

  useEffect(() => {
    if (devices && devices.some((d: any) => d.needs_help)) {
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.type = 'square';
        oscillator.frequency.value = 880;
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.2);
        
        const oscillator2 = audioCtx.createOscillator();
        const gainNode2 = audioCtx.createGain();
        oscillator2.connect(gainNode2);
        gainNode2.connect(audioCtx.destination);
        oscillator2.type = 'square';
        oscillator2.frequency.value = 660;
        gainNode2.gain.setValueAtTime(0.1, audioCtx.currentTime + 0.3);
        oscillator2.start(audioCtx.currentTime + 0.3);
        oscillator2.stop(audioCtx.currentTime + 0.5);
      } catch (e) {
        console.error(e);
      }
    }
  }, [devices]);

  const selectedDevice = devices?.find((d: any) => d.id === selectedDeviceId);
  const castDevice = devices?.find((d: any) => d.id === castDeviceId) || castDeviceSnapshot;
  const availableApps: DeviceApp[] = (() => {
    if (!selectedDevice?.installed_apps) return [];
    try {
      return JSON.parse(selectedDevice.installed_apps);
    } catch (e) {
      return [];
    }
  })();
  const selectedAppEntry = availableApps.find((app) => app.package === selectedApp);

  useEffect(() => {
    if (!isModalOpen) return;
    if (availableApps.length === 0) {
      setSelectedApp('');
      return;
    }
    if (!availableApps.some((app) => app.package === selectedApp)) {
      setSelectedApp(availableApps[0].package);
    }
  }, [isModalOpen, availableApps, selectedApp]);

  const castQuery = useQuery<DeviceCastInfo>({
    queryKey: ['map-device-cast', castDeviceId],
    enabled: !!castDeviceId,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/devices/${castDeviceId}/cast`);
      return readApiResponse(res);
    },
  });

  useEffect(() => {
    if (!castQuery.data?.stream_url) return;

    setCastState("ready");
    setCastError(null);
  }, [castQuery.data?.stream_url]);

  const openCastPanel = (device: any) => {
    setCastDeviceId(device.id);
    setCastDeviceSnapshot(device);
    setCastState("loading");
    setCastError(null);
  };

  const closeCastPanel = () => {
    setCastDeviceId(null);
    setCastDeviceSnapshot(null);
    setCastState("idle");
    setCastError(null);
  };

  if (isLoading) return <div className="p-8 text-sm text-slate-400">Loading map...</div>;

  const partialOffline = Array.isArray(devices) && devices.some((device: any) => {
    const connectionStatus = getResolvedConnectionStatus(device);
    return connectionStatus === "offline" || connectionStatus === "usb_repair_required" || connectionStatus === "agent_online_adb_offline" || connectionStatus === "adb_online_agent_offline" || device.adb_status === "offline" || device.usb_repair_required;
  });
  const visibleNotice = actionNotice ?? (partialOffline
    ? { state: "partial_offline" as const, message: "Part of the club is offline or needs USB repair. Fix Local Hub/ADB readiness before launching affected sessions." }
    : null);

  return (
    <div className="flex-1 flex gap-6 p-6 h-full bg-[#0F1115]">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex justify-between items-center mb-6">
        <div>
           <h1 className="text-2xl font-bold uppercase tracking-tighter">Main Floor <span className="text-slate-500">/ Club Map</span></h1>
           <p className="text-xs text-slate-400 mt-1">Live status of your VR arenas.</p>
        </div>
        <div className="flex gap-2">
          <button className="px-4 py-2 bg-[#1C2128] border border-[#2D3139] text-[10px] font-bold uppercase hover:bg-[#2D3139] transition-colors">Refresh Map</button>
          <button className="px-4 py-2 bg-[#1C2128] border border-[#2D3139] text-[10px] font-bold uppercase hover:bg-[#2D3139] transition-colors">Cast All</button>
        </div>
      </div>

      {visibleNotice && (
        <div className={`mb-4 border px-4 py-3 text-xs font-semibold uppercase tracking-wide ${getNoticeTone(visibleNotice.state)}`}>
          <span className="mr-2 font-black">{visibleNotice.state.replace(/_/g, " ")}</span>
          <span className="normal-case tracking-normal">{visibleNotice.message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 flex-1">
        {/* Unassigned Devices Section */}
        {(() => {
          const unassignedDevices = devices?.filter((d: any) => d.room_id === null) || [];
          if (unassignedDevices.length === 0) return null;
          
          return (
            <div className="col-span-1 md:col-span-2 lg:col-span-3 mb-8">
              <h2 className="text-xl font-black italic text-amber-500 uppercase mb-4">Unassigned Devices (Pairing Required)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {unassignedDevices.map((dev: any) => (
                  <div key={dev.id} className="bg-amber-500/10 border border-amber-500/30 p-4 flex flex-col justify-between">
                    <div>
                      <span className="text-[10px] font-mono text-amber-500 uppercase leading-none">S/N: {dev.serial_number}</span>
                      <h3 className="text-xl font-black italic text-white">{dev.name}</h3>
                      <div className="mt-2 text-xs text-slate-400">Battery: {dev.battery}% | Status: {dev.status}</div>
                    </div>
                    <div className="mt-4 flex gap-2">
                       <select 
                         className="flex-1 bg-[#0F1115] border border-[#2D3139] text-xs text-white p-2"
                         onChange={(e) => {
                             if (e.target.value) {
                                 fetch(`/api/devices/${dev.id}/assign`, {
                                     method: 'POST',
                                     headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify({ room_id: e.target.value })
                                 })
                                   .then(readApiResponse)
                                   .then(() => queryClient.invalidateQueries({ queryKey: ['devices'] }))
                                   .catch((error) => setActionNotice(noticeFromError(error, 'Assign failed')));
                             }
                         }}
                         defaultValue=""
                       >
                         <option value="" disabled>Assign to Room...</option>
                         {rooms?.map((r: any) => (
                           <option key={r.id} value={r.id}>{r.name}</option>
                         ))}
                       </select>
                       <button
                         className="bg-blue-500/10 text-blue-500 border border-blue-500/30 text-[10px] font-bold uppercase hover:bg-blue-500/20 px-2"
                         onClick={() => installAgent.mutate(dev.id)}
                       >
                         Install Agent
                       </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {rooms?.map((room: any) => {
          const roomDevices = devices?.filter((d: any) => d.room_id === room.id) || [];
          return (
            <div key={room.id} className="col-span-1 md:col-span-2 lg:col-span-3">
              <h2 className="text-xl font-black italic text-slate-300 uppercase mb-4">{room.name}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {roomDevices.map((dev: any) => {
                  const isOnline = dev.status === 'online' || dev.status === 'in_session';
                  const canStartFromSleep = dev.adb_status === 'online' && (dev.status === 'online' || dev.status === 'in_session');
                  const isLowBattery = dev.battery < 20;
                  const isHelpRequested = dev.needs_help === 1;
                  const connectivity = getConnectivityBadge(dev);
                  const ConnectivityIcon = connectivity.icon;

                  return (
                    <div key={dev.id} className={`bg-[#16191E] border p-4 flex flex-col relative group ${isHelpRequested ? 'border-red-500 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.5)]' : (isOnline ? 'border-blue-500' : 'border-[#2D3139] opacity-40 grayscale')} transition-all`}>
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <span className={`text-[10px] font-mono uppercase leading-none ${isHelpRequested ? 'text-red-500 font-bold' : (isOnline ? 'text-blue-400' : 'text-slate-500')}`}>S/N: {dev.serial_number}</span>
                          <h3 className={`text-xl font-black italic ${isHelpRequested ? 'text-red-500' : (!isOnline ? 'text-slate-400' : '')}`}>{dev.name}</h3>
                        </div>
                        <div className="flex flex-col items-end">
                          <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-tight ${isHelpRequested ? 'bg-red-500/20 text-red-500' : (dev.status === 'in_session' ? 'bg-amber-500/10 text-amber-500' : (isOnline ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-500'))}`}>
                            {isHelpRequested ? 'NEEDS HELP' : dev.status}
                          </span>
                        </div>
                      </div>

                      {isHelpRequested && (
                        <div className="absolute inset-0 bg-red-500/10 backdrop-blur-sm z-30 flex flex-col items-center justify-center">
                          <AlertTriangle className="w-12 h-12 text-red-500 mb-2 animate-bounce" />
                          <div className="text-red-500 font-black uppercase text-xl mb-4">Operator Called</div>
                          <button
                            className="bg-red-500 text-white font-bold uppercase px-6 py-2 text-sm shadow-lg hover:bg-red-600 transition-colors"
                            onClick={() => dismissHelp.mutate(dev.id)}
                          >
                            Dismiss
                          </button>
                        </div>
                      )}

                      {isOnline ? (
                        <div className="flex-1 bg-[#0F1115] relative overflow-hidden group">
                        <div className="p-4 flex flex-col h-full justify-between">
                          <div>
                            <div className="text-xs text-slate-500 uppercase">Current Session</div>
                            <div className="text-sm font-bold">
                              {dev.status === 'in_session' ? (
                                  dev.session_seconds !== undefined && dev.session_seconds > 0
                                    ? `Running: ${Math.floor(dev.session_seconds / 60)}m ${dev.session_seconds % 60}s`
                                    : 'Running User Session...'
                                ) : 'Ready / Waiting'}
                              </div>
                              <div className={`mt-3 inline-flex items-center gap-2 border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${connectivity.className}`}>
                                <ConnectivityIcon className="h-3.5 w-3.5" />
                                <span>{connectivity.label}</span>
                              </div>
                              <p className="mt-2 min-h-8 text-[11px] leading-4 text-slate-400">
                                {dev.status_reason || 'Waiting for Local Hub Wi-Fi ADB diagnostics.'}
                              </p>
                            </div>
                            <div className="mt-4 space-y-2">
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 flex-1 bg-slate-800">
                                  <div className={`h-full ${isLowBattery ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${dev.battery}%` }}></div>
                                </div>
                                <span className="text-[10px] font-mono">{dev.battery}%</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex-1 border-2 border-dashed border-slate-800 flex items-center justify-center min-h-[120px]">
                          <span className="text-[10px] font-bold uppercase text-slate-500">Offline</span>
                        </div>
                      )}

                      <div className="flex gap-2 mt-4 relative z-20">
                        <button 
                          className={`flex-1 border py-2 text-[10px] font-bold uppercase transition-colors ${dev.status === 'in_session' ? 'bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20' : 'bg-red-500/5 text-red-500/50 border-red-500/10 cursor-not-allowed'}`}
                          disabled={dev.status !== 'in_session'}
                          onClick={() => stopSession.mutate(dev.id)}
                        >
                          Stop
                        </button>
                        <button 
                          className={`flex-1 border py-2 text-[10px] font-bold uppercase transition-colors ${canStartFromSleep ? 'bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20' : 'bg-[#1C2128] border-[#2D3139] cursor-not-allowed text-slate-600'}`}
                          disabled={!canStartFromSleep}
                          onClick={() => {
                              setSelectedDeviceId(dev.id);
                              setIsModalOpen(true);
                          }}
                        >
                          {dev.status === 'in_session' ? 'Switch App' : 'Start'}
                        </button>
                        <button
                          className={`border p-2 transition-colors ${dev.adb_status === 'online' ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white' : 'bg-[#1C2128] border-[#2D3139] text-slate-600 cursor-not-allowed'}`}
                          disabled={dev.adb_status !== 'online'}
                          onClick={() => openCastPanel(dev)}
                          title="View Screen In Panel"
                        >
                          <MonitorSmartphone className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {roomDevices.length === 0 && (
                  <div className="col-span-1 bg-[#16191E] border border-dashed border-[#2D3139] p-4 flex items-center justify-center min-h-[200px]">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">No Devices found</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </div>

      <aside className="flex w-[26rem] shrink-0 flex-col border border-[#2D3139] bg-[#16191E]">
        <div className="flex items-center justify-between border-b border-[#2D3139] px-5 py-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Live Cast</div>
            <h2 className="mt-1 text-lg font-black uppercase tracking-tight text-slate-100">
              {castDevice ? castDevice.name : 'Select Headset'}
            </h2>
          </div>
          {castDevice && (
            <button
              onClick={closeCastPanel}
              className="inline-flex h-9 w-9 items-center justify-center border border-[#2D3139] text-slate-400 transition-colors hover:border-slate-500 hover:text-white"
              title="Close Cast Panel"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4 p-5">
          {!castDevice && (
            <div className="flex flex-1 items-center justify-center border border-dashed border-[#2D3139] bg-[#11141A] px-6 text-center">
              <div>
                <MonitorSmartphone className="mx-auto mb-4 h-10 w-10 text-slate-600" />
                <p className="text-sm font-semibold uppercase tracking-wide text-slate-300">Cast not selected</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Press the monitor button on any online Quest to open its view here instead of a separate window.
                </p>
              </div>
            </div>
          )}

          {castDevice && castQuery.isLoading && (
            <div className="flex flex-1 items-center justify-center border border-[#2D3139] bg-[#11141A] px-6 text-center">
              <div>
                <MonitorSmartphone className="mx-auto mb-4 h-8 w-8 animate-pulse text-blue-400" />
                <p className="text-sm font-semibold uppercase tracking-wide text-slate-200">Connecting to Local Hub</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Preparing embedded cast inside the club map.
                </p>
              </div>
            </div>
          )}

          {castDevice && castQuery.isError && (
            <div className="flex flex-1 items-center justify-center border border-red-500/30 bg-red-500/5 px-6 text-center">
              <div>
                <AlertTriangle className="mx-auto mb-4 h-9 w-9 text-red-400" />
                <p className="text-sm font-semibold uppercase tracking-wide text-red-200">Cast unavailable</p>
                <p className="mt-2 text-xs leading-5 text-red-100/80">
                  {castQuery.error instanceof Error ? castQuery.error.message : 'Reconnect Local Hub and retry.'}
                </p>
              </div>
            </div>
          )}

          {castDevice && castQuery.data && (
            <>
              <div className="overflow-hidden border border-[#2D3139] bg-black">
                {castState === "error" && (
                  <div className="flex aspect-[4/3] items-center justify-center bg-[#05070A] px-6 text-center">
                    <div>
                      <MonitorSmartphone className="mx-auto mb-3 h-7 w-7 text-blue-400" />
                      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-300">
                        Stream failed
                      </p>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        {castError || 'Local Hub could not capture the Quest screen. Check ADB and retry.'}
                      </p>
                    </div>
                  </div>
                )}
                <img
                  src={castQuery.data.stream_url}
                  alt={`Live cast for ${castDevice.name}`}
                  className={`aspect-[4/3] w-full object-cover ${castState === "error" ? "hidden" : "block"}`}
                  onLoad={() => {
                    setCastState("ready");
                    setCastError(null);
                  }}
                  onError={() => {
                    setCastState("error");
                    setCastError("Local Hub did not return a live stream. Verify that the headset is online and ADB is available.");
                  }}
                />
              </div>

              <div className="grid gap-3 text-xs text-slate-300">
                <div className="flex items-center justify-between border border-[#2D3139] bg-[#11141A] px-4 py-3">
                  <span className="uppercase tracking-[0.25em] text-slate-500">Device</span>
                  <span className="font-mono">{castQuery.data.device.serial_number}</span>
                </div>
                <div className="flex items-center justify-between border border-[#2D3139] bg-[#11141A] px-4 py-3">
                  <span className="uppercase tracking-[0.25em] text-slate-500">Local Hub</span>
                  <span className="font-mono">{castQuery.data.hub.host}:{castQuery.data.hub.port}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {isModalOpen && selectedDeviceId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#16191E] border border-[#2D3139] shadow-2xl overflow-hidden w-full max-w-md flex flex-col">
             <div className="px-6 py-4 border-b border-[#2D3139] flex justify-between items-center bg-[#1C2128]">
                 <h3 className="text-sm font-bold uppercase tracking-widest text-slate-200">{selectedDevice?.status === 'in_session' ? 'Switch App' : 'Start Session'}</h3>
                 <button onClick={() => setIsModalOpen(false)} className="text-slate-500 hover:text-white">
                     <X className="w-5 h-5" />
                 </button>
             </div>
             <div className="p-6 flex flex-col gap-6">
                 <div className="flex flex-col gap-2">
                     <label className="text-[10px] font-bold uppercase text-slate-500 tracking-widest">Select Game</label>
                     {availableApps.length === 0 ? (
                         <div className="bg-[#0F1115] border border-[#2D3139] text-sm text-slate-500 p-3">
                           No launchable apps detected
                         </div>
                     ) : (
                         <div className="grid gap-2 max-h-64 overflow-auto pr-1">
                           {availableApps.map(app => {
                             const isSelected = app.package === selectedApp;
                             return (
                               <button
                                 key={app.package}
                                 type="button"
                                 onClick={() => setSelectedApp(app.package)}
                                 className={`w-full text-left border p-3 transition-colors ${isSelected ? 'border-blue-500 bg-blue-500/10' : 'border-[#2D3139] bg-[#0F1115] hover:border-slate-500'}`}
                               >
                                 <div className="flex items-center gap-3">
                                   <AppIconBadge app={app} selected={isSelected} />
                                   <div className="min-w-0">
                                     <div className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-slate-200'}`}>{getAppDisplayName(app)}</div>
                                     <div className="text-[10px] font-mono text-slate-500 truncate">{app.package}</div>
                                   </div>
                                 </div>
                               </button>
                             );
                           })}
                         </div>
                     )}
                 </div>
                 
                 <div className="flex flex-col gap-2">
                     <label className="text-[10px] font-bold uppercase text-slate-500 tracking-widest">Duration</label>
                     <div className="grid grid-cols-3 gap-2">
                         {[15, 30, 60].map(min => (
                             <button 
                                 key={min} 
                                 onClick={() => setDuration(min)}
                                 className={`py-3 text-xs font-bold font-mono transition-colors border ${duration === min ? 'bg-blue-500/20 border-blue-500 text-blue-400' : 'bg-[#0F1115] border-[#2D3139] text-slate-400 hover:border-slate-500'}`}
                             >
                                 {min} MIN
                             </button>
                         ))}
                     </div>
                 </div>

                 <div className="bg-[#0F1115] border border-[#2D3139] p-4 flex flex-col gap-3">
                     <div className="text-[10px] font-bold uppercase text-slate-500 tracking-widest mb-1">Pre-flight Check</div>
                     {(() => {
                         const device = devices?.find((d: any) => d.id === selectedDeviceId);
                         const isBatteryOk = device?.battery >= 5;
                         const isOnline = device?.status === 'online' || device?.status === 'in_session';
                         const hasLaunchableApps = availableApps.length > 0;
                         const isPreFlightOk = isBatteryOk && isOnline && hasLaunchableApps;

                         return (
                             <>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-slate-300">Target Device:</span>
                                    <span className="text-xs font-mono font-bold text-white">{device?.name} ({device?.serial_number})</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${isBatteryOk ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                                    <span className={`text-xs ${isBatteryOk ? 'text-slate-300' : 'text-red-400 font-bold'}`}>Battery {isBatteryOk ? 'OK' : 'Low'} ({device?.battery}%)</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                                    <span className={`text-xs ${isOnline ? 'text-slate-300' : 'text-red-400 font-bold'}`}>Network {isOnline ? 'Connected' : 'Offline'}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${hasLaunchableApps ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                                    <span className={`text-xs ${hasLaunchableApps ? 'text-slate-300' : 'text-red-400 font-bold'}`}>Apps {hasLaunchableApps ? `${availableApps.length} detected` : 'Not detected'}</span>
                                </div>
                                {selectedAppEntry && (
                                    <div className="mt-2 flex items-center gap-3 border border-[#2D3139] bg-[#11151B] p-3">
                                        <AppIconBadge app={selectedAppEntry} selected />
                                        <div className="min-w-0">
                                            <div className="text-xs font-bold text-white">{getAppDisplayName(selectedAppEntry)}</div>
                                            <div className="text-[10px] font-mono text-slate-500 truncate">{selectedAppEntry.package}</div>
                                        </div>
                                    </div>
                                )}
                                {!isPreFlightOk && (
                                        <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 flex items-start gap-2">
                                        <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                                        <div className="text-[10px] text-red-400 uppercase tracking-wide">Cannot start session. Resolve issues first.</div>
                                    </div>
                                )}
                             </>
                         )
                     })()}
                 </div>

             </div>
             <div className="p-4 border-t border-[#2D3139] bg-[#1C2128] grid grid-cols-2 gap-3">
                <button onClick={() => setIsModalOpen(false)} className="py-3 text-[10px] font-bold uppercase tracking-widest bg-transparent border border-[#2D3139] text-slate-400 hover:text-white transition-colors">Cancel</button>
                <button 
                  onClick={() => {
                      const mutation = selectedDevice?.status === 'in_session' ? switchApp : startSession;
                      mutation.mutate({ deviceId: selectedDeviceId, appPackage: selectedApp, appActivity: selectedAppEntry?.activity, durationMinutes: duration });
                      setIsModalOpen(false);
                  }} 
                  disabled={(() => {
                      const device = devices?.find((d: any) => d.id === selectedDeviceId);
                      return !(device?.battery >= 5 && (device?.status === 'online' || device?.status === 'in_session') && selectedApp);
                  })()}
                  className={`py-3 text-[10px] font-bold uppercase tracking-widest transition-colors ${(() => {
                      const device = devices?.find((d: any) => d.id === selectedDeviceId);
                      return (device?.battery >= 5 && (device?.status === 'online' || device?.status === 'in_session') && selectedApp) ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-slate-800 text-slate-500 cursor-not-allowed';
                  })()}`}
                >
                    {selectedDevice?.status === 'in_session' ? 'Switch' : 'Launch'}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
