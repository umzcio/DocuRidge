'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Toaster } from 'sonner';

/**
 * Global toast host, mounted once inside the root ThemeProvider.
 * Theme follows next-themes; like ThemeToggle we render nothing until
 * mounted so the resolved theme can't cause a hydration mismatch.
 */
export function AppToaster() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return null;
  return (
    <Toaster
      position="bottom-right"
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      toastOptions={{
        style: {
          background: 'var(--card)',
          color: 'var(--card-foreground)',
          border: '1px solid var(--border)',
        },
      }}
    />
  );
}
