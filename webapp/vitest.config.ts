import { defineConfig } from "vitest/config";
import path from "path";
import swc from "unplugin-swc";

export default defineConfig({
  // unplugin-swc handles TypeScript's legacy (Stage 2) decorator semantics
  // (experimentalDecorators: true) via SWC, since Vite 8's Rolldown/Oxc
  // transformer does not support them. Without this, @ClientModel / @Property
  // decorators never fire and ModelRegistry remains empty.
  // oxc: false disables Vite 8's default Oxc transformer so SWC runs instead.
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: "es2020",
      },
      module: { type: "es6" },
    }),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./lib/sync-engine/__tests__/setup.ts"],
    include: ["./lib/sync-engine/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "@sync-engine": path.resolve(__dirname, "lib/sync-engine/core"),
    },
  },
});
