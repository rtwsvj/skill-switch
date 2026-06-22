// R8-b 配置安全:audit --configs --json 输出 → ConfigAudit 视图模型 + 渲染验证。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { ConfigAudit } from '../src/components/ConfigAudit';
import { createI18nForLanguage } from '../src/i18n';
import type { ConfigAuditReport, ConfigFileResult } from '../src/data';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<ConfigAuditReport> = {}): ConfigAuditReport {
  return {
    home: '/home/user',
    total: 0,
    skills: [],
    configs: [],
    configsBlocked: false,
    ...overrides,
  };
}

function cleanFile(relPath: string): ConfigFileResult {
  return { absPath: `/home/user/${relPath}`, relPath, findings: [] };
}

function dirtyFile(relPath: string): ConfigFileResult {
  return {
    absPath: `/home/user/${relPath}`,
    relPath,
    findings: [
      {
        ruleId: 'mcp-remote-url-command',
        severity: 'high',
        file: relPath,
        line: 5,
        excerpt: '"url": "https://evil.example.com/mcp"',
        message: 'MCP server points to a remote URL — verify you trust this endpoint.',
      },
    ],
  };
}

async function renderComponent(
  report: ConfigAuditReport | null,
  status: 'idle' | 'loading' | 'loaded' | 'error' = 'loaded',
) {
  const i18n = await createI18nForLanguage('en');
  const html = renderToString(
    <I18nextProvider i18n={i18n}>
      <ConfigAudit
        report={report}
        section={{ status, ...(status === 'loaded' ? { loadedAt: new Date().toISOString() } : {}) }}
        onReload={() => undefined}
      />
    </I18nextProvider>,
  );
  return { html, i18n };
}

// ─── view-model unit tests (pure logic, no DOM) ───────────────────────────────

describe('config-audit view-model logic', () => {
  it('counts all findings across config files', () => {
    const report = makeReport({
      configs: [cleanFile('.claude/settings.json'), dirtyFile('.claude/mcp.json')],
      configsBlocked: true,
    });
    const allFindings = report.configs.flatMap((cfg) => cfg.findings);
    expect(allFindings).toHaveLength(1);
    expect(allFindings[0]?.ruleId).toBe('mcp-remote-url-command');
    expect(allFindings[0]?.severity).toBe('high');
  });

  it('reports configsBlocked=false when there are no findings', () => {
    const report = makeReport({
      configs: [cleanFile('.claude/settings.json'), cleanFile('.claude/mcp.json')],
      configsBlocked: false,
    });
    const anyBlocking = report.configs.flatMap((cfg) => cfg.findings).some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );
    expect(anyBlocking).toBe(false);
    expect(report.configsBlocked).toBe(false);
  });

  it('parses raw audit --configs --json output shape correctly', () => {
    // Simulates what the CLI returns over stdout as a raw JSON string.
    const rawJson = JSON.stringify({
      home: '/home/user',
      total: 2,
      skills: [],
      configs: [
        { absPath: '/home/user/.claude/settings.json', relPath: '.claude/settings.json', findings: [] },
        {
          absPath: '/home/user/.claude/mcp.json',
          relPath: '.claude/mcp.json',
          findings: [
            {
              ruleId: 'ld-preload-inject',
              severity: 'critical',
              file: '.claude/mcp.json',
              line: 3,
              excerpt: 'LD_PRELOAD=/evil.so',
              message: 'Possible LD_PRELOAD injection detected.',
            },
          ],
        },
      ],
      configsBlocked: true,
    });

    const parsed = JSON.parse(rawJson) as ConfigAuditReport;
    expect(parsed.configs).toHaveLength(2);
    expect(parsed.configs[1]?.findings[0]?.ruleId).toBe('ld-preload-inject');
    expect(parsed.configs[1]?.findings[0]?.severity).toBe('critical');
    expect(parsed.configsBlocked).toBe(true);
  });
});

// ─── rendering tests (SSR, no flaky DOM) ─────────────────────────────────────

describe('ConfigAudit component rendering', () => {
  it('shows the section title', async () => {
    const { html, i18n } = await renderComponent(makeReport());
    expect(html).toContain(i18n.t('configAudit.title'));
  });

  it('shows "no config files found" when configs array is empty', async () => {
    const { html, i18n } = await renderComponent(makeReport({ configs: [] }));
    expect(html).toContain(i18n.t('configAudit.noConfigsFound'));
  });

  it('shows "no findings" empty state when all config files are clean', async () => {
    const report = makeReport({
      configs: [cleanFile('.claude/settings.json'), cleanFile('.claude/settings.local.json')],
    });
    const { html, i18n } = await renderComponent(report);
    expect(html).toContain(i18n.t('configAudit.noFindings'));
    // Clean badge should appear for each file
    expect(html).toContain(i18n.t('configAudit.fileClean'));
  });

  it('renders finding ruleId and severity label for a dirty file', async () => {
    const report = makeReport({
      configs: [dirtyFile('.claude/mcp.json')],
      configsBlocked: true,
    });
    const { html, i18n } = await renderComponent(report);
    expect(html).toContain('mcp-remote-url-command');
    // Severity label from the existing audit.severity.* keys
    expect(html).toContain(i18n.t('audit.severity.high'));
    expect(html).toContain('mcp.json');
  });

  it('shows loading placeholder when section is loading and report is null', async () => {
    const { html, i18n } = await renderComponent(null, 'loading');
    expect(html).toContain(i18n.t('section.loading'));
  });

  it('shows error pill when section status is error', async () => {
    const i18n = await createI18nForLanguage('en');
    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <ConfigAudit
          report={null}
          section={{ status: 'error', error: 'CLI timed out' }}
          onReload={() => undefined}
        />
      </I18nextProvider>,
    );
    expect(html).toContain(i18n.t('section.failed'));
    expect(html).toContain('CLI timed out');
  });

  it('renders all four locales without crashing', async () => {
    const report = makeReport({ configs: [dirtyFile('.claude/mcp.json')], configsBlocked: true });
    for (const lang of ['en', 'zh-CN', 'ja', 'es'] as const) {
      const i18n = await createI18nForLanguage(lang);
      const html = renderToString(
        <I18nextProvider i18n={i18n}>
          <ConfigAudit report={report} section={{ status: 'loaded', loadedAt: new Date().toISOString() }} onReload={() => undefined} />
        </I18nextProvider>,
      );
      expect(html).toContain(i18n.t('configAudit.title'));
    }
  });
});
