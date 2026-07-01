// 一键安装:粘贴 GitHub 链接 / git clone / npx·npm 指令 → 解析+审计预览 → 勾选 → 安装。
// 复用 CLI 的 `add`(经数据层 previewAdd / runAdd)。绝不在前端执行任何命令。
//
// i18n:界面文案全走 t();CLI 返回的 note/provenanceWarning 是中文,这里不直接显示,
// 而是用结构化字段(kind / 是否有 provenanceWarning)在 GUI 端映射成当前语言的文案。
//
// W4 迁移:改用 shadcn 设计系统(Card 分区 / Badge verdict / Button 动作 / 设计 token),
// 数据流与「绝不执行粘贴命令」等安全提示原样保留。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardPaste } from 'lucide-react';
import { previewAdd, runAdd } from '../data';
import type { AddCliResult, AddSkillCandidate, AuditVerdict } from '../data/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

// verdict → Badge 语义变体(safe/review/danger → good/warn/danger)
const VERDICT_VARIANT: Record<AuditVerdict, 'good' | 'warn' | 'danger'> = {
  SAFE: 'good',
  REVIEW: 'warn',
  DANGER: 'danger',
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <ClipboardPaste size={16} className="text-muted-foreground" />
          {t('skills.paste.title')}
        </CardTitle>
        {/* 安全提示:审计后再装,绝不执行粘贴命令 —— 文案原样保留。 */}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('skills.paste.hint')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          className={cn(
            'flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-console shadow-sm',
            'transition-colors placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          value={raw}
          rows={3}
          placeholder={t('skills.paste.placeholder')}
          onChange={(e) => setRaw((e.target as HTMLTextAreaElement).value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy !== 'idle' || !raw.trim()}
            onClick={onParse}
          >
            {busy === 'parsing' ? t('skills.paste.parsing') : t('skills.paste.parse')}
          </Button>
        </div>

        {previewError ? (
          <p className="flex items-start gap-1.5 text-sm text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{parsed?.kind === 'unsupported' ? t('skills.paste.unsupported') : previewError}</span>
          </p>
        ) : null}

        {parsed?.gitSource ? (
          <p className="text-[13px] text-muted-foreground">
            {t('skills.paste.sourceLabel')}: <span className="font-console text-foreground">{parsed.gitSource}</span>
            {parsed.ref ? ` @${parsed.ref}` : ''}
          </p>
        ) : null}
        {parsed?.provenanceWarning ? (
          <p className="flex items-start gap-1.5 text-sm text-warn">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{t('skills.paste.npmProvenance')}</span>
          </p>
        ) : null}

        {candidates.length > 0 ? (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">{t('skills.paste.found', { count: candidates.length })}</p>
            <ul className="flex flex-col gap-1.5">
              {candidates.map((c) => (
                <li
                  key={c.name}
                  className={cn(
                    'flex flex-col gap-1 rounded-md border border-border/70 px-3 py-2',
                    c.blocked && 'opacity-70',
                  )}
                >
                  <label className={cn('flex items-center gap-2', c.blocked ? 'cursor-not-allowed' : 'cursor-pointer')}>
                    <input
                      type="checkbox"
                      className="accent-primary"
                      disabled={c.blocked}
                      checked={selected.has(c.name)}
                      onChange={() => toggle(c.name)}
                    />
                    <Badge variant={VERDICT_VARIANT[c.verdict]}>{t(VERDICT_KEY[c.verdict])}</Badge>
                    <span className="font-console text-sm text-foreground">{c.name}</span>
                    <span className="text-xs text-muted-foreground">({c.score})</span>
                  </label>
                  {c.blocked ? (
                    <span className="text-xs text-muted-foreground">{t('skills.paste.blockedNote')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                {t('skills.paste.selectAgent')}
                <select
                  className={cn(
                    'h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  )}
                  value={agent}
                  onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}
                >
                  {agentOptions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                size="sm"
                disabled={busy !== 'idle' || selected.size === 0}
                onClick={onInstall}
              >
                {busy === 'installing' ? t('skills.paste.installing') : t('skills.paste.install')}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
