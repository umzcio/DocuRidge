import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  callCreate: vi.fn(),
  dnsLookup: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup, default: { lookup: mocks.dnsLookup } }));
vi.mock('../prisma', () => ({
  prisma: {
    webhookSubscription: { findMany: mocks.findMany },
    webhookCall: { create: mocks.callCreate },
  },
}));
vi.mock('../logger', () => ({ childLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { deliverWebhookEvent } from './dispatch';

const EVENT = {
  type: 'envelope.sent',
  envelopeId: 'env_1',
  orgId: 'org_1',
  occurredAt: new Date('2026-01-01T00:00:00Z'),
};

function sub(url: string) {
  return { id: `sub_${url}`, url, secret: 'shh', events: [] as string[], enabled: true, orgId: 'org_1' };
}

let server: http.Server;
let port: number;
const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let respond: (res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  hits.length = 0;
  respond = (res) => res.end('ok');
  mocks.findMany.mockReset();
  mocks.callCreate.mockReset().mockResolvedValue({});
  mocks.dnsLookup.mockReset();
  delete process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;
});

function failurePayloads() {
  return mocks.callCreate.mock.calls
    .map(([arg]) => (arg as { data: { payload: { error?: string } } }).data.payload.error)
    .filter(Boolean);
}

describe('deliverWebhookEvent — SSRF refusal at delivery time', () => {
  it('refuses a stored URL whose name resolves to a private address', async () => {
    mocks.findMany.mockResolvedValue([sub(`http://10.0.0.1.nip.io:${port}/`)]);
    mocks.dnsLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await deliverWebhookEvent(EVENT);
    expect(failurePayloads()).toEqual(['refused target (private_address)']);
    expect(hits).toHaveLength(0);
  });

  it('refuses a name that rebinds to loopback', async () => {
    mocks.findMany.mockResolvedValue([sub(`http://rebind.example.com:${port}/`)]);
    mocks.dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await deliverWebhookEvent(EVENT);
    expect(failurePayloads()).toEqual(['refused target (loopback)']);
    expect(hits).toHaveLength(0);
  });

  it('refuses a stored IPv4-mapped IPv6 literal without connecting', async () => {
    mocks.findMany.mockResolvedValue([sub(`http://[::ffff:7f00:1]:${port}/`)]);
    await deliverWebhookEvent(EVENT);
    expect(failurePayloads()).toEqual(['refused target (loopback)']);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);
  });

  it('refuses a stored Docker service name without looking it up', async () => {
    mocks.findMany.mockResolvedValue([sub('http://docuridge_mailhog.docuridge_internal:8025/api/v2/jim')]);
    await deliverWebhookEvent(EVENT);
    expect(failurePayloads()).toEqual(['refused target (non_public_hostname)']);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
  });
});

describe('deliverWebhookEvent — delivery to a vetted target', () => {
  it('POSTs the signed body to the pinned address of an allowlisted receiver', async () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = 'receiver.example.com';
    mocks.findMany.mockResolvedValue([sub(`http://receiver.example.com:${port}/hook`)]);
    mocks.dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await deliverWebhookEvent(EVENT);

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    const expectedSig = createHmac('sha256', 'shh').update(hit.body).digest('hex');
    expect(hit.headers['x-docuridge-signature']).toBe(`sha256=${expectedSig}`);
    expect(hit.headers['x-docuridge-event']).toBe('envelope.sent');
    expect(hit.headers.host).toBe(`receiver.example.com:${port}`);
    expect(JSON.parse(hit.body)).toMatchObject({ event: 'envelope.sent', envelopeId: 'env_1' });
    expect(mocks.callCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ responseStatus: 200 }),
    });
    expect(mocks.dnsLookup).toHaveBeenCalledTimes(1);
  });

  it('records a redirect as a failure instead of following it', async () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = 'receiver.example.com';
    respond = (res) => {
      res.statusCode = 307;
      res.setHeader('location', 'http://127.0.0.1:1/');
      res.end();
    };
    mocks.findMany.mockResolvedValue([sub(`http://receiver.example.com:${port}/hook`)]);
    mocks.dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await deliverWebhookEvent(EVENT);
    expect(hits).toHaveLength(1);
    expect(failurePayloads()).toEqual(['HTTP 307']);
  });
});
