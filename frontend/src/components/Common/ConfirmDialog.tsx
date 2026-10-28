import React from 'react';
import { Dialog } from './Dialog';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  isDestructive = false,
  isLoading = false,
}) => {
  return (
    <Dialog isOpen={isOpen} onClose={isLoading ? () => {} : onClose} title={title} maxWidth="sm">
      <div className="space-y-4">
        <div className="flex items-start space-x-3">
          <div
            className={`p-2 rounded-full shrink-0 ${
              isDestructive ? 'bg-red-50 text-red-600' : 'bg-teal-50 text-teal-600'
            }`}
          >
            <AlertTriangle className="w-5 h-5" />
          </div>
          <p className="text-sm text-slate-600 leading-relaxed pt-0.5">{message}</p>
        </div>

        <div className="flex items-center justify-end space-x-3 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500 disabled:opacity-50 transition-colors"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 transition-colors ${
              isDestructive
                ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                : 'bg-teal-600 hover:bg-teal-700 focus:ring-teal-500'
            }`}
          >
            {isLoading && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </Dialog>
  );
};
