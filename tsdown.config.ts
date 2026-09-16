import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",
  external: ["bun:sqlite"],

  sourcemap: true,
  clean: true,
  fixedExtension: false,
  nodeProtocol: false,

  env: {
    NODE_ENV: "production",
  },
})
