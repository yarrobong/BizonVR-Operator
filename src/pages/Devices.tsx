import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PlayCircle, RefreshCw, Battery, Plus, MonitorSmartphone, Radio, TriangleAlert, X, Power, Wifi, Cable, Wrench, Stethoscope, Trash2 } from "lucide-react";

type Device = {
  id: number;
  name: string;
  serial_number: string;
  device_status?: string;
  stable_id?: string | null;
  agent_id?: string | null;
  android_id?: string | null;
  status: string;
  connection_status?: string | null;
  battery: number;
  adb_status?: string;
  agent_status?: string;
  active_route?: string | null;
  wifi_ssid?: string | null;
  wifi_ip?: string | null;
  last_heartbeat_at?: string | null;
  last_adb_seen_at?: string | null;
  agent_version?: string | null;
  previous_ips?: string[];
  wifi_ready?: boolean;
  usb_repair_required?: boolean;
  status_reason?: string | null;
  next_operator_step?: string | null;
  transport?: string | null;
  wake_supported?: boolean;
  ip_changed?: boolean;
  adb_recovery_status?: string | null;
  adb_recovery_permission?: string | null;
  room_id?: number | null;
  room_name?: string | null;
};

type Room = {
  id: number;
  name: string;
};

type CastInfo = {
  stream_url: string;
  device: Device;
  hub: {
    id: number;
    name: string;
    status: string;
    host: string;
    port: number;
  };
};

type ApiState = "permission_denied" | "subscription_blocked" | "partial_offline" | "command_failed" | "preflight_failed";

type ActionNotice = {
  state: ApiState;
  message: string;
};

type HealthCheckResult = {
  summary: string;
  probable_cause: string;
  next_step: string;
  what_works: string[];
  what_failed: string[];
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
  return "border-red-400/40 bg-red-500/10 text-red-100";
}

