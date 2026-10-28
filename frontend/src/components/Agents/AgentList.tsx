import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Agent, Group, InstallInfo } from '../../types/protocol';
import { api } from '../../api/client';
import { AgentStatusBadge } from '../Common/Badge';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { EditAgentDialog } from './EditAgentDialog';
import { formatLatency } from '../../utils/format';
import {
  Server,
  Plus,
  RefreshCw,
  Search,
  KeyRound,
  Ban,
  Terminal,
  Activity,
  Download,
  Edit2,
  Users,
  CheckSquare,
  Square,
  MinusSquare,
  Layers,
} from 'lucide-react';

interface AgentListProps {
  agents: Agent[];
  groups: Group[];
  isLoading: boolean;
  onRefresh: () => void;
  onOpenAddModal: () => void;
  onOpenBatchEnrollModal: () => void;
  onOpenGroupModal: () => void;
  onExecuteBatch: (agentIds: string[]) => void;
  onShowInstall: (info: InstallInfo, agentName: string) => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
  isActiveTab: boolean;
}

export const AgentList: React.FC<AgentListProps> = ({
  agents,
  groups,
  isLoading,
  onRefresh,
  onOpenAddModal,
  onOpenBatchEnrollModal,
  onOpenGroupModal,
  onExecuteBatch,
  onShowInstall,
  onError,
  onSuccess,
  isActiveTab,
}) => {
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'disabled'>('all');

  // Dialog states
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [disablingAgent, setDisablingAgent] = useState<Agent | null>(null);
  const [rotatingAgent, setRotatingAgent] = useState<Agent | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isProbing, setIsProbing] = useState(false);

  // Group Map for quick name lookup
  const groupMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      map.set(g.id, g.name);
    }
    return map;
  }, [groups]);

  // Periodic latency probe: a stable 15s cadence while this tab is visible.
  // Do not reset the interval on every agents refresh (that could turn a
  // background refresh loop into extra probe requests).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const probeInFlightRef = useRef(false);

  useEffect(() => {
    if (!isActiveTab) return;

    let probeTimer: number | null = null;
    let isCancelled = false;

    const runProbe = async () => {
      if (isCancelled || document.hidden || probeInFlightRef.current) return;
      const onlineAgents = agentsRef.current
        .filter((a) => a.online && !a.disabled)
        .map((a) => a.id);
      if (onlineAgents.length === 0) return;

      probeInFlightRef.current = true;
      try {
        await api.probeAgents(onlineAgents);
      } catch {
        // Silent probe failure; the next 15s tick retries.
      } finally {
        probeInFlightRef.current = false;
      }
    };

    // Initial probe on mount / tab activation
    runProbe();

    probeTimer = window.setInterval(runProbe, 15000);

    const handleVisibility = () => {
      if (!document.hidden) {
        runProbe();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      isCancelled = true;
      if (probeTimer) clearInterval(probeTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isActiveTab]);

  // Filtered agents
  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      // Group filter
      if (selectedGroupFilter !== 'all' && !agent.groupIds.includes(selectedGroupFilter)) {
        return false;
      }

      // Status filter
      if (statusFilter === 'online' && (!agent.online || agent.disabled)) return false;
      if (statusFilter === 'offline' && (agent.online || agent.disabled)) return false;
      if (statusFilter === 'disabled' && !agent.disabled) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const nameMatch = agent.name?.toLowerCase().includes(q);
        const hostMatch = agent.hostname?.toLowerCase().includes(q);
        const idMatch = agent.id.toLowerCase().includes(q);
        if (!nameMatch && !hostMatch && !idMatch) return false;
      }

      return true;
    });
  }, [agents, selectedGroupFilter, statusFilter, searchQuery]);

  // Selection helpers
  const allFilteredSelected =
    filteredAgents.length > 0 &&
    filteredAgents.every((a) => selectedAgentIds.includes(a.id));
  const someFilteredSelected =
    filteredAgents.some((a) => selectedAgentIds.includes(a.id)) && !allFilteredSelected;

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      const filteredIds = new Set(filteredAgents.map((a) => a.id));
      setSelectedAgentIds((prev) => prev.filter((id) => !filteredIds.has(id)));
    } else {
      const newSelected = new Set(selectedAgentIds);
      filteredAgents.forEach((a) => newSelected.add(a.id));
      setSelectedAgentIds(Array.from(newSelected));
    }
  };

  const toggleSelectAgent = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  };

  // Actions
  const handleFetchInstall = async (agent: Agent) => {
    try {
      const install = await api.getAgentInstall(agent.id);
      onShowInstall(install, agent.name || agent.hostname || agent.id);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '获取机器安装命令失败');
    }
  };

  const handleDisableAgent = async () => {
    if (!disablingAgent) return;
    setIsActionLoading(true);
    try {
      await api.disableAgent(disablingAgent.id);
      onSuccess(`机器 ${disablingAgent.name || disablingAgent.hostname} 已禁用并断开连接`);
      setDisablingAgent(null);
      onRefresh();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '禁用机器操作失败');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRotateToken = async () => {
    if (!rotatingAgent) return;
    setIsActionLoading(true);
    try {
      const res = await api.rotateAgentToken(rotatingAgent.id);
      const install = await api.getAgentInstall(res.agent.id);
      onSuccess(`机器 ${rotatingAgent.name || rotatingAgent.hostname} 令牌已轮换`);
      setRotatingAgent(null);
      onRefresh();
      // Open install dialog with new credentials
      onShowInstall(install, res.agent.name || res.agent.hostname || res.agent.id);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '轮换机器凭据失败');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleManualProbe = async () => {
    const targets = selectedAgentIds.length > 0 ? selectedAgentIds : agents.filter(a => a.online).map(a => a.id);
    if (targets.length === 0) {
      onError('当前没有选中的在线机器可供探测');
      return;
    }

    setIsProbing(true);
    try {
      await api.probeAgents(targets);
      onSuccess(`已向 ${targets.length} 台机器发送 RTT 延迟探测包`);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '探测延迟失败');
    } finally {
      setIsProbing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Header / Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-teal-50 text-teal-600 rounded-lg">
            <Server className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-base font-bold text-slate-900">边缘机器节点</h2>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
                {agents.length} 台
              </span>
            </div>
            <p className="text-xs text-slate-500">通过 WebSocket 长连接实现纳秒级任务调度与状态同步</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenGroupModal}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 shadow-sm transition-colors"
          >
            <Layers className="w-3.5 h-3.5 mr-1.5 text-slate-500" />
            分组管理
          </button>
          <button
            type="button"
            onClick={onOpenBatchEnrollModal}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 shadow-sm transition-colors"
          >
            <Users className="w-3.5 h-3.5 mr-1.5 text-teal-600" />
            批量接入
          </button>
          <button
            type="button"
            onClick={onOpenAddModal}
            className="inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            添加机器
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          {/* Search Box */}
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索名称、主机名或 ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 bg-slate-50/50"
            />
          </div>

          {/* Group Filter */}
          <select
            value={selectedGroupFilter}
            onChange={(e) => setSelectedGroupFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white text-slate-700"
          >
            <option value="all">全部分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white text-slate-700"
          >
            <option value="all">全部状态</option>
            <option value="online">仅在线</option>
            <option value="offline">仅离线</option>
            <option value="disabled">已禁用</option>
          </select>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          <button
            type="button"
            onClick={handleManualProbe}
            disabled={isProbing}
            className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors disabled:opacity-50"
            title="对机器发起端到端 WS RTT 延迟采样"
          >
            <Activity className={`w-3.5 h-3.5 mr-1 text-teal-600 ${isProbing ? 'animate-spin' : ''}`} />
            延迟探测
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors"
            aria-label="刷新机器列表"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Bulk Selection Action Banner */}
      {selectedAgentIds.length > 0 && (
        <div className="flex items-center justify-between p-3 bg-teal-50 border border-teal-200 rounded-xl animate-fade-in text-teal-900 text-xs">
          <div className="flex items-center space-x-2">
            <span className="font-semibold">已选中 {selectedAgentIds.length} 台机器</span>
            <button
              type="button"
              onClick={() => setSelectedAgentIds([])}
              className="text-teal-700 underline hover:text-teal-900"
            >
              清空选择
            </button>
          </div>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => onExecuteBatch(selectedAgentIds)}
              className="inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
            >
              <Terminal className="w-3.5 h-3.5 mr-1.5" />
              对所选机器执行命令
            </button>
          </div>
        </div>
      )}

      {/* Main Agents Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto min-h-[300px]">
          <table className="w-full min-w-[980px] text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50/75 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <th className="py-3 px-3 w-10 text-center">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    aria-label="全选或取消全选"
                    className="p-0.5 rounded text-slate-500 hover:text-slate-800"
                  >
                    {allFilteredSelected ? (
                      <CheckSquare className="w-4 h-4 text-teal-600" />
                    ) : someFilteredSelected ? (
                      <MinusSquare className="w-4 h-4 text-teal-600" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="py-3 px-3">机器标识 / 主机名</th>
                <th className="py-3 px-3">所属分组</th>
                <th className="py-3 px-3">状态</th>
                <th className="py-3 px-3">当前任务</th>
                <th className="py-3 px-3">WS 往返延迟 (RTT)</th>
                <th className="py-3 px-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center">
                    <div className="max-w-sm mx-auto space-y-3">
                      <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                        <Server className="w-6 h-6" />
                      </div>
                      <h3 className="text-sm font-semibold text-slate-800">
                        {agents.length === 0 ? '暂无边缘机器' : '未匹配到符合条件的机器'}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {agents.length === 0
                          ? '点击“添加机器”或“批量接入”，在你的目标机器终端中执行生成的安装命令即可接入。'
                          : '请尝试更换搜索关键字或重置分组/状态过滤筛选条件。'}
                      </p>
                      {agents.length === 0 && (
                        <div className="pt-2 flex justify-center space-x-2">
                          <button
                            type="button"
                            onClick={onOpenAddModal}
                            className="inline-flex items-center px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm"
                          >
                            <Plus className="w-3.5 h-3.5 mr-1" />
                            添加第一台机器
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredAgents.map((agent) => {
                  const isSelected = selectedAgentIds.includes(agent.id);
                  const latency = formatLatency(agent.latencyMs, agent.latencyMeasuredAt);

                  return (
                    <tr
                      key={agent.id}
                      className={`hover:bg-slate-50/70 transition-colors ${
                        isSelected ? 'bg-teal-50/30' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => toggleSelectAgent(agent.id)}
                          aria-label={`选择机器 ${agent.name || agent.hostname}`}
                          className="p-0.5 rounded text-slate-400 hover:text-slate-800"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-teal-600" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>

                      {/* Name & Hostname */}
                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-900">
                          {agent.name || agent.hostname || '(首次连入自动识别)'}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 flex items-center space-x-2 mt-0.5">
                          <span>{agent.hostname ? `host: ${agent.hostname}` : `id: ${agent.id.slice(0, 12)}...`}</span>
                          {agent.version && (
                            <span className="bg-slate-100 text-slate-500 px-1 rounded">v{agent.version}</span>
                          )}
                        </div>
                      </td>

                      {/* Groups */}
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap gap-1 max-w-[180px]">
                          {agent.groupIds.length === 0 ? (
                            <span className="text-slate-400 italic">未分组</span>
                          ) : (
                            agent.groupIds.map((gid) => (
                              <span
                                key={gid}
                                className="inline-block px-1.5 py-0.5 rounded text-[11px] bg-slate-100 text-slate-600 border border-slate-200"
                              >
                                {groupMap.get(gid) || gid}
                              </span>
                            ))
                          )}
                        </div>
                      </td>

                      {/* Online status */}
                      <td className="py-3 px-3">
                        <AgentStatusBadge online={agent.online} disabled={agent.disabled} />
                      </td>

                      {/* Current Run */}
                      <td className="py-3 px-3">
                        {agent.currentRunId ? (
                          <span className="inline-flex items-center text-blue-600 font-mono text-[11px] bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                            <span className="w-1.5 h-1.5 mr-1 rounded-full bg-blue-500 animate-ping" />
                            运行 #{agent.currentRunId.slice(0, 8)}
                          </span>
                        ) : (
                          <span className="text-slate-400">空闲</span>
                        )}
                      </td>

                      {/* Latency */}
                      <td className="py-3 px-3">
                        <div className="flex items-center space-x-1.5">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              latency.status === 'good'
                                ? 'bg-emerald-500'
                                : latency.status === 'medium'
                                ? 'bg-amber-500'
                                : latency.status === 'slow'
                                ? 'bg-rose-500'
                                : 'bg-slate-300'
                            }`}
                          />
                          <span className="font-mono text-[11px] text-slate-600">
                            {latency.text}
                          </span>
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-3 text-right">
                        <div className="inline-flex items-center space-x-1">
                          <button
                            type="button"
                            onClick={() => handleFetchInstall(agent)}
                            title="获取安装命令与脚本"
                            aria-label={`获取机器 ${agent.name} 安装命令`}
                            className="p-1.5 text-slate-500 hover:text-teal-700 hover:bg-teal-50 rounded-lg transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onExecuteBatch([agent.id])}
                            title="向该机器执行命令"
                            aria-label={`向机器 ${agent.name} 执行命令`}
                            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                          >
                            <Terminal className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingAgent(agent)}
                            title="编辑属性"
                            aria-label={`编辑机器 ${agent.name}`}
                            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setRotatingAgent(agent)}
                            title="轮换访问令牌 (Rotate Token)"
                            aria-label={`轮换机器 ${agent.name} Token`}
                            className="p-1.5 text-slate-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDisablingAgent(agent)}
                            title="禁用机器并立即断开"
                            aria-label={`禁用机器 ${agent.name}`}
                            className="p-1.5 text-slate-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Disable Confirmation */}
      <ConfirmDialog
        isOpen={!!disablingAgent}
        onClose={() => setDisablingAgent(null)}
        onConfirm={handleDisableAgent}
        title="禁用机器节点"
        message={`确定要禁用机器 "${disablingAgent?.name || disablingAgent?.hostname}" 吗？该机器将立即从边缘面板断开连接，且无法接收新任务，直到重新启用。`}
        confirmText="确认禁用"
        isDestructive
        isLoading={isActionLoading}
      />

      {/* Rotate Token Confirmation */}
      <ConfirmDialog
        isOpen={!!rotatingAgent}
        onClose={() => setRotatingAgent(null)}
        onConfirm={handleRotateToken}
        title="轮换机器 OneToken 凭据"
        message={`确定为机器 "${rotatingAgent?.name || rotatingAgent?.hostname}" 重新生成接入凭据？原有的安装 Token 和连接将立刻失效，你需要使用新命令重新配置机器。`}
        confirmText="确认轮换"
        isDestructive={false}
        isLoading={isActionLoading}
      />

      {/* Edit Agent Dialog */}
      <EditAgentDialog
        isOpen={!!editingAgent}
        onClose={() => setEditingAgent(null)}
        agent={editingAgent}
        groups={groups}
        onSuccess={(updated) => {
          onSuccess(`机器 ${updated.name || updated.id} 修改成功`);
          onRefresh();
        }}
        onError={onError}
      />
    </div>
  );
};
