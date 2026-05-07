'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveDefaultSignatureAction, type SavedSignatureActionState } from './actions';

const initial: SavedSignatureActionState = { ok: false };

/**
 * Settings card for managing one default signature slot (signature OR
 * initials). Shows the current saved value (drawn → image, typed → cursive
 * preview) plus a Clear button. Adopting a NEW default is intentionally
 * done from inside a real signing ceremony — that's where the modal lives,
 * and it's the only place we can guarantee the recipient understands the
 * binding effect of saving a default.
 */
export function DefaultSignaturePanel({
  kind, pngBase64, typed,
}: {
  kind: 'SIGNATURE' | 'INITIALS';
  pngBase64: string | null;
  typed: string | null;
}) {
  const [state, action] = useActionState(saveDefaultSignatureAction, initial);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (state.ok && state.success) setFeedback({ ok: true, text: state.success });
    else if (state.error) setFeedback({ ok: false, text: state.error });
  }, [state]);
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  const hasSomething = !!pngBase64 || !!typed;
  const label = kind === 'SIGNATURE' ? 'signature' : 'initials';

  return (
    <div className="mt-3 rounded-md border border-hairline bg-surface p-4">
      <div className="flex items-center gap-4">
        <div className="flex-shrink-0 h-16 w-44 rounded border border-hairline bg-surface-muted/30 flex items-center justify-center px-2 overflow-hidden">
          {pngBase64 ? (
            <img
              src={`data:image/png;base64,${pngBase64}`}
              alt={`Saved ${label}`}
              className="max-h-12 max-w-full object-contain"
            />
          ) : typed ? (
            <span className="font-sig text-[24px] text-ink truncate">{typed}</span>
          ) : (
            <span className="text-[11px] font-mono text-ink-tertiary uppercase">No default saved</span>
          )}
        </div>
        <div className="flex-1 text-[12.5px] text-ink-secondary leading-snug">
          {hasSomething
            ? <>Adopted from a previous signing session. {kind === 'SIGNATURE' ? 'Signature' : 'Initials'} fields will pre-fill with this whenever you open a new envelope addressed to your account email.</>
            : <>You'll see your default appear here the first time you adopt {kind === 'SIGNATURE' ? 'a signature' : 'initials'} during signing on a device that's signed in. There's nothing to set up here.</>}
        </div>
      </div>
      {hasSomething && (
        <form action={action} className="mt-3 flex items-center gap-2">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="pngBase64" value="" />
          <input type="hidden" name="typed" value="" />
          <ClearBtn label={`Clear default ${label}`} />
          {feedback && (
            <span className={`text-[11.5px] ${feedback.ok ? 'text-status-completed' : 'text-status-declined'}`}>
              {feedback.ok ? '✓ ' : ''}{feedback.text}
            </span>
          )}
        </form>
      )}
    </div>
  );
}

function ClearBtn({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-8 items-center px-3 rounded-md border border-hairline text-[12.5px] font-medium text-ink-secondary hover:text-status-declined hover:border-status-declined-border disabled:opacity-50"
    >
      {pending ? 'Clearing…' : label}
    </button>
  );
}
