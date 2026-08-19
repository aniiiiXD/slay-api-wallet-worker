import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Port 5173 is not incidental: the extension's vendor methods
 * (slay_listConnections / slay_revokeConnection) are callable only from
 * allow-listed origins, and `http://localhost:5173` is the dev entry on
 * that list. Changing the port silently breaks the Connections page.
 */

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
