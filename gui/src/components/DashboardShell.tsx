import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runInstall,
  runRemove,
  runRestore,
  runSync,
  runToggle,
  type ConfigAuditReport,
  type DashboardData,
  type InstallRunResult,
  type RestoreListResult,
  type SkillRecord,
  type SyncRunResult,
} from '../data';
import {
  actionSkillName,
  advancedStorageKey,
  agentOptions,
  changedActionCount,
  createConfirmationDialogState,
  cx,
  importableSkills,
  initialSectionStates,
  isRestoreList,
  mergeDeclaredSkills,
  onboardedStorageKey,
  readStoredAdvanced,
  readStoredOnboarded,
  screens,
  sectionsForScreen,
  skillAgentKey,
  snapshotPaths,
  syncActionLabel,
} from '../lib/helpers';
import type {
  ConfirmationDialogState,
  InstallDraft,
  OperationNotice,
  Screen,
  SectionName,
  SectionStates,
  SkillActionsProps,
  WriteConfirmationRequest,
  WriteOperationsProps,
} from '../lib/types';
import { ConfirmationDialog, Header, OperationBanner } from './atoms';
import { Audit } from './Audit';
import { ConfigAudit } from './ConfigAudit';
import { History } from './History';
import { Overview } from './Overview';
import { Skills } from './Skills';
import { Stats } from './Stats';

