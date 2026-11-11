import oxfmt from "@agntn/ox/oxfmt";
import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ...oxfmt, ignorePatterns: ["dist"] },
  lint: {
    ...oxlint,
    rules: {
      ...oxlint.rules,
      "typescript/prefer-readonly-parameter-types": [
        "error",
        {
          /* A probe carries the response Headers; nothing writes to them. */
          allow: [
            { from: "file", name: ["Probe"] },
            {
              from: "package",
              name: ["ExtensionAPI"],
              package: "@earendil-works/pi-coding-agent",
            },
            { from: "package", name: ["ExtensionAPI"], package: "@oh-my-pi/pi-coding-agent" },
          ],
          ignoreInferredTypes: true,
        },
      ],
    },
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
    setupFiles: ["./test/setup.ts"],
  },
});
