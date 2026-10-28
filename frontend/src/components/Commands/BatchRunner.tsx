import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Agent, Batch, BrowserFrame, Group, Run } from '../../types/protocol';
import { api } from '../../api/client';
import {
  appendEventToCache,
  createRunLogCache,
  getVisibleChunks,
  type RunLogCache,
} from '../../utils/runLogs';
import { TerminalViewer } from './TerminalViewer';
import { RunStatusBadge } from '../Common/Badge';
import { formatTimestamp } from '../../utils/format';
import {
  Play,
  Terminal,
  Loader2,
  Clock,
  ChevronRight,
  Server,
  AlertCircle,
  Layers,
} from 'lucide-react';

interface BatchRunnerProps {
  agents: Agent[];
  groups?: Group[];
  preselectedAgentIds?: string[];
  initialCommand?: string;
  initialBatchId?: string | null;
  onBatchCreated?: (batchId: string) => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
  isWsConnected: boolean;
  lastWsFrame: BrowserFrame | null;
  /** Increments once per received WS frame. Effects key off this, never off the frame object. */
  wsFrameId?: number;
  /** Increments on every WS open (including the first), used to backfill snapshots. */
  wsGeneration?: number;
}

const PRESET_COMMANDS = [
  { label: '系统架构', cmd: 'uname -a && cat /etc/os-release | head -n 5' },
  { label: '负载与运行时间', cmd: 'uptime' },
  { label: '内存使用', cmd: 'free -m' },
  { label: '磁盘空间', cmd: 'df -h' },
  { label: '容器列表', cmd: 'docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"' },
];

type BatchLoadMode = 'switch' | 'refresh';

