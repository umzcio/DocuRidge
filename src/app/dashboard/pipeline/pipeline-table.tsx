'use client';

import { useState } from 'react';
import { Select } from '@/components/ui/select';

/**
 * Client-side status picker for the pipeline filter bar. Renders the styled
 * Select and auto-submits the wrapping GET form on change, mirroring the
 * envelope-list filter idiom: URL state stays the source of truth and
 * back/forward navigation keeps working.
 */
export function PipelineStatusSelect({ value }: { value: string }) {
  const [status, setStatus] = useState(value);

  function commit(next: string) {
    if (typeof document === 'undefined') return;
    const form = document.querySelector<HTMLFormElement>('form[data-pipeline-filters]');
    if (!form) return;
    let input = form.querySelector<HTMLInputElement>('input[name="status"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'status';
      form.appendChild(input);
    }
    input.value = next;
    form.requestSubmit();
  }

  return (
    <div className="w-[200px]">
      <Select
        value={status}
        onChange={(v) => { setStatus(v); commit(v); }}
        ariaLabel="Filter by status"
        options={[
          { value: '', label: 'In progress (default)' },
          { value: 'SENT', label: 'sent' },
          { value: 'IN_PROGRESS', label: 'in progress' },
          { value: 'COMPLETED', label: 'completed' },
          { value: 'DECLINED', label: 'declined' },
          { value: 'VOIDED', label: 'voided' },
          { value: 'EXPIRED', label: 'expired' },
          { value: 'ALL', label: 'All (except drafts)' },
        ]}
      />
    </div>
  );
}
