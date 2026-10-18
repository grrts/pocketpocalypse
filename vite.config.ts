import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
} as any);
