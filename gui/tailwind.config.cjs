/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        coal: '#14130f',
        iron: '#1d1b16',
        brass: '#d89924',
        verdigris: '#24b8a6',
        signal: '#ef4444',
        parchment: '#f0e6d1',
      },
      fontFamily: {
        console: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        body: ['Aptos', 'Segoe UI', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        insetLine: 'inset 0 1px 0 rgb(255 255 255 / 0.06)',
      },
    },
  },
  plugins: [],
};
