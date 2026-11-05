import { defineConfig } from "astro/config";

import cloudflare from "@astrojs/cloudflare";

// API-only app (no pages): Webflow Cloud replaces CLOUD_MOUNT_PATH with the environment's mount path
// (/app on Johnston Motors) at build time.
export default defineConfig({
  base: "CLOUD_MOUNT_PATH",
  output: "server",
  // No forms or cookies here; every endpoint checks a webhook signature or bearer token. Astro's
  // same-origin check would refuse server-to-server POSTs that arrive without a JSON content type.
  security: { checkOrigin: false },
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
  }),
});
