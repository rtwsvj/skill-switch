import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

export interface UndoToastItem {
  id: string;
  message: string;
  onUndo: () => void;
  /** toast 弹出前焦点所在元素,关闭时恢复 */
  triggerEl?: Element | null;
}

/** 全局撤销 toast 队列 — 每条 toast 在 AUTO_DISMISS_MS 后自动消失。最短 ≥5s(WCAG 2.2) */
export const AUTO_DISMISS_MS = 6000;

export function useUndoToast() {
  const [toasts, setToasts] = useState<UndoToastItem[]>([]);
  const counterRef = useRef(0);

  /** 弹出一条可撤销 toast。triggerEl 可选传当前焦点元素,关闭时自动归还焦点。 */
  function showUndo(message: string, onUndo: () => void) {
    const id = String(++counterRef.current);
    // 记录弹出时的焦点元素,toast 关闭后归还
    const triggerEl = typeof document !== 'undefined' ? document.activeElement : null;
    setToasts((prev: UndoToastItem[]) => [...prev, { id, message, onUndo, triggerEl }]);
    setTimeout(() => {
      setToasts((prev: UndoToastItem[]) => prev.filter((item: UndoToastItem) => item.id !== id));
    }, AUTO_DISMISS_MS);
  }

  const dismissToast = useCallback((id: string) => {
    setToasts((prev: UndoToastItem[]) => {
      const item = prev.find((t) => t.id === id);
      // 关闭时恢复焦点到触发元素
      if (item?.triggerEl && 'focus' in item.triggerEl) {
        requestAnimationFrame(() => {
          (item.triggerEl as HTMLElement).focus?.();
        });
      }
      return prev.filter((t) => t.id !== id);
    });
  }, []);

  return { toasts, showUndo, dismissToast };
}

/**
 * 单条 toast。单独抽出是为了能用 useEffect 挂进度条动画和键盘导航。
 * W4/G2:迁移到 shadcn 设计系统(Button + 设计 token),明暗自适应,风格与 Overview 一致。
 * a11y 不动:role="status"、aria-atomic、进度条 aria-hidden、关闭按钮 aria-label 全部保留;
 * 结构类名(undo-toast-*)也保留,供无障碍测试断言与既有 CSS 布局挂载。
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
    <div
      className={cn(
        'undo-toast',
        'pointer-events-auto relative overflow-hidden rounded-lg',
        'border border-primary/50 bg-card text-card-foreground shadow-dialog',
        'animate-fade-in',
      )}
      // role="status" 用于非紧急通知;屏幕阅读器会在合适时机朗读
      role="status"
      // aria-atomic=false:允许阅读器只读更新内容,不打断整段
      aria-atomic="false"
    >
      <div
        className="undo-toast-progress absolute left-0 top-0 h-0.5 w-full bg-primary/60 will-change-[width]"
        ref={progressRef}
        aria-hidden="true"
      />
      <div className="undo-toast-body flex items-center gap-2.5 px-3.5 py-3">
        {/* 消息与操作按钮是兄弟节点,辅助技术可依次访问 */}
        <span className="undo-toast-msg flex-1 text-[13px] leading-snug text-foreground">
          {toast.message}
        </span>
        <div className="undo-toast-actions flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="default"
            size="sm"
            className="undo-toast-undo h-7 px-2.5 text-xs"
            onClick={() => {
              toast.onUndo();
              onDismiss(toast.id);
            }}
          >
            {t('skills.undo.action')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="undo-toast-close h-7 w-7 text-muted-foreground"
            aria-label={t('skills.undo.close')}
            onClick={() => onDismiss(toast.id)}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function UndoToastStack({
  toasts,
  onDismiss,
}: {
  toasts: UndoToastItem[];
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  // toast 区域始终挂载在 DOM 里(空时隐藏),保持 aria-live 区域稳定,避免动态插入导致朗读失效
  return (
    <section
      className={cn(
        'undo-toast-stack',
        'pointer-events-none fixed bottom-6 right-5 z-50 grid gap-2',
        'w-[min(360px,calc(100vw-2rem))]',
        toasts.length === 0 && 'undo-toast-stack-empty',
      )}
      aria-label={t('skills.undo.region')}
      // aria-live=polite:插入新消息时屏幕阅读器在空闲时机朗读,不打断当前操作
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions removals"
    >
      {toasts.map((toast: UndoToastItem) =>
        // createElement 用于绕开 @types/react 缺失时 JSX 对 key 的误报
        createElement(ToastRow, { key: toast.id, toast, onDismiss }),
      )}
    </section>
  );
}
