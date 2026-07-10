import { isScalar, parseDocument, visit } from 'yaml';

/**
 * Agent skill metadata should be small and almost never needs YAML aliases.
 * Keep a modest compatibility allowance while bounding exponential expansion.
 */
export const MAX_FRONTMATTER_ALIASES = 20;

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

interface FrontmatterSections {
  metadata: string;
  content: string;
}

/**
 * Split the conventional leading `---` block without interpreting delimiters
 * elsewhere in the Markdown body. A missing closing delimiter matches the old
 * parser's behaviour: the remainder is metadata and the body is empty.
 */
function splitFrontmatter(raw: string): FrontmatterSections | null {
  const source = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const opening = /^---(?:\r\n|\n|$)/.exec(source);
  if (!opening) return null;

  const metadataStart = opening[0].length;
  let lineStart = metadataStart;

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const rawLine = source.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '---') {
      return {
        metadata: source.slice(metadataStart, lineStart),
        content: newline === -1 ? '' : source.slice(newline + 1),
      };
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return { metadata: source.slice(metadataStart), content: '' };
}

function assertSafeMappingKeys(document: ReturnType<typeof parseDocument>): void {
  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        throw new Error('Frontmatter mapping keys must be strings');
      }
      if (UNSAFE_OBJECT_KEYS.has(pair.key.value)) {
        throw new Error(`Unsafe frontmatter mapping key: ${pair.key.value}`);
      }
    },
  });
}

/**
 * Parse Agent Skills YAML frontmatter with a deliberately narrow YAML 1.2
 * feature set. In particular, merge keys/custom tags are disabled, duplicate
 * keys are rejected, and alias expansion is bounded.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const source = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const sections = splitFrontmatter(raw);
  if (!sections) return { data: {}, content: source };

  const document = parseDocument(sections.metadata, {
    version: '1.2',
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    merge: false,
    customTags: null,
    resolveKnownTags: false,
    prettyErrors: true,
    logLevel: 'silent',
  });

  if (document.errors.length > 0) throw document.errors[0];
  if (document.warnings.length > 0) throw document.warnings[0];
  assertSafeMappingKeys(document);

  const parsed: unknown = document.toJS({
    mapAsMap: false,
    maxAliasCount: MAX_FRONTMATTER_ALIASES,
  });
  if (parsed === null) return { data: {}, content: sections.content };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Frontmatter must contain a YAML mapping');
  }

  return { data: parsed as Record<string, unknown>, content: sections.content };
}
