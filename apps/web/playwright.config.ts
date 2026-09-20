import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // The API caps registrations per IP/hour, defaulting to five in production.
  // This suite needs more than that (several signup-flow cases plus the
  // shared-account fixture), so apps/api/.env raises REGISTER_RATE_LIMIT_PER_HOUR
  // for local runs. Serial execution is kept so failures are readable and the
  // shared fixture is created once.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    // Playwright's own Chromium is a separate download. Set PLAYWRIGHT_CHANNEL=chrome
    // to run against installed Google Chrome instead. Unset in CI, which installs
    // the bundled browser, so the default is untouched there.
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  },
})
