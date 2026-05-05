export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-neutral-100">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">DocuRidge</h1>
          <p className="text-sm text-neutral-600">Acme Org</p>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}
