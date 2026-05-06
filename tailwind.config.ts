import type { Config } from 'tailwindcss';

/**
 * Editorial Stationery — see DECISIONS.md D-037.
 *
 * Single accent (existing teal #265558) is kept as the brand spine; the rest
 * of the palette is paper-toned warm neutrals with muted, document-sympathetic
 * status colors. NO drop shadows, NO bright Tailwind status defaults.
 */
const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ─── Surfaces ───────────────────────────────────────────────────
        page: '#FAF7F2',           // warm off-white — body bg
        surface: '#FFFFFF',        // cards
        'surface-muted': '#F5F0E8', // tinted surface (hover, input bg)

        // ─── Text ──────────────────────────────────────────────────────
        ink: '#1A1A1A',
        'ink-secondary': '#5C5C5C',
        'ink-tertiary': '#8A8A8A',

        // ─── Hairlines ─────────────────────────────────────────────────
        hairline: '#E8E2D6',
        'hairline-strong': '#D4CDBE',

        // ─── Brand spine — sampled from /public/docuridge-icon.png ─────
        accent: {
          DEFAULT: '#2544FB',  // bright cobalt — the "Ridge" color
          deep: '#1A2FBF',     // hover / pressed
          soft: '#E5E9FF',     // tinted bg for accent banners
          ink: '#0A163F',      // headline-on-accent
        },
        // Deep navy — the "Docu" color, used for dark hero strips & auth panel.
        canvas: {
          DEFAULT: '#0A163F',
          edge: '#1A2855',
          line: '#2A3A6E',
        },

        // ─── Status palette (muted, paper-compatible) ──────────────────
        status: {
          'completed':        '#1F6F4A',
          'completed-bg':     '#E5EFE6',
          'completed-border': '#C4DBC8',
          'progress':         '#A06800',
          'progress-bg':      '#F4EAD2',
          'progress-border':  '#E4D4A8',
          'sent':             '#1F4F8A',
          'sent-bg':          '#E2EAF4',
          'sent-border':      '#C0CFE2',
          'draft':            '#6B5E40',
          'draft-bg':         '#EFEAE0',
          'draft-border':     '#DCD2BE',
          'declined':         '#9F1F2C',
          'declined-bg':      '#F2E0E2',
          'declined-border':  '#E2BDC1',
          'voided':           '#5A5A5A',
          'voided-bg':        '#EAEAEA',
          'voided-border':    '#CFCFCF',
        },
      },
      fontFamily: {
        // Inter for everything, JetBrains Mono for tabular/code.
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Modern sans type ramp. Inter is tightly tracked at large sizes.
        'label':      ['0.6875rem', { lineHeight: '1', letterSpacing: '0.12em' }],
        'meta':       ['0.8125rem', { lineHeight: '1.5' }],
        'body':       ['0.9375rem', { lineHeight: '1.6' }],
        'h2':         ['1.125rem',  { lineHeight: '1.4',  letterSpacing: '-0.012em' }],
        'h1':         ['1.5rem',    { lineHeight: '1.25', letterSpacing: '-0.022em' }],
        'display-2':  ['1.875rem',  { lineHeight: '1.15', letterSpacing: '-0.028em' }],
        'display-1':  ['2.5rem',    { lineHeight: '1.05', letterSpacing: '-0.034em' }],
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '6px',
        lg: '8px',
      },
      letterSpacing: {
        label: '0.18em',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 600ms ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
