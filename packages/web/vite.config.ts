import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

/**
 * Development (spec sections 4 and 11.7). Open the dashboard at http://hydra.localhost:5173.
 * The gateway runs on the host on port 8080 with
 *   HYDRA_PUBLIC_URL=http://hydra.localhost:5173
 *   HYDRA_LIVE_URL=http://live.hydra.localhost:8080
 * The proxy keeps the Host and the Origin header of the browser (no changeOrigin), so the host
 * routing and the CSRF check of the gateway see the dashboard origin. The live view iframe loads
 * the live origin from the gateway directly.
 */
const GATEWAY = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@hydra/source', ...defaultClientConditions] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: false },
      '^/s/[^/]+/mcp': { target: GATEWAY, changeOrigin: false },
    },
  },
  // One bundle for an internal tool: react-dom, react-router, and zod are most of it.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1024 },
});
