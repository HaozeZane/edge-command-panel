import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, Group, InstallInfo, Usage, BrowserFrame } from './types/protocol';
import { api, SessionExpiredError } from './api/client';
import { useWebSocket } from './hooks/useWebSocket';

import { Sidebar, type NavTab } from './components/Layout/Sidebar';
import { Header } from './components/Layout/Header';
import { AgentList } from './components/Agents/AgentList';
import { AddAgentDialog } from './components/Agents/AddAgentDialog';
import { GroupManager } from './components/Groups/GroupManager';
import { EnrollmentList } from './components/Enrollments/EnrollmentList';
import { BatchRunner } from './components/Commands/BatchRunner';
import { BatchHistory } from './components/History/BatchHistory';
import { UsageCard } from './components/Usage/UsageCard';
import { InstallDialog } from './components/Install/InstallDialog';
import { InstallPortal } from './components/Install/InstallPortal';
import { ToastContainer, SessionExpiredModal, type ToastMessage } from './components/Common/Toast';

export const App: React.FC = () => {
  // If route is /install, render dedicated local decode portal
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/install')) {
    return <InstallPortal />;
  }

  // Navigation tab state
  const [currentTab, setCurrentTab] = useState<NavTab>('agents');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Authentication & Session (all credentials stay in memory only)
  const [identity, setIdentity] = useState<string>('');
  const [isSessionExpired, setIsSessionExpired] = useState(false);
  const isMountedRef = useRef(true);
  const sessionExpiredRef = useRef(false);
  useEffect(() => {
    sessionExpiredRef.current = isSessionExpired;
  }, [isSessionExpired]);

  // Core Data
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [enrollments, setEnrollments] = useState<any[]>([]);

  // Loading flags
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);
  const [isLoadingEnrollments, setIsLoadingEnrollments] = useState(false);

  // Cross-tab interaction states
  const [runnerPreselectedAgentIds, setRunnerPreselectedAgentIds] = useState<string[]>([]);
  const [runnerPresetCommand, setRunnerPresetCommand] = useState<string>('');
  const [activeBatchIdFromUrl, setActiveBatchIdFromUrl] = useState<string | null>(null);

  // Modals state
  const [isAddAgentOpen, setIsAddAgentOpen] = useState(false);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);

  // In-memory install credentials dialog state (NEVER saved to localStorage/console.log)
  const [installModalInfo, setInstallModalInfo] = useState<{
    info: InstallInfo | null;
    title: string;
    agentName?: string;
  }>({ info: null, title: '安装命令' });

  // Notifications
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (!isMountedRef.current) return;
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, type, message }]);
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
    toastTimersRef.current.set(id, timer);
  }, []);

  const handleError = useCallback((msg: string) => {
    // Once Access has expired, suppress a storm of secondary error toasts.
    if (sessionExpiredRef.current) return;
    addToast(msg, 'error');
  }, [addToast]);

  const handleSuccess = useCallback((msg: string) => {
    addToast(msg, 'success');
  }, [addToast]);

  // Initial URL check: ?batch=id
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bId = params.get('batch');
    if (bId) {
      setActiveBatchIdFromUrl(bId);
      setCurrentTab('runner');
    }
  }, []);

  // Fetch Session Identity
  useEffect(() => {
    api
      .getSession()
      .then((res) => {
        if (!isMountedRef.current) return;
        setIdentity(res.identity || 'CF Access User');
      })
      .catch((err) => {
        if (!isMountedRef.current) return;
        if (err instanceof SessionExpiredError) {
          setIsSessionExpired(true);
        } else {
          handleError(err instanceof Error ? err.message : '获取会话身份失败');
        }
      });
  }, [handleError]);

  // Data Fetchers
  const refreshAgents = useCallback(async () => {
    setIsLoadingAgents(true);
    try {
      const res = await api.getAgents();
      if (!isMountedRef.current) return;
      setAgents(res.agents);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (err instanceof SessionExpiredError) {
        setIsSessionExpired(true);
      } else {
        handleError(err instanceof Error ? err.message : '拉取机器列表失败');
      }
    } finally {
      if (isMountedRef.current) setIsLoadingAgents(false);
    }
  }, [handleError]);

  const refreshGroups = useCallback(async () => {
    try {
      const res = await api.getGroups();
      if (!isMountedRef.current) return;
      setGroups(res.groups);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (err instanceof SessionExpiredError) {
        setIsSessionExpired(true);
      } else {
        handleError(err instanceof Error ? err.message : '拉取分组列表失败');
      }
    }
  }, [handleError]);

  const refreshUsage = useCallback(async () => {
    setIsLoadingUsage(true);
    try {
      const res = await api.getUsage();
      if (!isMountedRef.current) return;
      setUsage(res);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (err instanceof SessionExpiredError) {
        setIsSessionExpired(true);
      }
    } finally {
      if (isMountedRef.current) setIsLoadingUsage(false);
    }
  }, []);

  const refreshEnrollments = useCallback(async () => {
    setIsLoadingEnrollments(true);
    try {
      const res = await api.getEnrollments();
      if (!isMountedRef.current) return;
      setEnrollments(res.enrollments);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (err instanceof SessionExpiredError) {
        setIsSessionExpired(true);
      } else {
        handleError(err instanceof Error ? err.message : '拉取批量接入列表失败');
      }
    } finally {
      if (isMountedRef.current) setIsLoadingEnrollments(false);
    }
  }, [handleError]);

  // Initial load
  useEffect(() => {
    refreshAgents();
    refreshGroups();
    refreshUsage();
    refreshEnrollments();
  }, [refreshAgents, refreshGroups, refreshUsage, refreshEnrollments]);

  // Debounced Agent List Refresher for WS notification events
  const debounceAgentTimerRef = useRef<number | null>(null);
  const debouncedRefreshAgents = useCallback(() => {
    if (debounceAgentTimerRef.current) clearTimeout(debounceAgentTimerRef.current);
    debounceAgentTimerRef.current = window.setTimeout(() => {
      refreshAgents();
    }, 400);
  }, [refreshAgents]);

  // Clear all timers on unmount and prevent late async state writes.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceAgentTimerRef.current) clearTimeout(debounceAgentTimerRef.current);
      for (const timer of toastTimersRef.current.values()) clearTimeout(timer);
      toastTimersRef.current.clear();
    };
  }, []);

  // WebSocket live frames. Each frame gets a monotonically increasing id so
  // consumers can process it exactly once; a generation changes on every
  // (re)connect so batch/runner views can backfill snapshots.
  const [lastWsFrame, setLastWsFrame] = useState<BrowserFrame | null>(null);
  const [wsFrameId, setWsFrameId] = useState(0);
  const [wsGeneration, setWsGeneration] = useState(0);
  const wsFrameIdRef = useRef(0);
  const wsGenerationRef = useRef(0);

  const handleWsFrame = useCallback((frame: BrowserFrame) => {
    if (!isMountedRef.current) return;
    wsFrameIdRef.current += 1;
    setLastWsFrame(frame);
    setWsFrameId(wsFrameIdRef.current);
    if (frame.type === 'agents_changed') {
      debouncedRefreshAgents();
    }
  }, [debouncedRefreshAgents]);

  const handleWsConnect = useCallback(
    (info: { isReconnect: boolean }) => {
      if (!isMountedRef.current) return;
      wsGenerationRef.current += 1;
      setWsGeneration(wsGenerationRef.current);
      if (info.isReconnect) {
        // Backfill global data after a gap. Batch/history views react to the
        // generation change themselves and re-fetch their own snapshots.
        refreshAgents();
        refreshGroups();
        refreshUsage();
        refreshEnrollments();
      }
    },
    [refreshAgents, refreshEnrollments, refreshGroups, refreshUsage],
  );

  const { isConnected: isWsConnected, isConnecting: isWsConnecting } = useWebSocket({
    onFrame: handleWsFrame,
    onConnect: handleWsConnect,
    enabled: !isSessionExpired,
  });

  // Action handlers
  const handleOpenInstallModal = (info: InstallInfo, title: string, agentName?: string) => {
    setInstallModalInfo({ info, title, agentName });
  };

  const handleExecuteBatchFromAgents = (agentIds: string[]) => {
    setRunnerPreselectedAgentIds(agentIds);
    setCurrentTab('runner');
  };

  const handleBatchSelectedForUrl = useCallback((batchId: string) => {
    setActiveBatchIdFromUrl(batchId);
    const url = new URL(window.location.href);
    url.searchParams.set('batch', batchId);
    window.history.replaceState({}, '', url.toString());
  }, []);

  const handleRerunCommandFromHistory = (cmd: string, agentIds: string[]) => {
    setRunnerPresetCommand(cmd);
    setRunnerPreselectedAgentIds(agentIds);
    setCurrentTab('runner');
    handleSuccess('已载入历史命令与目标机器');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Cloudflare Access Session Expired Modal */}
      <SessionExpiredModal isOpen={isSessionExpired} />

      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={(tab) => {
          setCurrentTab(tab);
          if (tab === 'usage') refreshUsage();
          if (tab === 'enrollments') refreshEnrollments();
        }}
        agentCount={agents.length}
        identity={identity}
        isWsConnected={isWsConnected}
        isWsConnecting={isWsConnecting}
        isOpenMobile={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
      />

      {/* Main Content Area */}
      <div className="lg:pl-64 flex flex-col flex-1 min-w-0">
        <Header
          currentTab={currentTab}
          identity={identity}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
          {currentTab === 'agents' && (
            <AgentList
              agents={agents}
              groups={groups}
              isLoading={isLoadingAgents}
              onRefresh={refreshAgents}
              onOpenAddModal={() => setIsAddAgentOpen(true)}
              onOpenBatchEnrollModal={() => setCurrentTab('enrollments')}
              onOpenGroupModal={() => setIsGroupModalOpen(true)}
              onExecuteBatch={handleExecuteBatchFromAgents}
              onShowInstall={(info, name) => handleOpenInstallModal(info, `机器安装引导: ${name}`, name)}
              onError={handleError}
              onSuccess={handleSuccess}
              isActiveTab={currentTab === 'agents'}
            />
          )}

          {currentTab === 'runner' && (
            <BatchRunner
              agents={agents}
              groups={groups}
              preselectedAgentIds={runnerPreselectedAgentIds}
              initialCommand={runnerPresetCommand}
              initialBatchId={activeBatchIdFromUrl}
              onBatchCreated={(bId) => handleBatchSelectedForUrl(bId)}
              onError={handleError}
              onSuccess={handleSuccess}
              isWsConnected={isWsConnected}
              lastWsFrame={lastWsFrame}
              wsFrameId={wsFrameId}
              wsGeneration={wsGeneration}
            />
          )}

          {currentTab === 'history' && (
            <BatchHistory
              initialBatchId={activeBatchIdFromUrl}
              onSelectBatchForUrl={handleBatchSelectedForUrl}
              onRerunCommand={handleRerunCommandFromHistory}
              onError={handleError}
              lastWsFrame={lastWsFrame}
              wsFrameId={wsFrameId}
              wsGeneration={wsGeneration}
            />
          )}

          {currentTab === 'enrollments' && (
            <EnrollmentList
              enrollments={enrollments}
              groups={groups}
              isLoading={isLoadingEnrollments}
              onRefresh={refreshEnrollments}
              onShowInstall={(info, title) => handleOpenInstallModal(info, title)}
              onError={handleError}
              onSuccess={handleSuccess}
            />
          )}

          {currentTab === 'usage' && (
            <div className="space-y-4">
              <UsageCard usage={usage} isLoading={isLoadingUsage} />
            </div>
          )}
        </main>
      </div>

      {/* Modals & Dialogs */}
      <AddAgentDialog
        isOpen={isAddAgentOpen}
        onClose={() => setIsAddAgentOpen(false)}
        groups={groups}
        onSuccess={(agent, install) => {
          setIsAddAgentOpen(false);
          refreshAgents();
          handleOpenInstallModal(install, `新机器安装: ${agent.name || agent.hostname || agent.id}`, agent.name);
          handleSuccess(`机器 ${agent.name || agent.id} 创建成功`);
        }}
        onError={handleError}
      />

      <GroupManager
        isOpen={isGroupModalOpen}
        onClose={() => setIsGroupModalOpen(false)}
        groups={groups}
        agents={agents}
        onRefresh={() => {
          refreshGroups();
          refreshAgents();
        }}
        onError={handleError}
      />

      <InstallDialog
        isOpen={!!installModalInfo.info}
        onClose={() => setInstallModalInfo({ info: null, title: '' })}
        title={installModalInfo.title}
        installInfo={installModalInfo.info}
        agentName={installModalInfo.agentName}
      />
    </div>
  );
};
