// 安全的 Markdown 渲染组件 —— 用于把「用户数据」(技能描述 / SKILL.md 正文)渲染成富文本。
//
// 安全约束(这是个安全审计工具,绝不能成为 XSS 通道):
//   • 基于 react-markdown,渲染管线强制挂 rehype-sanitize(默认 sanitize schema)。
//   • 禁止 raw HTML:不引入 rehype-raw、不传 allowDangerousHtml。技能描述里的
//     <script> / <img onerror=…> / 内联事件处理器都会被默认 schema 剥掉。
//   • 默认 schema 的 href 协议白名单仅 http/https/mailto/irc/ircs/xmpp ——
//     javascript: / data: 等钓鱼链接协议会被净化为无效,不会渲染成可点链接。
//   • 外链一律加 rel="noopener noreferrer" 并 target="_blank",不在 webview 内自动跳转、
//     不泄漏 referrer / window.opener。
//
// 样式:Tailwind + 设计系统 token(foreground / muted-foreground / border / muted…),
// 明暗主题自适应;克制的 prose 风格,够用即可,不引第三方 typography 插件。
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '../../lib/utils';

// 链接:外链强制安全 rel + target;无 href(被净化掉的协议)时降级为纯文本,避免空 <a>。
function MarkdownLink({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) {
  if (!href) {
    return <span {...rest}>{children}</span>;
  }
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  );
}

// 行内代码:react-markdown v10 不再传 `inline`;<pre> 内的代码块由 pre 渲染器负责外框。
function MarkdownCode({ className, children, ...rest }: ComponentPropsWithoutRef<'code'>) {
  return (
    <code
      {...rest}
      className={cn(
        'rounded bg-muted px-1.5 py-0.5 font-console text-[0.85em] text-foreground',
        className,
      )}
    >
      {children}
    </code>
  );
}

// 自定义元素映射:统一套上设计系统 token,保证明暗主题一致、留白克制。
const markdownComponents: Components = {
  a: MarkdownLink,
  code: MarkdownCode,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-lg font-semibold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-sm font-semibold text-muted-foreground first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-border bg-muted p-3 font-console text-xs leading-relaxed text-foreground">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

export interface MarkdownViewProps {
  /** 待渲染的 Markdown 源文本(技能描述 / SKILL.md 正文等用户数据)。 */
  children?: string | null;
  /** 额外的容器 class。 */
  className?: string;
}

/**
 * MarkdownView —— 安全渲染一段 Markdown 文本。
 * 空 / 纯空白输入时返回 null(不渲染空块,调用方应自行处理「无内容」占位)。
 */
export function MarkdownView({ children, className }: MarkdownViewProps): ReactNode {
  const source = typeof children === 'string' ? children : '';
  if (source.trim().length === 0) {
    return null;
  }
  return (
    <div className={cn('text-sm text-foreground', className)}>
      <ReactMarkdown
        // 安全核心:rehype-sanitize 用默认 schema;不开启 rehype-raw / allowDangerousHtml。
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownView;
