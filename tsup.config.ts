import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/protocol.ts", "src/transition-policy.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
});
