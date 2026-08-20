import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      // The IPC boundary hands back `unknown`; narrowing it is the point of the bridge module,
      // and an explicit cast there is the narrowing.
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  { ignores: ["dist/**", "node_modules/**", "*.config.js"] },
);
