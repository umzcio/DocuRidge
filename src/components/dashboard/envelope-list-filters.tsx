'use client';

import { useState } from 'react';
import { Select } from '@/components/ui/select';
import type { EnvelopeStatus } from '@prisma/client';

const ALL_STATUSES: EnvelopeStatus[] = [
  'DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED',
];

/**
 * Client-side filter pickers for the envelope list. Renders styled
 * Select widgets and auto-submits the wrapping form whenever a value
 * changes, so the page reloads with the new query string.
 */
export function EnvelopeListFilters({
  showStatus, statusValue, sortValue,
}: {
  showStatus: boolean;
  statusValue: string;
  sortValue: string;
}) {
  const [status, setStatus] = useState(statusValue);
  const [sort, setSort] = useState(sortValue);

  function commit(name: string, value: string) {
    if (typeof document === 'undefined') return;
    const form = document.querySelector<HTMLFormElement>('form[data-envelope-filters]');
    if (!form) return;
    // Update the matching hidden input then submit. Letting the browser
    // round-trip the GET keeps URL state and back/forward behavior intact.
    let input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
    form.requestSubmit();
  }

  return (
    <>
      {showStatus && (
        <div className="w-[180px]">
          <Select
            value={status}
            onChange={(v) => { setStatus(v); commit('status', v); }}
            ariaLabel="Filter by status"
            options={[
              { value: '', label: 'All statuses' },
              ...ALL_STATUSES.map((s) => ({
                value: s,
                label: s.replace('_', ' ').toLowerCase(),
              })),
            ]}
          />
        </div>
      )}
      <div className="w-[180px]">
        <Select
          value={sort}
          onChange={(v) => { setSort(v); commit('sort', v); }}
          ariaLabel="Sort"
          options={[
            { value: 'recent', label: 'Recently updated' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
      </div>
    </>
  );
}
