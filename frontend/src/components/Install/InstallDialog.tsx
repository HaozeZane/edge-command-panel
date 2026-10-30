import React, { useState } from 'react';
import { Dialog } from '../Common/Dialog';
import type { InstallInfo } from '../../types/protocol';
import { Check, Copy, Download, ShieldAlert, Terminal, ExternalLink } from 'lucide-react';

interface InstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  installInfo: InstallInfo | null;
  agentName?: string;
}

export const InstallDialog: React.FC<InstallDialogProps> = ({
  isOpen,
  onClose,
  title = '机器安装与接入引导',
  installInfo,
  agentName,
}) => {
  const [copiedType, setCopiedType] = useState<'command' | 'link' | null>(null);

  if (!installInfo) return null;

  const handleCopy = async (text: string, type: 'command' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    } catch {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    }
  };

  const handleDownloadScript = () => {
    if (!installInfo.script) return;
    const blob = new Blob([installInfo.script], { type: 'text/x-sh;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'install.sh';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={agentName ? `目标机器: ${agentName}` : '请在目标 Linux 系统中运行安装命令（root 或 sudo）'}
      maxWidth="2xl"
    >
      <div className="space-y-6">
        {/* Security Notice */}
        <div className="flex items-start space-x-3 p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs leading-relaxed">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">凭据保管须知：</span>
            本命令与脚本内含专属 One 设备凭据（可重复获取与安装）。请妥善保存，切勿泄露或提交至公开代码仓库。机器上线后将默认使用系统主机名（hostname）登记。
            <br />
            <span className="font-semibold">运行身份说明：</span>
            以 root 执行安装时 Agent 将以 root 身份运行；通过 sudo 执行安装时 Agent 将以发起安装的原登录账号运行，现有 systemd 服务隔离设置继续适用。
          </div>
        </div>

        {/* Option 1: One-line Command */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-700 flex items-center space-x-1.5">
              <Terminal className="w-4 h-4 text-teal-600" />
              <span>方式一：一键终端安装命令（推荐）</span>
            </label>
            <button
              type="button"
              onClick={() => handleCopy(installInfo.command, 'command')}
              className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 transition-colors"
              aria-label="复制一键安装命令"
            >
              {copiedType === 'command' ? (
                <>
                  <Check className="w-3.5 h-3.5 mr-1 text-emerald-600" />
                  <span className="text-emerald-700 font-semibold">已复制!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  <span>复制命令</span>
                </>
              )}
            </button>
          </div>
          <div className="relative group">
            <pre className="p-3.5 bg-slate-900 text-slate-100 font-mono text-xs rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-slate-800 selection:bg-teal-600 selection:text-white max-h-32">
              <code>{installInfo.command}</code>
            </pre>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            普通用户粘贴执行即可：命令会自动通过 sudo 安装（可能提示当前 sudo 密码），Agent 随后以发起安装的原登录账号运行；以 root 执行则 Agent 以 root 运行（现有 systemd 服务隔离继续适用）。注意：复用本机身份、不新增机器且不消耗注册名额，仅适用于重复执行批量接入（enroll）安装且本机已存在有效配置的情况；单台机器（direct）安装仍会以所选机器的凭据显式覆盖本机配置。复用或覆盖时都会升级 Agent 并伴随服务重启，可能中断正在执行的任务；已保留的本地旧业务命令记录不会重新执行。
          </p>
        </div>

        {/* Option 2: Web Install Link */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-700 flex items-center space-x-1.5">
              <ExternalLink className="w-4 h-4 text-cyan-600" />
              <span>方式二：独立安装页面链接（转发给运维人员）</span>
            </label>
            <button
              type="button"
              onClick={() => handleCopy(installInfo.link, 'link')}
              className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-md hover:bg-cyan-100 transition-colors"
              aria-label="复制独立安装链接"
            >
              {copiedType === 'link' ? (
                <>
                  <Check className="w-3.5 h-3.5 mr-1 text-emerald-600" />
                  <span className="text-emerald-700 font-semibold">已复制!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  <span>复制链接</span>
                </>
              )}
            </button>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              readOnly
              value={installInfo.link}
              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-600 select-all focus:outline-none"
            />
          </div>
          <p className="text-[11px] text-slate-400">
            凭据包含在链接片段中，仅在此页面解析，请妥善保存。访问页面可直接复制命令或下载自包含脚本。
          </p>
        </div>

        {/* Option 3: Download Install Script */}
        {installInfo.script && (
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-slate-700">方式三：自包含安装脚本</div>
              <p className="text-[11px] text-slate-400">
                下载 <code>install.sh</code>（需联网拉取 Agent 运行时），普通用户在目标 Linux 机器执行 <code>sudo bash install.sh</code>，root 可直接执行 <code>bash install.sh</code>
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadScript}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 shadow-sm transition-colors"
              aria-label="下载安装脚本"
            >
              <Download className="w-3.5 h-3.5 mr-1.5 text-slate-500" />
              下载 install.sh
            </button>
          </div>
        )}

        <div className="pt-4 border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
          >
            完成并关闭
          </button>
        </div>
      </div>
    </Dialog>
  );
};
