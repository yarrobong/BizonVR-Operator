import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Battery, Play, MonitorSmartphone, Square, X, AlertTriangle, PhoneCall, Sparkles, Gamepad2, Wifi, Cable, Wrench } from "lucide-react";
import { canRepairWireless, getCastAvailability, getOperatorStatus, getResolvedConnectionStatus, getSessionAvailability, hasUsbRoute, isOperatorReachable, isReadyForWirelessControl } from "../lib/operatorStatus";
import { formatRemainingTime, getSessionUiState, type SessionCardState } from "../lib/sessionUi";

type DeviceApp = {
  package: string;
  name: string;
  activity: string;
  icon_url?: string | null;
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

function getAdbDegradedLabel(device: any) {
  switch (device.adb_status) {
    case "reconnecting":
      return "Online, ADB reconnecting";
    case "tcpip_unavailable":
      return "Online, wireless ADB off";
    case "port_closed":
      return "Online, port 5555 closed";
    case "different_device":
      return "ADB route mismatch";
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

function connectivityFallbackTitle(device: any) {
  const badge = getConnectivityBadge(device);
  return badge.label;
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
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [repairingDeviceId, setRepairingDeviceId] = useState<number | null>(null);
  const [recentlyRecoveredDeviceId, setRecentlyRecoveredDeviceId] = useState<number | null>(null);

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
    mutationFn: async ({ sessionId, appPackage, appActivity }: { sessionId: number, appPackage: string, appActivity?: string }) => {
      const res = await fetch(`/api/sessions/${sessionId}/switch-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_package: appPackage,
          app_activity: appActivity,
        }),
      });
      return readApiResponse(res);
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
    mutationFn: async ({ deviceId }: { deviceId: number }) => {
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

  const pauseCurrentSession = useMutation({
    mutationFn: async (sessionId: number) => {
      const res = await fetch(`/api/sessions/${sessionId}/pause`, { method: 'POST' });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Session pause failed"));
    }
  });

  const resumeCurrentSession = useMutation({
    mutationFn: async (sessionId: number) => {
      const res = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Session resume failed"));
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

  const repairDevice = useMutation({
    mutationFn: async (deviceId: number) => {
      setRepairingDeviceId(deviceId);
      setRecentlyRecoveredDeviceId(null);
      const res = await fetch(`/api/devices/${deviceId}/repair`, { method: 'POST' });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice({ state: "partial_offline", message: "Восстанавливаем Wi-Fi ADB. Не отключайте USB, пока статус не станет зелёным." });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setRepairingDeviceId(null);
      setActionNotice(noticeFromError(error, "USB Repair failed"));
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
  const selectedSession = (selectedDevice?.active_session ?? null) as SessionCardState | null;
  const selectedSessionUi = getSessionUiState(selectedSession);

  useEffect(() => {
    if (!repairingDeviceId || !Array.isArray(devices)) {
      return;
    }
    const recovered = devices.find((device: any) => device.id === repairingDeviceId && isReadyForWirelessControl(device));
    if (recovered) {
      setRepairingDeviceId(null);
      setRecentlyRecoveredDeviceId(recovered.id);
      setActionNotice({ state: "partial_offline", message: "Wi-Fi ADB восстановлен. Теперь можно отключить USB." });
    }
  }, [devices, repairingDeviceId]);
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

  const openCastWindow = (deviceId: number) => {
    window.open(`/cast/${deviceId}`, "_blank", "noopener,noreferrer");
  };

  if (isLoading) return <div className="p-8 text-sm text-slate-400">Loading map...</div>;

  const partialOffline = Array.isArray(devices) && devices.some((device: any) => {
    const connectionStatus = getResolvedConnectionStatus(device);
    return connectionStatus === "offline" || connectionStatus === "usb_repair_required" || connectionStatus === "agent_online_adb_offline" || connectionStatus === "adb_online_agent_offline" || device.adb_status === "offline" || device.usb_repair_required;
  });
  const helpRequests = Array.isArray(devices) ? devices.filter((device: any) => device.needs_help === 1) : [];
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

      {helpRequests.length > 0 && (
        <div className="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-50">
          <div className="font-black uppercase tracking-[0.2em] text-red-200">Operator Call</div>
          <div className="mt-1">
            {helpRequests.map((device: any) => device.name).join(", ")} {helpRequests.length === 1 ? "ждет" : "ждут"} оператора.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 flex-1">
        {/* Unassigned Devices Section */}
        {(() => {
          const unassignedDevices = devices?.filter((d: any) => d.room_id === null) || [];
          if (unassignedDevices.length === 0) return null;
          
          return (
            <div className="col-span-1 md:col-span-2 lg:col-span-3 mb-8">
              <div className="mb-4">
                <h2 className="text-xl font-black italic text-amber-500 uppercase">Unassigned Devices</h2>
                <p className="mt-2 max-w-3xl text-sm text-slate-400">
                  Эти шлемы уже видны оператору, но ещё не назначены комнате. Назначьте место, чтобы они появились на карте зала.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {unassignedDevices.map((dev: any) => (
                  <div key={dev.id} className="bg-amber-500/10 border border-amber-500/30 p-4 flex flex-col justify-between">
                    {(() => {
                      const operatorStatus = getOperatorStatus(dev, {
                        repairPending: repairingDeviceId === dev.id || (repairDevice.isPending && repairDevice.variables === dev.id),
                        recentlyRecovered: recentlyRecoveredDeviceId === dev.id,
                      });

                      return (
                        <>
                    <div>
                      <span className="text-[10px] font-mono text-amber-500 uppercase leading-none">S/N: {dev.serial_number}</span>
                      <h3 className="text-xl font-black italic text-white">{dev.name}</h3>
                      <div className="mt-2 text-xs text-slate-400">Battery: {dev.battery}%</div>
                      <div className={`mt-3 border px-3 py-3 ${operatorStatus.tone}`}>
                        <div className="text-[10px] font-bold uppercase tracking-[0.18em]">Статус оператора</div>
                        <p className="mt-1 text-sm font-semibold text-white">{operatorStatus.title}</p>
                        <p className="mt-2 text-[12px] leading-5 text-inherit">{operatorStatus.message}</p>
                        {operatorStatus.secondary && (
                          <p className="mt-2 text-[12px] leading-5 text-inherit/90">{operatorStatus.secondary}</p>
                        )}
                        {operatorStatus.showRepair && (
                          <button
                            onClick={() => repairDevice.mutate(dev.id)}
                            disabled={!hasUsbRoute(dev) || repairingDeviceId === dev.id}
                            className="mt-3 inline-flex items-center gap-2 border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-50 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Wrench className="h-3.5 w-3.5" />
                            <span>Восстановить Wi-Fi ADB</span>
                          </button>
                        )}
                      </div>
                      <p className="mt-3 text-[12px] leading-5 text-slate-300">
                        Шлем работает, но пока не привязан к комнате.
                      </p>
                      <details className="mt-3 border border-[#2D3139] bg-[#11141A] px-3 py-2 text-[11px] text-slate-400">
                        <summary className="cursor-pointer list-none font-semibold text-slate-300">Техническая информация</summary>
                        <div className="mt-3 grid gap-1 font-mono text-[10px] text-slate-500">
                          <span>agent: {dev.agent_status || "unknown"} / adb: {dev.adb_status || "unknown"}</span>
                          <span>route: {dev.active_route || dev.serial_number}</span>
                          <span>ip: {dev.wifi_ip || "unknown"}</span>
                          <span>android id: {dev.android_id || "unknown"}</span>
                        </div>
                      </details>
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
                        </>
                      );
                    })()}
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
                  const isOnline = isOperatorReachable(dev) || dev.status === 'in_session';
                  const sessionAvailability = getSessionAvailability(dev);
                  const castAvailability = getCastAvailability(dev);
                  const activeSession = (dev.active_session ?? null) as SessionCardState | null;
                  const sessionUi = getSessionUiState(activeSession);
                  const isLowBattery = dev.battery < 20;
                  const isHelpRequested = dev.needs_help === 1;
                  const operatorStatus = getOperatorStatus(dev, {
                    repairPending: repairingDeviceId === dev.id || (repairDevice.isPending && repairDevice.variables === dev.id),
                    recentlyRecovered: recentlyRecoveredDeviceId === dev.id,
                  });

                  return (
                    <div key={dev.id} className={`bg-[#16191E] border p-4 flex flex-col relative group ${isHelpRequested ? 'border-red-500 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.5)]' : (isOnline ? 'border-blue-500' : 'border-[#2D3139] opacity-40 grayscale')} transition-all`}>
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <span className={`text-[10px] font-mono uppercase leading-none ${isHelpRequested ? 'text-red-500 font-bold' : (isOnline ? 'text-blue-400' : 'text-slate-500')}`}>S/N: {dev.serial_number}</span>
                          <h3 className={`text-xl font-black italic ${isHelpRequested ? 'text-red-500' : (!isOnline ? 'text-slate-400' : '')}`}>{dev.name}</h3>
                        </div>
                        <div className="flex flex-col items-end">
                          <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-tight ${isHelpRequested ? 'bg-red-500/20 text-red-500' : (dev.status === 'in_session' ? 'bg-amber-500/10 text-amber-500' : (isOnline ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-500'))}`}>
                            {isHelpRequested ? 'NEEDS HELP' : activeSession?.status === 'paused' ? 'paused' : dev.status}
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
                            {activeSession && sessionUi.headline && (
                              <div className="mt-2 text-4xl font-black tabular-nums text-white">
                                {sessionUi.headline}
                              </div>
                            )}
                            <div className="mt-1 text-sm font-bold text-slate-200">
                              {activeSession ? sessionUi.subline : (sessionAvailability.enabled ? 'Ready / Waiting' : 'Waiting for control')}
                            </div>
                            {activeSession && (
                              <div className="mt-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
                                {activeSession.current_app_name || activeSession.current_app_package}
                              </div>
                            )}
                              <div className={`mt-3 border px-3 py-3 ${operatorStatus.tone}`}>
                                <div className="text-[10px] font-bold uppercase tracking-[0.18em]">Статус оператора</div>
                                <p className="mt-1 text-sm font-semibold text-white">{operatorStatus.title}</p>
                                <p className="mt-2 min-h-8 text-[12px] leading-5 text-inherit">{operatorStatus.message}</p>
                                {operatorStatus.secondary && (
                                  <p className="mt-2 text-[12px] leading-5 text-inherit/90">{operatorStatus.secondary}</p>
                                )}
                                {operatorStatus.showRepair && (
                                  <button
                                    onClick={() => repairDevice.mutate(dev.id)}
                                    disabled={!hasUsbRoute(dev) || repairingDeviceId === dev.id}
                                    className="mt-3 inline-flex items-center gap-2 border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-50 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Wrench className="h-3.5 w-3.5" />
                                    <span>Восстановить Wi-Fi ADB</span>
                                  </button>
                                )}
                              </div>
                              <details className="mt-3 border border-[#2D3139] bg-[#11141A] px-3 py-2 text-[11px] text-slate-400">
                                <summary className="cursor-pointer list-none font-semibold text-slate-300">Техническая информация</summary>
                                <div className="mt-3 grid gap-1 font-mono text-[10px] text-slate-500">
                                  <span>agent: {dev.agent_status || "unknown"} / adb: {dev.adb_status || "unknown"}</span>
                                  <span>route: {dev.active_route || dev.serial_number}</span>
                                  <span>ip: {dev.wifi_ip || "unknown"}</span>
                                  <span>android id: {dev.android_id || "unknown"}</span>
                                  <span>heartbeat: {dev.last_heartbeat_at || "never"} / adb seen: {dev.last_adb_seen_at || "never"}</span>
                                </div>
                              </details>
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
                        {sessionUi.canPause && activeSession && (
                          <button
                            className="flex-1 border py-2 text-[10px] font-bold uppercase transition-colors bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20"
                            onClick={() => pauseCurrentSession.mutate(activeSession.session_id)}
                          >
                            Pause
                          </button>
                        )}
                        {sessionUi.canResume && activeSession && (
                          <button
                            className="flex-1 border py-2 text-[10px] font-bold uppercase transition-colors bg-emerald-500/10 text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/20"
                            onClick={() => resumeCurrentSession.mutate(activeSession.session_id)}
                          >
                            Resume
                          </button>
                        )}
                        <button 
                          className={`flex-1 border py-2 text-[10px] font-bold uppercase transition-colors ${sessionUi.canStop ? 'bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20' : 'bg-red-500/5 text-red-500/50 border-red-500/10 cursor-not-allowed'}`}
                          disabled={!sessionUi.canStop}
                          onClick={() => stopSession.mutate({ deviceId: dev.id })}
                        >
                          Stop
                        </button>
                        <button 
                          className={`flex-1 border py-2 text-[10px] font-bold uppercase transition-colors ${sessionAvailability.enabled ? 'bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20' : 'bg-[#1C2128] border-[#2D3139] cursor-not-allowed text-slate-600'}`}
                          disabled={!sessionAvailability.enabled}
                          onClick={() => {
                              setSelectedDeviceId(dev.id);
                              setIsModalOpen(true);
                          }}
                          title={sessionAvailability.reason}
                        >
                          {activeSession ? 'Switch App' : 'Start'}
                        </button>
                        <button
                          className={`border p-2 transition-colors ${castAvailability.enabled ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white' : 'bg-[#1C2128] border-[#2D3139] text-slate-600 cursor-not-allowed'}`}
                          disabled={!castAvailability.enabled}
                          onClick={() => openCastWindow(dev.id)}
                          title={castAvailability.reason}
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

      {isModalOpen && selectedDeviceId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#16191E] border border-[#2D3139] shadow-2xl overflow-hidden w-full max-w-md flex flex-col">
             <div className="px-6 py-4 border-b border-[#2D3139] flex justify-between items-center bg-[#1C2128]">
                 <h3 className="text-sm font-bold uppercase tracking-widest text-slate-200">{selectedSession ? 'Current Session' : 'Start Session'}</h3>
                 <button onClick={() => setIsModalOpen(false)} className="text-slate-500 hover:text-white">
                     <X className="w-5 h-5" />
                 </button>
             </div>
             <div className="p-6 flex flex-col gap-6">
                 {selectedSession && (
                   <div className="border border-[#2D3139] bg-[#0F1115] p-4">
                     <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Current Session</div>
                     <div className="mt-3 text-4xl font-black tabular-nums text-white">{selectedSessionUi.headline}</div>
                     <div className="mt-1 text-sm font-bold text-slate-200">{selectedSessionUi.subline}</div>
                     <div className="mt-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
                       {selectedSession.current_app_name || selectedSession.current_app_package}
                     </div>
                     <div className="mt-4 grid grid-cols-3 gap-2">
                       {selectedSessionUi.canPause && (
                         <button
                           onClick={() => pauseCurrentSession.mutate(selectedSession.session_id)}
                           className="border border-amber-500/30 bg-amber-500/10 py-2 text-[10px] font-bold uppercase text-amber-200 hover:bg-amber-500/20"
                         >
                           Pause
                         </button>
                       )}
                       {selectedSessionUi.canResume && (
                         <button
                           onClick={() => resumeCurrentSession.mutate(selectedSession.session_id)}
                           className="border border-emerald-500/30 bg-emerald-500/10 py-2 text-[10px] font-bold uppercase text-emerald-200 hover:bg-emerald-500/20"
                         >
                           Resume
                         </button>
                       )}
                       {selectedSessionUi.canStop && (
                         <button
                           onClick={() => stopSession.mutate({ deviceId: selectedDeviceId })}
                           className="border border-red-500/30 bg-red-500/10 py-2 text-[10px] font-bold uppercase text-red-200 hover:bg-red-500/20"
                         >
                           Stop
                         </button>
                       )}
                     </div>
                   </div>
                 )}
                 <div className="flex flex-col gap-2">
                     <label className="text-[10px] font-bold uppercase text-slate-500 tracking-widest">{selectedSession ? 'Switch App' : 'Select Game'}</label>
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
                 
                 {!selectedSession && (
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
                 )}

                 <div className="bg-[#0F1115] border border-[#2D3139] p-4 flex flex-col gap-3">
                     <div className="text-[10px] font-bold uppercase text-slate-500 tracking-widest mb-1">{selectedSession ? 'Session State' : 'Pre-flight Check'}</div>
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
                                {selectedSession && (
                                  <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${selectedSession.status === 'paused' ? 'bg-amber-400' : 'bg-emerald-500'}`}></span>
                                    <span className="text-xs text-slate-300">
                                      Session {selectedSession.status === 'paused' ? 'Paused' : 'Running'} · {formatRemainingTime(selectedSession.remaining_seconds)} left
                                    </span>
                                  </div>
                                )}
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
                      if (selectedSession) {
                        switchApp.mutate({ sessionId: selectedSession.session_id, appPackage: selectedApp, appActivity: selectedAppEntry?.activity });
                      } else {
                        startSession.mutate({ deviceId: selectedDeviceId, appPackage: selectedApp, appActivity: selectedAppEntry?.activity, durationMinutes: duration });
                      }
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
                    {selectedSession ? (selectedSession.status === 'paused' ? 'Queue Switch' : 'Switch') : 'Launch'}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
