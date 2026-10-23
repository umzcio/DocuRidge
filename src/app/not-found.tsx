import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-muted">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you tried to load doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
        >
          Return home
        </Link>
      </div>
    </div>
  );
}
