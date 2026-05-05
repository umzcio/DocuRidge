import type { Config } from 'tailwindcss';

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
        // Neutral palette + single accent.
        // Accent is a desaturated blue/teal — trustworthy, not "AI gradient."
        accent: {
          50: '#f1f7f7',
          100: '#dbecec',
          200: '#bcdada',
          300: '#90c2c2',
          400: '#5fa1a1',
          500: '#3d8585',
          600: '#2d6a6c',
          700: '#265558',
          800: '#214548',
          900: '#1d393c',
          950: '#0f2225',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
      },
      borderRadius: {
        lg: '0.5rem',
        md: '0.375rem',
        sm: '0.25rem',
      },
    },
  },
  plugins: [],
};

export default config;
