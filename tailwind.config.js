/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      maxWidth: {
        page: '1200px',
        'page-sm': '800px',
      },
      borderRadius: {
        ant: '8px',
        'ant-lg': '12px',
      },
    },
  },
  plugins: [],
}
