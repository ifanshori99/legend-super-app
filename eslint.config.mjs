import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    ".worktrees/**",
    "**/dist/**",
    "**/.output/**",
    "**/.nitro/**",
    "**/.tanstack/**",
    "**/.turbo/**",
    "apps/web/src/routeTree.gen.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@starter/shared/core/server",
              message:
                "Server-only: tenant context is minted by the API, never in the web app.",
            },
          ],
        },
      ],
    },
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
]);
