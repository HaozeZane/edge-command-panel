import React, { useState, useRef } from 'react';
import type { Enrollment, Group, InstallInfo } from '../../types/protocol';
import { api } from '../../api/client';
import { Dialog } from '../Common/Dialog';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { formatTimestamp } from '../../utils/format';
import {
  Users,
  Plus,
  RefreshCw,
  Download,
  Ban,
  Clock,
  Loader2,
  Info,
} from 'lucide-react';

interface EnrollmentListProps {
  enrollments: Enrollment[];
  groups: Group[];
  isLoading: boolean;
  onRefresh: () => void;
  onShowInstall: (info: InstallInfo, title: string) => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export const EnrollmentList: React.FC<EnrollmentListProps> = ({
  enrollments,
  groups,
  isLoading,
  onRefresh,
  onShowInstall,
  onError,
  onSuccess,
}) => {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [maxAgents, setMaxAgents] = useState(10);
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Preserve requestId on failure until inputs change
  const requestIdRef = useRef<string>(crypto.randomUUID());
  const lastPayloadRef = useRef<string>('');

  const currentPayload = JSON.stringify({
    name: name.trim(),
    groupIds: [...selectedGroupIds].sort(),
    maxAgents,
    ttlMinutes,
  });

  if (lastPayloadRef.current !== currentPayload) {
    requestIdRef.current = crypto.randomUUID();
    lastPayloadRef.current = currentPayload;
  }

  // Revoke state
  const [revokingEnrollment, setRevokingEnrollment] = useState<Enrollment | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId],
    );
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    try {
      const res = await api.createEnrollment({
        requestId: requestIdRef.current,
        name: trimmed,
        groupIds: selectedGroupIds,
        maxAgents: Number(maxAgents),
        ttlMinutes: Number(ttlMinutes),
      });

      setIsCreateOpen(false);
      setName('');
      setSelectedGroupIds([]);
      setMaxAgents(10);
      setTtlMinutes(60);
      requestIdRef.current = crypto.randomUUID();
      lastPayloadRef.current = '';

      onRefresh();
      onSuccess(`批量接入规则 "${res.enrollment.name}" 创建成功`);
      onShowInstall(res.install, `批量接入: ${res.enrollment.name}`);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '创建批量接入规则失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFetchInstall = async (item: Enrollment) => {
    try {
      const install = await api.getEnrollmentInstall(item.id);
      onShowInstall(install, `批量接入: ${item.name}`);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '获取批量接入安装命令失败');
    }
  };

  const handleRevokeConfirm = async () => {
    if (!revokingEnrollment) return;
    setIsRevoking(true);
    try {
      await api.revokeEnrollment(revokingEnrollment.id);
      onSuccess(`批量接入规则 "${revokingEnrollment.name}" 已成功撤销`);
      setRevokingEnrollment(null);
      onRefresh();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '撤销批量接入规则失败');
    } finally {
      setIsRevoking(false);
    }
  };

  const groupMap = new Map(groups.map((g) => [g.id, g.name]));

  return (
    <div className="space-y-4">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-teal-50 text-teal-600 rounded-lg">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">批量设备自动接入 (Auto-Enrollment)</h2>
            <p className="text-xs text-slate-500">
              生成单条通用命令供多台主机并发注册，适用于 CI/CD、Ansible、cloud-init 自动化初始化
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors"
            aria-label="刷新批量接入列表"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="inline-flex items-center px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            新建批量接入
          </button>
        </div>
      </div>

      {/* Enrollments Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto min-h-[250px]">
          <table className="w-full min-w-[900px] text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50/75 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <th className="py-3 px-4">接入规则名称</th>
                <th className="py-3 px-4">自动归属分组</th>
                <th className="py-3 px-4">已注册数 / 配额上限</th>
                <th className="py-3 px-4">过期时间</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {enrollments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center">
                    <div className="max-w-sm mx-auto space-y-3">
                      <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                        <Users className="w-6 h-6" />
                      </div>
                      <h3 className="text-sm font-semibold text-slate-800">暂无批量接入规则</h3>
                      <p className="text-xs text-slate-500">
                        新建一个批量接入规则，即可生成一条可被多台机器并发调用的安装脚本命令。
                      </p>
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => setIsCreateOpen(true)}
                          className="inline-flex items-center px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm"
                        >
                          <Plus className="w-3.5 h-3.5 mr-1" />
                          新建第一条接入规则
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                enrollments.map((item) => {
                  const isExpired = Date.now() > item.expiresAt;
                  const isFull = item.registeredCount >= item.maxAgents;

                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4 font-semibold text-slate-900">
                        <div>{item.name}</div>
                        <div className="text-[11px] font-mono text-slate-400 font-normal">
                          ID: {item.id}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1">
                          {item.groupIds.length === 0 ? (
                            <span className="text-slate-400 italic">默认无分组</span>
                          ) : (
                            item.groupIds.map((gid) => (
                              <span
                                key={gid}
                                className="px-1.5 py-0.5 rounded text-[11px] bg-slate-100 text-slate-600 border border-slate-200"
                              >
                                {groupMap.get(gid) || gid}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`font-semibold ${
                              isFull ? 'text-amber-600' : 'text-slate-800'
                            }`}
                          >
                            {item.registeredCount} / {item.maxAgents}
                          </span>
                          <span className="text-slate-400 text-[11px]">台</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center space-x-1.5 text-slate-600">
                          <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>{formatTimestamp(item.expiresAt)}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        {item.revoked ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
                            已撤销
                          </span>
                        ) : isExpired ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                            已过期
                          </span>
                        ) : isFull ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                            配额满
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            生效中
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex items-center space-x-2">
                          <button
                            type="button"
                            onClick={() => handleFetchInstall(item)}
                            disabled={item.revoked || isExpired}
                            className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 disabled:opacity-40 transition-colors"
                            aria-label="获取接入命令"
                          >
                            <Download className="w-3.5 h-3.5 mr-1" />
                            安装命令
                          </button>
                          {!item.revoked && (
                            <button
                              type="button"
                              onClick={() => setRevokingEnrollment(item)}
                              className="inline-flex items-center px-2 py-1 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-md hover:bg-rose-100 transition-colors"
                              aria-label="撤销此规则"
                            >
                              <Ban className="w-3.5 h-3.5 mr-1" />
                              撤销
                            </button>
                          )}
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

      {/* Create Enrollment Dialog */}
      <Dialog
        isOpen={isCreateOpen}
        onClose={isSubmitting ? () => {} : () => setIsCreateOpen(false)}
        title="创建批量设备自动接入规则"
        description="用于大规模服务器无交互集群部署"
        maxWidth="md"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">规则名称</label>
            <input
              type="text"
              required
              placeholder="如：生产 Kubernetes 节点批量部署"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              自动分配的分组
            </label>
            {groups.length === 0 ? (
              <p className="text-xs text-slate-400">暂无分组</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {groups.map((group) => {
                  const isSelected = selectedGroupIds.includes(group.id);
                  return (
                    <button
                      type="button"
                      key={group.id}
                      onClick={() => toggleGroup(group.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        isSelected
                          ? 'bg-teal-50 border-teal-500 text-teal-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {group.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                允许最大注册机器数 (Max Agents)
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={maxAgents}
                onChange={(e) => setMaxAgents(parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                有效时长 (分钟, 默认60)
              </label>
              <input
                type="number"
                min="5"
                max="10080"
                value={ttlMinutes}
                onChange={(e) => setTtlMinutes(parseInt(e.target.value) || 60)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-500 space-y-1">
            <div className="flex items-center space-x-1 font-semibold text-slate-700">
              <Info className="w-3.5 h-3.5 text-teal-600" />
              <span>接入说明</span>
            </div>
            <p>1. 各机器首次连入时以本机系统 hostname 登记，并自动由服务端分配专属设备 Token。</p>
            <p>2. 命令中包含临时共享接入凭据，达到最大注册数或到期后该命令将失效，请妥善保存。</p>
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-center justify-end space-x-3">
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              生成批量接入凭据
            </button>
          </div>
        </form>
      </Dialog>

      {/* Revoke Confirm Dialog */}
      <ConfirmDialog
        isOpen={!!revokingEnrollment}
        onClose={() => setRevokingEnrollment(null)}
        onConfirm={handleRevokeConfirm}
        title="撤销批量接入凭据"
        message={`确定要撤销批量接入规则 "${revokingEnrollment?.name}" 吗？撤销后，尚未接入的机器将无法再使用该命令注册，已接入的机器不受影响。`}
        confirmText="确认撤销"
        isDestructive
        isLoading={isRevoking}
      />
    </div>
  );
};
