import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: { viewport: { width: 1280, height: 800 }, baseURL: 'http://localhost:4173/' },
  webServer: { command: 'npm run build && npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 120_000 },
});
