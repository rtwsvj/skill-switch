import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  loadAudit,
  loadCoreDashboard,
  loadStats,
  type AuditReport,
  type DashboardData,
  type StatsReport,
} from './data';
import { initialSectionStates } from './lib/helpers';
import type { SectionName, SectionStates } from './lib/types';
import { DashboardShell } from './components/DashboardShell';

// HARD CONSTRAINT:这些符号在拆分后仍必须能从 ./App 导入(测试与 main 入口都依赖)。
export { mergeDeclaredSkills, importableSkills, syncActionLabel, describeSnapshotLabel, auditCoverageSummary, coverageSummary, createConfirmationDialogState } from './lib/helpers';
export type { ConfirmationDialogState } from './lib/types';
export { HealthCenter } from './components/atoms';
export { History } from './components/History';
export { DashboardShell } from './components/DashboardShell';

export default function App() {
  const { t } = useTranslation();
  // M0-5.6:首屏只加载 core(scan/doctor/lock),audit/stats 由各屏按需懒加载,不阻塞首屏。
  const [core, setCore] = useState<DashboardData | null>(null);
  const [auditValue, setAuditValue] = useState<AuditReport[] | null>(null);
  const [statsValue, setStatsValue] = useState<StatsReport | null>(null);
  const [sections, setSections] = useState<SectionStates>(initialSectionStates);
  const [error, setError] = useState<string | null>(null);

  // ensureSections 需读到最新 sections 又要保持引用稳定(否则会重复触发 effect),用 ref 兜。
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const loadSection = useCallback(async (name: SectionName) => {
    setSections((prev) => ({ ...prev, [name]: { ...prev[name], status: 'loading' } }));
    try {
      if (name === 'audit') {
        setAuditValue(await loadAudit());
      } else {
        setStatsValue(await loadStats());
      }
      setSections((prev) => ({ ...prev, [name]: { status: 'loaded', loadedAt: new Date().toISOString() } }));
    } catch (reason) {
      setSections((prev) => ({
        ...prev,
        [name]: { status: 'error', error: reason instanceof Error ? reason.message : String(reason) },
      }));
    }
  }, []);

  // 进入消费某区块的屏时调用:仅当该区块还没触发过(idle)才加载,避免重复跑。
  const ensureSections = useCallback(
    (names: SectionName[]) => {
      for (const name of names) {
        if (sectionsRef.current[name].status === 'idle') void loadSection(name);
      }
    },
    [loadSection],
  );

  const reloadCore = useCallback(async () => {
    setError(null);
    setCore(await loadCoreDashboard());
  }, []);

  // 全局刷新(刷新按钮 / 写操作后):重载 core,并强制刷新已加载过的懒区块;idle 的保持懒态。
  const refreshAll = useCallback(async () => {
    await reloadCore();
    for (const name of ['audit', 'stats'] as SectionName[]) {
      if (sectionsRef.current[name].status !== 'idle') void loadSection(name);
    }
  }, [reloadCore, loadSection]);

  useEffect(() => {
    let cancelled = false;
    reloadCore().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [reloadCore]);

  const data = useMemo<DashboardData | null>(
    () => (core ? { ...core, audit: auditValue ?? core.audit, stats: statsValue ?? core.stats } : null),
    [core, auditValue, statsValue],
  );

  if (error) {
    return (
      <main className="app-shell">
        <section className="fatal-panel">{error}</section>
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
      <DashboardShell
        data={data}
        onRefresh={refreshAll}
        sections={sections}
        onEnsureSections={ensureSections}
        onReloadSection={loadSection}
      />
    </main>
  );
}
