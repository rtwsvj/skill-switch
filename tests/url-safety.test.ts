import { describe, expect, it } from 'vitest';
import {
  assertResolvedHostPolicy,
  hasUrlCredentials,
  isLoopbackHost,
  isPrivateNetworkLiteral,
  isRedirectStatus,
  resolveRedirectUrl,
  stripSensitiveHeadersForRedirect,
} from '../src/core/security/url-safety.ts';

describe('url-safety', () => {
  it('classifies private, loopback, link-local, mapped, and special-use IP literals', () => {
    for (const host of [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
      '198.51.100.1', '203.0.113.1', '224.0.0.1',
      '[::]', '[::1]', '[fd00::1]', '[fe80::1]', '[ff02::1]', '[::ffff:7f00:1]',
    ]) {
      expect(isPrivateNetworkLiteral(host), host).toBe(true);
    }
    expect(isPrivateNetworkLiteral('8.8.8.8')).toBe(false);
    expect(isPrivateNetworkLiteral('example.test')).toBe(false);
  });

  it('allows only explicit loopback names and addresses for local HTTP', () => {
    for (const host of ['localhost', 'service.localhost.', '127.42.0.1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '10.0.0.1', 'localhost.attacker.test']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('recognizes only HTTP redirect statuses and resolves relative locations', () => {
    for (const status of [301, 302, 303, 307, 308]) expect(isRedirectStatus(status)).toBe(true);
    for (const status of [200, 300, 304, 305, 400]) expect(isRedirectStatus(status)).toBe(false);
    expect(resolveRedirectUrl(new URL('https://example.test/a/b'), '../next').toString())
      .toBe('https://example.test/next');
  });

  it('strips credentials case-insensitively only when origin changes', () => {
    const headers = {
      accept: 'application/json',
      Authorization: 'Bearer secret',
      COOKIE: 'session=secret',
      'X-Api-Key': 'secret',
      'x-trace': 'visible',
    };
    const current = new URL('https://one.example.test/mcp');
    const changed = stripSensitiveHeadersForRedirect(
      headers,
      current,
      new URL('https://two.example.test/mcp'),
    );
    expect(changed).toEqual({ accept: 'application/json', 'x-trace': 'visible' });
    expect(stripSensitiveHeadersForRedirect(headers, current, new URL('https://one.example.test/next')))
      .toEqual(headers);
  });

  it('detects URL credentials without decoding or logging them', () => {
    expect(hasUrlCredentials(new URL('https://user:p%40ss@example.test/'))).toBe(true);
    expect(hasUrlCredentials(new URL('https://example.test/'))).toBe(false);
  });

  it('rejects hostnames resolving to any non-public address', async () => {
    const url = new URL('https://registry.example.test/catalog');
    await expect(assertResolvedHostPolicy(url, {
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    })).rejects.toMatchObject({ code: 'non-public-address' });
  });

  it('allows public answers and explicit loopback only for local transports', async () => {
    await expect(assertResolvedHostPolicy(new URL('https://example.test'), {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toBeUndefined();

    const loopbackResolver = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(assertResolvedHostPolicy(new URL('http://localhost:3000'), {
      resolver: loopbackResolver,
      allowLoopback: true,
    })).resolves.toBeUndefined();
    await expect(assertResolvedHostPolicy(new URL('https://localhost'), {
      resolver: loopbackResolver,
    })).rejects.toMatchObject({ code: 'non-public-address' });
  });

  it('fails closed when DNS lookup fails or returns no addresses', async () => {
    await expect(assertResolvedHostPolicy(new URL('https://example.test'), {
      resolver: async () => { throw new Error('dns detail must not escape'); },
    })).rejects.toMatchObject({ code: 'lookup-failed' });
    await expect(assertResolvedHostPolicy(new URL('https://example.test'), {
      resolver: async () => [],
    })).rejects.toMatchObject({ code: 'lookup-failed' });
  });
});
