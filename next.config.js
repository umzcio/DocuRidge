/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/DocuRidge',
  assetPrefix: '/DocuRidge',
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
      // Trust the public origin behind nginx.
      // Server Actions check the Origin/Host headers against this allowlist.
      // Add your production hostname here (e.g. 'docs.example.com').
      allowedOrigins: [
        'localhost:3737',
        '127.0.0.1:3737',
        'docuridge_app:3000',
      ],
    },
  },
  // The app sits behind nginx. Honor X-Forwarded-Proto for secure-cookie decisions
  // and X-Forwarded-Host for absolute-URL building. Next.js consults `x-forwarded-*`
  // automatically for `headers()` lookup; we add a runtime trust policy in middleware.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // CSP: tightened later as components stabilize. Allows self + inline-style for shadcn.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
