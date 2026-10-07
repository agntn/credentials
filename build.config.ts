import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      /** One bundle, so every subpath shares the cf session cache with the root. */
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/cloudflare.ts",
        "./src/gitea.ts",
        "./src/github.ts",
        "./src/gitlab.ts",
      ],
    },
  ],
});
