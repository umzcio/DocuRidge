'use client';

import { useEffect } from 'react';

/**
 * Last-resort error boundary. The actual error message is NOT shown to the
 * user — Next surfaces a digest hash that maps back to the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server has already logged this through Pino on the route handler;
    // we only need a console hook for the client crash case.
    // eslint-disable-next-line no-console
    console.error('[error-boundary]', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-muted">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred. Our team has been notified.
        </p>
        {error.digest && (
          <p className="mt-3 text-xs text-faint">
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
