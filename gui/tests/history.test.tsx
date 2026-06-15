// F-B1:撤销/历史中心 —— 快照时间线渲染 + 一键还原动作 + 空态。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { History } from '../src/App';
import { createI18nForLanguage } from '../src/i18n';
import { runRestore } from '../src/data/fixtures';
import type { RestoreListResult } from '../src/data';

async function renderHistory(restoreList: RestoreListResult | null, loaded: boolean) {
  const i18n = await createI18nForLanguage('en');
  const html = renderToString(
    <I18nextProvider i18n={i18n}>
      <History restoreList={restoreList} busy={null} loaded={loaded} onReload={() => {}} onRestore={() => {}} />
    </I18nextProvider>,
  );
  return { html, i18n };
}

describe('F-B1 History center', () => {
  it('renders the snapshot timeline with a restore action when snapshots are loaded', async () => {
    const result = await runRestore({});
    const list = result.data as RestoreListResult; // 无 id/latest → 列表分支
    expect(list.snapshots.length).toBeGreaterThan(0);

    const { html, i18n } = await renderHistory(list, true);
    expect(html).toContain(list.snapshots[0].label); // 快照标签可见(如 pre-toggle)
    expect(html).toContain(i18n.t('history.restoreHere')); // 一键还原按钮
  });

  it('shows a friendly empty state (not an error) when loaded with no snapshots', async () => {
    const { html, i18n } = await renderHistory({ store: '/x', snapshots: [] }, true);
    expect(html).toContain(i18n.t('history.empty'));
  });

  it('does not show the empty state before the first load completes', async () => {
    const { html, i18n } = await renderHistory(null, false);
    expect(html).not.toContain(i18n.t('history.empty'));
  });
});
