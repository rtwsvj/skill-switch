import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import {
  DashboardShell,
  createConfirmationDialogState,
  mergeDeclaredSkills,
  syncActionLabel,
} from '../src/App';
import { createI18nForLanguage } from '../src/i18n';
import { loadDashboardData } from '../src/data/fixtures';
import type { DashboardData, DoctorDeclaration } from '../src/data';

function cloneData(data: DashboardData): DashboardData {
  return JSON.parse(JSON.stringify(data)) as DashboardData;
}

function withDeclarations(data: DashboardData, declarations: DoctorDeclaration[]): DashboardData {
  const next = cloneData(data);
  next.doctor.declarations = declarations;
  return next;
}

describe('GUI write confirmation and disabled declarations', () => {
  it('runs a write callback only when the app confirmation is confirmed', async () => {
    const close = vi.fn();
    const run = vi.fn();
    const cancelled = createConfirmationDialogState({
      title: 'Confirm',
      message: 'Write to disk?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      onConfirm: run,
    }, close);

    await cancelled.onCancel();
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    const confirmed = createConfirmationDialogState({
      title: 'Confirm',
      message: 'Write to disk?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      onConfirm: run,
    }, close);

    await confirmed.onConfirm();
    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('carries the F-B2 plain-language consequence line into the dialog state', () => {
    const withConsequence = createConfirmationDialogState({
      title: 'Confirm',
      message: 'Delete this skill?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      tone: 'danger',
      consequence: 'A backup is taken first — you can restore anytime.',
      onConfirm: () => {},
    }, () => {});
    expect(withConsequence.consequence).toBe('A backup is taken first — you can restore anytime.');

    // 省略 consequence 时不应凭空冒出该字段。
    const withoutConsequence = createConfirmationDialogState({
      title: 'Confirm',
      message: 'Plain write?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      onConfirm: () => {},
    }, () => {});
    expect(withoutConsequence.consequence).toBeUndefined();
  });

  it('F-A2: carries the structured "what will happen" details into the dialog state', () => {
    const withDetails = createConfirmationDialogState({
      title: 'Confirm',
      message: 'Apply sync?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      details: ['Add claude-code / foo', 'Remove gemini / bar'],
      onConfirm: () => {},
    }, () => {});
    expect(withDetails.details).toEqual(['Add claude-code / foo', 'Remove gemini / bar']);

    // 空 details 不应凭空出现该字段。
    const empty = createConfirmationDialogState({
      title: 'Confirm', message: 'x', confirmLabel: 'OK', cancelLabel: 'Cancel', details: [], onConfirm: () => {},
    }, () => {});
    expect(empty.details).toBeUndefined();
  });

  it('F-A2: syncActionLabel maps each action kind to plain language', async () => {
    const i18n = await createI18nForLanguage('en');
    const t = i18n.t.bind(i18n);
    expect(syncActionLabel({ kind: 'create', agent: 'claude-code', name: 'foo' }, t)).toBe('Add claude-code / foo');
    expect(syncActionLabel({ kind: 'remove', agent: 'gemini', name: 'bar' }, t)).toBe('Remove gemini / bar');
    expect(syncActionLabel({ kind: 'config-disable', agent: 'codex', name: 'baz' }, t)).toBe('Disable codex / baz');
    expect(syncActionLabel({ kind: 'weird-unknown', agent: 'a', name: 'b' }, t)).toBe('Change a / b');
  });

  it('renders the consequence reassurance text for the four consequence keys (i18n parity smoke)', async () => {
    const i18n = await createI18nForLanguage('zh-CN');
    for (const key of ['backup', 'disableKept', 'restoreOverwrite', 'forceRisk']) {
      const text = i18n.t(`operations.confirm.consequence.${key}`);
      // 键存在且非回退到键名本身。
      expect(text).not.toBe(`operations.confirm.consequence.${key}`);
      expect(text.length).toBeGreaterThan(4);
    }
  });

  it('merges declared disabled skills into the dashboard list without duplicating disk rows', async () => {
    const data = await loadDashboardData();
    const merged = mergeDeclaredSkills(withDeclarations(data, [
      {
        name: 'parked-skill',
        source: '/fixtures/.skill-switch/store/claude-code/parked-skill',
        agents: ['claude-code'],
        enabled: false,
        mode: 'copy',
      },
      {
        name: 'commit-style',
        source: '/fixtures/.skill-switch/store/claude-code/commit-style',
        agents: ['claude-code'],
        enabled: false,
        mode: 'copy',
      },
    ]));

    expect(merged.scan.skills.filter((skill) => skill.dirName === 'parked-skill')).toEqual([
      expect.objectContaining({
        name: 'parked-skill',
        agents: ['claude-code'],
        enabled: false,
      }),
    ]);
    expect(merged.scan.skills.filter((skill) => skill.dirName === 'commit-style')).toHaveLength(1);
    expect(merged.scan.skills.find((skill) => skill.dirName === 'commit-style')?.enabled).toBe(false);
    expect(merged.scan.total).toBe(data.scan.total + 1);
  });

  it('renders a disabled declared-only skill with an Enable action', async () => {
    const data = withDeclarations(await loadDashboardData(), [
      {
        name: 'parked-skill',
        source: '/fixtures/.skill-switch/store/claude-code/parked-skill',
        agents: ['claude-code'],
        enabled: false,
        mode: 'copy',
      },
    ]);
    const i18n = await createI18nForLanguage('en');

    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <DashboardShell data={data} initialScreen="skills" onRefresh={async () => {}} />
      </I18nextProvider>,
    );

    expect(html).toContain('parked-skill');
    // F-B3:停用状态明示「未删除」,且对停用项显示「启用」动作。
    expect(html).toContain(i18n.t('status.disabledKept'));
    expect(html).toContain(i18n.t('skills.actions.enable'));
  });
});
