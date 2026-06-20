import { useEffect, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DashboardData, DoctorReport } from '../data';
import { languageLabels, supportedLanguages, type SupportedLanguage } from '../i18n';
import { cx, doctorHint, doctorKindLabel, driftTone } from '../lib/helpers';
import type { ConfirmationDialogState, OperationNotice, SectionState } from '../lib/types';

// v0.3 D1:健康中心 —— doctor 三方对账(声明×锁×磁盘)可视化,按漂移类型分组 + 本地化提示 + legacy 名告警。
// 纯展示,便于测试;沿用「高级」面板定位(技术受众 P2/P4),文案全 i18n(不暴露 CLI 的中文 detail)。
export function HealthCenter({ doctor, lockOk }: { doctor: DoctorReport; lockOk: boolean }) {
  const { t } = useTranslation();
  const findings = doctor.findings ?? [];
  const legacyNames = doctor.legacyNames ?? [];
  const kinds = [...new Set(findings.map((finding) => finding.kind))];
  const allGood = findings.length === 0 && legacyNames.length === 0;

  return (
    <section className="panel health-center">
      <div className="panel-title">
        <h2>{t('doctor.title')}</h2>
        <StatusPill tone={doctor.clean ? 'good' : 'danger'}>{doctor.clean ? t('status.clean') : t('status.drift')}</StatusPill>
      </div>
      <dl className="definition-grid">
        <div>
          <dt>{t('doctor.checked.declared')}</dt>
          <dd>{doctor.checked.declared}</dd>
        </div>
        <div>
          <dt>{t('doctor.checked.locked')}</dt>
          <dd>{doctor.checked.locked}</dd>
        </div>
        <div>
          <dt>{t('doctor.checked.lockVerify')}</dt>
          <dd>{lockOk ? t('status.ok') : t('status.failed')}</dd>
        </div>
      </dl>
      {allGood ? <p className="empty">{t('doctor.allGood')}</p> : null}
      {kinds.map((kind) => {
        const items = findings.filter((finding) => finding.kind === kind);
        return (
          <div className="drift-group" key={kind}>
            <div className="drift-group-head">
              <StatusPill tone={driftTone(kind)}>{doctorKindLabel(kind, t)}</StatusPill>
              <span className="muted">{t('doctor.kindCount', { count: items.length })}</span>
            </div>
            <p className="muted">{doctorHint(kind, t)}</p>
            <ul className="doctor-list">
              {items.map((finding) => (
                <li key={`${finding.kind}-${finding.agent}-${finding.name}`}>
                  <strong>{`${finding.agent} / ${finding.name}`}</strong>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {legacyNames.length > 0 ? (
        <div className="drift-group">
          <div className="drift-group-head">
            <StatusPill tone="warn">{t('doctor.legacy.title')}</StatusPill>
            <span className="muted">{t('doctor.kindCount', { count: legacyNames.length })}</span>
          </div>
          <p className="muted">{t('doctor.legacy.hint')}</p>
          <ul className="doctor-list">
            {legacyNames.map((name) => (
              <li key={name}><strong>{name}</strong></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function Metric({ value, label, tone = 'neutral' }: { value: number | string; label: string; tone?: 'neutral' | 'good' | 'danger' }) {
  return (
    <div className={cx('metric', tone === 'danger' && 'metric-danger', tone === 'good' && 'metric-good')}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'danger' }) {
  return <span className={cx('pill', `pill-${tone}`)}>{children}</span>;
}

// M0-5.6:某懒加载区块(audit/stats)的状态条 —— 加载中/失败/上次刷新时间 + 刷新按钮。
export function SectionStatusBar({ section, onReload }: { section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const time = section.loadedAt
    ? new Date(section.loadedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div className="section-status">
      {section.status === 'loading' ? <StatusPill tone="warn">{t('section.loading')}</StatusPill> : null}
      {section.status === 'error' ? <StatusPill tone="danger">{t('section.failed')}</StatusPill> : null}
      {section.status === 'loaded' ? <span className="muted">{t('section.lastRefreshed', { time })}</span> : null}
      {section.status === 'idle' ? <span className="muted">{t('section.notLoaded')}</span> : null}
      <button type="button" className="ghost-button" onClick={onReload} disabled={section.status === 'loading'}>
        {section.status === 'error' ? t('section.retry') : t('section.refresh')}
      </button>
    </div>
  );
}

export function OperationBanner({ notice }: { notice: OperationNotice | null }) {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <section className={cx('operation-banner', `operation-banner-${notice.tone}`)}>
      <div>
        <strong>{notice.title}</strong>
        {notice.detail ? <p>{notice.detail}</p> : null}
      </div>
      {notice.snapshots && notice.snapshots.length > 0 ? (
        <ul>
          {notice.snapshots.map((path) => (
            <li key={path}>
              <span>{t('operations.snapshot')}</span>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ConfirmationDialog({ confirmation }: { confirmation: ConfirmationDialogState | null }) {
  const titleId = useId();
  const messageId = useId();
  // M3 可达性:Esc 取消高风险弹窗(键盘用户不必用鼠标)。
  useEffect(() => {
    if (!confirmation) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void confirmation.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmation]);
  if (!confirmation) return null;

  return (
    <div className="dialog-backdrop">
      <section
        className={cx('confirm-dialog', confirmation.tone === 'danger' && 'confirm-dialog-danger')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <h2 id={titleId}>{confirmation.title}</h2>
        <p id={messageId}>{confirmation.message}</p>
        {confirmation.details && confirmation.details.length > 0 ? (
          <ul className="dialog-details">
            {confirmation.details.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        ) : null}
        {confirmation.consequence ? (
          <p className={cx('dialog-consequence', confirmation.tone === 'danger' && 'dialog-consequence-danger')}>
            {confirmation.consequence}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={() => void confirmation.onCancel()}>
            {confirmation.cancelLabel}
          </button>
          <button
            className={confirmation.tone === 'danger' ? 'danger-action' : 'primary-action'}
            type="button"
            onClick={() => void confirmation.onConfirm()}
            autoFocus
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const activeLanguage = supportedLanguages.includes(i18n.resolvedLanguage as SupportedLanguage) ? (i18n.resolvedLanguage as SupportedLanguage) : 'en';

  return (
    <label className="language-switcher">
      <span>{t('header.languageLabel')}</span>
      <select
        aria-label={t('header.languageLabel')}
        value={activeLanguage}
        onChange={(event) => {
          const language = event.target.value as SupportedLanguage;
          window.localStorage.setItem('skill-switch-language', language);
          void i18n.changeLanguage(language);
        }}
      >
        {supportedLanguages.map((language) => (
          <option key={language} value={language}>
            {languageLabels[language]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Header({
  data,
  advanced,
  onAdvancedChange,
}: {
  data: DashboardData;
  advanced: boolean;
  onAdvancedChange: (enabled: boolean) => void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <header className="header">
      <div>
        <p className="eyebrow">skill-switch</p>
        <h1>{t('header.title')}</h1>
      </div>
      <div className="header-meta">
        <StatusPill tone={data.source === 'fixtures' ? 'warn' : 'good'}>{data.source === 'fixtures' ? t('header.source.fixtures') : t('header.source.live')}</StatusPill>
        {advanced ? <span>{new Date(data.loadedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</span> : null}
        <LanguageSwitcher />
        <label className="advanced-toggle">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(event) => onAdvancedChange(event.target.checked)}
          />
          <span>{t('header.advanced')}</span>
        </label>
      </div>
    </header>
  );
}
