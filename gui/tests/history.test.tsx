// F-B1:撤销/历史中心 —— 快照时间线渲染 + 一键还原动作 + 空态。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { History, describeSnapshotLabel } from '../src/App';
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
    // F1:标签翻成大白话操作记录(如 pre-toggle → "Backup before toggling …")。
    expect(html).toContain('Backup before');
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

describe('F1 describeSnapshotLabel (operation history)', () => {
  it('maps snapshot labels to plain-language operations with detail', async () => {
    const i18n = await createI18nForLanguage('en');
    const t = i18n.t.bind(i18n);
    expect(describeSnapshotLabel('pre-install-claude-code', t)).toBe('Backup before installing (claude-code)');
    expect(describeSnapshotLabel('pre-toggle-my-skill', t)).toBe('Backup before toggling “my-skill”');
    expect(describeSnapshotLabel('pre-remove-old-skill', t)).toBe('Backup before removing “old-skill”');
    expect(describeSnapshotLabel('pre-sync', t)).toBe('Backup before syncing');
    expect(describeSnapshotLabel('pre-restore', t)).toBe('Backup before restoring');
  });

  it('returns unrecognized labels unchanged', async () => {
    const i18n = await createI18nForLanguage('en');
    const t = i18n.t.bind(i18n);
    expect(describeSnapshotLabel('custom-label-xyz', t)).toBe('custom-label-xyz');
  });
});
