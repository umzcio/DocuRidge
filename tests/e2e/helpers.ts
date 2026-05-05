import { execSync } from 'node:child_process';

/**
 * Resolve the BOOTSTRAP_TOKEN value the running app expects.
 *
 * Strategy: read it from inside the running app container's environment.
 * If we can't reach Docker (e.g., tests run outside the host), fall back
 * to the host's .env file.
 */
export async function resolveBootstrapToken(): Promise<string> {
  if (process.env.BOOTSTRAP_TOKEN) return process.env.BOOTSTRAP_TOKEN;
  try {
    const out = execSync(
      "docker exec docuridge_app sh -c 'echo $BOOTSTRAP_TOKEN'",
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (out) return out;
  } catch {
    // fallthrough
  }
  const envFile = require('node:fs').readFileSync('.env', 'utf8') as string;
  const match = envFile.match(/^BOOTSTRAP_TOKEN=(.*)$/m);
  if (match && match[1]) return match[1].trim();
  throw new Error('BOOTSTRAP_TOKEN unavailable');
}

interface MailhogMessage {
  Content: { Headers: Record<string, string[]>; Body: string };
  To: { Mailbox: string; Domain: string }[];
  From: { Mailbox: string; Domain: string };
}

interface MailhogResponse {
  total: number;
  count: number;
  start: number;
  items: MailhogMessage[];
}

export async function fetchMailhog(): Promise<MailhogResponse> {
  const url = process.env.MAILHOG_API_URL || 'http://localhost:8737/api/v2/messages';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MailHog returned ${res.status}`);
  return (await res.json()) as MailhogResponse;
}

/** Decode a quoted-printable string: soft line breaks (=\r?\n) and =XX hex escapes. */
function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function extractLink(
  res: MailhogResponse,
  toEmail: string,
  pathRegex: RegExp,
): string | null {
  for (const item of res.items) {
    const recipients = item.To.map((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase());
    if (!recipients.includes(toEmail.toLowerCase())) continue;
    const decoded = decodeQuotedPrintable(item.Content.Body);
    // Match http(s) URLs; the test wants the one whose pathname matches.
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    const matches = decoded.match(urlRegex) ?? [];
    for (const candidate of matches) {
      try {
        const u = new URL(candidate);
        if (pathRegex.test(u.pathname + u.search)) return candidate;
      } catch {
        // not a URL
      }
    }
  }
  return null;
}

/**
 * Turn a public, absolute URL (from an email) into one against the test's
 * own origin. Preserves pathname + search. Used so tests can navigate to
 * tokens minted with PUBLIC_URL while the test stack is on 127.0.0.1.
 */
export function toTestUrl(absoluteUrl: string): string {
  const base = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3737/DocuRidge/';
  const baseOrigin = new URL(base).origin;
  const u = new URL(absoluteUrl);
  return `${baseOrigin}${u.pathname}${u.search}`;
}
