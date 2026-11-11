import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      /** One bundle, so every entry shares the cf session cache with the root. */
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/bitbucket.ts",
        "./src/cloudflare.ts",
        "./src/gitea.ts",
        "./src/gitee.ts",
        "./src/github.ts",
        "./src/gitlab.ts",
        "./src/sourcehut.ts",
        "./src/cli.ts",
        "./src/ai.ts",
        "./src/mcp.ts",
        "./src/tools.ts",
      ],
      /** No maps: the JS ones miss every throw, the type ones point at a src/ we don't ship. */
      dts: { sourcemap: false },
    },
  ],
});
