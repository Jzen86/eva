import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // better-sqlite3 is a native addon. Where it cannot be built (no C++
      // toolchain), every database test dies at import time, which hides real
      // regressions behind environment noise. Node's built-in sqlite speaks
      // the same wire protocol and covers the API surface this project uses.
      "better-sqlite3": fileURLToPath(new URL("./test/shim/better-sqlite3.ts", import.meta.url)),
    },
  },
});
