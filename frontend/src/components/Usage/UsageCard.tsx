import React from 'react';
import type { Usage } from '../../types/protocol';
import { formatBytes } from '../../utils/format';
import { Gauge, AlertTriangle, CheckCircle, Database, HardDrive, Cpu, FileText } from 'lucide-react';

interface UsageCardProps {
  usage: Usage | null;
  isLoading?: boolean;
}

export const UsageCard: React.FC<UsageCardProps> = ({ usage, isLoading }) => {
  if (!usage) {
    return (
      <div className="p-4 bg-white rounded-xl border border-slate-200 text-xs text-slate-400 text-center">
        {isLoading ? '正在获取配额信息...' : '暂无用量数据'}
      </div>
    );
  }

  const { requests, rowsRead, rowsWritten, logFrames, storageBytes, limits, limited, day } = usage;

  const storagePct = limits?.storageBytes
    ? Math.min(100, Math.round((storageBytes / limits.storageBytes) * 100))
    : 0;

  const logFramesPct = limits?.logFrames
    ? Math.min(100, Math.round((logFrames / limits.logFrames) * 100))
    : 0;

  const requestsPct = limits?.requests
    ? Math.min(100, Math.round((requests / limits.requests) * 100))
    : 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-teal-50 text-teal-600 rounded-lg">
            <Gauge className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">系统配额与用量水位</h3>
            <p className="text-[11px] text-slate-400">统计日期: {day}</p>
          </div>
        </div>

        {limited ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            <AlertTriangle className="w-3.5 h-3.5 mr-1 text-rose-600" />
            配额受限 (Limited)
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle className="w-3.5 h-3.5 mr-1 text-emerald-600" />
            正常运行
          </span>
        )}
      </div>

      {limited && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs flex items-start space-x-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <strong>注意：</strong>
            当前已达本项目资源配额上限，后续新增命令下发将被服务端直接拒绝。
          </div>
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Storage */}
        <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center space-x-1">
              <HardDrive className="w-3.5 h-3.5 text-teal-600" />
              <span>Durable Object 存储</span>
            </span>
            <span className="font-semibold text-slate-800">{storagePct}%</span>
          </div>
          <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                storagePct > 85 ? 'bg-rose-500' : 'bg-teal-500'
              }`}
              style={{ width: `${storagePct}%` }}
            />
          </div>
          <div className="text-[11px] font-mono text-slate-600 flex justify-between">
            <span>{formatBytes(storageBytes)}</span>
            <span className="text-slate-400">/ {formatBytes(limits?.storageBytes)}</span>
          </div>
        </div>

        {/* Daily Log Frames */}
        <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center space-x-1">
              <FileText className="w-3.5 h-3.5 text-cyan-600" />
              <span>今日日志帧数</span>
            </span>
            <span className="font-semibold text-slate-800">{logFramesPct}%</span>
          </div>
          <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                logFramesPct > 85 ? 'bg-rose-500' : 'bg-cyan-500'
              }`}
              style={{ width: `${logFramesPct}%` }}
            />
          </div>
          <div className="text-[11px] font-mono text-slate-600 flex justify-between">
            <span>{logFrames.toLocaleString()}</span>
            <span className="text-slate-400">/ {limits?.logFrames?.toLocaleString()}</span>
          </div>
        </div>

        {/* Daily Requests */}
        <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center space-x-1">
              <Cpu className="w-3.5 h-3.5 text-indigo-600" />
              <span>今日 API 请求</span>
            </span>
            <span className="font-semibold text-slate-800">{requestsPct}%</span>
          </div>
          <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                requestsPct > 85 ? 'bg-rose-500' : 'bg-indigo-500'
              }`}
              style={{ width: `${requestsPct}%` }}
            />
          </div>
          <div className="text-[11px] font-mono text-slate-600 flex justify-between">
            <span>{requests.toLocaleString()}</span>
            <span className="text-slate-400">/ {limits?.requests?.toLocaleString()}</span>
          </div>
        </div>

        {/* SQLite Database Rows */}
        <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center space-x-1">
              <Database className="w-3.5 h-3.5 text-emerald-600" />
              <span>SQLite 读/写行数</span>
            </span>
          </div>
          <div className="text-xs font-mono text-slate-700 pt-1 flex items-center justify-between">
            <span>读: {rowsRead.toLocaleString()}</span>
            <span>写: {rowsWritten.toLocaleString()}</span>
          </div>
          <div className="text-[10px] text-slate-400">单 DO 嵌入式 SQLite 引擎</div>
        </div>
      </div>

      {/* Quota disclaimer */}
      <div className="text-[11px] text-slate-400 bg-slate-50/70 p-2.5 rounded-lg border border-slate-100 leading-relaxed">
        <strong>说明：</strong>
        上述指标仅统计本 Edge Command 面板专用存储与每日调用水位，非 Cloudflare 账户全量指标。One 账户 Token 上限为 50，配额耗尽时服务端将拒绝新任务下发。
      </div>
    </div>
  );
};
