import oxfmt from "@agntn/ox/oxfmt";
import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ...oxfmt, ignorePatterns: ["dist", "/CHANGELOG.md"] },
  lint: {
    ...oxlint,
    rules: { ...oxlint.rules },
    overrides: [
      {
        /** Tests stub `execFile` with mutable host shapes and need no API docs. */
        files: ["test/**/*.ts"],
        rules: {
          "jsdoc/require-param": "off",
          "jsdoc/require-returns": "off",
          "typescript/prefer-readonly-parameter-types": "off",
        },
      },
    ],
    ignorePatterns: ["dist"],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
