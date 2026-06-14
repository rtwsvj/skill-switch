import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import {
  DashboardShell,
  createConfirmationDialogState,
  mergeDeclaredSkills,
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
    expect(html).toContain(i18n.t('status.disabled'));
    expect(html).toContain(i18n.t('skills.actions.enable'));
  });
});
