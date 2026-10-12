import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [react()]),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
  },
  fmt: {
    arrowParens: "always",
    bracketSpacing: true,
    endOfLine: "lf",
    ignorePatterns: ["pnpm-lock.yaml"],
    insertFinalNewline: true,
    printWidth: 100,
    semi: true,
    singleQuote: false,
    sortImports: {
      groups: [
        ["value-builtin"],
        ["value-external"],
        ["value-internal"],
        ["value-parent", "value-sibling", "value-index"],
        ["type-import"],
        ["unknown"],
      ],
      newlinesBetween: true,
      order: "asc",
    },
    sortPackageJson: true,
    tabWidth: 2,
    trailingComma: "all",
    useTabs: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["vite.config.ts"],
        rules: {
          "sort-keys": "off",
        },
      },
    ],
  },
});
