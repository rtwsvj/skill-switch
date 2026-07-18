import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isSensitiveHeaderName } from './output-safety.ts';

/** Maximum redirects followed for any single outbound request. */
export const MAX_SAFE_REDIRECTS = 5;

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/u, '');
  return lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;
}

function parseIpv4(hostname: string): readonly number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) =>
    !/^\d{1,3}$/u.test(parts[index]!) ||
    !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224;
}

function mappedIpv4FromIpv6(hostname: string): readonly number[] | null {
  if (!hostname.startsWith('::ffff:')) return null;
  const tail = hostname.slice('::ffff:'.length);
  const dotted = parseIpv4(tail);
  if (dotted) return dotted;

  const words = tail.split(':');
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/iu.test(word))) return null;
  const high = Number.parseInt(words[0]!, 16);
  const low = Number.parseInt(words[1]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** True only for literal IP addresses in non-public or special-use ranges. */
export function isPrivateNetworkLiteral(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  const ipVersion = isIP(host);
  if (ipVersion === 0) return false;
  if (ipVersion === 4) {
    const octets = parseIpv4(host);
    return octets !== null && isPrivateIpv4(octets);
  }

  const mapped = mappedIpv4FromIpv6(host);
  if (mapped) return isPrivateIpv4(mapped);

  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const firstWord = Number.parseInt(host.split(':')[0] || '0', 16);
  return (firstWord & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (firstWord & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (firstWord & 0xff00) === 0xff00; // multicast
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return ipv4[0] === 127;
  return host === '::1' || host === '0:0:0:0:0:0:0:1';
}

export function hasUrlCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

export interface ResolvedHostAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedHostAddress[]>;

/** Production resolver; injectable so network clients can test DNS policy without real lookups. */
export const defaultHostResolver: HostResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export class HostResolutionPolicyError extends Error {
  constructor(
    message: string,
    readonly code: 'lookup-failed' | 'non-public-address',
  ) {
    super(message);
    this.name = 'HostResolutionPolicyError';
  }
}

/**
 * Resolve a URL hostname and return the vetted address list, rejecting non-public
 * answers. `allowLoopback` exists only for the explicitly local HTTP MCP transport.
 *
 * pinned-http.ts consumes the returned addresses to pin the actual socket to the
 * exact answers that passed policy — one lookup, no revalidation window.
 */
export async function resolveVerifiedAddresses(
  url: URL,
  options: { resolver?: HostResolver; allowLoopback?: boolean } = {},
): Promise<readonly ResolvedHostAddress[]> {
  const resolver = options.resolver ?? defaultHostResolver;
  const host = normalizedHostname(url.hostname);
  let addresses: readonly ResolvedHostAddress[];
  try {
    addresses = isIP(host) === 0
      ? await resolver(host)
      : [{ address: host, family: isIP(host) }];
  } catch {
    throw new HostResolutionPolicyError(`无法解析远程主机: ${host}`, 'lookup-failed');
  }
  if (addresses.length === 0) {
    throw new HostResolutionPolicyError(`远程主机没有可用地址: ${host}`, 'lookup-failed');
  }

  for (const { address } of addresses) {
    if (!isPrivateNetworkLiteral(address)) continue;
    if (options.allowLoopback && isLoopbackHost(address)) continue;
    throw new HostResolutionPolicyError(
      `远程主机解析到非公网或特殊用途地址,已拒绝: ${host}`,
      'non-public-address',
    );
  }
  return addresses;
}

/**
 * Policy check without address pinning (legacy call sites). Prefer pinned-http,
 * which connects to the exact addresses returned by resolveVerifiedAddresses.
 */
export async function assertResolvedHostPolicy(
  url: URL,
  options: { resolver?: HostResolver; allowLoopback?: boolean } = {},
): Promise<void> {
  await resolveVerifiedAddresses(url, options);
}

/** Resolve a redirect Location header without applying any trust policy. */
export function resolveRedirectUrl(currentUrl: URL, location: string): URL {
  return new URL(location, currentUrl);
}

/** Copy request headers while removing credentials after an origin change. */
export function stripSensitiveHeadersForRedirect(
  headers: Readonly<Record<string, string>>,
  currentUrl: URL,
  nextUrl: URL,
): Record<string, string> {
  if (currentUrl.origin === nextUrl.origin) return { ...headers };
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
  );
}
