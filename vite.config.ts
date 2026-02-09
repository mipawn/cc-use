import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { resolve } from "path";

const alias = {
  "@main": resolve(__dirname, "src/main"),
  "@renderer": resolve(__dirname, "src/renderer"),
  "@shared": resolve(__dirname, "src/shared"),
  "@preload": resolve(__dirname, "src/preload"),
};

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: "src/main/index.ts",
        onstart(args) {
          args.startup();
        },
        vite: {
          resolve: { alias },
          build: {
            outDir: "dist-electron/main",
            rollupOptions: {
              external: ["better-sqlite3"],
            },
          },
        },
      },
      preload: {
        input: "src/preload/index.ts",
        onstart(args) {
          args.reload();
        },
        vite: {
          resolve: { alias },
          build: {
            outDir: "dist-electron/preload",
          },
        },
      },
    }),
  ],
  resolve: {
    alias,
  },
  build: {
    outDir: "dist",
  },
});
