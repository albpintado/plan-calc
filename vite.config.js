import { defineConfig } from 'vite';

const tailnetHosts = ['server.dolly-sailfin.ts.net', '.dolly-sailfin.ts.net'];

export default defineConfig({
  server: {
    host: true,
    allowedHosts: tailnetHosts,
  },
  preview: {
    host: true,
    allowedHosts: tailnetHosts,
  },
});
