import React, { useState, useEffect } from 'react';
import type { Agent, Group } from '../../types/protocol';
import { api } from '../../api/client';
import { Dialog } from '../Common/Dialog';
import { Loader2 } from 'lucide-react';

interface EditAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agent: Agent | null;
  groups: Group[];
  onSuccess: (updatedAgent: Agent) => void;
  onError: (msg: string) => void;
}

export const EditAgentDialog: React.FC<EditAgentDialogProps> = ({
  isOpen,
  onClose,
  agent,
  groups,
  onSuccess,
  onError,
}) => {
  const [name, setName] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (agent) {
      setName(agent.name || '');
      setSelectedGroupIds(agent.groupIds || []);
    }
  }, [agent]);

  if (!agent) return null;

  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await api.updateAgent(agent.id, {
        name: name.trim(),
        groupIds: selectedGroupIds,
      });
      onSuccess(res.agent);
      onClose();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '更新机器信息失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={isSubmitting ? () => {} : onClose}
      title="编辑机器属性"
      description={`机器 ID: ${agent.id}`}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">机器显示名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={agent.hostname || '留空恢复为主机名'}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          {agent.hostname && (
            <p className="mt-1 text-xs text-slate-400">检测到的主机名: {agent.hostname}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">所属分组</label>
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

        <div className="pt-4 border-t border-slate-100 flex items-center justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm disabled:opacity-50"
          >
            {isSubmitting && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            保存修改
          </button>
        </div>
      </form>
    </Dialog>
  );
};