export function DashboardShell({
  data,
  configAudit = null,
  initialScreen = 'overview',
  onRefresh,
  sections = initialSectionStates,
  onEnsureSections,
  onReloadSection,
}: {
  data: DashboardData;
  configAudit?: ConfigAuditReport | null;
  initialScreen?: Screen;
  onRefresh: () => Promise<void>;
  sections?: SectionStates;
  onEnsureSections?: (names: SectionName[]) => void;
  onReloadSection?: (name: SectionName) => void;
}) {
  const { t } = useTranslation();
  const mergedData = useMemo(() => mergeDeclaredSkills(data), [data]);
  const [active, setActive] = useState<Screen>(initialScreen);

  // M0-5.6:进入某屏时按需触发它消费的懒加载区块(idle→loading)。overview 触发 audit+stats。
  useEffect(() => {
    onEnsureSections?.(sectionsForScreen(active));
  }, [active, onEnsureSections]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<OperationNotice | null>(null);
  const [installDraft, setInstallDraft] = useState<InstallDraft>({
    source: '',
    agent: agentOptions(mergedData)[0] ?? 'claude-code',
    mode: 'copy',
    skill: '',
    ref: '',
    force: false,
  });
  const [installResult, setInstallResult] = useState<InstallRunResult | null>(null);
  const [blockedReason, setBlockedReason] = useState('');
  const [syncPlan, setSyncPlan] = useState<SyncRunResult | null>(null);
  const [restoreList, setRestoreList] = useState<RestoreListResult | null>(null);
  const [advanced, setAdvanced] = useState(readStoredAdvanced);
  const [onboarded, setOnboarded] = useState(readStoredOnboarded);
  const [confirmation, setConfirmation] = useState<ConfirmationDialogState | null>(null);

  const declaredAgentPairs = useMemo(
    () => new Set((data.doctor.declarations ?? []).flatMap((entry) => entry.agents.map((agent) => skillAgentKey(agent, entry.name)))),
    [data.doctor.declarations],
  );

  // F-A3:磁盘上还没纳入声明管理的技能,可一键导入。
  const importable = useMemo(
    () => importableSkills(mergedData.scan.skills, declaredAgentPairs),
    [mergedData.scan.skills, declaredAgentPairs],
  );

  const requestConfirmation = useCallback((request: WriteConfirmationRequest) => {
    setConfirmation(createConfirmationDialogState({
      title: t('operations.confirmDialog.title'),
      confirmLabel: t('operations.confirmDialog.confirm'),
      cancelLabel: t('operations.confirmDialog.cancel'),
      ...request,
    }, () => setConfirmation(null)));
  }, [t]);

  const setAdvancedPreference = useCallback((enabled: boolean) => {
    setAdvanced(enabled);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(advancedStorageKey, String(enabled));
    }
  }, []);

  const dismissOnboarding = useCallback(() => {
    setOnboarded(true);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(onboardedStorageKey, 'true');
    }
  }, []);

  const runBusy = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (reason) {
      setNotice({
        tone: 'danger',
        title: t('operations.notice.failed'),
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusy(null);
    }
  }, [t]);

  const handleInstall = useCallback(() => {
    const source = installDraft.source.trim();
    if (!source) {
      setNotice({ tone: 'warn', title: t('operations.notice.missingSource') });
      return;
    }
    requestConfirmation({
      message: t(installDraft.force ? 'operations.confirm.forceInstall' : 'operations.confirm.install'),
      tone: installDraft.force ? 'danger' : 'warn',
      consequence: t(installDraft.force ? 'operations.confirm.consequence.forceRisk' : 'operations.confirm.consequence.backup'),
      onConfirm: () => runBusy('install', async () => {
        const result = await runInstall({
          source,
          agent: installDraft.agent,
          mode: installDraft.mode,
          ...(installDraft.skill.trim() ? { skill: installDraft.skill.trim() } : {}),
          ...(installDraft.ref.trim() ? { ref: installDraft.ref.trim() } : {}),
          force: installDraft.force,
        });
        setInstallResult(result.data);
        if (result.data.blocked.length > 0) {
          setNotice({
            tone: 'danger',
            title: t('operations.install.blocked'),
            detail: t('operations.install.blockedDetail', { count: result.data.blocked.length }),
          });
          return;
        }
        setNotice({
          tone: 'good',
          title: t('operations.notice.installed'),
          detail: t('operations.notice.exitCode', { code: result.exitCode }),
          snapshots: snapshotPaths(result.data),
        });
        await onRefresh();
      }),
    });
  }, [installDraft, onRefresh, requestConfirmation, runBusy, t]);

  // F-A3:把磁盘上未纳入管理的技能一键收编(对每个未声明的 agent 走 install-from-disk = 与启用未声明技能同一条成熟路径)。
  const handleImportExisting = useCallback(() => {
    if (importable.length === 0) return;
    requestConfirmation({
      message: t('operations.import.confirm', { count: importable.length }),
      consequence: t('operations.confirm.consequence.backup'),
      details: importable.map((skill) => skill.dirName),
      onConfirm: () => runBusy('import', async () => {
        const snapshots: string[] = [];
        let imported = 0;
        for (const skill of importable) {
          const name = skill.dirName;
          const undeclaredAgents = skill.agents.filter((agent) => !declaredAgentPairs.has(skillAgentKey(agent, name)));
          for (const agent of undeclaredAgents) {
            const result = await runInstall({ source: skill.dir, agent, mode: 'copy', skill: name, force: false });
            if (result.data.blocked.length > 0) {
              setInstallResult(result.data);
              setNotice({
                tone: 'danger',
                title: t('operations.install.blocked'),
                detail: t('operations.install.blockedDetail', { count: result.data.blocked.length }),
              });
              return;
            }
            snapshots.push(...snapshotPaths(result.data));
          }
          imported += 1;
        }
        setNotice({ tone: 'good', title: t('operations.import.done', { count: imported }), snapshots });
        await onRefresh();
      }),
    });
  }, [importable, declaredAgentPairs, onRefresh, requestConfirmation, runBusy, t]);

  // F-C2:被安全拦截后,填了原因再「仍要安装」—— force + --force-reason,留痕进 bypass-ledger。
  const handleForceInstall = useCallback(() => {
    const source = installDraft.source.trim();
    const reason = blockedReason.trim();
    if (!source || !reason) return;
    requestConfirmation({
      message: t('operations.confirm.forceInstall'),
      tone: 'danger',
      consequence: t('operations.confirm.consequence.forceRisk'),
      onConfirm: () => runBusy('install', async () => {
        const result = await runInstall({
          source,
          agent: installDraft.agent,
          mode: installDraft.mode,
          ...(installDraft.skill.trim() ? { skill: installDraft.skill.trim() } : {}),
          ...(installDraft.ref.trim() ? { ref: installDraft.ref.trim() } : {}),
          force: true,
          forceReason: reason,
        });
        setInstallResult(result.data);
        if (result.data.blocked.length > 0) {
          setNotice({
            tone: 'danger',
            title: t('operations.install.blocked'),
            detail: t('operations.install.blockedDetail', { count: result.data.blocked.length }),
          });
          return;
        }
        setBlockedReason('');
        setNotice({
          tone: 'good',
          title: t('operations.notice.installed'),
          detail: t('operations.notice.exitCode', { code: result.exitCode }),
          snapshots: snapshotPaths(result.data),
        });
        await onRefresh();
      }),
    });
  }, [installDraft, blockedReason, onRefresh, requestConfirmation, runBusy, t]);

  const handleToggle = useCallback((skill: SkillRecord, enabled: boolean) => {
    const name = actionSkillName(skill);
    requestConfirmation({
      message: t(enabled ? 'operations.confirm.toggleOn' : 'operations.confirm.toggleOff', { name }),
      consequence: t(enabled ? 'operations.confirm.consequence.backup' : 'operations.confirm.consequence.disableKept'),
      details: skill.agents.map((agent) => syncActionLabel({ kind: enabled ? 'config-enable' : 'config-disable', agent, name }, t)),
      onConfirm: () => runBusy(`toggle-${name}`, async () => {
        const installSnapshots: string[] = [];
        const agentsToPrepare = skill.agents.filter((agent) => !declaredAgentPairs.has(skillAgentKey(agent, name)));
        for (const agent of agentsToPrepare) {
          const prepared = await runInstall({
            source: skill.dir,
            agent,
            mode: 'copy',
            skill: name,
            force: false,
          });
          setInstallResult(prepared.data);
          if (prepared.data.blocked.length > 0) {
            setNotice({
              tone: 'danger',
              title: t('operations.install.blocked'),
              detail: t('operations.install.blockedDetail', { count: prepared.data.blocked.length }),
            });
            return;
          }
          installSnapshots.push(...snapshotPaths(prepared.data));
        }
        const result = await runToggle({ name, enabled });
        setNotice({
          tone: 'good',
          title: enabled ? t('operations.notice.toggledOn') : t('operations.notice.toggledOff'),
          detail: `${result.data.actions.length} actions`,
          snapshots: [...installSnapshots, ...snapshotPaths(result.data)],
        });
        await onRefresh();
      }),
    });
  }, [declaredAgentPairs, onRefresh, requestConfirmation, runBusy, t]);

  const handleRemove = useCallback((skill: SkillRecord) => {
    const name = actionSkillName(skill);
    requestConfirmation({
      message: t('operations.confirm.remove', { name }),
      tone: 'danger',
      consequence: t('operations.confirm.consequence.backup'),
      details: skill.agents.map((agent) => syncActionLabel({ kind: 'remove', agent, name }, t)),
      onConfirm: () => runBusy(`remove-${name}`, async () => {
        const snapshots: string[] = [];
        for (const agent of skill.agents) {
          const result = await runRemove({ name, agent });
          snapshots.push(...snapshotPaths(result.data));
        }
        setNotice({
          tone: 'good',
          title: t('operations.notice.removed'),
          detail: name,
          snapshots,
        });
        await onRefresh();
      }),
    });
  }, [onRefresh, requestConfirmation, runBusy, t]);

  const handleSyncDryRun = useCallback(() => {
    void runBusy('sync-dry-run', async () => {
      const result = await runSync({ dryRun: true });
      setSyncPlan(result.data);
      setNotice({
        tone: changedActionCount(result.data) > 0 ? 'warn' : 'good',
        title: t('operations.notice.syncPlanned'),
        detail: t('operations.sync.planCount', { changed: changedActionCount(result.data), total: result.data.actions.length }),
      });
    });
  }, [runBusy, t]);

  const handleSyncApply = useCallback(() => {
    if (!syncPlan) return;
    requestConfirmation({
      message: t('operations.confirm.sync', { count: changedActionCount(syncPlan) }),
      consequence: t('operations.confirm.consequence.backup'),
      details: syncPlan.actions.filter((action) => action.kind !== 'noop').slice(0, 8).map((action) => syncActionLabel(action, t)),
      onConfirm: () => runBusy('sync-apply', async () => {
        const result = await runSync({ dryRun: false });
        setSyncPlan(result.data);
        setNotice({
          tone: 'good',
          title: t('operations.notice.synced'),
          detail: t('operations.sync.planCount', { changed: changedActionCount(result.data), total: result.data.actions.length }),
          snapshots: snapshotPaths(result.data),
        });
        await onRefresh();
      }),
    });
  }, [onRefresh, requestConfirmation, runBusy, syncPlan, t]);

  const handleLoadSnapshots = useCallback(() => {
    void runBusy('restore-list', async () => {
      const result = await runRestore({});
      if (isRestoreList(result.data)) {
        setRestoreList(result.data);
        setNotice({
          tone: 'good',
          title: t('operations.notice.snapshotsLoaded'),
          detail: t('operations.restore.count', { count: result.data.snapshots.length }),
        });
      }
    });
  }, [runBusy, t]);

  const handleRestore = useCallback((id: string) => {
    if (!id) return;
    requestConfirmation({
      message: t('operations.confirm.restore'),
      tone: 'danger',
      consequence: t('operations.confirm.consequence.restoreOverwrite'),
      onConfirm: () => runBusy('restore-apply', async () => {
        const result = await runRestore({ id });
        if (!isRestoreList(result.data)) {
          setNotice({
            tone: 'good',
            title: t('operations.notice.restored'),
            detail: result.data.target,
            snapshots: snapshotPaths(result.data),
          });
          await onRefresh();
          const list = await runRestore({});
          if (isRestoreList(list.data)) setRestoreList(list.data);
        }
      }),
    });
  }, [onRefresh, requestConfirmation, runBusy, t]);

  // F-B1:进入「历史」tab 时按需拉一次快照列表(还没拉过才拉,避免重复)。
  useEffect(() => {
    if (active === 'history' && restoreList === null && busy !== 'restore-list') {
      handleLoadSnapshots();
    }
  }, [active, restoreList, busy, handleLoadSnapshots]);

  const operations: WriteOperationsProps = {
    data: mergedData,
    busy,
    installDraft,
    installResult,
    syncPlan,
    restoreList,
    onInstallDraftChange: setInstallDraft,
    onInstall: handleInstall,
    onSyncDryRun: handleSyncDryRun,
    onSyncApply: handleSyncApply,
    onLoadSnapshots: handleLoadSnapshots,
    onRestore: handleRestore,
    blockedReason,
    onBlockedReasonChange: setBlockedReason,
    onForceInstall: handleForceInstall,
  };

  const skillActions: SkillActionsProps = {
    busy,
    onToggle: handleToggle,
    onRemove: handleRemove,
    importableCount: importable.length,
    onImportExisting: handleImportExisting,
  };

  return (
    <>
      <Header data={mergedData} advanced={advanced} onAdvancedChange={setAdvancedPreference} />
      <nav className="screen-tabs" aria-label={t('screens.ariaLabel')}>
        {screens.map((screen) => (
          <button type="button" className={cx(active === screen.id && 'active')} key={screen.id} onClick={() => setActive(screen.id)}>
            {t(screen.labelKey)}
          </button>
        ))}
      </nav>
      {mergedData.source === 'fixtures' ? (
        <section className="operation-banner operation-banner-warn">
          <div>
            <strong>{t('dashboard.fixtureMode')}</strong>
          </div>
        </section>
      ) : null}
      <OperationBanner notice={notice} />
      {mergedData.loadErrors ? (
        <section className="operation-banner operation-banner-warn">
          <div>
            <strong>{t('dashboard.partialLoad')}</strong>
            <p>{Object.keys(mergedData.loadErrors).join(', ')}</p>
          </div>
        </section>
      ) : null}
      <ConfirmationDialog confirmation={confirmation} />
      {active === 'overview' ? <Overview data={mergedData} operations={operations} advanced={advanced} sections={sections} showOnboarding={!onboarded} onDismissOnboarding={dismissOnboarding} /> : null}
      {active === 'skills' ? <Skills data={mergedData} actions={skillActions} /> : null}
      {active === 'audit' ? (
        <>
          <Audit data={mergedData} section={sections.audit} onReload={() => onReloadSection?.('audit')} />
          <ConfigAudit report={configAudit} section={sections.configAudit} onReload={() => onReloadSection?.('configAudit')} />
        </>
      ) : null}
      {active === 'history' ? (
        <History
          restoreList={restoreList}
          busy={busy}
          loaded={restoreList !== null}
          onReload={handleLoadSnapshots}
          onRestore={handleRestore}
        />
      ) : null}
      {active === 'stats' ? <Stats data={mergedData} section={sections.stats} onReload={() => onReloadSection?.('stats')} /> : null}
      <footer className="app-footer">{t('about.privacy')}</footer>
    </>
  );
}
