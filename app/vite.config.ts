import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev -w @danka/app`, API and WebSocket calls go to the local room server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
      '/j': 'http://127.0.0.1:8787',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
