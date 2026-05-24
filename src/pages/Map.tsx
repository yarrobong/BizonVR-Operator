import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Battery, Play, MonitorSmartphone, Square, X, AlertTriangle, PhoneCall } from "lucide-react";

export function Map() {
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [selectedApp, setSelectedApp] = useState<string>('com.beatgames.beatsaber');
  const [duration, setDuration] = useState<number>(30);

  const APPS = [
    { name: 'Superhot VR', package: 'com.game.superhot' },
    { name: 'Arizona Sunshine 2', package: 'com.vertigogames.arizona2' },
    { name: 'Beat Saber', package: 'com.beatgames.beatsaber' },
    { name: 'Job Simulator', package: 'com.owlchemylabs.jobsimulator' },
  ];

  const { data: devices, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      return res.json();
    },
    refetchInterval: 3000,
  });

  const { data: rooms } = useQuery({
    queryKey: ['rooms'],
    queryFn: async () => {
      const res = await fetch('/api/rooms');
      return res.json();
    },
    refetchInterval: 10000,
  });

  const startSession = useMutation({
    mutationFn: async ({ deviceId, appPackage, durationMinutes }: { deviceId: number, appPackage: string, durationMinutes: number }) => {
      const res = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId,
          app_package: appPackage,
          duration_minutes: durationMinutes
        })
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    }
  });

  const stopSession = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/sessions/${deviceId}/stop`, {
        method: 'POST'
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    }
  });

  const openScrcpy = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/scrcpy`, {
        method: 'POST'
      });
      return res.json();
    }
  });

  const installAgent = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/install_agent`, {
        method: 'POST'
      });
      return res.json();
    }
  });

  const dismissHelp = useMutation({
    mutationFn: async (deviceId: number) => {
      const res = await fetch(`/api/devices/${deviceId}/dismiss_help`, {
        method: 'POST'
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
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

  if (isLoading) return <div className="p-8 text-sm text-slate-400">Loading map...</div>;

  return (
    <div className="flex-1 flex flex-col p-6 h-full bg-[#0F1115]">
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
                                 }).then(() => queryClient.invalidateQueries({ queryKey: ['devices'] }));
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
                  const isLowBattery = dev.battery < 20;
                  const isHelpRequested = dev.needs_help === 1;

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
                          className={`flex-1 border py-2 text-[10px] font-bold uppercase transition-colors ${dev.status === 'online' ? 'bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20' : 'bg-[#1C2128] border-[#2D3139] cursor-not-allowed text-slate-600'}`}
                          disabled={dev.status !== 'online'}
                          onClick={() => {
                              setSelectedDeviceId(dev.id);
                              setIsModalOpen(true);
                          }}
                        >
                          Start
                        </button>
                        <button
                          className={`border p-2 transition-colors ${isOnline ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white' : 'bg-[#1C2128] border-[#2D3139] text-slate-600 cursor-not-allowed'}`}
                          disabled={!isOnline}
                          onClick={() => openScrcpy.mutate(dev.id)}
                          title="View Screen (Scrcpy)"
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

      {isModalOpen && selectedDeviceId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#16191E] border border-[#2D3139] shadow-2xl overflow-hidden w-full max-w-md flex flex-col">
             <div className="px-6 py-4 border-b border-[#2D3139] flex justify-between items-center bg-[#1C2128]">
                 <h3 className="text-sm font-bold uppercase tracking-widest text-slate-200">Start Session</h3>
                 <button onClick={() => setIsModalOpen(false)} className="text-slate-500 hover:text-white">
                     <X className="w-5 h-5" />
                 </button>
             </div>
             <div className="p-6 flex flex-col gap-6">
                 <div className="flex flex-col gap-2">
                     <label className="text-[10px] font-bold uppercase text-slate-500 tracking-widest">Select Game</label>
                     <select className="bg-[#0F1115] border border-[#2D3139] text-sm text-slate-200 p-3 outline-none focus:border-blue-500" value={selectedApp} onChange={e => setSelectedApp(e.target.value)}>
                         {APPS.map(app => (
                             <option key={app.package} value={app.package}>{app.name}</option>
                         ))}
                     </select>
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
                         const isBatteryOk = device?.battery >= 20;
                         const isOnline = device?.status === 'online';
                         const isPreFlightOk = isBatteryOk && isOnline;

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
                      startSession.mutate({ deviceId: selectedDeviceId, appPackage: selectedApp, durationMinutes: duration });
                      setIsModalOpen(false);
                  }} 
                  disabled={(() => {
                      const device = devices?.find((d: any) => d.id === selectedDeviceId);
                      return !(device?.battery >= 20 && device?.status === 'online');
                  })()}
                  className={`py-3 text-[10px] font-bold uppercase tracking-widest transition-colors ${(() => {
                      const device = devices?.find((d: any) => d.id === selectedDeviceId);
                      return (device?.battery >= 20 && device?.status === 'online') ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-slate-800 text-slate-500 cursor-not-allowed';
                  })()}`}
                >
                    Launch
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
