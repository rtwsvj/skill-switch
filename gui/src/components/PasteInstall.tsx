// 一键安装:粘贴 GitHub 链接 / git clone / npx·npm 指令 → 解析+审计预览 → 勾选 → 安装。
// 复用 CLI 的 `add`(经数据层 previewAdd / runAdd)。绝不在前端执行任何命令。
//
// i18n:界面文案全走 t();CLI 返回的 note/provenanceWarning 是中文,这里不直接显示,
// 而是用结构化字段(kind / 是否有 provenanceWarning)在 GUI 端映射成当前语言的文案。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewAdd, runAdd } from '../data';
import type { AddCliResult, AddSkillCandidate, AuditVerdict } from '../data/types';

const VERDICT_PILL: Record<AuditVerdict, string> = {
  SAFE: 'pill-good',
  REVIEW: 'pill-warn',
  DANGER: 'pill-danger',
};
const VERDICT_KEY: Record<AuditVerdict, string> = {
  SAFE: 'skills.paste.verdict.safe',
  REVIEW: 'skills.paste.verdict.review',
  DANGER: 'skills.paste.verdict.danger',
};

export function PasteInstall({
  agentOptions,
  defaultAgent,
  onInstalled,
}: {
  agentOptions: string[];
  defaultAgent: string;
  onInstalled: (installedNames: string[]) => void;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<AddCliResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [agent, setAgent] = useState(defaultAgent);
  const [busy, setBusy] = useState<'idle' | 'parsing' | 'installing'>('idle');

  const candidates: AddSkillCandidate[] = preview?.preview.candidates ?? [];
  const parsed = preview?.preview.parsed;
  const previewError = preview?.preview.error ?? preview?.error;

  async function onParse() {
    const text = raw.trim();
    if (!text || busy !== 'idle') return;
    setBusy('parsing');
    setPreview(null);
    setSelected(new Set());
    try {
      const result = await previewAdd(text);
      setPreview(result);
      // 默认勾选所有「非拦下」候选
      setSelected(new Set(result.preview.candidates.filter((c) => !c.blocked).map((c) => c.name)));
    } catch {
      setPreview({ preview: { parsed: { kind: 'unsupported', raw: text }, candidates: [], error: t('skills.paste.failed') }, installed: [] });
    } finally {
      setBusy('idle');
    }
  }

  async function onInstall() {
    const skills = [...selected];
    if (skills.length === 0 || busy !== 'idle') return;
    setBusy('installing');
    try {
      const result = await runAdd({ raw: raw.trim(), skills, agent });
      onInstalled(result.data.installed.map((i) => i.name));
      setRaw('');
      setPreview(null);
      setSelected(new Set());
    } finally {
      setBusy('idle');
    }
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <section className="paste-install">
      <h3>{t('skills.paste.title')}</h3>
      <p className="muted">{t('skills.paste.hint')}</p>
      <textarea
        className="paste-box"
        value={raw}
        rows={3}
        placeholder={t('skills.paste.placeholder')}
        onChange={(e) => setRaw((e.target as HTMLTextAreaElement).value)}
      />
      <div className="paste-actions">
        <button
          type="button"
          className="primary-action"
          disabled={busy !== 'idle' || !raw.trim()}
          onClick={onParse}
        >
          {busy === 'parsing' ? t('skills.paste.parsing') : t('skills.paste.parse')}
        </button>
      </div>

      {previewError ? (
        <p className="paste-error">
          ⚠ {parsed?.kind === 'unsupported' ? t('skills.paste.unsupported') : previewError}
        </p>
      ) : null}

      {parsed?.gitSource ? (
        <p className="muted paste-source">
          {t('skills.paste.sourceLabel')}: <span className="mono">{parsed.gitSource}</span>
          {parsed.ref ? ` @${parsed.ref}` : ''}
        </p>
      ) : null}
      {parsed?.provenanceWarning ? (
        <p className="paste-warn">⚠ {t('skills.paste.npmProvenance')}</p>
      ) : null}

      {candidates.length > 0 ? (
        <>
          <p className="muted">{t('skills.paste.found', { count: candidates.length })}</p>
          <ul className="paste-candidates">
            {candidates.map((c) => (
              <li key={c.name} className={c.blocked ? 'paste-cand blocked' : 'paste-cand'}>
                <label className="paste-cand-label">
                  <input
                    type="checkbox"
                    disabled={c.blocked}
                    checked={selected.has(c.name)}
                    onChange={() => toggle(c.name)}
                  />
                  <span className={`pill ${VERDICT_PILL[c.verdict]}`}>{t(VERDICT_KEY[c.verdict])}</span>
                  <span className="mono">{c.name}</span>
                  <span className="muted">({c.score})</span>
                </label>
                {c.blocked ? (
                  <span className="muted paste-blocked-note">{t('skills.paste.blockedNote')}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="paste-actions">
            <label className="paste-agent">
              {t('skills.paste.selectAgent')}
              <select value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}>
                {agentOptions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary-action"
              disabled={busy !== 'idle' || selected.size === 0}
              onClick={onInstall}
            >
              {busy === 'installing' ? t('skills.paste.installing') : t('skills.paste.install')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
