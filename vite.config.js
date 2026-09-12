import { defineConfig } from 'vite';

const tailnetHosts = ['server.dolly-sailfin.ts.net', '.dolly-sailfin.ts.net'];
const canonicalHost = 'server.dolly-sailfin.ts.net';
const devPort = 5173;
const previewPort = 4174;

export default defineConfig({
  define: {
    __CANONICAL_HOST__: JSON.stringify(canonicalHost),
  },
  server: {
    host: true,
    port: devPort,
    strictPort: true,
    allowedHosts: tailnetHosts,
  },
  preview: {
    host: true,
    port: previewPort,
    strictPort: true,
    allowedHosts: tailnetHosts,
  },
});
