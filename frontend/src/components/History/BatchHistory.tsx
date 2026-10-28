import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Batch, BrowserFrame, Run, RunEvent } from '../../types/protocol';
import { api } from '../../api/client';
import {
  appendEventToCache,
  createRunLogCache,
  getVisibleChunks,
  type RunLogCache,
} from '../../utils/runLogs';
import { TerminalViewer } from '../Commands/TerminalViewer';
import { RunStatusBadge } from '../Common/Badge';
import { formatTimestamp } from '../../utils/format';
import {
  History,
  RefreshCw,
  ChevronRight,
  Play,
  ChevronDown,
  Loader2,
} from 'lucide-react';

interface BatchHistoryProps {
  initialBatchId?: string | null;
  onSelectBatchForUrl?: (batchId: string) => void;
  onRerunCommand?: (command: string, agentIds: string[]) => void;
  onError: (msg: string) => void;
  lastWsFrame?: BrowserFrame | null;
  wsFrameId?: number;
  wsGeneration?: number;
}

type DetailMode = 'switch' | 'refresh';

export const BatchHistory: React.FC<BatchHistoryProps> = ({
  initialBatchId,
  onSelectBatchForUrl,
  onRerunCommand,
  onError,
  lastWsFrame = null,
  wsFrameId = 0,
  wsGeneration = 0,
}) => {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Selected batch state
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Terminal log state for selected historical run
  const [, setLogVersion] = useState(0);
  const bumpLogVersion = useCallback(() => setLogVersion((v) => v + 1), []);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const logCachesRef = useRef<Map<string, RunLogCache>>(new Map());
  const selectedBatchRef = useRef<Batch | null>(null);
  const runsRef = useRef<Run[]>([]);
  const activeRunIdRef = useRef<string | null>(null);
  const latestWsFrameRef = useRef<BrowserFrame | null>(lastWsFrame);
  latestWsFrameRef.current = lastWsFrame;
  const lastWsFrameIdRef = useRef(0);
  const lastWsGenerationRef = useRef(wsGeneration);

  const detailTokenRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);

  const clearCaches = useCallback(() => {
    for (const cache of logCachesRef.current.values()) {
      cache.abort?.abort();
      cache.abort = null;
      cache.isFetching = false;
    }
    logCachesRef.current.clear();
  }, []);

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

  const fetchRunEvents = useCallback(
    async (runId: string, options: { force?: boolean } = {}) => {
      const cache = getOrCreateCache(runId);
      if (cache.isFetching) return;
      if (!options.force && cache.error && Date.now() - cache.lastErrorAt < 3000) return;

      cache.isFetching = true;
      cache.error = null;
      const controller = new AbortController();
      cache.abort = controller;
      if (runId === activeRunIdRef.current) {
        setIsLoadingLogs(true);
        setLogsError(null);
      }

      try {
        let hasMore = true;
        while (hasMore) {
          const res = await api.getRunEvents(runId, cache.lastSeq, controller.signal);
          if (controller.signal.aborted) return;

          for (const ev of res.events as RunEvent[]) {
            appendEventToCache(cache, ev);
          }
          if (res.nextSeq > 0) {
            cache.lastSeq = Math.max(cache.lastSeq, res.nextSeq - 1);
          }
          hasMore = res.hasMore;

          if (runId === activeRunIdRef.current && logCachesRef.current.get(runId) === cache) {
            bumpLogVersion();
          }
        }
        cache.error = null;
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : '网络请求失败';
        cache.error = `历史日志加载失败：${message}。可点击重试。`;
        cache.lastErrorAt = Date.now();
      } finally {
        cache.isFetching = false;
        if (cache.abort === controller) cache.abort = null;
        if (runId === activeRunIdRef.current && logCachesRef.current.get(runId) === cache) {
          setIsLoadingLogs(false);
          setLogsError(cache.error);
        }
      }
    },
    [bumpLogVersion, getOrCreateCache],
  );

  const loadBatchDetail = useCallback(
    async (batchId: string, mode: DetailMode = 'switch') => {
      const isSwitch = mode === 'switch' && selectedBatchRef.current?.id !== batchId;

      if (isSwitch) {
        clearCaches();
        selectedBatchRef.current = null;
        setSelectedBatch(null);
        runsRef.current = [];
        setRuns([]);
        setActiveRun(null);
        setLogsError(null);
        setIsLoadingLogs(false);
        bumpLogVersion();
      }

      const token = ++detailTokenRef.current;
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      if (isSwitch) setIsLoadingDetail(true);

      try {
        const res = await api.getBatchDetail(batchId, controller.signal);
        if (controller.signal.aborted || token !== detailTokenRef.current) return;

        const isNewBatch = selectedBatchRef.current?.id !== res.batch.id;
        selectedBatchRef.current = res.batch;
        setSelectedBatch(res.batch);
        runsRef.current = res.runs;
        setRuns(res.runs);

        let nextActive = activeRunIdRef.current;
        if (isNewBatch || !nextActive || !res.runs.some((r) => r.id === nextActive)) {
          nextActive = res.runs[0]?.id ?? null;
        }
        setActiveRun(nextActive);

        if (isSwitch) onSelectBatchForUrl?.(batchId);

        const targets = new Set<string>();
        if (nextActive) targets.add(nextActive);
        for (const runId of logCachesRef.current.keys()) targets.add(runId);
        for (const runId of targets) void fetchRunEvents(runId);
      } catch (err: unknown) {
        if (controller.signal.aborted || token !== detailTokenRef.current) return;
        if (isSwitch) {
          onError(err instanceof Error ? err.message : '获取批次详情失败');
        }
      } finally {
        if (token === detailTokenRef.current) setIsLoadingDetail(false);
      }
    },
    [bumpLogVersion, clearCaches, fetchRunEvents, onError, onSelectBatchForUrl, setActiveRun],
  );

  const fetchBatches = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.getBatches();
      setBatches(res.batches);
      setNextCursor(res.nextCursor);

      const desired =
        initialBatchId || selectedBatchRef.current?.id || res.batches[0]?.id || null;
      if (desired) {
        await loadBatchDetail(
          desired,
          selectedBatchRef.current?.id === desired ? 'refresh' : 'switch',
        );
      }
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '获取历史批次列表失败');
    } finally {
      setIsLoading(false);
    }
  }, [initialBatchId, loadBatchDetail, onError]);

  useEffect(() => {
    void fetchBatches();
    // Initial load only; refresh is explicit or WS-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
    const cache = activeRunId ? logCachesRef.current.get(activeRunId) : null;
    setLogsError(cache?.error ?? null);
    if (activeRunId) void fetchRunEvents(activeRunId);
  }, [activeRunId, fetchRunEvents]);

  // Coalesced WS notifications
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

    const selected = selectedBatchRef.current;
    if (!selected) return;
    if (batchIds.includes(selected.id)) {
      // Snapshot refresh also resumes active/cached run logs incrementally.
      void loadBatchDetail(selected.id, 'refresh');
      return;
    }
    for (const runId of runIds) void fetchRunEvents(runId);
  }, [fetchRunEvents, loadBatchDetail]);

  const enqueueChangedNotification = useCallback(
    (frame: BrowserFrame) => {
      if (frame.type !== 'changed') return;
      const selected = selectedBatchRef.current;
      if (!selected) return;

      const batchMatches = !!frame.batchId && frame.batchId === selected.id;
      const activeRunMatches = !!frame.runId && frame.runId === activeRunIdRef.current;
      if (!batchMatches && !activeRunMatches) return;

      const pending = pendingNotificationsRef.current;
      if (batchMatches && frame.batchId) pending.batchIds.add(frame.batchId);
      if (activeRunMatches && frame.runId) pending.runIds.add(frame.runId);
      if (pending.batchIds.size === 0 && pending.runIds.size === 0) return;

      if (pending.timer === null) pending.timer = window.setTimeout(flushNotifications, 100);
    },
    [flushNotifications],
  );

  useEffect(() => {
    if (!wsFrameId || wsFrameId === lastWsFrameIdRef.current) return;
    lastWsFrameIdRef.current = wsFrameId;
    const frame = latestWsFrameRef.current;
    if (frame) enqueueChangedNotification(frame);
  }, [wsFrameId, enqueueChangedNotification]);

  useEffect(() => {
    if (wsGeneration === lastWsGenerationRef.current) return;
    lastWsGenerationRef.current = wsGeneration;
    const selected = selectedBatchRef.current;
    if (selected) void loadBatchDetail(selected.id, 'refresh');
  }, [wsGeneration, loadBatchDetail]);

  useEffect(() => {
    return () => {
      const pending = pendingNotificationsRef.current;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      detailAbortRef.current?.abort();
      for (const cache of logCachesRef.current.values()) cache.abort?.abort();
    };
  }, []);

  const loadMore = async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const res = await api.getBatches(nextCursor);
      setBatches((prev) => [...prev, ...res.batches]);
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '加载更多批次失败');
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleRetryActiveLogs = () => {
    if (activeRunIdRef.current) void fetchRunEvents(activeRunIdRef.current, { force: true });
  };

  const activeRun = runs.find((r) => r.id === activeRunId) || null;
  const activeCache = activeRunId ? logCachesRef.current.get(activeRunId) ?? null : null;
  const visibleChunks = getVisibleChunks(activeCache, 'all');
  const isTruncated = activeCache?.hasTruncated ?? false;

  return (
    <div className="space-y-4">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-teal-50 text-teal-600 rounded-lg">
            <History className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">执行历史记录 (Batch History)</h2>
            <p className="text-xs text-slate-500">
              按批次审计历史下发的 Shell 命令、执行机器列表与完整标准输出流
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void fetchBatches()}
          disabled={isLoading}
          className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors self-start sm:self-auto"
          aria-label="刷新历史记录"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Main Grid: Left Batches List, Right Batch Detail + Terminal */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Batches List */}
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-[700px]">
          <div className="p-3 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700 flex items-center justify-between">
            <span>历史批次</span>
            <span className="text-[11px] text-slate-400 font-normal">{batches.length} 条记录</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-2">
            {batches.length === 0 ? (
              <div className="py-16 text-center text-xs text-slate-400">暂无历史执行记录</div>
            ) : (
              batches.map((b) => {
                const isSelected = selectedBatch?.id === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => void loadBatchDetail(b.id, 'switch')}
                    className={`w-full text-left p-3 rounded-lg transition-colors mb-1 ${
                      isSelected
                        ? 'bg-teal-50 border border-teal-300 text-teal-900 shadow-sm'
                        : 'hover:bg-slate-50 text-slate-700 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-bold text-slate-800">
                        #{b.id.slice(0, 8)}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {formatTimestamp(b.createdAt)}
                      </span>
                    </div>

                    <div className="font-mono text-xs text-slate-600 bg-white/80 p-1.5 rounded border border-slate-200/60 truncate mb-1.5">
                      {b.command}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>超时: {b.timeoutSec}s</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </button>
                );
              })
            )}

            {nextCursor && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={isLoadingMore}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                >
                  {isLoadingMore ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 mr-1" />
                  )}
                  加载更多批次
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Selected Batch Details & Terminal */}
        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-[700px] overflow-hidden">
          {isLoadingDetail ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-xs">
              <Loader2 className="w-5 h-5 mr-2 animate-spin text-teal-600" />
              正在载入批次详情...
            </div>
          ) : !selectedBatch ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-xs">
              请从左侧选择一个历史批次查看详细日志
            </div>
          ) : (
            <div className="flex flex-col h-full">
              {/* Batch Header */}
              <div className="p-4 border-b border-slate-200 bg-slate-50/50 space-y-2 shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-bold text-slate-900">
                      批次 #{selectedBatch.id}
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatTimestamp(selectedBatch.createdAt)}
                    </span>
                  </div>

                  {onRerunCommand && (
                    <button
                      type="button"
                      onClick={() =>
                        onRerunCommand(
                          selectedBatch.command,
                          runs.map((r) => r.agentId),
                        )
                      }
                      className="inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
                    >
                      <Play className="w-3 h-3 mr-1.5 fill-current" />
                      重新执行该命令
                    </button>
                  )}
                </div>

                <div className="p-2 bg-slate-900 text-teal-300 font-mono text-xs rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-slate-800">
                  {selectedBatch.command}
                </div>

                {/* Machine tabs */}
                <div className="flex items-center space-x-1.5 overflow-x-auto pt-1">
                  <span className="text-xs text-slate-500 shrink-0 mr-1">机器 ({runs.length}):</span>
                  {runs.map((r) => {
                    const isTabActive = r.id === activeRunId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setActiveRun(r.id)}
                        className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded-md text-xs font-medium border shrink-0 transition-colors ${
                          isTabActive
                            ? 'bg-teal-50 border-teal-500 text-teal-800 shadow-sm'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <span>{r.agentName}</span>
                        <RunStatusBadge status={r.status} exitCode={r.exitCode} />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Terminal Viewer */}
              <div className="flex-1 p-3 min-h-0">
                <TerminalViewer
                  run={activeRun}
                  chunks={visibleChunks}
                  hasTruncated={isTruncated}
                  isLoadingEvents={isLoadingLogs}
                  loadError={logsError}
                  onRetry={handleRetryActiveLogs}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
