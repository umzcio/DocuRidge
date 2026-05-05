/**
 * Email templates. Plain text + minimal HTML. No images, no marketing chrome.
 * Subject lines deliberately specific to fight phishing fatigue (R-1).
 *
 * All `${...}` substitutions are pre-escaped at the call site or rendered
 * through React on the signing page; HTML-only mail is built here with
 * `escapeHtml`.
 */

export interface EnvelopeSentArgs {
  recipientName: string;
  senderName: string;
  documentTitle: string;
  signingUrl: string;
  message?: string;
  expiresAt?: Date;
}

export function envelopeSentTemplate(args: EnvelopeSentArgs) {
  const subject = `${args.senderName} needs your signature: ${args.documentTitle}`;
  const expiresLine = args.expiresAt
    ? `\n\nThis link expires ${args.expiresAt.toUTCString()}.`
    : '';
  const optionalMessage = args.message ? `\n\nMessage from ${args.senderName}:\n${args.message}` : '';
  const text =
`Hi ${args.recipientName},

${args.senderName} has prepared a document that needs your signature:

  ${args.documentTitle}

Open the document to review and sign:
${args.signingUrl}${expiresLine}${optionalMessage}

If you did not expect this email, you can safely ignore it; nothing will be
signed in your name.`;
  const html =
`<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#1f2937;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
<h1 style="font-size:18px;margin:0 0 8px;">Signature requested</h1>
<p style="margin:0 0 12px;color:#374151;"><strong>${escapeHtml(args.senderName)}</strong> has prepared a document that needs your signature:</p>
<p style="font-weight:600;margin:0 0 16px;">${escapeHtml(args.documentTitle)}</p>
<p style="margin:0 0 24px;"><a href="${escapeAttr(args.signingUrl)}" style="display:inline-block;background:#265558;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:500;">Review and sign</a></p>
${args.message ? `<p style="margin:0 0 16px;"><em>Message from ${escapeHtml(args.senderName)}:</em><br/>${escapeHtml(args.message)}</p>` : ''}
${args.expiresAt ? `<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">This link expires ${escapeHtml(args.expiresAt.toUTCString())}.</p>` : ''}
<p style="margin:24px 0 0;color:#6b7280;font-size:12px;">If you did not expect this email, you can safely ignore it.</p>
</body></html>`;
  return { subject, text, html };
}

export interface EnvelopeCompletedArgs {
  recipientName: string;
  documentTitle: string;
  downloadUrl?: string;
}

export function envelopeCompletedTemplate(args: EnvelopeCompletedArgs) {
  const subject = `Signed: ${args.documentTitle}`;
  const downloadLine = args.downloadUrl
    ? `\n\nDownload the sealed copy:\n${args.downloadUrl}`
    : '';
  const text =
`Hi ${args.recipientName},

The document "${args.documentTitle}" has been signed by all parties and is now complete.${downloadLine}`;
  const html =
`<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#1f2937;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
<h1 style="font-size:18px;margin:0 0 8px;">Document complete</h1>
<p style="margin:0 0 12px;">The document <strong>${escapeHtml(args.documentTitle)}</strong> has been signed by all parties.</p>
${args.downloadUrl ? `<p style="margin:0 0 16px;"><a href="${escapeAttr(args.downloadUrl)}">Download the sealed copy</a></p>` : ''}
</body></html>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
