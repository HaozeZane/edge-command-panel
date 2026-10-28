import React from 'react';
import type { RunStatus } from '../../types/protocol';

interface AgentStatusBadgeProps {
  online: boolean;
  disabled?: boolean;
}

export const AgentStatusBadge: React.FC<AgentStatusBadgeProps> = ({ online, disabled }) => {
  if (disabled) {
    return (
      <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
        <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-red-500" />
        已禁用
      </span>
    );
  }

  if (online) {
    return (
      <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="relative flex h-2 w-2 mr-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        在线
      </span>
    );
  }

  return (
    <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
      <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-slate-400" />
      离线
    </span>
  );
};

interface RunStatusBadgeProps {
  status: RunStatus;
  exitCode?: number;
}

export const RunStatusBadge: React.FC<RunStatusBadgeProps> = ({ status, exitCode }) => {
  switch (status) {
    case 'succeeded':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
          成功 {exitCode !== undefined && `(${exitCode})`}
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
          失败 {exitCode !== undefined && `(${exitCode})`}
        </span>
      );
    case 'running':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
          <span className="w-1.5 h-1.5 mr-1 rounded-full bg-blue-500 animate-pulse" />
          执行中
        </span>
      );
    case 'accepted':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-cyan-50 text-cyan-700 border border-cyan-200">
          已接收
        </span>
      );
    case 'dispatching':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
          分发中
        </span>
      );
    case 'timed_out':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
          超时
        </span>
      );
    case 'interrupted':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200">
          中断
        </span>
      );
    case 'skipped_offline':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
          离线跳过
        </span>
      );
    case 'skipped_busy':
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-orange-50 text-orange-700 border border-orange-200">
          繁忙跳过
        </span>
      );
    case 'unknown':
    default:
      return (
        <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">
          未知
        </span>
      );
  }
};
