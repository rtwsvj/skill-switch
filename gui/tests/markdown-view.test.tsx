// MarkdownView —— SSR(renderToString)渲染 + 安全净化断言。
// 渲染的内容是「用户数据」(技能描述),本身不走 i18n;测试只验证结构与净化。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from '../src/components/ui/markdown';

describe('MarkdownView — Markdown 结构渲染(SSR)', () => {
  it('渲染标题 / 列表 / 粗体 / 链接 / 代码块为对应 HTML 结构', () => {
    const md = [
      '# Heading One',
      '',
      'Some **bold** text and `inline code`.',
      '',
      '- item one',
      '- item two',
      '',
      '[Example](https://example.com)',
      '',
      '```',
      'const x = 1;',
      '```',
    ].join('\n');

    const html = renderToString(<MarkdownView>{md}</MarkdownView>);

    expect(html).toContain('<h1');
    expect(html).toContain('Heading One');
    expect(html).toContain('<strong');
    expect(html).toContain('bold');
    expect(html).toContain('<code');
    expect(html).toContain('inline code');
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).toContain('item one');
    expect(html).toContain('<pre');
    expect(html).toContain('const x = 1;');
    // 链接:渲染为带安全 rel/target 的 <a>
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});

describe('MarkdownView — 安全净化(rehype-sanitize 默认 schema)', () => {
  it('剥离 <script> 元素 —— 输出里没有可执行 script 标签', () => {
    const md = 'before<script>window.__pwned = 1;</script>after';
    const html = renderToString(<MarkdownView>{md}</MarkdownView>);
    // 无 rehype-raw:<script>/</script> 标签被完全丢弃,中间内容降级为惰性纯文本。
    // 安全关键是「没有可执行 <script> 元素」,而不是脚本字面文本是否残留。
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
    // 周围正文文本仍正常渲染
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('剥离 <img onerror=...> 的内联事件处理器', () => {
    const md = '![x](https://example.com/a.png "t")\n\n<img src="x" onerror="alert(1)">';
    const html = renderToString(<MarkdownView>{md}</MarkdownView>);
    // onerror 不在默认 schema 的 img 允许属性内 → 被剥离
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('净化 javascript: 协议链接 —— 不渲染为可点 javascript: href', () => {
    const md = '[click me](javascript:alert(1))';
    const html = renderToString(<MarkdownView>{md}</MarkdownView>);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('alert(1)');
    // 链接文字应保留(降级为纯文本或无 href)
    expect(html).toContain('click me');
  });

  it('净化 data: 协议链接', () => {
    const md = '[x](data:text/html;base64,PHNjcmlwdD4=)';
    const html = renderToString(<MarkdownView>{md}</MarkdownView>);
    expect(html).not.toContain('data:text/html');
  });
});

describe('MarkdownView — 边界情况', () => {
  it('空字符串 → 渲染为空(不崩、不产出空块)', () => {
    expect(renderToString(<MarkdownView>{''}</MarkdownView>)).toBe('');
  });

  it('纯空白 → 渲染为空', () => {
    expect(renderToString(<MarkdownView>{'   \n  \t '}</MarkdownView>)).toBe('');
  });

  it('null / undefined → 渲染为空,不抛错', () => {
    expect(renderToString(<MarkdownView>{null}</MarkdownView>)).toBe('');
    expect(renderToString(<MarkdownView>{undefined}</MarkdownView>)).toBe('');
  });

  it('普通纯文本(无 Markdown 语法)→ 包成段落渲染', () => {
    const html = renderToString(<MarkdownView>{'just plain text'}</MarkdownView>);
    expect(html).toContain('just plain text');
    expect(html).toContain('<p');
  });
});
