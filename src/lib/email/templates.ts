/**
 * Email templates. Plain text + minimal HTML. No images, no marketing chrome.
 * Subject lines deliberately specific to fight phishing fatigue (R-1).
 *
 * All `${...}` substitutions are pre-escaped at the call site or rendered
 * through React on the signing page; HTML-only mail is built here with
 * `escapeHtml`.
 */

/**
 * Resolve the org-configured brand accent color (or fall back to the project
 * cobalt) and produce both the button background and a darker pressed/border
 * shade. Centralised so every template uses the same fallback chain.
 */
function brandPalette(brand?: string | null) {
  const valid = brand && /^#[0-9a-fA-F]{6}$/.test(brand) ? brand : '#2544FB';
  // Border = same hex with each channel darkened by ~20%. Cheap manual
  // calculation avoids pulling in a color library for one CTA.
  const r = Math.max(0, Math.round(parseInt(valid.slice(1, 3), 16) * 0.78));
  const g = Math.max(0, Math.round(parseInt(valid.slice(3, 5), 16) * 0.78));
  const b = Math.max(0, Math.round(parseInt(valid.slice(5, 7), 16) * 0.78));
  const deep = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { brand: valid, deep };
}

export interface ForwardArgs {
  recipientEmail: string;
  forwarderName: string;
  documentTitle: string;
  viewUrl: string;
  note?: string;
  expiresAt: Date;
  emailFooter?: string;
  brandColor?: string | null;
}

export function envelopeForwardTemplate(args: ForwardArgs) {
  const palette = brandPalette(args.brandColor);
  const subject = `${args.forwarderName} shared a signed document: ${args.documentTitle}`;
  const text =
`Hi,

${args.forwarderName} has shared a signed and sealed document with you:

  ${args.documentTitle}

Open the link below to view and download the sealed PDF:
${args.viewUrl}

This link expires ${args.expiresAt.toUTCString()}.${args.note ? `\n\nNote from ${args.forwarderName}:\n${args.note}` : ''}${args.emailFooter ? `\n\n— ${args.emailFooter}` : ''}

If you weren't expecting this, you can safely ignore the email.`;
  const html =
`<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#1f2937;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
<h1 style="font-size:18px;margin:0 0 8px;">A signed document was shared with you</h1>
<p style="margin:0 0 12px;color:#374151;"><strong>${escapeHtml(args.forwarderName)}</strong> shared a sealed document:</p>
<p style="font-weight:600;margin:0 0 16px;">${escapeHtml(args.documentTitle)}</p>
<p style="margin:0 0 24px;"><a href="${escapeAttr(args.viewUrl)}" style="display:inline-block;background:${palette.brand};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:500;border:1px solid ${palette.deep};">View signed PDF →</a></p>
${args.note ? `<p style="margin:0 0 16px;"><em>Note from ${escapeHtml(args.forwarderName)}:</em><br/>${escapeHtml(args.note)}</p>` : ''}
<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">This link expires ${escapeHtml(args.expiresAt.toUTCString())}.</p>
${args.emailFooter ? `<p style="margin:24px 0 0;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:12px;">${escapeHtml(args.emailFooter)}</p>` : ''}
<p style="margin:8px 0 0;color:#6b7280;font-size:12px;">If you weren't expecting this email, you can safely ignore it.</p>
</body></html>`;
  return { subject, text, html };
}

export interface EnvelopeSentArgs {
  recipientName: string;
  senderName: string;
  documentTitle: string;
  signingUrl: string;
  message?: string;
  expiresAt?: Date;
  emailFooter?: string;
  brandColor?: string | null;
}

