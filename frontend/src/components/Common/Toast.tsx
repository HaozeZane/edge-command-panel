import React from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, X } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col space-y-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto p-3.5 rounded-xl shadow-lg border text-xs flex items-start space-x-3 transition-all animate-slide-up ${
            toast.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-900'
              : toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-slate-900 border-slate-800 text-white'
          }`}
        >
          {toast.type === 'error' ? (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          ) : toast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-teal-400 shrink-0 mt-0.5" />
          )}

          <div className="flex-1 font-medium leading-relaxed">{toast.message}</div>

          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="关闭提示"
            className="p-1 rounded hover:bg-black/5 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};

interface SessionExpiredModalProps {
  isOpen: boolean;
}

export const SessionExpiredModal: React.FC<SessionExpiredModalProps> = ({ isOpen }) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 space-y-4 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600">
          <AlertCircle className="w-6 h-6" />
        </div>

        <div className="space-y-1">
          <h3 id="session-expired-title" className="text-base font-bold text-slate-900">
            Cloudflare Access 会话已过期
          </h3>
          <p className="text-xs text-slate-500 leading-relaxed">
            你的 Cloudflare Access 身份验证令牌已失效或未通过鉴权。实时事件连接已暂停，避免继续重试消耗额度；请刷新页面完成重定向登录。
          </p>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full inline-flex items-center justify-center px-4 py-2.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4 mr-1.5" />
            刷新页面重新登录
          </button>
        </div>
      </div>
    </div>
  );
};
