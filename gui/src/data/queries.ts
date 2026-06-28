/**
 * TanStack Query hooks — 封装各区块的数据加载逻辑。
 *
 * 设计原则:
 * - 核心区块(scan/doctor/lock)随 coreDashboard 一起加载,queryKey = ['core']
 * - 懒加载区块(audit/stats/configAudit)默认 enabled:false,由消费方显式 enable
 * - queryFn 全部调用 data/index.ts 暴露的函数,自动 demo/tauri 切换
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  loadAudit,
  loadConfigAudit,
  loadCoreDashboard,
  loadStats,
  type AuditReport,
  type ConfigAuditReport,
  type DashboardData,
  type StatsReport,
} from './index';

// ─── query key 常量 ────────────────────────────────────────────────────────────

export const QUERY_KEYS = {
  /** 核心仪表盘:scan + doctor + lock(首屏必须) */
  core: ['core'] as const,
  /** 安全审计区块(懒加载) */
  audit: ['audit'] as const,
  /** 使用统计区块(懒加载) */
  stats: ['stats'] as const,
  /** 配置文件审计区块(懒加载) */
  configAudit: ['configAudit'] as const,
};

// ─── 核心 query hook ───────────────────────────────────────────────────────────

/**
 * 核心仪表盘数据(scan + doctor + lock)。
 * 首屏立即执行,不懒加载。
 */
export function useCoreDashboardQuery() {
  return useQuery<DashboardData>({
    queryKey: QUERY_KEYS.core,
    queryFn: loadCoreDashboard,
  });
}

// ─── 懒加载区块 hooks ──────────────────────────────────────────────────────────

/**
 * 安全审计区块(懒加载)。
 * 默认 enabled:false,进入 overview/audit 屏时通过 refetch 或 setEnabled 触发。
 */
export function useAuditQuery(enabled: boolean) {
  return useQuery<AuditReport[]>({
    queryKey: QUERY_KEYS.audit,
    queryFn: loadAudit,
    enabled,
  });
}

/**
 * 使用统计区块(懒加载)。
 * 默认 enabled:false,进入 overview/stats 屏时触发。
 */
export function useStatsQuery(enabled: boolean) {
  return useQuery<StatsReport>({
    queryKey: QUERY_KEYS.stats,
    queryFn: loadStats,
    enabled,
  });
}

/**
 * 配置文件审计区块(懒加载)。
 * 默认 enabled:false,进入 audit 屏时触发。
 */
export function useConfigAuditQuery(enabled: boolean) {
  return useQuery<ConfigAuditReport>({
    queryKey: QUERY_KEYS.configAudit,
    queryFn: loadConfigAudit,
    enabled,
  });
}

// ─── 失效助手 ──────────────────────────────────────────────────────────────────

/**
 * 返回精细失效函数集合。
 *
 * 精细失效策略(代替原来的 refreshAll 全量刷新):
 * - toggle/remove/import 后:只失效 core + 已加载的 audit(scan/doctor 受影响,stats 不重跑)
 * - install 后:失效 core + 已加载的 audit(新技能可能有安全问题)
 * - sync 后:失效 core + 已加载的 audit
 * - restore 后:失效 core + 所有已加载的懒区块(全盘还原,状态不可预测)
 * - 全局刷新按钮:失效全部
 */
export function useSkillSwitchInvalidators() {
  const queryClient = useQueryClient();

  /**
   * 失效核心 + 已加载的 audit 区块(toggle/remove/install/sync 后用)。
   * stats 不重跑,因为聊天记录统计不受这些操作影响。
   */
  const invalidateAfterWrite = async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.core });
    // 只有已被触发过(有缓存)的懒区块才重跑
    if (queryClient.getQueryState(QUERY_KEYS.audit)?.status !== 'pending') {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.audit });
    }
    if (queryClient.getQueryState(QUERY_KEYS.configAudit)?.status !== 'pending') {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.configAudit });
    }
  };

  /**
   * 失效全部(restore / 全局刷新按钮)。
   */
  const invalidateAll = async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.core });
    if (queryClient.getQueryState(QUERY_KEYS.audit)?.status !== 'pending') {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.audit });
    }
    if (queryClient.getQueryState(QUERY_KEYS.stats)?.status !== 'pending') {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
    }
    if (queryClient.getQueryState(QUERY_KEYS.configAudit)?.status !== 'pending') {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.configAudit });
    }
  };

  return { invalidateAfterWrite, invalidateAll };
}
