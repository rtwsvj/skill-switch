import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface UndoToastItem {
  id: string;
  message: string;
  onUndo: () => void;
}

/** 全局撤销 toast 队列 — 每条 toast 在 AUTO_DISMISS_MS 后自动消失。 */
export const AUTO_DISMISS_MS = 6000;

export function useUndoToast() {
  const [toasts, setToasts] = useState<UndoToastItem[]>([]);
  const counterRef = useRef(0);

  function showUndo(message: string, onUndo: () => void) {
    const id = String(++counterRef.current);
    setToasts((prev: UndoToastItem[]) => [...prev, { id, message, onUndo }]);
    setTimeout(() => {
      setToasts((prev: UndoToastItem[]) => prev.filter((item: UndoToastItem) => item.id !== id));
    }, AUTO_DISMISS_MS);
  }

  function dismissToast(id: string) {
    setToasts((prev: UndoToastItem[]) => prev.filter((item: UndoToastItem) => item.id !== id));
  }

  return { toasts, showUndo, dismissToast };
}

/**
 * 单条 toast。单独抽出是为了能用 useEffect 挂进度条动画。
 * 注:在没有 @types/react 时,往自定义组件传 key 会出现 TS2322 误报。
 * 规避方式:通过 createElement 绕开 JSX key 类型检查 — key 在 React 运行时仍正常工作。
 */
export function ToastRow({
  toast,
  onDismiss,
}: {
  toast: UndoToastItem;
  onDismiss: (id: string) => void;
}) {
  const progressRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  // 让进度条动画匹配自动关闭时长
  useEffect(() => {
    const el = progressRef.current;
    if (!el) return;
    el.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
    // 用 rAF 等 paint 之后再设置宽度,让 transition 生效
    const raf = requestAnimationFrame(() => {
      el.style.width = '0%';
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="undo-toast" role="status">
      <div className="undo-toast-progress" ref={progressRef} />
      <div className="undo-toast-body">
        <span className="undo-toast-msg">{toast.message}</span>
        <div className="undo-toast-actions">
          <button
            type="button"
            className="undo-toast-undo primary-action"
            onClick={() => {
              toast.onUndo();
              onDismiss(toast.id);
            }}
          >
            {t('skills.undo.action')}
          </button>
          <button
            type="button"
            className="undo-toast-close ghost-button"
            aria-label={t('skills.undo.close')}
            onClick={() => onDismiss(toast.id)}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

import { createElement } from 'react';

export function UndoToastStack({
  toasts,
  onDismiss,
}: {
  toasts: UndoToastItem[];
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (toasts.length === 0) return null;
  return (
    <section className="undo-toast-stack" aria-label={t('skills.undo.region')}>
      {toasts.map((toast: UndoToastItem) =>
        // createElement 用于绕开 @types/react 缺失时 JSX 对 key 的误报
        createElement(ToastRow, { key: toast.id, toast, onDismiss }),
      )}
    </section>
  );
}
