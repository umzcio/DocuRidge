import { unstable_rethrow } from 'next/navigation';
import type { CreateEnvelopeState } from '@/app/dashboard/envelopes/new/actions';

/** An interrupted response can leave an envelope created or sent on the server. */
export type EnvelopeSubmissionState = CreateEnvelopeState & { outcomeUnknown?: boolean };
type Invoke = (previous: CreateEnvelopeState, data: FormData) => Promise<CreateEnvelopeState>;

// Match next.config.js, reserving room for React's action encoding and multipart headers.
const REQUEST_LIMIT = 50 * 1024 * 1024;
const ENCODING_RESERVE = 1024 * 1024;

export async function submitEnvelopeSafely(previous: EnvelopeSubmissionState, data: FormData, invoke: Invoke): Promise<EnvelopeSubmissionState> {
  if (previous.outcomeUnknown) return previous;

  const encoder = new TextEncoder();
  let bytes = ENCODING_RESERVE;
  for (const [name, value] of data.entries()) {
    // Header names/filenames may be escaped; reserve three bytes per UTF-8 byte.
    bytes += 1024 + 3 * encoder.encode(name).byteLength;
    bytes += typeof value === 'string'
      ? encoder.encode(value.replace(/\r\n|\r|\n/g, '\r\n')).byteLength
      : value.size + 3 * encoder.encode(value.name).byteLength;
    if (bytes >= REQUEST_LIMIT) {
      return { ok: false, error: 'The combined upload size is too large. Reduce the total PDF size below 49 MB or send fewer documents together.' };
    }
  }

  try {
    return await invoke(previous, data);
  } catch (error) {
    // Successful server actions redirect by throwing a framework control-flow error.
    unstable_rethrow(error);
    return {
      ok: false,
      outcomeUnknown: true,
      error: 'The server response was interrupted. Your documents and fields are still here. Check the dashboard in another tab before you retry; the envelope may already have been saved or sent.',
    };
  }
}
