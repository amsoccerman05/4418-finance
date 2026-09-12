import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  workers: 2,
  use: { baseURL: "http://127.0.0.1:4430" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4430 --strictPort",
    url: "http://127.0.0.1:4430",
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: "https://finance-test.supabase.invalid",
      VITE_SUPABASE_ANON_KEY: "test-public-key",
    },
  },
});
