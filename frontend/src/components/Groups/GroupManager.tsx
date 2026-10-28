import React, { useState } from 'react';
import type { Group, Agent } from '../../types/protocol';
import { api } from '../../api/client';
import { Dialog } from '../Common/Dialog';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { Plus, Edit2, Trash2, Folder, Loader2 } from 'lucide-react';

interface GroupManagerProps {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  agents: Agent[];
  onRefresh: () => void;
  onError: (msg: string) => void;
}

export const GroupManager: React.FC<GroupManagerProps> = ({
  isOpen,
  onClose,
  groups,
  agents,
  onRefresh,
  onError,
}) => {
  const [newGroupName, setNewGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [editName, setEditName] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);

  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;

    setIsCreating(true);
    try {
      await api.createGroup(trimmed);
      setNewGroupName('');
      onRefresh();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '创建分组失败');
    } finally {
      setIsCreating(false);
    }
  };

  const handleUpdateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingGroup) return;
    const trimmed = editName.trim();
    if (!trimmed) return;

    setIsUpdating(true);
    try {
      await api.updateGroup(editingGroup.id, trimmed);
      setEditingGroup(null);
      onRefresh();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '更新分组失败');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!deletingGroup) return;
    setIsDeleting(true);
    try {
      await api.deleteGroup(deletingGroup.id);
      setDeletingGroup(null);
      onRefresh();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : '删除分组失败');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Dialog
        isOpen={isOpen}
        onClose={onClose}
        title="机器分组管理"
        description="分组可用于批量下发命令过滤及多机权限划分"
        maxWidth="lg"
      >
        <div className="space-y-6">
          {/* Create Group Form */}
          <form onSubmit={handleCreateGroup} className="flex gap-2">
            <input
              type="text"
              placeholder="输入新分组名称（如：生产集群、测试节点）"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
            <button
              type="submit"
              disabled={isCreating || !newGroupName.trim()}
              className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-1.5" />
              )}
              新增分组
            </button>
          </form>

          {/* Group List */}
          <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
            {groups.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-400">
                暂无分组，请在上方输入名称创建第一个分组
              </div>
            ) : (
              groups.map((group) => {
                const count = agents.filter((a) => a.groupIds.includes(group.id)).length;
                return (
                  <div
                    key={group.id}
                    className="flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="p-1.5 bg-slate-100 text-slate-600 rounded-md">
                        <Folder className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-slate-800">{group.name}</div>
                        <div className="text-xs text-slate-400">ID: {group.id}</div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-4">
                      <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                        {count} 台机器
                      </span>
                      <div className="flex items-center space-x-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingGroup(group);
                            setEditName(group.name);
                          }}
                          className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                          aria-label={`编辑分组 ${group.name}`}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingGroup(group)}
                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                          aria-label={`删除分组 ${group.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      </Dialog>

      {/* Edit Group Sub-dialog */}
      <Dialog
        isOpen={!!editingGroup}
        onClose={() => setEditingGroup(null)}
        title="重命名分组"
        maxWidth="sm"
      >
        <form onSubmit={handleUpdateGroup} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">分组名称</label>
            <input
              type="text"
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>
          <div className="flex justify-end space-x-2 pt-2">
            <button
              type="button"
              onClick={() => setEditingGroup(null)}
              className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isUpdating || !editName.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-md disabled:opacity-50"
            >
              {isUpdating ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <ConfirmDialog
        isOpen={!!deletingGroup}
        onClose={() => setDeletingGroup(null)}
        onConfirm={handleDeleteGroup}
        title="删除分组"
        message={`确定要删除分组 "${deletingGroup?.name}" 吗？该操作不会删除其中的机器，但机器将被移出此分组。`}
        confirmText="确认删除"
        isDestructive
        isLoading={isDeleting}
      />
    </>
  );
};
