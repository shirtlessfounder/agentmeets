import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/adapters/types.ts",
    "src/adapters/detect-invite.ts",
    "src/adapters/fake-session.ts",
  ],
  format: "esm",
  target: "node18",
  outDir: "dist",
  clean: true,
});
