import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const API_TARGET = process.env.API_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: null,
      registerType: 'prompt',
      manifest: {
        name: 'Reichweite – Tank- & Ladestopp-Navigation',
        short_name: 'Reichweite',
        description:
          'Turn-by-Turn-Navigation mit automatischer Reichweiten-Überwachung und Vorschlägen für günstige Tankstellen und Ladesäulen entlang der Route.',
        lang: 'de',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0b1120',
        theme_color: '#0b1120',
        categories: ['navigation', 'travel', 'utilities'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false, type: 'module' },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) only accepts the function form. Mapbox and Supabase
        // are large and change far less often than app code, so splitting them
        // out keeps them cached across deploys.
        manualChunks(id: string) {
          if (id.includes('node_modules/mapbox-gl')) return 'mapbox';
          if (id.includes('node_modules/@supabase')) return 'supabase';
          return null;
        },
      },
    },
  },
});