export const BatchRunner: React.FC<BatchRunnerProps> = ({
  agents,
  groups = [],
  preselectedAgentIds = [],
  initialCommand,
  initialBatchId,
  onBatchCreated,
  onError,
  onSuccess,
  isWsConnected,
  lastWsFrame,
  wsFrameId = 0,
  wsGeneration = 0,
}) => {
  // Command form state
  const [command, setCommand] = useState(initialCommand || 'uname -a');
  const [timeoutSec, setTimeoutSec] = useState(300);
  const [targetAgentIds, setTargetAgentIds] = useState<string[]>(preselectedAgentIds);
  const [bulkGroupId, setBulkGroupId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Active batch and runs state
  const [currentBatch, setCurrentBatch] = useState<Batch | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isLoadingBatch, setIsLoadingBatch] = useState(false);

  // Per-run log caches. Each cache owns stdout/stderr decoders independently.
  const logCachesRef = useRef<Map<string, RunLogCache>>(new Map());
  const [, setOutputVersion] = useState(0);
  const bumpOutputVersion = useCallback(() => setOutputVersion((v) => v + 1), []);
  const [isActiveTruncated, setIsActiveTruncated] = useState<boolean>(false);
  const [isLoadingEvents, setIsLoadingEvents] = useState<boolean>(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  // Latest values for async/event callbacks (avoids stale closures and effect deps on state)
  const currentBatchRef = useRef<Batch | null>(null);
  const runsRef = useRef<Run[]>([]);
  const activeRunIdRef = useRef<string | null>(null);
  const latestWsFrameRef = useRef<BrowserFrame | null>(lastWsFrame);
  latestWsFrameRef.current = lastWsFrame;

  // Snapshot/latest-wins guards
  const batchTokenRef = useRef(0);
  const batchAbortRef = useRef<AbortController | null>(null);
  const lastWsFrameIdRef = useRef(0);
  const lastWsGenerationRef = useRef(wsGeneration);

  // Preserve requestId across retries until inputs change
  const requestIdRef = useRef<string>(crypto.randomUUID());
  const lastPayloadKeyRef = useRef<string>('');

  const currentPayloadKey = `${command}__${timeoutSec}__${[...targetAgentIds].sort().join(',')}`;
  if (lastPayloadKeyRef.current !== currentPayloadKey) {
    requestIdRef.current = crypto.randomUUID();
    lastPayloadKeyRef.current = currentPayloadKey;
  }

  // Update targetAgentIds when preselectedAgentIds change
  useEffect(() => {
    if (preselectedAgentIds && preselectedAgentIds.length > 0) {
      setTargetAgentIds(preselectedAgentIds);
    }
  }, [preselectedAgentIds]);

  useEffect(() => {
    if (initialCommand) {
      setCommand(initialCommand);
    }
  }, [initialCommand]);

  const setActiveRun = useCallback((runId: string | null) => {
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
  }, []);

  const getOrCreateCache = useCallback((runId: string): RunLogCache => {
    let cache = logCachesRef.current.get(runId);
    if (!cache) {
      cache = createRunLogCache(runId);
      logCachesRef.current.set(runId, cache);
    }
    return cache;
  }, []);

  const clearCaches = useCallback(() => {
    for (const cache of logCachesRef.current.values()) {
      cache.abort?.abort();
      cache.abort = null;
      cache.isFetching = false;
    }
    logCachesRef.current.clear();
  }, []);

  // Fetch incremental events for a run. A run id is captured locally, and UI
  // publishing additionally checks that the run is still active and that the
  // cache object is still the current one, so late responses can never leak
  // into another run/batch.
  const fetchRunEvents = useCallback(
    async (runId: string, options: { force?: boolean } = {}) => {
      const cache = getOrCreateCache(runId);
      if (cache.isFetching) return;

      // Cooldown repeated background failures instead of retrying/error-toasting in a loop.
      if (!options.force && cache.error && Date.now() - cache.lastErrorAt < 3000) return;

      cache.isFetching = true;
      cache.error = null;
      const controller = new AbortController();
      cache.abort = controller;
      if (runId === activeRunIdRef.current) {
        setIsLoadingEvents(true);
        setLogsError(null);
      }

      try {
        let hasMore = true;
        while (hasMore) {
          const res = await api.getRunEvents(runId, cache.lastSeq, controller.signal);
          if (controller.signal.aborted) return;

          for (const ev of res.events) {
            appendEventToCache(cache, ev);
          }
          if (res.nextSeq > 0) {
            cache.lastSeq = Math.max(cache.lastSeq, res.nextSeq - 1);
          }
          hasMore = res.hasMore;

          if (runId === activeRunIdRef.current && logCachesRef.current.get(runId) === cache) {
            bumpOutputVersion();
            setIsActiveTruncated(cache.hasTruncated);
          }
        }
        cache.error = null;
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : '网络请求失败';
        cache.error = `实时日志加载失败：${message}。可点击重试。`;
        cache.lastErrorAt = Date.now();
      } finally {
        cache.isFetching = false;
        if (cache.abort === controller) cache.abort = null;
        if (runId === activeRunIdRef.current && logCachesRef.current.get(runId) === cache) {
          setIsLoadingEvents(false);
          setLogsError(cache.error);
        }
      }
    },
    [getOrCreateCache],
  );

  const loadBatchDetail = useCallback(
    async (batchId: string, mode: BatchLoadMode = 'switch') => {
      const isSwitch = mode === 'switch' && currentBatchRef.current?.id !== batchId;

      if (isSwitch) {
        // Reset selected run and every visible cache before switching batches.
        clearCaches();
        currentBatchRef.current = null;
        setCurrentBatch(null);
        runsRef.current = [];
        setRuns([]);
        setActiveRun(null);
        bumpOutputVersion();
        setIsActiveTruncated(false);
        setIsLoadingEvents(false);
        setLogsError(null);
      }

      const token = ++batchTokenRef.current;
      batchAbortRef.current?.abort();
      const controller = new AbortController();
      batchAbortRef.current = controller;
      if (isSwitch) setIsLoadingBatch(true);

      try {
        const res = await api.getBatchDetail(batchId, controller.signal);
        if (controller.signal.aborted || token !== batchTokenRef.current) return;

        const isNewBatch = currentBatchRef.current?.id !== res.batch.id;
        currentBatchRef.current = res.batch;
        setCurrentBatch(res.batch);
        runsRef.current = res.runs;
        setRuns(res.runs);

        let nextActive = activeRunIdRef.current;
        if (isNewBatch || !nextActive || !res.runs.some((r) => r.id === nextActive)) {
          nextActive = res.runs[0]?.id ?? null;
        }
        setActiveRun(nextActive);

        // Backfill after the snapshot. Fetch refs are seq-based and idempotent.
        const targets = new Set<string>();
        if (nextActive) targets.add(nextActive);
        for (const runId of logCachesRef.current.keys()) targets.add(runId);
        for (const runId of targets) {
          void fetchRunEvents(runId);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted || token !== batchTokenRef.current) return;
        // Background refresh failures stay quiet (WS can notify again); explicit
        // navigation failures get a single user-visible message.
        if (isSwitch) {
          onError(err instanceof Error ? err.message : '加载批次详情失败');
        }
      } finally {
        if (token === batchTokenRef.current) setIsLoadingBatch(false);
      }
    },
    [clearCaches, fetchRunEvents, onError, setActiveRun],
  );

  // Load initial batch if provided via URL
  useEffect(() => {
    if (initialBatchId && currentBatchRef.current?.id !== initialBatchId) {
      void loadBatchDetail(initialBatchId, 'switch');
    }
  }, [initialBatchId, loadBatchDetail]);

  // When active run changes, show that run's cache immediately. The fetch is
  // incremental from its own lastSeq; stale runs cannot publish because of the
  // activeRunIdRef check in fetchRunEvents.
  useEffect(() => {
    activeRunIdRef.current = activeRunId;
    const cache = activeRunId ? logCachesRef.current.get(activeRunId) : null;
    if (cache) {
      bumpOutputVersion();
      setIsActiveTruncated(cache.hasTruncated);
      setLogsError(cache.error);
    } else {
      bumpOutputVersion();
      setIsActiveTruncated(false);
      setLogsError(null);
    }
    if (activeRunId) void fetchRunEvents(activeRunId);
  }, [activeRunId, fetchRunEvents]);

  // Coalesce short bursts of identical batch/run notifications into one
  // snapshot/incremental refresh. No polling loop is used.
  const pendingNotificationsRef = useRef<{
    timer: number | null;
    batchIds: Set<string>;
    runIds: Set<string>;
  }>({
    timer: null,
    batchIds: new Set<string>(),
    runIds: new Set<string>(),
  });

  const flushNotifications = useCallback(() => {
    const pending = pendingNotificationsRef.current;
    pending.timer = null;
    const batchIds = Array.from(pending.batchIds);
    const runIds = Array.from(pending.runIds);
    pending.batchIds.clear();
    pending.runIds.clear();

    const batch = currentBatchRef.current;
    if (!batch) return;

    if (batchIds.includes(batch.id)) {
      // A snapshot refresh already incrementally fetches the active/cached
      // runs, so avoid issuing the same event request twice for one frame.
      void loadBatchDetail(batch.id, 'refresh');
      return;
    }
    for (const runId of runIds) {
      void fetchRunEvents(runId);
    }
  }, [fetchRunEvents, loadBatchDetail]);

  const enqueueChangedNotification = useCallback(
    (frame: BrowserFrame) => {
      if (frame.type !== 'changed') return;
      const batch = currentBatchRef.current;
      if (!batch) return;

      const batchMatches = !!frame.batchId && frame.batchId === batch.id;
      const activeRunMatches = !!frame.runId && frame.runId === activeRunIdRef.current;
      if (!batchMatches && !activeRunMatches) return;

      const pending = pendingNotificationsRef.current;
      if (batchMatches && frame.batchId) pending.batchIds.add(frame.batchId);
      if (activeRunMatches && frame.runId) pending.runIds.add(frame.runId);
      if (pending.batchIds.size === 0 && pending.runIds.size === 0) return;

      if (pending.timer === null) {
        pending.timer = window.setTimeout(flushNotifications, 100);
      }
    },
    [flushNotifications],
  );

  // Handle every WS frame exactly once. The effect depends only on the frame
  // sequence id, so setting runs/batch state cannot re-trigger it.
  useEffect(() => {
    if (!wsFrameId || wsFrameId === lastWsFrameIdRef.current) return;
    lastWsFrameIdRef.current = wsFrameId;
    const frame = latestWsFrameRef.current;
    if (frame) enqueueChangedNotification(frame);
  }, [wsFrameId, enqueueChangedNotification]);

  // Reconnect / first-connect generation: backfill the batch snapshot and
  // incrementally resume output for the active run.
  useEffect(() => {
    if (wsGeneration === lastWsGenerationRef.current) return;
    lastWsGenerationRef.current = wsGeneration;
    const batch = currentBatchRef.current;
    if (batch) void loadBatchDetail(batch.id, 'refresh');
  }, [wsGeneration, loadBatchDetail]);

  // Cleanup timers/requests on unmount.
  useEffect(() => {
    return () => {
      const pending = pendingNotificationsRef.current;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      batchAbortRef.current?.abort();
      for (const cache of logCachesRef.current.values()) {
        cache.abort?.abort();
      }
    };
  }, []);

  const handleRetryActiveLogs = () => {
    if (activeRunIdRef.current) {
      void fetchRunEvents(activeRunIdRef.current, { force: true });
    }
  };

  // Submit batch execution
  const handleSubmitBatch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (targetAgentIds.length === 0) {
      onError('请至少选择一台目标机器执行命令');
      return;
    }

    const trimmedCmd = command.trim();
    if (!trimmedCmd) {
      onError('命令内容不能为空');
      return;
    }

    const t = Math.min(3600, Math.max(1, Number(timeoutSec) || 300));

    setIsSubmitting(true);
    try {
      const res = await api.createBatch({
        requestId: requestIdRef.current,
        agentIds: targetAgentIds,
        command: trimmedCmd,
        timeoutSec: t,
      });

      // New batch: drop all caches and abort in-flight requests from the old one.
      clearCaches();
      batchAbortRef.current?.abort();
      batchTokenRef.current += 1;

      currentBatchRef.current = res.batch;
      setCurrentBatch(res.batch);
      runsRef.current = res.runs;
      setRuns(res.runs);
      setActiveRun(res.runs[0]?.id ?? null);
      bumpOutputVersion();
      setIsActiveTruncated(false);
      setLogsError(null);

      // Reset requestId for subsequent new executions
      requestIdRef.current = crypto.randomUUID();
      lastPayloadKeyRef.current = '';

      onSuccess(`成功下发批次 #${res.batch.id.slice(0, 8)} 至 ${res.runs.length} 台机器`);
      onBatchCreated?.(res.batch.id);

      if (res.runs[0]) void fetchRunEvents(res.runs[0].id);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '批次任务分发失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleTargetAgent = (agentId: string) => {
    setTargetAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  };

  const selectAllOnlineAgents = () => {
    const onlineIds = agents.filter((a) => a.online && !a.disabled).map((a) => a.id);
    setTargetAgentIds(onlineIds);
  };

  const selectGroupAgents = (groupId: string) => {
    setBulkGroupId(groupId);
    if (!groupId) return;
    setTargetAgentIds(agents.filter((a) => a.groupIds.includes(groupId)).map((a) => a.id));
  };

  const activeRun = runs.find((r) => r.id === activeRunId) || null;
  // Derive from the active cache on every render (cache mutations bump a
  // version state) so a late response for a previous run can never be shown
  // for the newly selected run.
  const activeCache = activeRunId ? logCachesRef.current.get(activeRunId) ?? null : null;
  const visibleChunks = getVisibleChunks(activeCache, 'all');

  return (
    <div className="space-y-4">
      {/* WS Disconnect Warning */}
      {!isWsConnected && (
        <div className="flex items-center space-x-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
          <span>WebSocket 连接已断开，正在尝试重连... 恢复连接后将自动补全任务执行快照。</span>
        </div>
      )}

      {/* Command Configuration Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 bg-teal-50 text-teal-600 rounded-lg">
              <Terminal className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-bold text-slate-900">执行批次命令</h3>
          </div>

          <div className="flex items-center space-x-2 text-xs text-slate-500">
            <span>目标机器:</span>
            <span className="font-semibold text-teal-700 bg-teal-50 px-2 py-0.5 rounded border border-teal-200">
              {targetAgentIds.length} 台
            </span>
          </div>
        </div>

        {/* Target Machine Selector */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center space-x-1.5">
              <Server className="w-3.5 h-3.5 text-slate-500" />
              <span>选择目标机器</span>
            </label>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {groups.length > 0 && (
                <div className="flex items-center space-x-1.5">
                  <Layers className="w-3.5 h-3.5 text-slate-400" />
                  <select
                    aria-label="按分组批量选择目标机器"
                    value={bulkGroupId}
                    onChange={(e) => selectGroupAgents(e.target.value)}
                    className="max-w-[150px] px-2 py-1 text-xs border border-slate-300 rounded-md bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  >
                    <option value="">按分组选择...</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={selectAllOnlineAgents}
                className="text-teal-600 hover:text-teal-700 font-medium"
              >
                选择全部在线 ({agents.filter((a) => a.online && !a.disabled).length})
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() => {
                  setTargetAgentIds([]);
                  setBulkGroupId('');
                }}
                className="text-slate-500 hover:text-slate-700"
              >
                清空
              </button>
            </div>
          </div>

          <div className="max-h-24 overflow-y-auto p-2 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap gap-1.5">
            {agents.length === 0 ? (
              <p className="text-xs text-slate-400 italic">暂无可用机器节点，请先添加机器</p>
            ) : (
              agents.map((agent) => {
                const isSelected = targetAgentIds.includes(agent.id);
                return (
                  <button
                    type="button"
                    key={agent.id}
                    onClick={() => toggleTargetAgent(agent.id)}
                    className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                      isSelected
                        ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        agent.online && !agent.disabled ? 'bg-emerald-400' : 'bg-slate-400'
                      }`}
                    />
                    <span>{agent.name || agent.hostname || agent.id.slice(0, 8)}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Command Editor */}
        <form onSubmit={handleSubmitBatch} className="space-y-3">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
              <label className="text-xs font-semibold text-slate-700">Shell 脚本内容</label>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-400">预设模板:</span>
                {PRESET_COMMANDS.map((preset) => (
                  <button
                    type="button"
                    key={preset.label}
                    onClick={() => setCommand(preset.cmd)}
                    className="px-2 py-0.5 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 rounded transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative">
              <textarea
                rows={4}
                required
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="例如: uname -a && uptime"
                className="w-full font-mono text-xs p-3 bg-slate-900 text-emerald-300 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500 selection:bg-teal-700 selection:text-white leading-relaxed resize-y"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
            <div className="flex items-center space-x-2">
              <label className="text-xs font-medium text-slate-600 flex items-center space-x-1">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>超时时间 (秒):</span>
              </label>
              <input
                type="number"
                min="1"
                max="3600"
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(parseInt(e.target.value) || 300)}
                className="w-20 px-2 py-1 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono text-center"
              />
              <span className="text-[11px] text-slate-400">(范围 1 ~ 3600 秒)</span>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || targetAgentIds.length === 0 || !command.trim()}
              className="inline-flex items-center justify-center px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5 mr-1.5 fill-current" />
              )}
              提交并分发任务
            </button>
          </div>
        </form>
      </div>

      {/* Current Execution Result View */}
      {isLoadingBatch ? (
        <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm text-center text-xs text-slate-400 flex items-center justify-center">
          <Loader2 className="w-5 h-5 mr-2 animate-spin text-teal-600" />
          正在载入批次详情...
        </div>
      ) : currentBatch && (
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex items-center space-x-3">
              <div className="font-mono text-xs font-bold text-slate-900 bg-slate-100 px-2 py-1 rounded">
                批次 #{currentBatch.id.slice(0, 8)}
              </div>
              <div className="text-xs text-slate-500">
                创建于: {formatTimestamp(currentBatch.createdAt)}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">
                总目标: <strong className="text-slate-800">{runs.length}</strong>
              </span>
              <span className="text-emerald-600">
                成功: <strong>{runs.filter((r) => r.status === 'succeeded').length}</strong>
              </span>
              <span className="text-blue-600">
                运行中: <strong>{runs.filter((r) => r.status === 'running' || r.status === 'dispatching').length}</strong>
              </span>
              <span className="text-rose-600">
                失败/超时: <strong>{runs.filter((r) => r.status === 'failed' || r.status === 'timed_out').length}</strong>
              </span>
            </div>
          </div>

          {/* Grid Layout: Left Machines Run List, Right Terminal Viewer */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[480px]">
            {/* Runs Sidebar List */}
            <div className="lg:col-span-4 border border-slate-200 rounded-xl overflow-hidden flex flex-col bg-slate-50/50">
              <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 text-xs font-semibold text-slate-700 flex items-center justify-between">
                <span>机器执行进度</span>
                <span className="text-[11px] text-slate-400 font-normal">点击切换控制台</span>
              </div>
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-1">
                {runs.map((r) => {
                  const isActive = r.id === activeRunId;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setActiveRun(r.id)}
                      className={`w-full text-left p-2.5 rounded-lg transition-colors flex items-center justify-between ${
                        isActive
                          ? 'bg-teal-50 border border-teal-300 text-teal-900 shadow-sm'
                          : 'hover:bg-white text-slate-700'
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="text-xs font-semibold truncate">{r.agentName}</div>
                        <div className="text-[11px] font-mono text-slate-400 truncate">
                          run #{r.id.slice(0, 8)}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center space-x-1">
                        <RunStatusBadge status={r.status} exitCode={r.exitCode} />
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Terminal Window on Right */}
            <div className="lg:col-span-8 h-full">
              <TerminalViewer
                run={activeRun}
                chunks={visibleChunks}
                hasTruncated={isActiveTruncated}
                isLoadingEvents={isLoadingEvents}
                loadError={logsError}
                onRetry={handleRetryActiveLogs}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
