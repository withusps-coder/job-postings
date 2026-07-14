import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "_site/**",
      "node_modules/**",
      ".wrangler/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
        ...globals.serviceworker,
      },
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "no-undef": "error",
    },
  },
  {
    files: [
      "src/assets/scripts/**/*.js",
      "scripts/capture-public-qa.mjs",
      "tests/e2e/**/*.mjs",
    ],
    languageOptions: { globals: globals.browser },
  },
];
