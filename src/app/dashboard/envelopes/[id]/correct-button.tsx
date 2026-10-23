'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { correctEnvelopeAction, type CorrectEnvelopeState } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const initial: CorrectEnvelopeState = { ok: false };

export interface CorrectionRecipientRow {
  id: string;
  name: string;
  email: string;
  recipientRole: string;
  signingStatus: string;
}

/**
 * Envelope correction — fix routing mistakes on a sent envelope: replace or
 * remove recipients who haven't signed, add a recipient, or update the
 * message / expiration. Each operation is a separate <form> sharing one
 * server action; every change lands in the audit chain as `envelope.corrected`.
 */
export function CorrectButton({
  envelopeId,
  recipients,
  message,
  expiresAt,
}: {
  envelopeId: string;
  recipients: CorrectionRecipientRow[];
  message: string | null;
  expiresAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(correctEnvelopeAction, initial);
  const router = useRouter();

  useEffect(() => {
    if (state.ok && state.corrected) {
      toast.success(state.messageText ?? 'Envelope corrected.');
      router.refresh();
    }
  }, [state, router]);

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <PenIcon /> Correct
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Correct envelope</DialogTitle>
            <DialogDescription>
              Fix routing mistakes on a sent envelope — replace or remove recipients who
              haven&apos;t signed, add a recipient, or update the message and expiration.
              Every change is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4 space-y-5">
            {state.error && (
              <div role="alert" className="rounded-md border border-destructive-border bg-destructive-bg p-3 text-[13px] text-destructive">
                {state.error}
              </div>
            )}

            {/* Recipients — pending ones are replaceable/removable, signed ones are locked. */}
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Recipients</h3>
              <ul className="mt-2 space-y-2.5">
                {recipients.map((r) => (
                  <li key={r.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-foreground truncate">{r.name}</p>
                        <p className="text-[11.5px] text-faint truncate">
                          {r.email}
                          <span className="mx-1.5">·</span>
                          {r.recipientRole.replace(/_/g, ' ').toLowerCase()}
                        </p>
                      </div>
                      <span
                        className={`text-[11px] font-medium flex-shrink-0 ${
                          r.signingStatus === 'SIGNED' ? 'text-success' : 'text-muted-foreground'
                        }`}
                      >
                        {r.signingStatus === 'SIGNED'
                          ? 'Signed'
                          : r.signingStatus === 'NOT_SIGNED'
                            ? 'Awaiting signature'
                            : r.signingStatus.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </div>
                    {r.signingStatus === 'NOT_SIGNED' && (
                      <div className="mt-2.5 space-y-2">
                        <form action={formAction} className="flex items-end gap-2">
                          <input type="hidden" name="envelopeId" value={envelopeId} />
                          <input type="hidden" name="operation" value="replaceRecipient" />
                          <input type="hidden" name="recipientId" value={r.id} />
                          <label className="flex-1 min-w-0">
                            <span className="sr-only">Name</span>
                            <Input name="name" defaultValue={r.name} required className="h-8 text-[12.5px]" />
                          </label>
                          <label className="flex-[1.4] min-w-0">
                            <span className="sr-only">Email</span>
                            <Input name="email" type="email" defaultValue={r.email} required className="h-8 text-[12.5px]" />
                          </label>
                          <OpSubmit label="Replace" pendingLabel="Replacing…" />
                        </form>
                        <form action={formAction}>
                          <input type="hidden" name="envelopeId" value={envelopeId} />
                          <input type="hidden" name="operation" value="removeRecipient" />
                          <input type="hidden" name="recipientId" value={r.id} />
                          <RemoveSubmit />
                        </form>
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {/* Add recipient — appended at the end of the pending sequence. */}
              <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="envelopeId" value={envelopeId} />
                <input type="hidden" name="operation" value="addRecipient" />
                <label className="flex-1 min-w-[120px]">
                  <span className="block text-[11px] font-medium text-muted-foreground mb-1">Name</span>
                  <Input name="name" required className="h-8 text-[12.5px]" placeholder="Jane Doe" />
                </label>
                <label className="flex-[1.4] min-w-[160px]">
                  <span className="block text-[11px] font-medium text-muted-foreground mb-1">Email</span>
                  <Input name="email" type="email" required className="h-8 text-[12.5px]" placeholder="jane@example.edu" />
                </label>
                <label>
                  <span className="block text-[11px] font-medium text-muted-foreground mb-1">Role</span>
                  <select
                    name="role"
                    className="h-8 rounded-md border border-input bg-card px-2 text-[12.5px] text-foreground"
                    defaultValue="SIGNER"
                  >
                    <option value="SIGNER">Signer</option>
                    <option value="APPROVER">Approver</option>
                    <option value="WITNESS">Witness</option>
                    <option value="IN_PERSON_SIGNER">In-person signer</option>
                    <option value="CC">Receives a copy</option>
                  </select>
                </label>
                <OpSubmit label="Add" pendingLabel="Adding…" />
              </form>
            </section>

            {/* Message + expiration */}
            <form action={formAction} className="space-y-3">
              <input type="hidden" name="envelopeId" value={envelopeId} />
              <input type="hidden" name="operation" value="updateDetails" />
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                  Message to recipients
                </span>
                <Textarea name="message" defaultValue={message ?? ''} rows={3} className="mt-1.5" />
              </label>
              <label className="block w-fit">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                  Expiration date
                </span>
                <input
                  type="date"
                  name="expiration"
                  defaultValue={expiresAt ? expiresAt.slice(0, 10) : ''}
                  className="mt-1.5 h-10 rounded-md border border-input bg-card px-3 text-[13px] text-foreground"
                />
              </label>
              <div className="flex justify-end">
                <OpSubmit label="Save changes" pendingLabel="Saving…" primary />
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OpSubmit({
  label,
  pendingLabel,
  primary = false,
}: {
  label: string;
  pendingLabel: string;
  primary?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={primary ? 'primary' : 'secondary'} size="sm" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function RemoveSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-[12px] font-medium text-destructive hover:underline disabled:opacity-50"
    >
      {pending ? 'Removing…' : 'Remove recipient'}
    </button>
  );
}

function PenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    </svg>
  );
}
