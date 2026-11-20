import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        cpu8bit: resolve(__dirname, "cpu8bit/index.html"),
      },
    },
  },
});
