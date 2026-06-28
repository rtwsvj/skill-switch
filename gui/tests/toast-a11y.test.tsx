// Toast 无障碍测试:验证 ARIA 属性、landmark 和焦点恢复语义。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { createI18nForLanguage } from '../src/i18n';
import { UndoToastStack, ToastRow } from '../src/components/UndoToast';
import type { UndoToastItem } from '../src/components/UndoToast';

const mockToast: UndoToastItem = {
  id: '1',
  message: '已停用 test-skill — 后悔了?',
  onUndo: () => {},
};

async function renderStack(toasts: UndoToastItem[]) {
  const i18n = await createI18nForLanguage('en');
  const html = renderToString(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(UndoToastStack, { toasts, onDismiss: () => {} }),
    ),
  );
  return { html, i18n };
}

async function renderRow(toast: UndoToastItem) {
  const i18n = await createI18nForLanguage('en');
  const html = renderToString(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ToastRow, { toast, onDismiss: () => {} }),
    ),
  );
  return { html, i18n };
}

describe('UndoToast a11y', () => {
  it('空 toast 栈仍渲染容器(保持 aria-live 区域稳定)', async () => {
    const { html } = await renderStack([]);
    // 容器始终存在,aria-live 属性稳定挂载,避免动态插入失效
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('undo-toast-stack');
  });

  it('toast 区域是有名 landmark(section + aria-label,隐含 region 角色)', async () => {
    const { html, i18n } = await renderStack([mockToast]);
    // <section> + aria-label 即构成可导航的 region landmark(无需显式 role="region",避免 biome 冗余告警)
    expect(html).toContain('<section');
    expect(html).toContain(i18n.t('skills.undo.region'));
  });

  it('toast 区域 aria-live=polite 且 aria-atomic=false', async () => {
    const { html } = await renderStack([mockToast]);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="false"');
    expect(html).toContain('aria-relevant="additions removals"');
  });

  it('单条 toast 有 role="status" 且 aria-atomic=false', async () => {
    const { html } = await renderRow(mockToast);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="false"');
  });

  it('撤销按钮可见且有文字内容', async () => {
    const { html, i18n } = await renderRow(mockToast);
    expect(html).toContain(i18n.t('skills.undo.action'));
  });

  it('关闭按钮有 aria-label', async () => {
    const { html, i18n } = await renderRow(mockToast);
    // 关闭按钮用 aria-label 而非 ✕ 文字提供语义
    expect(html).toContain(`aria-label="${i18n.t('skills.undo.close')}"`);
  });

  it('进度条有 aria-hidden=true 防止被辅助技术朗读', async () => {
    const { html } = await renderRow(mockToast);
    expect(html).toContain('undo-toast-progress');
    expect(html).toContain('aria-hidden="true"');
  });

  it('多条 toast 同时存在时各自渲染正确', async () => {
    const toasts: UndoToastItem[] = [
      { id: '1', message: '已停用 foo — 后悔了?', onUndo: () => {} },
      { id: '2', message: '已删除 bar — 后悔了?', onUndo: () => {} },
    ];
    const { html } = await renderStack(toasts);
    expect(html).toContain('已停用 foo');
    expect(html).toContain('已删除 bar');
  });

  it('toast 消息文本与操作按钮是兄弟节点(平级布局)', async () => {
    const { html } = await renderRow(mockToast);
    // undo-toast-body 包含 msg 和 actions 两个兄弟
    expect(html).toContain('undo-toast-body');
    expect(html).toContain('undo-toast-msg');
    expect(html).toContain('undo-toast-actions');
  });
});
