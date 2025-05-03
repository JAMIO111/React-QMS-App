import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    open: {
      app: {
        name: "google chrome", // Try 'google chrome' if 'chrome' doesn't work
        arguments: ["http://localhost:5173/index.html"],
      },
    },
  },
});
