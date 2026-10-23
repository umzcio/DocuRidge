'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { startBulkSendAction, type BulkSendActionState } from '@/app/dashboard/bulk-send/actions';

const initial: BulkSendActionState = { ok: false };

export function BulkLauncherForm({ templateId }: { templateId: string }) {
  const [state, action] = useActionState(startBulkSendAction, initial);
  return (
    <form action={action} encType="multipart/form-data" className="mt-6 rounded-lg border border-border bg-card p-5 space-y-4">
      <input type="hidden" name="templateId" value={templateId} />
      <label className="block">
        <span className="block text-[12px] font-medium text-muted-foreground mb-1">CSV file</span>
        <input
          type="file"
          name="csv"
          accept=".csv,text/csv"
          required
          className="w-full text-[13px] text-foreground file:inline-flex file:h-9 file:items-center file:px-3 file:rounded-md file:border file:border-border file:bg-card file:text-[13px] file:font-medium file:text-foreground hover:file:bg-muted/60 file:mr-3"
        />
      </label>
      {state.error && (
        <p className="text-[12.5px] text-destructive">{state.error}</p>
      )}
      <div className="flex items-center justify-end">
        <SubmitBtn />
      </div>
    </form>
  );
}

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Starting…' : 'Start bulk send'}
    </button>
  );
}
