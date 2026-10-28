import React, { useState, useRef } from 'react';
import type { Group, InstallInfo, Agent } from '../../types/protocol';
import { api } from '../../api/client';
import { Dialog } from '../Common/Dialog';
import { Loader2, Plus, Info } from 'lucide-react';

interface AddAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  onSuccess: (agent: Agent, install: InstallInfo) => void;
  onError: (msg: string) => void;
}

export const AddAgentDialog: React.FC<AddAgentDialogProps> = ({
  isOpen,
  onClose,
  groups,
  onSuccess,
  onError,
}) => {
  const [name, setName] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Preserve requestId on failure until inputs change
  const requestIdRef = useRef<string>(crypto.randomUUID());
  const lastPayloadRef = useRef<string>('');

  const currentPayload = JSON.stringify({ name: name.trim(), groupIds: [...selectedGroupIds].sort() });
  if (lastPayloadRef.current !== currentPayload) {
    // Payload changed, update requestId
    requestIdRef.current = crypto.randomUUID();
    lastPayloadRef.current = currentPayload;
  }

  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const trimmedName = name.trim();
      const res = await api.createAgent({
        requestId: requestIdRef.current,
        name: trimmedName || undefined,
        groupIds: selectedGroupIds,
      });

      // Fetch install credentials immediately
      const install = await api.getAgentInstall(res.agent.id);

      // Reset form and generate new requestId for subsequent creates
      setName('');
      setSelectedGroupIds([]);
      requestIdRef.current = crypto.randomUUID();
      lastPayloadRef.current = '';

      onSuccess(res.agent, install);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '添加机器失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={isSubmitting ? () => {} : onClose}
      title="添加单台新机器"
      description="创建机器接入令牌并生成一键安装脚本"
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">
            机器标识名称（可选）
          </label>
          <input
            type="text"
            placeholder="如：node-shanghai-01（留空将自动使用主机名）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          <div className="mt-1 flex items-center space-x-1 text-[11px] text-slate-500">
            <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>如果留空，Agent 在首次连入时会自动上报系统主机名（hostname）作为展示名称。</span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">
            所属分组（可选）
          </label>
          {groups.length === 0 ? (
            <p className="text-xs text-slate-400 italic">暂无可选分组，可在分组管理中预先创建</p>
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

        <div className="pt-4 border-t border-slate-100 flex items-center justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 mr-1.5" />
            )}
            生成凭据并继续
          </button>
        </div>
      </form>
    </Dialog>
  );
};
