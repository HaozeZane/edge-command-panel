import React from 'react';
import { Menu, ShieldCheck } from 'lucide-react';
import type { NavTab } from './Sidebar';

interface HeaderProps {
  currentTab: NavTab;
  identity: string;
  onOpenMobileSidebar: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  identity,
  onOpenMobileSidebar,
}) => {
  const titles: Record<NavTab, { title: string; desc: string }> = {
    agents: {
      title: '边缘机器节点',
      desc: '管理在线 Linux 节点、网络延迟探测与安装部署',
    },
    runner: {
      title: '批量命令下发',
      desc: '向选中边缘节点并发下发 Shell 命令并实时查看流式输出',
    },
    history: {
      title: '历史批次审计',
      desc: '查询以往下发批次执行结果、退出码与历史输出快照',
    },
    enrollments: {
      title: '批量自动接入',
      desc: '配置多机器一次性批量注册规则，自动化集群接入',
    },
    usage: {
      title: '用量与配额水位',
      desc: '查看本 Edge Command 面板专用存储、日志帧与 API 消耗',
    },
  };

  const current = titles[currentTab] || { title: '控制面板', desc: '' };

  return (
    <header className="h-16 px-4 sm:px-6 bg-white border-b border-slate-200 flex items-center justify-between sticky top-0 z-30 shadow-sm">
      <div className="flex items-center space-x-3">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label="打开导航菜单"
          className="p-2 -ml-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg lg:hidden"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div>
          <h1 className="text-base font-bold text-slate-900">{current.title}</h1>
          <p className="text-xs text-slate-400 hidden sm:block">{current.desc}</p>
        </div>
      </div>

      <div className="flex items-center space-x-3">
        <div className="hidden sm:flex items-center space-x-2 px-3 py-1 bg-slate-100 rounded-full border border-slate-200 text-xs text-slate-600">
          <ShieldCheck className="w-3.5 h-3.5 text-teal-600" />
          <span className="font-mono">{identity || 'Cloudflare Access'}</span>
        </div>
      </div>
    </header>
  );
};
