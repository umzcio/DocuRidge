import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attachmentsDir = mkdtempSync(join(tmpdir(), 'docuridge-attachments-test-'));

vi.mock('./env', () => ({
  getEnv: () => ({ ATTACHMENTS_DIR: attachmentsDir, MAX_ATTACHMENT_BYTES: 1024 }),
}));

const { stageRecipientAttachment } = await import('./storage');

const orgDir = join(attachmentsDir, 'org1');
const stage = (content: string) => stageRecipientAttachment({
  orgId: 'org1', buffer: Buffer.from(content), filename: 'proof.pdf', declaredMime: 'application/pdf',
});

beforeEach(() => rmSync(orgDir, { recursive: true, force: true }));
afterAll(() => rmSync(attachmentsDir, { recursive: true, force: true }));

describe('stageRecipientAttachment', () => {
  it('makes nothing visible at the content-addressed path until commit', async () => {
    const staged = await stage('%PDF-one');
    const finalPath = join(attachmentsDir, staged.relativePath);
    expect(staged.relativePath).toMatch(/^org1\/[0-9a-f]{64}\.pdf$/);
    expect(existsSync(finalPath)).toBe(false);

    await staged.commit();
    await staged.discard();

    expect(readFileSync(finalPath).toString()).toBe('%PDF-one');
    expect(readdirSync(orgDir)).toEqual([staged.relativePath.split('/')[1]]);
  });

  it('leaves no file behind when discarded', async () => {
    const staged = await stage('%PDF-two');
    await staged.discard();
    expect(readdirSync(orgDir)).toEqual([]);
  });

  it('keeps the file another attachment already committed at the same path', async () => {
    const first = await stage('%PDF-same');
    await first.commit();
    const second = await stage('%PDF-same');

    await second.discard();

    expect(existsSync(join(attachmentsDir, first.relativePath))).toBe(true);
    expect(readdirSync(orgDir)).toHaveLength(1);
  });
});
