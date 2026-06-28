import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  localizedErrorDetail,
  type AuditReport,
  type ConfigAuditReport,
  type DashboardData,
  type StatsReport,
} from './data';
import type { SectionName, SectionState, SectionStates } from './lib/types';
import { DashboardShell } from './components/DashboardShell';
import { UpdateChecker } from './components/UpdateChecker';
import {
  useCoreDashboardQuery,
  useAuditQuery,
  useStatsQuery,
  useConfigAuditQuery,
  useSkillSwitchInvalidators,
} from './data/queries';

// HARD CONSTRAINT:这些符号在拆分后仍必须能从 ./App 导入(测试与 main 入口都依赖)。
export { mergeDeclaredSkills, importableSkills, syncActionLabel, describeSnapshotLabel, auditCoverageSummary, coverageSummary, createConfirmationDialogState } from './lib/helpers';
export type { ConfirmationDialogState } from './lib/types';
export { HealthCenter } from './components/atoms';
export { History } from './components/History';
export { DashboardShell } from './components/DashboardShell';

/**
 * 从 TanStack Query 的 isLoading/isError/data 状态派生出旧 SectionState 形状,
 * 保持与 DashboardShell / SectionStatusBar 的接口兼容。
 */
function deriveSectionState(query: {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  dataUpdatedAt: number;
}, t: ReturnType<typeof useTranslation>['t']): SectionState {
  if (query.isFetching || query.isLoading) return { status: 'loading' };
  if (query.isError) return { status: 'error', error: localizedErrorDetail(query.error, t) };
  if (query.isSuccess) return { status: 'loaded', loadedAt: new Date(query.dataUpdatedAt).toISOString() };
  // enabled=false 时 query 未启动,映射为 idle
  return { status: 'idle' };
}

export default function App() {
  const { t } = useTranslation();

  // M0-5.6:懒加载区块的 enabled 标志由进入对应屏时切换,默认 false(idle)。
  const [auditEnabled, setAuditEnabled] = useState(false);
  const [statsEnabled, setStatsEnabled] = useState(false);
  const [configAuditEnabled, setConfigAuditEnabled] = useState(false);

  // ── TanStack Query hooks ──────────────────────────────────────────────────
  const coreQuery = useCoreDashboardQuery();
  const auditQuery = useAuditQuery(auditEnabled);
  const statsQuery = useStatsQuery(statsEnabled);
  const configAuditQuery = useConfigAuditQuery(configAuditEnabled);

  const { invalidateAfterWrite, invalidateAll } = useSkillSwitchInvalidators();

  // ── 派生 sections(从 query 状态映射回旧接口) ──────────────────────────────
  const sections = useMemo<SectionStates>(() => ({
    audit: deriveSectionState(auditQuery, t),
    stats: deriveSectionState(statsQuery, t),
    configAudit: deriveSectionState(configAuditQuery, t),
  }), [auditQuery, statsQuery, configAuditQuery, t]);

  // ── onEnsureSections:进入某屏时按需 enable 懒加载区块 ────────────────────
  const handleEnsureSections = (names: SectionName[]) => {
    for (const name of names) {
      if (name === 'audit') setAuditEnabled(true);
      else if (name === 'stats') setStatsEnabled(true);
      else if (name === 'configAudit') setConfigAuditEnabled(true);
    }
  };

  // ── onReloadSection:强制重新拉取单个区块 ─────────────────────────────────
  const handleReloadSection = (name: SectionName) => {
    if (name === 'audit') {
      setAuditEnabled(true);
      void auditQuery.refetch();
    } else if (name === 'stats') {
      setStatsEnabled(true);
      void statsQuery.refetch();
    } else if (name === 'configAudit') {
      setConfigAuditEnabled(true);
      void configAuditQuery.refetch();
    }
  };

  // ── onRefresh:全局刷新(刷新按钮 / 写操作后的精细失效入口) ──────────────
  // DashboardShell 仍传入 onRefresh 保持接口兼容,内部转为 invalidateAll。
  const handleRefresh = async () => {
    await invalidateAll();
  };

  // ── 精细失效(写操作后:toggle/remove/install/sync,只失效 core+audit) ────
  // 暴露给 DashboardShell 的 onRefresh 统一走 invalidateAll,
  // 但 DashboardShell 内部的写操作 handler 都调用的是 onRefresh,
  // 所以这里把 onRefresh 实现为 invalidateAll;
  // 若未来需要更精细控制可从 shell 传入专用 prop。
  //
  // 注:toggle/remove/install/sync 操作不影响聊天记录统计(stats),
  //     但当前 DashboardShell 调用 onRefresh 时无法区分操作类型,
  //     故暂统一走 invalidateAll。更细的失效在 DashboardShell 内扩 prop 时再拆。

  // ── 合并 data(把懒加载值覆盖进 core) ────────────────────────────────────
  const core = coreQuery.data ?? null;
  const auditValue = auditQuery.data as AuditReport[] | undefined;
  const statsValue = statsQuery.data as StatsReport | undefined;

  const data = useMemo<DashboardData | null>(
    () => (core ? { ...core, audit: auditValue ?? core.audit, stats: statsValue ?? core.stats } : null),
    [core, auditValue, statsValue],
  );

  const configAuditValue = configAuditQuery.data as ConfigAuditReport | undefined;

  // ── 首屏 loading / error ──────────────────────────────────────────────────
  if (coreQuery.isError) {
    return (
      <main className="app-shell">
        <section className="fatal-panel">{localizedErrorDetail(coreQuery.error, t)}</section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="app-shell">
        <section className="loading-panel">{t('loading')}</section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <UpdateChecker />
      <DashboardShell
        data={data}
        configAudit={configAuditValue ?? null}
        onRefresh={handleRefresh}
        sections={sections}
        onEnsureSections={handleEnsureSections}
        onReloadSection={handleReloadSection}
      />
    </main>
  );
}
