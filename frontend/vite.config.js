import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// StreamFlix web client. Talks to the API over VITE_API_BASE_URL (baked in at build time,
// same convention the backend uses for its own env) — never proxied through this server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
});
