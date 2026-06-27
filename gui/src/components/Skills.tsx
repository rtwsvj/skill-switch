import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuditReport, DashboardData, SkillRecord } from '../data';
import { actionSkillName, cx, isBlockingAudit, isNameMismatch, isSkillEnabled, isWriteBusy } from '../lib/helpers';
import type { SkillActionsProps } from '../lib/types';
import { StatusPill } from './atoms';

// ──────────────────────────────────────────────────────────
// 状态徽章派生逻辑
// ──────────────────────────────────────────────────────────

/**
 * 从安全审计结果中找到与某个技能对应的报告。
 * 匹配优先级:dirName ↔ report.name,其次 dirName ↔ 路径片段。
 */
function findAuditReport(skill: SkillRecord, auditReports: AuditReport[]): AuditReport | undefined {
  return auditReports.find(
    (r) => r.name === skill.dirName || r.name === skill.name || r.path.includes(skill.dirName),
  );
}

type BadgeStatus = 'enabled' | 'disabled' | 'drift' | 'blocked';

interface SkillBadgeInfo {
  statuses: BadgeStatus[];
  hasError: boolean;
  hasMismatch: boolean;
  auditReport: AuditReport | undefined;
}

function deriveSkillBadges(skill: SkillRecord, auditReports: AuditReport[]): SkillBadgeInfo {
  const enabled = isSkillEnabled(skill);
  const hasMismatch = isNameMismatch(skill);
  const hasError = Boolean(skill.error);
  const auditReport = findAuditReport(skill, auditReports);
  const isBlocked = auditReport ? isBlockingAudit(auditReport) : false;

  const statuses: BadgeStatus[] = [];
  if (enabled) {
    statuses.push('enabled');
  } else {
    statuses.push('disabled');
  }
  if (hasMismatch || hasError) {
    statuses.push('drift');
  }
  if (isBlocked) {
    statuses.push('blocked');
  }

  return { statuses, hasError, hasMismatch, auditReport };
}

// ──────────────────────────────────────────────────────────
// 徽章组件
// ──────────────────────────────────────────────────────────

