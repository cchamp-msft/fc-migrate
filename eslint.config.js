import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

// This project has no format check. The Vue recommended set also enables the
// plugin's template layout rules, so they are switched off here, selected by
// the classification the plugin gives its own rules.
const vueLayoutRulesOff = Object.fromEntries(
  Object.entries(pluginVue.rules)
    .filter(([, rule]) => rule.meta?.type === "layout")
    .map(([name]) => [`vue/${name}`, "off"]),
);

export default defineConfig(
  globalIgnores(["**/dist/", "**/.wrangler/", "**/node_modules/", "**/.local/", "**/.claude/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: globals.browser,
    },
    rules: vueLayoutRulesOff,
  },
);
