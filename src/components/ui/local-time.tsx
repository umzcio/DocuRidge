'use client';

import { useEffect, useState } from 'react';

/**
 * Renders a timestamp in the viewer's local timezone. Avoids the trap of
 * server-side `toLocaleString` which uses the container's TZ (UTC) and shows
 * misleading clock time to users in other zones. The server emits UTC as a
 * stable initial render; on hydration we re-format with the browser's locale.
 */
export function LocalTime({
  iso,
  withSeconds = false,
}: {
  iso: string;
  withSeconds?: boolean;
}) {
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds && { second: '2-digit' }),
  };

  // SSR fallback: UTC. Hydration replaces with local TZ.
  const [text, setText] = useState<string>(() => {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' }) + ' UTC';
  });

  useEffect(() => {
    const d = new Date(iso);
    setText(d.toLocaleString(undefined, opts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso, withSeconds]);

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
