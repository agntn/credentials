import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      /** One bundle, so every entry shares the cf session cache with the root. */
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/cloudflare.ts",
        "./src/gitea.ts",
        "./src/github.ts",
        "./src/gitlab.ts",
        "./src/cli.ts",
        "./src/ai.ts",
        "./src/mcp.ts",
        "./src/tools.ts",
      ],
    },
  ],
});
