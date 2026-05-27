import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
  },
  preview: {
    allowedHosts: [
      'jjewa.jayjalaram.co.in',
      'jjewaapi.jayjalaram.co.in',
      '182.16.16.28',
      'localhost',
    ],
  },
});
