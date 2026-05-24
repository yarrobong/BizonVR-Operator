import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PlayCircle, RefreshCw, Battery, HardDrive, Wifi, Plus, MonitorSmartphone } from "lucide-react";

export function Devices() {
  const queryClient = useQueryClient();

  const { data: devices, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      return res.json();
    }
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
      return res.json();
    },
    onSuccess: () => {
      alert("Command sent to Local Hub!");
    }
  });

  if (isLoading) return <div className="p-6 text-sm text-slate-400">Loading devices...</div>;

  return (
    <div className="flex-1 flex flex-col p-6 h-full bg-[#0F1115]">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-tighter">Inventory <span className="text-slate-500">/ Devices</span></h1>
          <p className="text-xs text-slate-400 mt-1">Manage all VR headsets connected to your branches.</p>
        </div>
        <button className="flex items-center px-4 py-2 bg-[#3B82F6] hover:bg-blue-600 text-white text-[10px] uppercase font-bold tracking-widest transition-colors">
          <Plus className="w-4 h-4 mr-2" />
          Add Device
        </button>
      </div>

      <div className="bg-[#16191E] border border-[#2D3139] overflow-hidden flex-1">
        <table className="min-w-full divide-y divide-[#2D3139]">
          <thead className="bg-[#1C2128]">
            <tr>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Device</th>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Status</th>
              <th scope="col" className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Battery</th>
              <th scope="col" className="px-6 py-4 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-[#2D3139]">Quick Actions</th>
            </tr>
          </thead>
          <tbody className="bg-[#16191E] divide-y divide-[#2D3139]">
            {devices?.map((dev: any) => (
              <tr key={dev.id} className="hover:bg-[#1C2128] transition-colors group">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0 h-10 w-10 flex items-center justify-center bg-[#0F1115] border border-[#2D3139] rounded-none group-hover:border-blue-500/50 transition-colors">
                      <MonitorSmartphone className={`h-5 w-5 ${dev.status === 'online' ? 'text-blue-500' : 'text-slate-500'}`} />
                    </div>
                    <div>
                      <div className="text-sm font-black italic uppercase text-slate-200">{dev.name}</div>
                      <div className="text-[10px] font-mono text-slate-500 uppercase leading-none mt-1">S/N: {dev.serial_number}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-tight ${dev.status === 'online' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-500'}`}>
                    {dev.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center text-sm">
                    <Battery className={`w-4 h-4 mr-2 ${dev.battery < 20 ? 'text-red-500' : 'text-slate-400'}`} />
                    <span className="font-mono text-xs">{dev.battery}%</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                   <button 
                     onClick={() => sendCommand.mutate({ deviceId: dev.id, type: 'REFRESH_STATUS' })}
                     className="text-slate-400 hover:text-blue-400 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-blue-500/30 bg-transparent hover:bg-blue-500/10"
                     title="Refresh Status"
                   >
                     <RefreshCw className="w-4 h-4" />
                   </button>
                   <button 
                     onClick={() => sendCommand.mutate({ deviceId: dev.id, type: 'OPEN_SCRCPY' })}
                     className="text-slate-400 hover:text-emerald-400 mx-2 inline-flex items-center transition-colors px-2 py-1 border border-transparent hover:border-emerald-500/30 bg-transparent hover:bg-emerald-500/10"
                     title="Cast Stream"
                   >
                     <PlayCircle className="w-4 h-4" />
                   </button>
                </td>
              </tr>
            ))}
            {devices?.length === 0 && (
              <tr>
                 <td colSpan={4} className="px-6 py-12 text-center">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">No devices found. Add a Quest headset via Local Hub.</span>
                 </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
