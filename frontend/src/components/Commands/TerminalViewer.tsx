import React, { useRef, useEffect, useMemo, useState } from 'react';
import type { Run } from '../../types/protocol';
import type { LogChunk, LogFilter } from '../../utils/runLogs';
import { RunStatusBadge } from '../Common/Badge';
import { formatDuration } from '../../utils/format';
import {
  Terminal,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';

interface TerminalViewerProps {
  run: Run | null;
  chunks: LogChunk[];
  hasTruncated?: boolean;
  isLoadingEvents?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
}

export const TerminalViewer: React.FC<TerminalViewerProps> = ({
  run,
  chunks,
  hasTruncated = false,
  isLoadingEvents = false,
  loadError = null,
  onRetry,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<LogFilter>('all');

  const visibleChunks = useMemo(
    () => (filter === 'all' ? chunks : chunks.filter((c) => c.stream === filter)),
    [chunks, filter],
  );
  const visibleText = useMemo(() => visibleChunks.map((c) => c.text).join(''), [visibleChunks]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [visibleText]);

  const handleCopyLogs = async () => {
    if (!visibleText) return;
    try {
      await navigator.clipboard.writeText(visibleText);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = visibleText;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    setCopied(true);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  if (!run) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-slate-500 bg-terminal-bg rounded-xl border border-terminal-border">
        <Terminal className="w-10 h-10 mb-2 opacity-30 text-teal-400" />
        <p className="text-xs">请在左侧或上方列表中选择要查看实时输出的机器任务</p>
      </div>
    );
  }

  const filterButtonClass = (value: LogFilter) =>
    `px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
      filter === value
        ? 'bg-teal-600 text-white border-teal-500'
        : 'bg-[#21262d] text-slate-300 border-[#30363d] hover:bg-[#30363d]'
    }`;

  return (
    <div className="flex flex-col h-full bg-[#0d1117] rounded-xl border border-[#30363d] overflow-hidden shadow-2xl">
      {/* Terminal Title Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-[#161b22] border-b border-[#30363d] text-xs">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="flex space-x-1.5 shrink-0">
            <span className="w-3 h-3 rounded-full bg-[#ff5f56] inline-block" />
            <span className="w-3 h-3 rounded-full bg-[#ffbd2e] inline-block" />
            <span className="w-3 h-3 rounded-full bg-[#27c93f] inline-block" />
          </div>

          <div className="flex items-center space-x-2 truncate">
            <span className="font-semibold text-slate-200 truncate">{run.agentName}</span>
            <span className="text-[11px] font-mono text-slate-400">run #{run.id.slice(0, 8)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="flex items-center gap-1" role="group" aria-label="日志流筛选">
            <button type="button" onClick={() => setFilter('all')} className={filterButtonClass('all')} aria-pressed={filter === 'all'}>
              全部
            </button>
            <button type="button" onClick={() => setFilter('stdout')} className={filterButtonClass('stdout')} aria-pressed={filter === 'stdout'}>
              stdout
            </button>
            <button type="button" onClick={() => setFilter('stderr')} className={filterButtonClass('stderr')} aria-pressed={filter === 'stderr'}>
              stderr
            </button>
          </div>

          <RunStatusBadge status={run.status} exitCode={run.exitCode} />

          {run.createdAt && (
            <div className="hidden sm:flex items-center space-x-1 text-slate-400 text-[11px] font-mono">
              <Clock className="w-3 h-3" />
              <span>{formatDuration(run.createdAt, run.finishedAt)}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleCopyLogs}
            disabled={!visibleText}
            className="inline-flex items-center px-2 py-1 text-[11px] text-slate-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] rounded border border-[#30363d] disabled:opacity-40 transition-colors"
            aria-label={filter === 'all' ? '复制终端日志' : `复制 ${filter} 日志`}
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 mr-1 text-teal-400" />
                <span className="text-teal-400">已复制</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 mr-1" />
                <span>复制</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Output Truncated Warning (generic: per-run output or daily log quota) */}
      {hasTruncated && (
        <div className="flex items-center space-x-2 px-4 py-2 bg-amber-950/40 border-b border-amber-900/50 text-amber-300 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>输出已截断：已达到单任务输出上限或当日日志额度限制，后续数据未完整记录（详情见 Usage）。</span>
        </div>
      )}

      {/* Background log fetch error: retryable, no toast storm */}
      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-rose-950/40 border-b border-rose-900/50 text-rose-300 text-xs">
          <span className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{loadError}</span>
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center px-2 py-0.5 text-[11px] text-rose-200 bg-rose-900/40 hover:bg-rose-900/70 rounded border border-rose-800 transition-colors"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              重试
            </button>
          )}
        </div>
      )}

      {/* Terminal Body */}
      <div
        ref={terminalRef}
        className="flex-1 p-4 font-mono text-xs text-[#c9d1d9] overflow-y-auto whitespace-pre-wrap break-all select-text terminal-scroll leading-relaxed"
      >
        {visibleText ? (
          <code>
            {visibleChunks.map((chunk, index) => (
              <span
                key={`${chunk.seq}-${index}`}
                className={chunk.stream === 'stderr' ? 'text-rose-400' : undefined}
                title={chunk.stream}
              >
                {chunk.text}
              </span>
            ))}
          </code>
        ) : isLoadingEvents ? (
          <div className="text-slate-500 italic flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-teal-500 animate-ping" />
            <span>正在建立实时事件通道并拉取输出流...</span>
          </div>
        ) : loadError ? (
          <div className="text-rose-400 italic">日志暂不可用，请点击上方“重试”重新加载。</div>
        ) : run.status === 'dispatching' || run.status === 'accepted' ? (
          <div className="text-slate-500 italic">命令已派发至边缘节点，等待节点接收执行...</div>
        ) : run.status === 'running' ? (
          <div className="text-slate-500 italic flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span>节点正在执行命令，暂无输出...</span>
          </div>
        ) : run.status === 'skipped_offline' ? (
          <div className="text-slate-500 italic">该机器在命令派发时处于离线状态，已跳过执行。</div>
        ) : run.status === 'skipped_busy' ? (
          <div className="text-slate-500 italic">该机器正在执行其他任务，已跳过执行。</div>
        ) : (
          <div className="text-slate-500 italic">任务已结束，无控制台输出。</div>
        )}
      </div>

      {/* Terminal Footer Bar */}
      <div className="px-4 py-2 bg-[#161b22] border-t border-[#30363d] flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono">
        <div className="flex items-center space-x-3">
          <span>seq: {run.lastSeq}</span>
          {run.reason && <span className="text-amber-400">原因: {run.reason}</span>}
          {filter !== 'all' && <span className="text-slate-500">筛选: {filter}</span>}
        </div>
        <div>
          {run.status === 'succeeded' && (
            <span className="text-emerald-400 flex items-center space-x-1">
              <CheckCircle className="w-3 h-3" />
              <span>进程已正常退出 (exit 0)</span>
            </span>
          )}
          {run.status === 'failed' && (
            <span className="text-rose-400 flex items-center space-x-1">
              <XCircle className="w-3 h-3" />
              <span>进程异常退出 (exit {run.exitCode ?? '?'})</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
