import React from 'react';
import {
  Server,
  Terminal,
  History,
  Users,
  Gauge,
  Wifi,
  WifiOff,
  User,
  ShieldCheck,
} from 'lucide-react';

export type NavTab = 'agents' | 'runner' | 'history' | 'enrollments' | 'usage';

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  agentCount: number;
  identity: string;
  isWsConnected: boolean;
  isWsConnecting: boolean;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  agentCount,
  identity,
  isWsConnected,
  isWsConnecting,
  isOpenMobile,
  onCloseMobile,
}) => {
  const navItems: { id: NavTab; label: string; icon: React.FC<{ className?: string }>; badge?: number }[] = [
    { id: 'agents', label: '边缘机器', icon: Server, badge: agentCount },
    { id: 'runner', label: '批量命令', icon: Terminal },
    { id: 'history', label: '执行历史', icon: History },
    { id: 'enrollments', label: '批量接入', icon: Users },
    { id: 'usage', label: '额度水位', icon: Gauge },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm lg:hidden animate-fade-in"
          onClick={onCloseMobile}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#0f172a] text-slate-300 flex flex-col border-r border-[#1e293b] transform transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isOpenMobile ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand */}
        <div className="h-16 px-5 flex items-center justify-between border-b border-[#1e293b]">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-teal-400">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <div className="text-sm font-bold text-white tracking-wide">Edge Command</div>
              <div className="text-[10px] text-teal-400 font-mono">CF WORKERS + DO</div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            控制面板
          </div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onTabChange(item.id);
                  onCloseMobile();
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-teal-500/10 text-teal-300 border border-teal-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1e293b]'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-teal-400' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </div>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      isActive
                        ? 'bg-teal-500/20 text-teal-300'
                        : 'bg-[#1e293b] text-slate-400'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Footer: User Identity & WebSocket Status */}
        <div className="p-3 border-t border-[#1e293b] space-y-3 bg-[#0b1120]">
          {/* WS Status */}
          <div className="flex items-center justify-between px-2 text-[11px]">
            <span className="text-slate-400 flex items-center space-x-1.5">
              {isWsConnected ? (
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-amber-400" />
              )}
              <span>事件长连接</span>
            </span>
            <span
              className={`font-semibold ${
                isWsConnected
                  ? 'text-emerald-400'
                  : isWsConnecting
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}
            >
              {isWsConnected ? '已连接' : isWsConnecting ? '重连中...' : '已断开'}
            </span>
          </div>

          {/* User Identity from Cloudflare Access */}
          <div className="flex items-center space-x-2.5 p-2 bg-[#1e293b]/60 rounded-lg border border-[#334155]/40 text-xs">
            <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-slate-300 shrink-0">
              <User className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-slate-400 flex items-center space-x-1">
                <ShieldCheck className="w-3 h-3 text-teal-400" />
                <span>CF Access 认证</span>
              </div>
              <div className="text-xs font-medium text-slate-200 truncate" title={identity}>
                {identity || '已认证用户'}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};