export function envelopeSentTemplate(args: EnvelopeSentArgs) {
  const subject = `${args.senderName} needs your signature: ${args.documentTitle}`;
  const palette = brandPalette(args.brandColor);
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
<p style="margin:0 0 24px;"><a href="${escapeAttr(args.signingUrl)}" style="display:inline-block;background:${palette.brand};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:500;border:1px solid ${palette.deep};">Review and sign</a></p>
${args.message ? `<p style="margin:0 0 16px;"><em>Message from ${escapeHtml(args.senderName)}:</em><br/>${escapeHtml(args.message)}</p>` : ''}
${args.expiresAt ? `<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">This link expires ${escapeHtml(args.expiresAt.toUTCString())}.</p>` : ''}
${args.emailFooter ? `<p style="margin:24px 0 0;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:12px;">${escapeHtml(args.emailFooter)}</p>` : ''}
<p style="margin:8px 0 0;color:#6b7280;font-size:12px;">If you did not expect this email, you can safely ignore it.</p>
</body></html>`;
  return { subject, text, html };
}

export interface EnvelopeReminderArgs {
  recipientName: string;
  senderName: string;
  documentTitle: string;
  signingUrl: string;
  customSubject?: string;
  message?: string;
  expiresAt?: Date;
  emailFooter?: string;
  brandColor?: string | null;
}

export function envelopeReminderTemplate(args: EnvelopeReminderArgs) {
  const palette = brandPalette(args.brandColor);
  // Subject prefixed with "Reminder:" — when sender supplied a custom subject
  // we still keep the prefix so recipients can spot follow-ups in their inbox.
  const baseSubject = args.customSubject?.trim() || `${args.senderName} needs your signature: ${args.documentTitle}`;
  const subject = baseSubject.toLowerCase().startsWith('reminder')
    ? baseSubject
    : `Reminder: ${baseSubject}`;
  const expiresLine = args.expiresAt
    ? `\n\nThis link expires ${args.expiresAt.toUTCString()}.`
    : '';
  const optionalMessage = args.message ? `\n\nOriginal message from ${args.senderName}:\n${args.message}` : '';
  const footerLine = args.emailFooter ? `\n\n— ${args.emailFooter}` : '';
  const text =
`Hi ${args.recipientName},

This is a reminder that ${args.senderName} is still waiting on your signature for:

  ${args.documentTitle}

Open the document to review and sign:
${args.signingUrl}${expiresLine}${optionalMessage}${footerLine}

If you've already signed, you can ignore this message — multiple sends can
happen if email delivery was delayed.`;
  const html =
`<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#1f2937;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
<p style="margin:0 0 4px;color:#A06800;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Reminder</p>
<h1 style="font-size:18px;margin:0 0 8px;">Still waiting on your signature</h1>
<p style="margin:0 0 12px;color:#374151;"><strong>${escapeHtml(args.senderName)}</strong> is waiting on you to sign:</p>
<p style="font-weight:600;margin:0 0 16px;">${escapeHtml(args.documentTitle)}</p>
<p style="margin:0 0 24px;"><a href="${escapeAttr(args.signingUrl)}" style="display:inline-block;background:${palette.brand};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:500;border:1px solid ${palette.deep};">Review and sign</a></p>
${args.message ? `<p style="margin:0 0 16px;"><em>Original message from ${escapeHtml(args.senderName)}:</em><br/>${escapeHtml(args.message)}</p>` : ''}
${args.expiresAt ? `<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">This link expires ${escapeHtml(args.expiresAt.toUTCString())}.</p>` : ''}
${args.emailFooter ? `<p style="margin:24px 0 0;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:12px;">${escapeHtml(args.emailFooter)}</p>` : ''}
<p style="margin:8px 0 0;color:#6b7280;font-size:12px;">If you've already signed, ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}

export interface SignerSummary {
  name: string;
  email: string;
  signedAt: Date | null;
  /** Adopted-signature image as raw base64 (no data: prefix), if drawn. */
  signatureImageBase64?: string | null;
  /** Typed signature, if the recipient chose Type instead of Draw. */
  typedSignature?: string | null;
}

export interface EnvelopeCompletedArgs {
  recipientName: string;
  documentTitle: string;
  downloadUrl?: string;
  senderName?: string;
  senderEmail?: string;
  signers?: SignerSummary[];
  orgLogoBase64?: string | null;
  orgLogoMimeType?: string | null;
  orgName?: string;
  emailFooter?: string;
  completedAt?: Date;
  brandColor?: string | null;
}

export function envelopeCompletedTemplate(args: EnvelopeCompletedArgs) {
  const palette = brandPalette(args.brandColor);
  const subject = `Completed: ${args.documentTitle}`;
  const completedAt = args.completedAt ?? new Date();
  const completedAtPretty = completedAt.toUTCString();

  const signersText = (args.signers ?? [])
    .map((s) => {
      const stamp = s.signedAt ? s.signedAt.toUTCString() : '—';
      const sigNote = s.signatureImageBase64 ? ' (drawn)' : s.typedSignature ? ` (typed: ${s.typedSignature})` : '';
      return `  • ${s.name} <${s.email}> — signed ${stamp}${sigNote}`;
    })
    .join('\n');

  const text =
`Hi ${args.recipientName},

"${args.documentTitle}" has been signed by all parties and is sealed.

Signers:
${signersText || '  (none)'}

Completed: ${completedAtPretty}
${args.downloadUrl ? `\nDownload the sealed copy:\n${args.downloadUrl}\n` : ''}${args.emailFooter ? `\n— ${args.emailFooter}\n` : ''}
This document was sealed with an Ed25519-signed audit chain. Verify offline:
  npm run verify -- <sealed.pdf>`;

  const logoHtml = args.orgLogoBase64 && args.orgLogoMimeType
    ? `<img src="data:${args.orgLogoMimeType};base64,${args.orgLogoBase64}" alt="${escapeAttr(args.orgName ?? '')}" style="max-height:40px;max-width:160px;display:block;margin-bottom:18px;" />`
    : `<div style="font-family:system-ui,sans-serif;font-size:18px;font-weight:600;color:#0F1115;margin-bottom:18px;letter-spacing:-0.012em;"><span style="color:#0A163F;">Docu</span><span style="color:#2544FB;">Ridge</span></div>`;

  const sigBlocks = (args.signers ?? []).map((s) => {
    const initials = s.name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
    const sigCell = s.signatureImageBase64
      ? `<img src="data:image/png;base64,${s.signatureImageBase64}" alt="Signature of ${escapeAttr(s.name)}" style="max-height:48px;max-width:220px;background:#FFFFFF;display:block;" />`
      : s.typedSignature
        ? `<span style="font-family:'Brush Script MT','Lucida Handwriting',cursive;font-size:26px;color:#0F1115;line-height:1;">${escapeHtml(s.typedSignature)}</span>`
        : `<span style="font-family:system-ui,sans-serif;font-size:12px;color:#6B7280;font-style:italic;">No signature recorded</span>`;
    const stamp = s.signedAt ? s.signedAt.toUTCString() : '—';
    return `<tr>
  <td style="padding:14px 16px;border-top:1px solid #E8E2D6;vertical-align:top;width:48px;">
    <div style="width:36px;height:36px;border-radius:18px;background:#E5E9FF;color:#1A2FBF;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.02em;line-height:36px;text-align:center;">${escapeHtml(initials)}</div>
  </td>
  <td style="padding:14px 12px;border-top:1px solid #E8E2D6;vertical-align:top;font-family:system-ui,sans-serif;color:#1A1A1A;">
    <div style="font-size:14px;font-weight:600;line-height:1.3;">${escapeHtml(s.name)}</div>
    <div style="font-size:12px;color:#6B7280;line-height:1.3;margin-top:2px;">${escapeHtml(s.email)}</div>
    <div style="font-size:11px;color:#8A8A8A;line-height:1.3;margin-top:4px;font-family:'SFMono-Regular',Menlo,monospace;">Signed ${escapeHtml(stamp)}</div>
  </td>
  <td style="padding:14px 16px;border-top:1px solid #E8E2D6;vertical-align:middle;text-align:right;">
    ${sigCell}
  </td>
</tr>`;
  }).join('');

  const html =
`<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="color-scheme" content="light only" /></head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1A1A1A;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FAF7F2;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E8E2D6;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px 0;">
            ${logoHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 8px;">
            <div style="display:inline-block;background:#E5EFE6;color:#1F6F4A;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Sealed &amp; complete</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 4px;">
            <h1 style="font-size:22px;font-weight:600;line-height:1.25;letter-spacing:-0.022em;margin:0;color:#0F1115;">${escapeHtml(args.documentTitle)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 28px 18px;">
            <p style="font-size:13.5px;color:#5C5C5C;margin:0;">All parties have signed. Below is who signed and when, plus a link to download the sealed PDF.</p>
          </td>
        </tr>
        ${args.downloadUrl ? `<tr>
          <td style="padding:0 28px 22px;">
            <a href="${escapeAttr(args.downloadUrl)}" style="display:inline-block;background:${palette.brand};color:#FFFFFF;text-decoration:none;font-weight:500;font-size:14px;padding:11px 18px;border-radius:6px;border:1px solid ${palette.deep};">Download sealed PDF →</a>
          </td>
        </tr>` : ''}
        <tr>
          <td style="padding:0 28px 4px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8A8A8A;margin-bottom:6px;">Signers (${(args.signers ?? []).length})</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 18px;">
            <table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="border-top:0;">
              ${sigBlocks || '<tr><td style="padding:14px 28px;font-size:13px;color:#8A8A8A;">No signers recorded.</td></tr>'}
            </table>
          </td>
        </tr>
        ${args.senderName ? `<tr>
          <td style="padding:0 28px 16px;">
            <div style="font-size:12.5px;color:#5C5C5C;line-height:1.5;border-top:1px solid #E8E2D6;padding-top:14px;">
              Sent by <strong>${escapeHtml(args.senderName)}</strong>${args.senderEmail ? ` &lt;${escapeHtml(args.senderEmail)}&gt;` : ''}
              ${args.orgName ? `<br/><span style="color:#8A8A8A;">${escapeHtml(args.orgName)}</span>` : ''}
            </div>
          </td>
        </tr>` : ''}
        <tr>
          <td style="padding:14px 28px 18px;background:#F5F0E8;border-top:1px solid #E8E2D6;">
            <div style="font-size:11.5px;color:#5C5C5C;line-height:1.55;">
              Completed ${escapeHtml(completedAtPretty)}.<br/>
              Sealed with an Ed25519-signed audit chain. Each event is hash-chained and tamper-evident.
            </div>
            ${args.emailFooter ? `<div style="margin-top:10px;font-size:11px;color:#8A8A8A;line-height:1.5;border-top:1px solid #E8E2D6;padding-top:10px;">${escapeHtml(args.emailFooter)}</div>` : ''}
          </td>
        </tr>
      </table>
      <p style="font-size:11px;color:#8A8A8A;margin:14px 0 0;font-family:'SFMono-Regular',Menlo,monospace;">DocuRidge · self-hosted e-signature</p>
    </td>
  </tr>
</table>
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
