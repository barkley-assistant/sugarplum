import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "data/**", "node_modules/**", "e2e/**", "test-results/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
      globals: {
        // Bun runtime + platform globals used across src, scripts, and tests.
        Bun: "readonly",
        HTMLRewriter: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        Headers: "readonly",
        console: "readonly",
        globalThis: "readonly",
        atob: "readonly",
        btoa: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Buffer: "readonly",
        Event: "readonly",
        Error: "readonly",
        Date: "readonly",
        Promise: "readonly",
        Map: "readonly",
        Set: "readonly",
        // Browser globals (the SPA runs client-side).
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        HTMLElement: "readonly",
        Element: "readonly",
        Node: "readonly",
        // NodeJS namespace — used as a TypeScript type-only construct for
        // typing platform signals (NodeJS.Signals). It's not a runtime
        // global, but eslint's no-undef treats it as an unknown identifier
        // without this declaration.
        NodeJS: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        performance: "readonly",
        MutationObserver: "readonly",
        getComputedStyle: "readonly",
        matchMedia: "readonly",
        CustomEvent: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        NodeList: "readonly",
        HTMLCollection: "readonly",
        location: "readonly",
        history: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        FormData: "readonly",
        File: "readonly",
        Blob: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooks },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
];