'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { addCommentSenderAction, type CommentActionState } from './comment-actions';

const initial: CommentActionState = { ok: false };

export interface CommentRow {
  id: string;
  authorName: string;
  /** True when this post was made by the currently signed-in user. */
  isOwnPost: boolean;
  /** True when this post was made via the dashboard (sender side). */
  isSender: boolean;
  body: string;
  /** ISO string for SSR-safe comparisons. */
  createdAt: string;
}

/**
 * Comment thread for an envelope. Sender posts via dashboard session;
 * recipient posts via the signing ceremony's `addCommentRecipientAction`.
 * Both sides see the full thread in chronological order. Posts get
 * audit-chain entries (`comment.added`) so the body is tamper-evidently
 * preserved alongside the rest of the envelope's history.
 */
export function CommentsPanel({
  envelopeId, comments,
}: {
  envelopeId: string;
  currentUserId: string;
  comments: CommentRow[];
}) {
  const [state, action] = useActionState(addCommentSenderAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [bodyValue, setBodyValue] = useState('');

  useEffect(() => {
    if (state.ok && formRef.current) {
      formRef.current.reset();
      setBodyValue('');
    }
  }, [state]);

  return (
    <div className="rounded-lg border border-hairline bg-surface">
      <div className="px-4 py-3 border-b border-hairline">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Discussion</h2>
        <p className="mt-1 text-[11px] text-ink-tertiary">
          Visible to the sender and every recipient. Each post is signed into the audit chain.
        </p>
      </div>
      <ul className="px-4 py-3 flex flex-col gap-3 max-h-[420px] overflow-y-auto">
        {comments.length === 0 ? (
          <li className="text-[12.5px] text-ink-tertiary text-center py-4">
            No comments yet.
          </li>
        ) : comments.map((c) => (
          <li key={c.id} className={c.isOwnPost ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
            <div className={`max-w-[88%] rounded-md px-3 py-2 text-[12.5px] leading-snug ${
              c.isOwnPost
                ? 'bg-accent-soft/60 border border-accent/20 text-ink'
                : 'bg-surface-muted border border-hairline text-ink'
            }`}>
              <p className="text-[10.5px] font-mono uppercase tracking-[0.06em] text-ink-tertiary mb-1">
                {c.authorName}{c.isSender ? ' · sender' : ' · recipient'}
              </p>
              <p className="whitespace-pre-wrap break-words">{c.body}</p>
            </div>
            <p className="mt-1 text-[10.5px] text-ink-tertiary">
              {new Date(c.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </p>
          </li>
        ))}
      </ul>
      <form ref={formRef} action={action} className="px-4 py-3 border-t border-hairline space-y-2">
        <input type="hidden" name="envelopeId" value={envelopeId} />
        <textarea
          name="body"
          rows={2}
          required
          maxLength={4000}
          placeholder="Add a note for recipients…"
          value={bodyValue}
          onChange={(e) => setBodyValue(e.currentTarget.value)}
          className="w-full px-3 py-2 rounded-md border border-hairline bg-surface text-[13px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
        />
        {state.error && <p className="text-[12px] text-status-declined">{state.error}</p>}
        <div className="flex justify-end">
          <SubmitBtn disabled={!bodyValue.trim()} />
        </div>
      </form>
    </div>
  );
}

function SubmitBtn({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex h-8 items-center px-3 rounded-md bg-accent text-[12.5px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Posting…' : 'Post'}
    </button>
  );
}
