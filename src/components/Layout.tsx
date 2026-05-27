import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, MonitorSmartphone, Map as MapIcon, Settings } from "lucide-react";

export function Layout() {
  const location = useLocation();

  return (
    <div className="flex flex-col h-screen w-full bg-[#0F1115] text-[#E0E2E5] font-sans overflow-hidden">
      {/* Top Navbar */}
      <header className="h-16 border-b border-[#2D3139] flex items-center justify-between px-6 bg-[#16191E] shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#3B82F6] flex items-center justify-center font-bold text-white">B</div>
            <span className="text-lg font-semibold tracking-tight uppercase">BizonVR <span className="text-[#3B82F6] font-light">Operator</span></span>
          </div>
          <div className="h-6 w-px bg-[#2D3139]"></div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="text-emerald-400">HUB-01 (LOCAL)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="text-emerald-400">ADB BRIDGE ACTIVE</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="bg-[#1C2128] border border-[#2D3139] px-3 py-1 text-xs flex items-center gap-2">
            <span className="text-slate-500 uppercase">Subscription:</span>
            <span className="text-blue-400 font-bold">PRO (12/24 UNITS)</span>
          </div>
          <div className="w-10 h-10 bg-slate-700"></div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-56 border-r border-[#2D3139] bg-[#16191E] flex flex-col pt-6 shrink-0">
          <div className="px-6 mb-8">
            <button className="w-full bg-[#3B82F6] hover:bg-blue-600 text-white font-bold py-3 text-xs uppercase tracking-widest">New Session</button>
          </div>
          <nav className="flex-1">
            <Link to="/dashboard" className={`flex items-center px-6 py-4 ${location.pathname === '/dashboard' ? 'bg-[#1F242D] border-l-4 border-blue-500 text-white' : 'border-l-4 border-transparent text-slate-400 hover:text-white hover:bg-[#1C2128]'}`}>
              <span className="text-xs font-bold uppercase tracking-widest">Dashboard</span>
            </Link>
            <Link to="/map" className={`flex items-center px-6 py-4 ${location.pathname === '/map' ? 'bg-[#1F242D] border-l-4 border-blue-500 text-white' : 'border-l-4 border-transparent text-slate-400 hover:text-white hover:bg-[#1C2128]'}`}>
              <span className="text-xs font-bold uppercase tracking-widest">Club Map</span>
            </Link>
            <Link to="/devices" className={`flex items-center px-6 py-4 ${location.pathname === '/devices' ? 'bg-[#1F242D] border-l-4 border-blue-500 text-white' : 'border-l-4 border-transparent text-slate-400 hover:text-white hover:bg-[#1C2128]'}`}>
              <span className="text-xs font-bold uppercase tracking-widest">Devices</span>
            </Link>
          </nav>
          <div className="p-6 border-t border-[#2D3139] text-[10px] text-slate-500">
             v1.0.4-MVP • 10.0.0.45
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-[#0F1115]">
          <Outlet />
        </main>
      </div>
      
      {/* Footer */}
      <footer className="h-8 border-t border-[#2D3139] bg-[#16191E] flex items-center justify-between px-6 text-[10px] font-bold uppercase tracking-widest text-slate-500 shrink-0">
        <div className="flex gap-8">
          <div className="flex items-center gap-2"><span className="text-[#3B82F6]">SYS:</span> READY</div>
          <div className="flex items-center gap-2"><span className="text-[#3B82F6]">SCRCPY ENGINE:</span> 2 ACTIVE</div>
          <div className="flex items-center gap-2"><span className="text-[#3B82F6]">LATENCY:</span> 12ms</div>
        </div>
        <div className="flex gap-4">
          <div className="text-emerald-500">PRO SUBSCRIPTION ACTIVE • 14 DAYS LEFT</div>
          <div className="text-slate-400">UTC 14:02:11</div>
        </div>
      </footer>
    </div>
  );
}
