import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      devtools: "src/devtools.ts",
    },
    format: ["esm"],
    dts: true,
  },
  {
    entry: {
      cli: "src/cli.ts",
    },
    format: ["esm"],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
