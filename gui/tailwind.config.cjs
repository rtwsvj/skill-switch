/** @type {import('tailwindcss').Config} */
module.exports = {
  // 黑暗模式:class 策略,由 ThemeProvider 在 <html> 上切换 .dark
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // ── 保留原有项目色系 ──────────────────────────────────
      colors: {
        coal: '#14130f',
        iron: '#1d1b16',
        brass: '#d89924',
        verdigris: '#24b8a6',
        signal: '#ef4444',
        parchment: '#f0e6d1',
        // ── shadcn/ui CSS 变量语义色 ─────────────────────────
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        // ── 语义扩展(good/warn/danger) ─────────────────────
        good: {
          DEFAULT: 'hsl(var(--good))',
          foreground: 'hsl(var(--good-foreground))',
        },
        warn: {
          DEFAULT: 'hsl(var(--warn))',
          foreground: 'hsl(var(--warn-foreground))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          foreground: 'hsl(var(--danger-foreground))',
        },
      },
      fontFamily: {
        console: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        body: ['Aptos', 'Segoe UI', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        insetLine: 'inset 0 1px 0 rgb(255 255 255 / 0.06)',
        card: 'var(--shadow-card)',
        dialog: 'var(--shadow-dialog)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.18s ease',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
