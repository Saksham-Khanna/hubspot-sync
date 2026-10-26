import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, /api is proxied to the backend so the session cookie is same-origin, exactly like in
// production where vercel.json rewrites /api/* to the backend.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.VITE_BACKEND_URL ?? 'http://localhost:3000', changeOrigin: false } } },
});
