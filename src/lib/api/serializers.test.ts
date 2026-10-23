import { describe, it, expect } from 'vitest';
import {
  serializeRecipient,
  serializeEnvelopeSummary,
  serializeEnvelopeDetail,
  type EnvelopeSummarySource,
} from './serializers';

const D = (s: string) => new Date(s);

const recipient = {
  id: 'rec_1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  recipientRole: 'SIGNER',
  roleLabel: 'Signer',
  signingOrder: 1,
  readStatus: 'OPENED',
  signingStatus: 'SIGNED',
  sentAt: D('2026-08-01T10:00:00.000Z'),
  signedAt: D('2026-08-02T11:00:00.000Z'),
  declinedAt: null,
};

const envelope: EnvelopeSummarySource = {
  id: 'env_1',
  title: 'Lease agreement',
  status: 'COMPLETED',
  routingMode: 'SEQUENTIAL',
  createdById: 'user_1',
  templateOriginId: null,
  message: 'Please sign',
  createdAt: D('2026-08-01T09:00:00.000Z'),
  updatedAt: D('2026-08-02T11:00:00.000Z'),
  sentAt: D('2026-08-01T10:00:00.000Z'),
  completedAt: D('2026-08-02T11:00:00.000Z'),
  expiresAt: null,
  recipients: [recipient],
};

describe('serializeRecipient', () => {
  it('maps role fields and ISO dates', () => {
    expect(serializeRecipient(recipient)).toEqual({
      id: 'rec_1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'SIGNER',
      roleLabel: 'Signer',
      signingOrder: 1,
      readStatus: 'OPENED',
      signingStatus: 'SIGNED',
      sentAt: '2026-08-01T10:00:00.000Z',
      signedAt: '2026-08-02T11:00:00.000Z',
      declinedAt: null,
    });
  });
});

describe('serializeEnvelopeSummary', () => {
  it('emits stable camelCase fields with ISO dates and summarized recipients', () => {
    const json = serializeEnvelopeSummary(envelope);
    expect(json).toEqual({
      id: 'env_1',
      title: 'Lease agreement',
      status: 'COMPLETED',
      routingMode: 'SEQUENTIAL',
      createdById: 'user_1',
      templateOriginId: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-02T11:00:00.000Z',
      sentAt: '2026-08-01T10:00:00.000Z',
      completedAt: '2026-08-02T11:00:00.000Z',
      expiresAt: null,
      recipients: [serializeRecipient(recipient)],
    });
    // The summary must not leak the message body.
    expect(json).not.toHaveProperty('message');
  });
});

describe('serializeEnvelopeDetail', () => {
  it('adds message and documents', () => {
    const json = serializeEnvelopeDetail({
      ...envelope,
      items: [
        {
          id: 'item_1',
          title: 'Lease.pdf',
          order: 1,
          pageCount: 3,
          documentFile: {
            id: 'file_1',
            mimeType: 'application/pdf',
            sizeBytes: 12345,
            sha256: 'abc123',
          },
        },
      ],
    });
    expect(json.message).toBe('Please sign');
    expect(json.documents).toEqual([
      {
        id: 'item_1',
        title: 'Lease.pdf',
        order: 1,
        pageCount: 3,
        documentFileId: 'file_1',
        mimeType: 'application/pdf',
        sizeBytes: 12345,
        sha256: 'abc123',
      },
    ]);
  });
});
