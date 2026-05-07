'use client';

import { useActionState, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { moveEnvelopeToFolderAction, type FolderActionState } from '@/app/dashboard/folders/actions';

const initial: FolderActionState = { ok: false };

/**
 * Detail-page picker for moving an envelope into / out of a folder. Renders
 * a dropdown of every org-scoped folder (passed in by the server) plus a
 * "(no folder)" option at the top. Selection submits the move action and
 * refreshes the page on success.
 */
export function FolderPicker({
  envelopeId,
  currentFolderId,
  folders,
}: {
  envelopeId: string;
  currentFolderId: string | null;
  folders: Array<{ id: string; name: string }>;
}) {
  const [state, action] = useActionState(moveEnvelopeToFolderAction, initial);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = folders.find((f) => f.id === currentFolderId);

  useEffect(() => {
    if (state.ok && state.success) {
      setFeedback(state.success);
      setOpen(false);
      router.refresh();
    }
    if (state.error) setFeedback(state.error);
  }, [state, router]);
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(t);
  }, [feedback]);
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60 transition-colors"
        title="Move this envelope to a folder"
      >
        <FolderIcon />
        {current ? current.name : 'Move'}
        <ChevronDown />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border border-hairline bg-surface shadow-[0_8px_24px_rgba(15,17,21,0.12)] py-1">
          <FolderRow
            envelopeId={envelopeId}
            folderId={null}
            label="(no folder)"
            isActive={!currentFolderId}
            action={action}
          />
          {folders.length > 0 && <div className="my-1 border-t border-hairline" />}
          {folders.map((f) => (
            <FolderRow
              key={f.id}
              envelopeId={envelopeId}
              folderId={f.id}
              label={f.name}
              isActive={currentFolderId === f.id}
              action={action}
            />
          ))}
          {folders.length === 0 && (
            <p className="px-3 py-2 text-[11.5px] text-ink-tertiary">
              No folders yet. Create one in the sidebar.
            </p>
          )}
        </div>
      )}
      {feedback && (
        <span className="absolute right-0 top-full mt-1 text-[11px] text-status-completed whitespace-nowrap">
          ✓ {feedback}
        </span>
      )}
    </div>
  );
}

function FolderRow({
  envelopeId, folderId, label, isActive, action,
}: {
  envelopeId: string;
  folderId: string | null;
  label: string;
  isActive: boolean;
  action: (formData: FormData) => void;
}) {
  return (
    <form action={action} className="contents">
      <input type="hidden" name="envelopeId" value={envelopeId} />
      <input type="hidden" name="folderId" value={folderId ?? ''} />
      <button
        type="submit"
        className={`w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 ${
          isActive ? 'bg-surface-muted/60 text-ink font-medium' : 'text-ink hover:bg-surface-muted/60'
        }`}
      >
        {isActive ? <CheckSm /> : <span className="w-3" />}
        <span className="flex-1 truncate">{label}</span>
      </button>
    </form>
  );
}

function FolderIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>);
}
function ChevronDown() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>);
}
function CheckSm() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>);
}
