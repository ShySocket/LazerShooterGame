import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

/** Short commit hash baked into the bundle, so a shot-feedback sample says which build produced it. */
function appCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// VITE_BASE lets the same build deploy to GitHub Pages (/RepoName/) or Vercel (/).
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? '/',
  define: { __APP_COMMIT__: JSON.stringify(appCommit()) },
  plugins: [
    react(),
    // Self-signed HTTPS in dev so phones on the same Wi-Fi can open the camera.
    // VITE_HTTPS=0 gives plain HTTP for localhost-only testing (localhost is a secure context anyway).
    ...(command === 'serve' && process.env.VITE_HTTPS !== '0' ? [basicSsl()] : []),
    VitePWA({
      // 'prompt' never reloads on its own; src/pwa.ts applies updates only while idle on the home screen.
      registerType: 'prompt',
      manifest: {
        name: 'Lazer Shooter',
        short_name: 'Lazer',
        description: 'Real-life laser tag with your phone camera.',
        theme_color: '#0b0f1a',
        background_color: '#0b0f1a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico}'],
        globIgnores: ['models/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/models\/.*\.(json|bin)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'vision-models', expiration: { maxEntries: 24 } },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: Number(process.env.PORT ?? 5173) },
  build: { chunkSizeWarningLimit: 3000 },
}));
