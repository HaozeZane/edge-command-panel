import React, { useState, useEffect } from 'react';
import { decodeBase64urlJson } from '../../utils/base64';
import { Terminal, Copy, Check, Download, AlertCircle, ArrowLeft, ShieldCheck } from 'lucide-react';

interface InstallPayload {
  command: string;
  script?: string;
}

export const InstallPortal: React.FC = () => {
  const [payload, setPayload] = useState<InstallPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Read payload strictly from client hash fragment, never sending to any backend
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) {
      setError('缺少安装凭据参数。请从 Edge Command 控制台复制完整的安装链接。');
      return;
    }

    try {
      const data = decodeBase64urlJson<InstallPayload>(hash);
      if (!data || typeof data.command !== 'string') {
        throw new Error('格式不符合预期');
      }
      setPayload(data);
    } catch {
      setError('安装凭据解析失败，链接可能已损坏或格式不正确。请重新生成。');
    }
  }, []);

  const handleCopy = async () => {
    if (!payload?.command) return;
    try {
      await navigator.clipboard.writeText(payload.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = payload.command;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (!payload?.command) return;
    const scriptContent = payload.script || `#!/usr/bin/env bash\nset -euo pipefail\n${payload.command}\n`;
    const blob = new Blob([scriptContent], { type: 'text/x-sh;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'install-agent.sh';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-between p-4 sm:p-6 lg:p-8">
      <div className="max-w-3xl w-full mx-auto space-y-6 pt-8">
        {/* Navigation / Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-teal-400">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">Edge Command 节点安装</h1>
              <p className="text-xs text-slate-400">设备接入引导与安装凭据</p>
            </div>
          </div>
          <a
            href="/"
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
            返回面板
          </a>
        </div>

        {error ? (
          <div className="p-6 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 space-y-3">
            <div className="flex items-center space-x-2 text-red-400 font-semibold">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>无法载入安装凭据</span>
            </div>
            <p className="text-sm">{error}</p>
          </div>
        ) : !payload ? (
          <div className="p-8 text-center text-slate-400 text-sm">正在加载凭据信息...</div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-start space-x-3 p-4 bg-teal-950/30 border border-teal-800/40 rounded-xl text-teal-200 text-xs leading-relaxed">
              <ShieldCheck className="w-5 h-5 text-teal-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-teal-300">安全提示：</span>
                凭据包含在链接片段中，仅在此页面解析，请妥善保存。命令内含设备接入凭据，在目标 Linux 机器执行后将自动完成鉴权并在面板上线。
              </div>
            </div>

            {/* Terminal Command Display */}
            <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
              <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800">
                <span className="text-xs font-mono text-slate-400">Shell Command (Linux)</span>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="inline-flex items-center px-3 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-md border border-slate-700 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5 mr-1.5 text-slate-400" />
                    下载 .sh 脚本
                  </button>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center px-3.5 py-1 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-500 rounded-md shadow-sm transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 mr-1 text-teal-200" />
                        <span>已复制命令!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 mr-1" />
                        <span>复制完整命令</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className="p-4 overflow-x-auto">
                <pre className="font-mono text-xs text-teal-300 whitespace-pre-wrap break-all leading-relaxed">
                  <code>{payload.command}</code>
                </pre>
              </div>
            </div>

            {/* Instruction Steps */}
            <div className="p-5 rounded-xl bg-slate-800/50 border border-slate-800 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                执行步骤与注意事项
              </h3>
              <ol className="text-xs text-slate-300 space-y-2 list-decimal list-inside leading-relaxed">
                <li>通过 SSH 登录到目标 Linux 机器（支持 Linux x86_64 / arm64，安装脚本将自动联网拉取运行时）。</li>
                <li>以 root 或具备 sudo 权限的账号粘贴上述命令并回车执行；普通用户的命令会自动通过 sudo 安装，可能提示当前 sudo 密码。</li>
                <li>Agent 以安装时所用的账号运行：root 安装即以 root 身份运行，sudo 安装则发起安装的原登录账号运行，现有 systemd 服务隔离设置继续适用。</li>
                <li>重复执行批量接入（enroll）安装且本机已存在有效配置时，会复用原机器身份：不新增机器、不消耗注册名额；单台机器（direct）安装则会以所选机器凭据显式覆盖本机配置。两种情况下安装都会升级并重启 Agent，可能中断正在执行的命令；本地旧业务命令记录不会重跑。</li>
                <li>执行完毕后，Agent 会作为后台守护服务启动并建立与面板的 WebSocket 长连接。</li>
                <li>稍后在 Edge Command 面板机器列表中即可看到该机器（默认显示系统主机名 hostname）。</li>
              </ol>
            </div>
          </div>
        )}
      </div>

      <div className="max-w-3xl w-full mx-auto text-center text-xs text-slate-500 py-6 border-t border-slate-800 mt-12">
        Edge Command - 边缘容器与主机运维自动化
      </div>
    </div>
  );
};
