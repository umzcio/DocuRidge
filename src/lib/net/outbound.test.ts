import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkOutboundUrl,
  vetOutboundUrl,
  guardedFetch,
  pinnedLookup,
  OutboundRefusedError,
  type Resolver,
} from './outbound';

function resolverFor(map: Record<string, string[]>): Resolver & ReturnType<typeof vi.fn> {
  return vi.fn(async (hostname: string) => {
    const answers = map[hostname];
    if (!answers) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);
  }) as unknown as Resolver & ReturnType<typeof vi.fn>;
}

describe('checkOutboundUrl — hostname shape', () => {
  it.each([
    ['http://docuridge_mailhog.docuridge_internal:8025/api/v2/jim', 'non_public_hostname'],
    ['http://docuridge_mailhog.:8025/', 'non_public_hostname'],
    ['http://hooks.example.com./x', 'non_public_hostname'],
    ['http://docuridge_postgres:5432/', 'non_public_hostname'],
    ['http://printer.local/', 'non_public_hostname'],
    ['http://svc.internal/', 'non_public_hostname'],
    ['http://router.home.arpa/', 'non_public_hostname'],
    ['http://foo.localhost/', 'loopback'],
    ['http://localhost./', 'loopback'],
  ])('rejects %s as %s', (url, reason) => {
    const result = checkOutboundUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it.each([
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
    ['http://[::ffff:7f00:1]/', 'loopback'],
    ['http://[::ffff:172.18.0.2]/', 'private_address'],
    ['http://[::ffff:169.254.169.254]/', 'link_local'],
    ['http://[::]/', 'loopback'],
    ['http://[64:ff9b::a00:1]/', 'private_address'],
    ['http://0x7f000001/', 'loopback'],
    ['http://2130706433/', 'loopback'],
    ['http://100.100.100.200/', 'private_address'],
  ])('rejects the IP literal %s as %s', (url, reason) => {
    const result = checkOutboundUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it('lets an allowlisted name skip the shape and range rules', () => {
    const allowed = new Set(['docuridge_mailhog.']);
    expect(checkOutboundUrl('http://docuridge_mailhog.:8025/', { allowedInternalHosts: allowed }).ok)
      .toBe(true);
  });
});

describe('vetOutboundUrl — resolves and checks every address', () => {
  it('accepts a public name and returns the vetted addresses', async () => {
    const resolve = resolverFor({ 'hooks.example.com': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'] });
    const result = await vetOutboundUrl('https://hooks.example.com/x', { resolve });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.addresses.map((a) => a.address)).toEqual([
        '93.184.215.14',
        '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
      ]);
    }
  });

  it.each([
    ['http://10.0.0.1.nip.io/', ['10.0.0.1'], 'private_address'],
    ['http://127.0.0.1.sslip.io/', ['127.0.0.1'], 'loopback'],
    ['http://metadata.example.com/', ['169.254.169.254'], 'link_local'],
    ['http://mapped.example.com/', ['::ffff:172.18.0.3'], 'private_address'],
    ['http://ula.example.com/', ['fd00::5'], 'private_address'],
  ])('rejects %s resolving to %j as %s', async (url, answers, reason) => {
    const host = new URL(url).hostname;
    const result = await vetOutboundUrl(url, { resolve: resolverFor({ [host]: answers }) });
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('rejects when ANY answer is internal, even if another is public', async () => {
    const resolve = resolverFor({ 'mixed.example.com': ['93.184.215.14', '10.0.0.7'] });
    const result = await vetOutboundUrl('https://mixed.example.com/', { resolve });
    expect(result).toMatchObject({ ok: false, reason: 'private_address' });
  });

  it('rejects a name that does not resolve', async () => {
    const result = await vetOutboundUrl('https://nowhere.example.com/', { resolve: resolverFor({}) });
    expect(result).toMatchObject({ ok: false, reason: 'unresolvable' });
  });

  it('rejects a name that resolves to an empty answer set', async () => {
    const resolve = resolverFor({ 'empty.example.com': [] });
    const result = await vetOutboundUrl('https://empty.example.com/', { resolve });
    expect(result).toMatchObject({ ok: false, reason: 'unresolvable' });
  });

  it('does not call the resolver for an IP literal', async () => {
    const resolve = resolverFor({});
    const result = await vetOutboundUrl('https://93.184.215.14/', { resolve });
    expect(result.ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never resolves a name the shape rules already refuse', async () => {
    const resolve = resolverFor({ 'docuridge_mailhog.docuridge_internal': ['93.184.215.14'] });
    const result = await vetOutboundUrl('http://docuridge_mailhog.docuridge_internal:8025/', { resolve });
    expect(result).toMatchObject({ ok: false, reason: 'non_public_hostname' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets an allowlisted host resolve to an internal address', async () => {
    const resolve = resolverFor({ 'receiver.example.com': ['10.0.0.9'] });
    const result = await vetOutboundUrl('http://receiver.example.com/', {
      resolve,
      allowedInternalHosts: new Set(['receiver.example.com']),
    });
    expect(result.ok).toBe(true);
  });
});

describe('pinnedLookup', () => {
  const addresses = [
    { address: '93.184.215.14', family: 4 as const },
    { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 as const },
  ];

  it('answers with the vetted addresses when all are requested', () => {
    const cb = vi.fn();
    pinnedLookup('hooks.example.com', addresses)('hooks.example.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, addresses);
  });

  it('answers with a single vetted address, honouring the family filter', () => {
    const cb = vi.fn();
    pinnedLookup('hooks.example.com', addresses)('hooks.example.com', { family: 6 }, cb);
    expect(cb).toHaveBeenCalledWith(null, addresses[1]!.address, 6);
  });

  it('refuses to answer for any other hostname', () => {
    const cb = vi.fn();
    pinnedLookup('hooks.example.com', addresses)('evil.example.com', {}, cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('guardedFetch — connects only to the vetted address', () => {
  let server: http.Server;
  let port: number;
  const hits: { method?: string; url?: string; host?: string; body: string }[] = [];
  let respond: (res: http.ServerResponse) => void = (res) => res.end('ok');

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, host: req.headers.host, body });
        respond(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    hits.length = 0;
    respond = (res) => res.end('ok');
  });

  it('refuses an internal target before opening a connection', async () => {
    const resolve = resolverFor({ 'rebind.example.com': ['127.0.0.1'] });
    await expect(
      guardedFetch(`http://rebind.example.com:${port}/hook`, { method: 'POST', body: 'x' }, { resolve }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(hits).toHaveLength(0);
  });

  it('refuses an IPv4-mapped literal before opening a connection', async () => {
    await expect(
      guardedFetch(`http://[::ffff:127.0.0.1]:${port}/hook`, { method: 'POST', body: 'x' }),
    ).rejects.toMatchObject({ reason: 'loopback' });
    expect(hits).toHaveLength(0);
  });

  it('connects to the address it vetted, resolving exactly once (no rebinding window)', async () => {
    // `pinned.invalid` cannot resolve through the system resolver, so the
    // request only lands if the socket uses the pinned answer.
    const resolve = resolverFor({ 'pinned.invalid': ['127.0.0.1'] });
    const res = await guardedFetch(
      `http://pinned.invalid:${port}/hook?a=1`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      { resolve, allowedInternalHosts: new Set(['pinned.invalid']) },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(hits).toEqual([
      { method: 'POST', url: '/hook?a=1', host: `pinned.invalid:${port}`, body: '{"a":1}' },
    ]);
  });

  it('does not follow redirects', async () => {
    respond = (res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://127.0.0.1:${port}/internal`);
      res.end();
    };
    const resolve = resolverFor({ 'pinned.invalid': ['127.0.0.1'] });
    const res = await guardedFetch(
      `http://pinned.invalid:${port}/hook`,
      { method: 'POST', body: 'x' },
      { resolve, allowedInternalHosts: new Set(['pinned.invalid']) },
    );
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
    expect(hits).toHaveLength(1);
  });

  it('caps the response body size', async () => {
    respond = (res) => res.end('x'.repeat(4096));
    const resolve = resolverFor({ 'pinned.invalid': ['127.0.0.1'] });
    await expect(
      guardedFetch(
        `http://pinned.invalid:${port}/big`,
        {},
        { resolve, allowedInternalHosts: new Set(['pinned.invalid']), maxResponseBytes: 1024 },
      ),
    ).rejects.toThrow(/too large/i);
  });
});