function getResolvedConnectionStatus(device: Device) {
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

function getAdbDegradedLabel(device: Device) {
  switch (device.adb_status) {
    case "reconnecting":
      return "Online, ADB reconnecting";
    case "tcpip_unavailable":
      return "Online, wireless ADB off";
    case "port_closed":
      return "Online, port 5555 closed";
    case "unauthorized":
      return "USB Authorize";
    default:
      return "Online, ADB degraded";
  }
}

export function Devices() {
  const queryClient = useQueryClient();
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [pairingDeviceId, setPairingDeviceId] = useState<number | null>(null);
  const [pairingRoomId, setPairingRoomId] = useState<number | null>(null);
  const [healthCheckResult, setHealthCheckResult] = useState<HealthCheckResult | null>(null);

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
  });

  const sendCommand = useMutation({
    mutationFn: async ({ deviceId, type }: { deviceId: number, type: string }) => {
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          local_hub_id: 1, // hardcoded for MVP
          device_id: deviceId,
          type
        })
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Command failed"));
    }
  });

  const wakeDevice = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/wake`, {
        method: 'POST',
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice({ state: "partial_offline", message: "Wake request queued. If the headset stays offline, reconnect it over USB to repair wireless ADB." });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => {
      setActionNotice(noticeFromError(error, "Wake request failed"));
    }
  });

  const pairDevice = useMutation({
    mutationFn: async ({ deviceId, roomId }: { deviceId: number; roomId: number }) => {
      const res = await fetch(`/api/devices/${deviceId}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId }),
      });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice({ state: "partial_offline", message: "First pairing started. Local Hub is enabling Wi-Fi ADB and validating Quest Agent spatial." });
      setIsAddModalOpen(false);
      setPairingDeviceId(null);
      setPairingRoomId(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => setActionNotice(noticeFromError(error, "Pairing failed")),
  });

  const repairDevice = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/repair`, { method: 'POST' });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice({ state: "partial_offline", message: "USB Repair started. Local Hub is refreshing the Wi-Fi ADB route for the known Quest." });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => setActionNotice(noticeFromError(error, "USB Repair failed")),
  });

  const runHealthCheck = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/health-check`, { method: 'POST' });
      return readApiResponse(res) as Promise<HealthCheckResult>;
    },
    onSuccess: (result) => {
      setHealthCheckResult(result);
      setActionNotice({ state: "partial_offline", message: `${result.probable_cause} ${result.next_step}` });
    },
    onError: (error) => setActionNotice(noticeFromError(error, "Health check failed")),
  });

  const forgetDevice = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
      return readApiResponse(res);
    },
    onSuccess: () => {
      setActionNotice({ state: "partial_offline", message: "Quest removal queued. Local Hub will forget remembered routes and the headset will disappear from inventory after sync." });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      if (selectedDevice && !knownDevices.find((device) => device.id === selectedDevice.id)) {
        setSelectedDevice(null);
      }
    },
    onError: (error) => setActionNotice(noticeFromError(error, "Quest removal failed")),
  });

  const castQuery = useQuery<CastInfo>({
    queryKey: ['device-cast', selectedDevice?.id],
    enabled: !!selectedDevice,
    retry: false,
    queryFn: async () => {
      if (!selectedDevice) {
        throw new Error('Device is not selected');
      }

      const res = await fetch(`/api/devices/${selectedDevice.id}/cast`);
      return readApiResponse(res);
    },
  });

  useEffect(() => {
    if (!castQuery.data?.stream_url) return;

    setStreamState("ready");
    setStreamError(null);
  }, [castQuery.data?.stream_url]);

  const openCast = (device: Device) => {
    setSelectedDevice(device);
    setStreamState("loading");
    setStreamError(null);
  };

  const closeCast = () => {
    setSelectedDevice(null);
    setStreamState("idle");
    setStreamError(null);
  };

  const getConnectivityTone = (device: Device) => {
    const connectionStatus = getResolvedConnectionStatus(device);
    if (connectionStatus === "online" || connectionStatus === "wifi_ready") {
      return "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
    }
    if (connectionStatus === "usb_repair_required" || connectionStatus === "vpn_or_lan_blocked" || device.usb_repair_required) {
      return "bg-amber-500/10 text-amber-200 border-amber-500/30";
    }
    if (connectionStatus === "usb_unauthorized" || connectionStatus === "new") {
      return "bg-red-500/10 text-red-200 border-red-500/30";
    }
    return "bg-blue-500/10 text-blue-200 border-blue-500/30";
  };

  const getConnectivityLabel = (device: Device) => {
    switch (getResolvedConnectionStatus(device)) {
      case "online":
        return "Online";
      case "wifi_ready":
        return "Wi-Fi Ready";
      case "usb_unauthorized":
        return "USB Authorize";
      case "usb_repair_required":
        return "USB Repair";
      case "vpn_or_lan_blocked":
        return "VPN/LAN Blocked";
      case "agent_online_adb_offline":
        return getAdbDegradedLabel(device);
      case "adb_online_agent_offline":
        return "Agent offline, relaunching";
      case "offline_sleeping":
        return "Sleeping or unreachable";
      case "pairing_in_progress":
        return "Pairing";
      case "new":
        return "New Quest";
      default:
        return device.usb_repair_required ? "USB Repair" : "Checking";
    }
  };

  if (isLoading) return <div className="p-6 text-sm text-slate-400">Loading devices...</div>;

  const knownDevices = Array.isArray(devices) ? devices as Device[] : [];
  const addCandidates = knownDevices.filter((device) => {
    const connectionStatus = String(getResolvedConnectionStatus(device));
    const needsRoomAssignment = !device.room_id;
    return needsRoomAssignment && ["new", "usb_unauthorized", "pairing_in_progress", "wifi_ready", "adb_online_agent_offline"].includes(connectionStatus);
  });
  const partialOffline = knownDevices.some((device: Device) => ["offline", "vpn_or_lan_blocked", "usb_repair_required", "agent_online_adb_offline", "adb_online_agent_offline"].includes(String(getResolvedConnectionStatus(device))) || device.adb_status === "offline" || device.usb_repair_required);
  const visibleNotice = actionNotice ?? (partialOffline
    ? { state: "partial_offline" as const, message: "Some Quest headsets are partially offline. Use USB repair or wake over Wi-Fi before starting sessions." }
    : null);

  return (
    <div className="flex-1 flex gap-6 p-6 h-full bg-[#0F1115]">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-tighter">Inventory <span className="text-slate-500">/ Devices</span></h1>
          <p className="text-xs text-slate-400 mt-1">Manage all VR headsets connected to your branches.</p>
        </div>
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="flex items-center px-4 py-2 bg-[#3B82F6] hover:bg-blue-600 text-white text-[10px] uppercase font-bold tracking-widest transition-colors"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Quest
        </button>
      </div>

      {visibleNotice && (
        <div className={`mb-4 border px-4 py-3 text-xs font-semibold uppercase tracking-wide ${getNoticeTone(visibleNotice.state)}`}>
          <span className="mr-2 font-black">{visibleNotice.state.replace(/_/g, " ")}</span>
          <span className="normal-case tracking-normal">{visibleNotice.message}</span>
        </div>
      )}

      <div className="bg-[#16191E] border border-[#2D3139] overflow-hidden flex-1">
        <table className="min-w-full divide-y divide-[#2D3139]">
          <thead className="bg-[#1C2128]">
            <tr>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Device</th>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Status</th>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Battery</th>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Connection</th>
              <th scope="col" className="px-6 py-4 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Quick Actions</th>
            </tr>
          </thead>
          <tbody className="bg-[#16191E] divide-y divide-[#2D3139]">
            {knownDevices.map((dev: Device) => (
              <tr key={dev.id} className="hover:bg-[#1C2128] transition-colors group">
                {(() => {
                  const connectionStatus = getResolvedConnectionStatus(dev);
                  return (
                    <>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0 h-10 w-10 flex items-center justify-center bg-[#0F1115] border border-[#2D3139] rounded-none group-hover:border-blue-500/50 transition-colors">
                      <MonitorSmartphone className={`h-5 w-5 ${dev.status === 'online' ? 'text-blue-500' : 'text-slate-500'}`} />
                    </div>
                    <div>
                      <div className="text-sm font-black italic uppercase text-slate-200">{dev.name}</div>
                      <div className="text-[10px] font-mono text-slate-500 uppercase leading-none mt-1">S/N: {dev.serial_number}</div>
                      {dev.wifi_ssid && (
                        <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-slate-500">{dev.wifi_ssid}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-tight ${connectionStatus === 'online' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-300'}`}>
                    {connectionStatus}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center text-sm">
                    <Battery className={`w-4 h-4 mr-2 ${dev.battery < 20 ? 'text-red-500' : 'text-slate-400'}`} />
                    <span className="font-mono text-xs">{dev.battery}%</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className={`inline-flex items-center gap-2 border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${getConnectivityTone(dev)}`}>
                    {connectionStatus === "online" || connectionStatus === "wifi_ready" ? <Wifi className="h-3.5 w-3.5" /> : <Cable className="h-3.5 w-3.5" />}
                    <span>{getConnectivityLabel(dev)}</span>
                  </div>
                  <p className="mt-2 max-w-[20rem] text-[11px] leading-4 text-slate-400">
                    {dev.status_reason || 'Local Hub has not reported Wi-Fi ADB diagnostics yet.'}
                  </p>
                  {dev.next_operator_step && (
                    <p className="mt-2 max-w-[20rem] text-[11px] leading-4 text-blue-200">
                      Next: {dev.next_operator_step}
                    </p>
                  )}
                  {dev.wifi_ip && (
                    <p className="mt-1 font-mono text-[10px] text-slate-500">
                      {dev.transport === 'wifi' ? 'wifi' : 'ip'}: {dev.wifi_ip}
                      {dev.ip_changed ? ' (updated)' : ''}
                    </p>
                  )}
                  <div className="mt-2 grid gap-1 font-mono text-[10px] text-slate-500">
                    <span>device: {dev.device_status || dev.status} / agent: {dev.agent_status || "unknown"} / adb: {dev.adb_status || "unknown"}</span>
                    <span>recovery: {dev.adb_recovery_status || "idle"} / permission: {dev.adb_recovery_permission || "missing"}</span>
                    <span>route: {dev.active_route || dev.serial_number}</span>
                    <span>heartbeat: {dev.last_heartbeat_at || "never"} / adb seen: {dev.last_adb_seen_at || "never"}</span>
                    <span>agent version: {dev.agent_version || "unknown"}</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                   <button 
                     onClick={() => runHealthCheck.mutate(dev.id)}
                     className="text-slate-400 hover:text-cyan-300 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-cyan-400/30 bg-transparent hover:bg-cyan-500/10"
                     title="Health Check"
                   >
                     <Stethoscope className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => sendCommand.mutate({ deviceId: dev.id, type: 'RECONNECT_ADB' })}
                     disabled={connectionStatus !== "agent_online_adb_offline" && connectionStatus !== "vpn_or_lan_blocked"}
                     className="text-slate-400 hover:text-cyan-300 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-cyan-400/30 bg-transparent hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                     title="Reconnect ADB"
                   >
                     <Wifi className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => sendCommand.mutate({ deviceId: dev.id, type: 'RELAUNCH_AGENT' })}
                     disabled={connectionStatus !== "adb_online_agent_offline" && connectionStatus !== "wifi_ready"}
                     className="text-slate-400 hover:text-emerald-300 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-emerald-400/30 bg-transparent hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                     title="Relaunch Agent"
                   >
                     <Radio className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => repairDevice.mutate(dev.id)}
                     disabled={!["usb_repair_required", "vpn_or_lan_blocked", "agent_online_adb_offline"].includes(connectionStatus)}
                     className="text-slate-400 hover:text-amber-300 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-amber-400/30 bg-transparent hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                     title="USB Repair"
                   >
                     <Wrench className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => sendCommand.mutate({ deviceId: dev.id, type: 'REFRESH_STATUS' })}
                     className="text-slate-400 hover:text-blue-400 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-blue-500/30 bg-transparent hover:bg-blue-500/10"
                     title="Refresh Status"
                   >
                     <RefreshCw className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => wakeDevice.mutate(dev.id)}
                     disabled={!dev.wake_supported}
                     className="text-slate-400 hover:text-amber-300 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-amber-400/30 bg-transparent hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                     title="Wake Over Wi-Fi"
                   >
                     <Power className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => openCast(dev)}
                     disabled={dev.adb_status !== "online"}
                     className="text-slate-400 hover:text-emerald-400 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-emerald-500/30 bg-transparent hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                     title="Open Cast In Panel"
                   >
                     <PlayCircle className="w-4 h-4" />
                   </button>
                   <button
                     onClick={() => {
                       if (window.confirm(`Remove ${dev.name} from Local Hub memory and device inventory? This will forget saved Wi-Fi routes and delete the headset from the database.`)) {
                         forgetDevice.mutate(dev.id);
                       }
                     }}
                     disabled={dev.status === 'in_session' || dev.status === 'busy'}
                     className="text-slate-400 hover:text-red-300 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-red-400/30 bg-transparent hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                     title="Forget Quest"
                   >
                     <Trash2 className="w-4 h-4" />
                   </button>
                </td>
                    </>
                  );
                })()}
              </tr>
            ))}
            {knownDevices.length === 0 && (
              <tr>
                 <td colSpan={5} className="px-6 py-12 text-center">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">No devices found. Add a Quest headset via Local Hub.</span>
                 </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isAddModalOpen && (
        <div className="mt-4 border border-[#2D3139] bg-[#16191E] p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-slate-500">Add Quest</div>
              <h3 className="mt-1 text-lg font-black uppercase tracking-tight text-white">First Pairing</h3>
            </div>
            <button
              onClick={() => setIsAddModalOpen(false)}
              className="inline-flex h-9 w-9 items-center justify-center border border-[#2D3139] text-slate-400 transition-colors hover:border-slate-500 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-xs leading-5 text-blue-100">
            1. Connect Quest over USB.
            <br />
            2. Accept USB debugging in the headset.
            <br />
            3. Assign the known headset to a room and start pairing once it appears below.
          </div>

          <div className="mt-4 space-y-3">
            {addCandidates.length === 0 && (
              <div className="border border-dashed border-[#2D3139] bg-[#11141A] px-4 py-6 text-sm text-slate-400">
                No USB pairing candidates yet. Connect a Quest and refresh once ADB sees it.
              </div>
            )}

            {addCandidates.map((device) => (
              <div key={device.id} className="border border-[#2D3139] bg-[#11141A] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-bold uppercase text-white">{device.name}</div>
                    <div className="mt-1 text-[11px] font-mono text-slate-500">{device.serial_number}</div>
                    <div className="mt-2 text-xs text-slate-300">{device.status_reason || "Waiting for Local Hub identity details."}</div>
                  </div>
                  <div className={`border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${getConnectivityTone(device)}`}>
                    {getConnectivityLabel(device)}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <select
                    value={pairingDeviceId === device.id ? String(pairingRoomId ?? "") : ""}
                    onChange={(event) => {
                      setPairingDeviceId(device.id);
                      setPairingRoomId(event.target.value ? Number(event.target.value) : null);
                    }}
                    className="min-w-[16rem] border border-[#2D3139] bg-[#0F1115] px-3 py-2 text-sm text-white"
                  >
                    <option value="">Select room</option>
                    {(rooms as Room[] | undefined)?.map((room) => (
                      <option key={room.id} value={room.id}>{room.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => pairDevice.mutate({ deviceId: device.id, roomId: Number(pairingRoomId) })}
                    disabled={pairingDeviceId !== device.id || !pairingRoomId}
                    className="border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Start Pairing
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {healthCheckResult && (
        <div className="mt-4 border border-cyan-500/30 bg-cyan-500/5 p-4 text-sm text-cyan-50">
          <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-200">Health Check</div>
          <p className="mt-2 font-semibold">{healthCheckResult.summary}</p>
          <p className="mt-2 text-cyan-100/90">{healthCheckResult.probable_cause}</p>
          <p className="mt-2 text-cyan-100/90">Next step: {healthCheckResult.next_step}</p>
        </div>
      )}
      </div>

      <aside className="flex w-[26rem] shrink-0 flex-col border border-[#2D3139] bg-[#16191E]">
        <div className="flex items-center justify-between border-b border-[#2D3139] px-5 py-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Web Cast</div>
            <h2 className="mt-1 text-lg font-black uppercase tracking-tight text-slate-100">
              {selectedDevice ? selectedDevice.name : 'Select Device'}
            </h2>
          </div>
          {selectedDevice && (
            <button
              onClick={closeCast}
              className="inline-flex h-9 w-9 items-center justify-center border border-[#2D3139] text-slate-400 transition-colors hover:border-slate-500 hover:text-white"
              title="Close Cast Panel"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4 p-5">
          {!selectedDevice && (
            <div className="flex flex-1 flex-col items-center justify-center border border-dashed border-[#2D3139] bg-[#11141A] px-6 text-center">
              <Radio className="mb-4 h-10 w-10 text-slate-600" />
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-300">No cast selected</p>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Choose a headset from the list to open its live view in this operator panel.
              </p>
            </div>
          )}

          {selectedDevice && castQuery.isLoading && (
            <div className="flex flex-1 flex-col items-center justify-center border border-[#2D3139] bg-[#11141A] px-6 text-center">
              <RefreshCw className="mb-4 h-8 w-8 animate-spin text-blue-400" />
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-200">Connecting to Local Hub</p>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                We are preparing the embedded cast for the operator panel.
              </p>
            </div>
          )}

          {selectedDevice && castQuery.isError && (
            <div className="flex flex-1 flex-col justify-center border border-red-500/30 bg-red-500/5 px-6 text-center">
              <TriangleAlert className="mx-auto mb-4 h-9 w-9 text-red-400" />
              <p className="text-sm font-semibold uppercase tracking-wide text-red-200">Cast unavailable</p>
              <p className="mt-2 text-xs leading-5 text-red-100/80">
                {castQuery.error instanceof Error ? castQuery.error.message : 'Open the Local Hub and reconnect the device.'}
              </p>
            </div>
          )}

          {selectedDevice && castQuery.data && (
            <>
              <div className="overflow-hidden border border-[#2D3139] bg-black">
                {streamState === "error" && (
                  <div className="flex aspect-[4/3] items-center justify-center bg-[#05070A] px-6 text-center">
                    <div>
                      <RefreshCw className="mx-auto mb-3 h-7 w-7 text-blue-400" />
                      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-300">
                        Stream failed
                      </p>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        {streamError || 'Local Hub could not capture the Quest screen. Check ADB and retry.'}
                      </p>
                    </div>
                  </div>
                )}

                <img
                  src={castQuery.data.stream_url}
                  alt={`Live cast for ${selectedDevice.name}`}
                  className={`aspect-[4/3] w-full object-cover ${streamState === "error" ? "hidden" : "block"}`}
                  onLoad={() => {
                    setStreamState("ready");
                    setStreamError(null);
                  }}
                  onError={() => {
                    setStreamState("error");
                    setStreamError("Local Hub did not return a live stream. Verify that the headset is online and ADB is available.");
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
                <div className="border border-[#2D3139] bg-[#11141A] px-4 py-3 leading-5 text-slate-400">
                  This cast stays inside the operator panel and is served by Local Hub, so the cloud still never connects directly to the Quest.
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