function SkillBadges({ info }: { info: SkillBadgeInfo }) {
  const { t } = useTranslation();
  const enabled = info.statuses.includes('enabled');
  const disabled = info.statuses.includes('disabled');
  const drift = info.statuses.includes('drift');
  const blocked = info.statuses.includes('blocked');
  return (
    <div className="status-stack">
      {enabled ? <StatusPill tone="good">{t('status.enabled')}</StatusPill> : null}
      {/* 停用徽章明示「未删除」,避免用户误以为东西没了(大白话要求) */}
      {disabled ? <StatusPill tone="warn">{t('status.disabledKept')}</StatusPill> : null}
      {drift ? <StatusPill tone="warn">{t('status.drift')}</StatusPill> : null}
      {blocked ? <StatusPill tone="danger">{t('status.auditBlocks')}</StatusPill> : null}
      {info.hasError ? <StatusPill tone="danger">{t('status.parseError')}</StatusPill> : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// 详情面板
// ──────────────────────────────────────────────────────────

function SkillDetail({
  skill,
  info,
  actions,
  writeBusy,
}: {
  skill: SkillRecord;
  info: SkillBadgeInfo;
  actions: SkillActionsProps;
  writeBusy: boolean;
}) {
  const { t } = useTranslation();
  const name = actionSkillName(skill);
  const enabled = isSkillEnabled(skill);

  return (
    <div className="skill-detail-panel">
      <div className="skill-detail-header">
        <h3 className="skill-detail-name">{skill.name ?? skill.dirName}</h3>
        <SkillBadges info={info} />
      </div>

      <dl className="skill-detail-grid">
        <div>
          <dt>{t('skills.detail.directory')}</dt>
          <dd className="mono">{skill.dirName}</dd>
        </div>
        <div>
          <dt>{t('skills.detail.source')}</dt>
          <dd className="muted">{skill.relSkillsDir || '-'}</dd>
        </div>
        <div>
          <dt>{t('skills.detail.tools')}</dt>
          <dd>
            <div className="agent-list">
              {skill.agents.length > 0
                ? skill.agents.map((agent) => <span key={agent}>{agent}</span>)
                : <span className="muted">-</span>}
            </div>
          </dd>
        </div>
        {info.auditReport ? (
          <div>
            <dt>{t('skills.detail.score')}</dt>
            <dd>
              <span className={cx('skill-score', info.auditReport.score >= 70 ? 'skill-score-ok' : 'skill-score-bad')}>
                {info.auditReport.score}
              </span>
            </dd>
          </div>
        ) : null}
        {skill.description ? (
          <div className="skill-detail-desc">
            <dt>{t('skills.detail.description')}</dt>
            <dd className="muted">{skill.description}</dd>
          </div>
        ) : null}
        {info.hasError ? (
          <div className="skill-detail-error">
            <dt>{t('skills.detail.error')}</dt>
            <dd className="skill-detail-error-msg">{skill.error}</dd>
          </div>
        ) : null}
      </dl>

      <div className="skill-detail-actions">
        <button
          type="button"
          className={enabled ? undefined : 'primary-action'}
          onClick={() => actions.onToggle(skill, !enabled)}
          disabled={actions.busy === `toggle-${name}` || writeBusy}
          title={enabled ? t('skills.actions.disableHint') : undefined}
        >
          {actions.busy === `toggle-${name}`
            ? t('operations.busy')
            : enabled ? t('skills.actions.disable') : t('skills.actions.enable')}
        </button>
        <button
          type="button"
          className="danger-action"
          onClick={() => actions.onRemove(skill)}
          disabled={actions.busy === `remove-${name}` || writeBusy}
          title={t('skills.actions.deleteHint')}
        >
          {actions.busy === `remove-${name}` ? t('operations.busy') : t('skills.actions.delete')}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// 主组件
// ──────────────────────────────────────────────────────────

export function Skills({ data, actions }: { data: DashboardData; actions: SkillActionsProps }) {
  const { t } = useTranslation();
  const writeBusy = isWriteBusy(actions.busy);
  const skills = data.scan.skills;

  // 主从布局:选中的技能
  const [selectedKey, setSelectedKey] = useState<string | null>(skills.length > 0 ? `${skills[0]!.relSkillsDir}/${skills[0]!.dirName}` : null);

  const selectedSkill = skills.find((s) => `${s.relSkillsDir}/${s.dirName}` === selectedKey) ?? null;
  const selectedInfo = selectedSkill ? deriveSkillBadges(selectedSkill, data.audit) : null;

  return (
    <section className="screen">
      <section className="guide-panel">
        {t('skills.guide')}
      </section>
      {actions.importableCount > 0 ? (
        <section className="import-banner">
          <span>{t('skills.import.found', { count: actions.importableCount })}</span>
          <button
            type="button"
            className="primary-action"
            onClick={actions.onImportExisting}
            disabled={actions.busy === 'import' || writeBusy}
          >
            {actions.busy === 'import' ? t('operations.busy') : t('skills.import.action')}
          </button>
        </section>
      ) : null}

      {/* 主从布局容器 */}
      <div className="skills-master-detail">
        {/* 左侧:技能列表 */}
        <section className="panel table-panel skills-master">
          <div className="panel-title">
            <h2>{t('skills.title')}</h2>
            <span>{t('skills.recordCount', { count: data.scan.total })}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('skills.columns.name')}</th>
                  <th>{t('skills.columns.status')}</th>
                  <th>{t('skills.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((skill) => {
                  const key = `${skill.relSkillsDir}/${skill.dirName}`;
                  const info = deriveSkillBadges(skill, data.audit);
                  const name = actionSkillName(skill);
                  const enabled = isSkillEnabled(skill);
                  const isSelected = selectedKey === key;
                  return (
                    <tr
                      key={key}
                      className={cx(
                        (info.hasMismatch || info.hasError) && 'row-alert',
                        isSelected && 'row-selected',
                        'skills-row-clickable',
                      )}
                      onClick={() => setSelectedKey(key)}
                      aria-selected={isSelected}
                    >
                      <td>
                        <div className="skill-row-name">
                          <span className="mono">{skill.dirName}</span>
                          {skill.name && skill.name !== skill.dirName
                            ? <span className="muted skill-display-name">{skill.name}</span>
                            : null}
                        </div>
                      </td>
                      <td>
                        <SkillBadges info={info} />
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className={enabled ? undefined : 'primary-action'}
                            onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); actions.onToggle(skill, !enabled); }}
                            disabled={actions.busy === `toggle-${name}` || writeBusy}
                            title={enabled ? t('skills.actions.disableHint') : undefined}
                          >
                            {enabled ? t('skills.actions.disable') : t('skills.actions.enable')}
                          </button>
                          <button
                            type="button"
                            className="danger-action"
                            onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); actions.onRemove(skill); }}
                            disabled={actions.busy === `remove-${name}` || writeBusy}
                            title={t('skills.actions.deleteHint')}
                          >
                            {t('skills.actions.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {skills.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="empty">{t('skills.empty')}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {/* 右侧:详情面板 */}
        {selectedSkill && selectedInfo ? (
          <SkillDetail
            skill={selectedSkill}
            info={selectedInfo}
            actions={actions}
            writeBusy={writeBusy}
          />
        ) : (
          <div className="skill-detail-panel skill-detail-empty">
            <p className="muted">{t('skills.detail.empty')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
