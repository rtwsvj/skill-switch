/**
 * UpdateChecker — 接入 @tauri-apps/plugin-updater 的自动更新横幅组件。
 *
 * 行为:
 *  - 组件挂载后静默检查一次更新;检查期间不显示任何 UI。
 *  - 有新版本:显示一条小横幅,告知版本号,提供「立即更新」和「稍后」按钮。
 *  - 点「立即更新」:调 downloadAndInstall(),完成后重启应用。
 *  - 无更新或非 Tauri 运行时(浏览器/demo):完全不渲染。
 *  - check() 抛错(浏览器/pubkey 未配置/网络失败):try/catch 静默忽略,不报错。
 *
 * 挂载点(给 G1 集成用):在 App.tsx 的 <main className="app-shell"> 内,
 * <DashboardShell .../> 之前插一行 <UpdateChecker /> 即可。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 动态 import,在 Tauri 运行时才可用;浏览器下 check/relaunch 会 throw → catch 静默处理。
// 避免在顶层 import,防止 SSR/测试环境下模块不存在时报错。
async function tryCheckUpdate(): Promise<{ version: string; install: () => Promise<void> } | null> {
  try {
    // @tauri-apps/plugin-updater 的 check() 在浏览器里会 throw,被下方 catch 捕获
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update?.available) return null;

    return {
      version: update.version ?? '',
      install: async () => {
        // 下载并安装更新
        await update.downloadAndInstall();
        // 安装完成后重启应用
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
    };
  } catch {
    // 非 Tauri 运行时、pubkey 未配置、网络错误 — 静默返回 null
    return null;
  }
}

interface UpdateInfo {
  version: string;
  install: () => Promise<void>;
}

type BannerState =
  | { phase: 'idle' }
  | { phase: 'available'; info: UpdateInfo }
  | { phase: 'installing' }
  | { phase: 'dismissed' };

/** 自动更新横幅。有新版本时显示,否则不渲染任何 DOM 节点。 */
export function UpdateChecker() {
  const { t } = useTranslation();
  const [state, setState] = useState<BannerState>({ phase: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void tryCheckUpdate().then((result) => {
      if (cancelled || !result) return;
      setState({ phase: 'available', info: result });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // idle 或 dismissed — 不渲染任何 DOM
  if (state.phase === 'idle' || state.phase === 'dismissed') return null;

  async function handleInstall(info: UpdateInfo) {
    setState({ phase: 'installing' });
    try {
      await info.install();
      // install() 内部会 relaunch,走不到这里;保险起见置为 dismissed
      setState({ phase: 'dismissed' });
    } catch {
      // 安装失败 — 回到 available 让用户重试
      setState({ phase: 'available', info });
    }
  }

  const installing = state.phase === 'installing';
  const info = state.phase === 'available' ? state.info : null;

  return (
    <div
      className="update-banner"
      // role="status" 让屏幕阅读器在合适时机播报,不打断当前操作
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="update-banner-body">
        <span className="update-banner-label">{t('update.available')}</span>
        {info && (
          <span className="update-banner-version">
            {t('update.version', { version: info.version })}
          </span>
        )}
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="update-banner-install primary-action"
          disabled={installing}
          onClick={() => {
            if (info) void handleInstall(info);
          }}
        >
          {installing ? t('section.loading') : t('update.installNow')}
        </button>
        {!installing && (
          <button
            type="button"
            className="update-banner-later ghost-button"
            onClick={() => setState({ phase: 'dismissed' })}
          >
            {t('update.later')}
          </button>
        )}
      </div>
    </div>
  );
}
