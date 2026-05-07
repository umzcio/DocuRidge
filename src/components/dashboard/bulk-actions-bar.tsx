'use client';

import { useEffect, useState } from 'react';
import { bulkVoidAction, bulkDeleteDraftsAction } from '@/app/dashboard/envelopes/[id]/actions';
import { useEscape } from '@/lib/use-escape';

/**
 * Bulk-action toolbar for the envelope list. Reads selected envelope ids
 * from sibling `<input type="checkbox" name="ids" form="bulk-form">`
 * elements via a `change` listener and a select-all link. Buttons submit
 * the form to different server actions via the `formAction` attribute,
 * so a single form drives multiple actions without React server-action
 * imports here (form actions can be string paths handled via the parent
 * server-rendered `<form action={...}>`).
 *
 * Why DOM-driven: the envelope list is a server component and we don't
 * want to refactor the whole list to client just to add selection state.
 * A change listener on the form gives us the selected count cheaply.
 */
export function BulkActionsBar() {
  const [count, setCount] = useState(0);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    function recompute() {
      const form = document.getElementById('bulk-form') as HTMLFormElement | null;
      if (!form) return setCount(0);
      const checked = form.querySelectorAll('input[name="ids"]:checked');
      setCount(checked.length);
    }
    recompute();
    const handler = () => recompute();
    document.addEventListener('change', handler);
    return () => document.removeEventListener('change', handler);
  }, []);

  function setAll(checked: boolean) {
    const form = document.getElementById('bulk-form') as HTMLFormElement | null;
    if (!form) return;
    const inputs = form.querySelectorAll<HTMLInputElement>('input[name="ids"]');
    inputs.forEach((el) => { el.checked = checked; });
    const event = new Event('change', { bubbles: true });
    form.dispatchEvent(event);
  }

  if (count === 0) return null;

  return (
    <div className="sticky top-0 z-20 mb-3 -mx-4 sm:mx-0 px-4 sm:rounded-md bg-canvas text-white border border-canvas-line shadow-[0_4px_12px_rgba(15,17,21,0.18)] py-2.5 flex items-center gap-3">
      <span className="text-[12.5px] font-medium font-mono tabular-nums">
        {count} selected
      </span>
      <button
        type="button"
        onClick={() => setAll(false)}
        className="text-[11.5px] text-white/70 hover:text-white"
      >
        Clear
      </button>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => setShowVoidConfirm(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-canvas-line bg-canvas-edge px-3 text-[12.5px] font-medium text-white hover:bg-canvas-line transition-colors"
      >
        <VoidIcon /> Void
      </button>
      <button
        type="button"
        onClick={() => setShowDeleteConfirm(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-status-declined bg-status-declined/30 px-3 text-[12.5px] font-medium text-white hover:bg-status-declined/45 transition-colors"
      >
        <TrashIcon /> Delete drafts
      </button>
      {/* Hidden submit buttons — confirm dialogs trigger these via .click()
          so the chosen server action runs against the bulk-form's selected
          ids. Buttons live INSIDE the toolbar so they participate in the
          form via the `form="bulk-form"` association. */}
      <button
        type="submit"
        form="bulk-form"
        formAction={bulkVoidAction}
        data-bulk-submit-void
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        type="submit"
        form="bulk-form"
        formAction={bulkDeleteDraftsAction}
        data-bulk-submit-delete
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {showVoidConfirm && (
        <ConfirmDialog
          title={`Void ${count} envelope${count === 1 ? '' : 's'}?`}
          body="In-progress envelopes will be moved to VOIDED. Anything not in SENT / IN_PROGRESS will be skipped. This is recorded in the audit chain."
          confirmLabel="Void selected"
          danger
          onConfirm={() => {
            setShowVoidConfirm(false);
            const form = document.getElementById('bulk-form') as HTMLFormElement | null;
            if (form) (form.querySelector('button[data-bulk-submit-void]') as HTMLButtonElement | null)?.click();
          }}
          onCancel={() => setShowVoidConfirm(false)}
        />
      )}
      {showDeleteConfirm && (
        <ConfirmDialog
          title={`Delete drafts?`}
          body="Soft-deletes any drafts in your selection. Sent or completed envelopes are skipped — those need to be voided."
          confirmLabel="Delete drafts"
          danger
          onConfirm={() => {
            setShowDeleteConfirm(false);
            const form = document.getElementById('bulk-form') as HTMLFormElement | null;
            if (form) (form.querySelector('button[data-bulk-submit-delete]') as HTMLButtonElement | null)?.click();
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  title, body, confirmLabel, danger, onConfirm, onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscape(onCancel);
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-canvas/40 backdrop-blur-sm flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-[420px] rounded-lg border border-hairline bg-surface text-ink shadow-[0_24px_48px_rgba(15,17,21,0.18)]">
        <div className="px-5 pt-5 pb-3 border-b border-hairline">
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <p className="mt-1 text-[12.5px] text-ink-secondary">{body}</p>
        </div>
        <div className="px-5 py-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center px-3 rounded-md border border-hairline bg-surface text-[13px] font-medium hover:bg-surface-muted/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              danger
                ? 'inline-flex h-9 items-center px-4 rounded-md bg-status-declined text-white text-[13px] font-medium hover:brightness-110'
                : 'inline-flex h-9 items-center px-4 rounded-md bg-accent text-white text-[13px] font-medium border border-accent-deep hover:bg-accent-deep'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function VoidIcon() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>);
}
function TrashIcon() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>);
}
