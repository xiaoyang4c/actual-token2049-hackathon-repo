// Google TypeScript Style Guide, enforced where an ESLint rule exists:
// https://google.github.io/styleguide/tsguide.html
//
// Error-level lint applies to app code only:
//   packages/**, services/**, and ui/**
// cre/agent-loop is ignored until that workflow branch freezes. It still uses
// explicit `any` and is not restyled by this config.
//
// Identifier rules follow the style guide's naming table. Object and type
// properties may also be snake_case because the policy shell and venue
// payloads are external JSON contracts; renaming them would change trading
// behavior. Quoted keys (route paths, HTTP headers) are not identifiers.
import eslint from "@eslint/js"
import tseslint from "typescript-eslint"

const appFiles = [
  "packages/**/*.{ts,tsx}",
  "services/**/*.{ts,tsx}",
  "ui/**/*.{ts,tsx}",
]

const tsxFiles = ["packages/**/*.tsx", "services/**/*.tsx", "ui/**/*.tsx"]

// Component functions in TSX are UpperCamelCase. Elsewhere, variables and
// functions stay lowerCamelCase (module-level constants may be CONSTANT_CASE).
const namingConvention = ({ tsxComponents = false, pascalRecordKeys = false } = {}) => [
  "error",
  {
    selector: "variable",
    format: tsxComponents ? ["camelCase", "UPPER_CASE", "PascalCase"] : ["camelCase", "UPPER_CASE"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
  },
  {
    selector: "function",
    format: tsxComponents ? ["camelCase", "PascalCase"] : ["camelCase"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
    filter: {
      regex: "^[A-Za-z_][A-Za-z0-9_]*$",
      match: true,
    },
  },
  {
    // Quoted method names are route-table keys (`"GET /wallet"`), not identifiers.
    selector: ["parameter", "method", "accessor"],
    format: ["camelCase"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
    filter: {
      regex: "^[A-Za-z_][A-Za-z0-9_]*$",
      match: true,
    },
  },
  {
    // Module alias and named imports. Type imports are UpperCamelCase.
    selector: "import",
    format: ["camelCase", "PascalCase"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
  },
  {
    // class / interface / type / enum / type parameters
    selector: "typeLike",
    format: ["PascalCase"],
  },
  {
    selector: "enumMember",
    format: ["UPPER_CASE"],
  },
  {
    selector: ["classProperty", "parameterProperty"],
    format: ["camelCase"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
  },
  {
    selector: "typeProperty",
    format: ["camelCase", "snake_case"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
    filter: {
      regex: "^[A-Za-z_][A-Za-z0-9_]*$",
      match: true,
    },
  },
  {
    // Quoted keys (headers, paths, multi-word labels) are not identifiers.
    // PascalCase is only enabled for records whose keys are an external vocabulary.
    selector: "objectLiteralProperty",
    format: pascalRecordKeys ? ["camelCase", "snake_case", "PascalCase"] : ["camelCase", "snake_case"],
    leadingUnderscore: "forbid",
    trailingUnderscore: "forbid",
    filter: {
      regex: "^[A-Za-z_][A-Za-z0-9_]*$",
      match: true,
    },
  },
]

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "services/.data/**",
      "cre/agent-loop/**",
    ],
  },
  {
    files: appFiles,
    extends: [eslint.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // `any` Type: https://google.github.io/styleguide/tsguide.html#any-type
      "@typescript-eslint/no-explicit-any": "error",

      // Visibility: never write `public`; mark private and protected explicitly.
      // https://google.github.io/styleguide/tsguide.html#visibility
      "@typescript-eslint/explicit-member-accessibility": [
        "error",
        { accessibility: "no-public" },
      ],

      // Modules, not namespaces.
      // https://google.github.io/styleguide/tsguide.html#use-modules-not-namespaces
      "@typescript-eslint/no-namespace": "error",

      // Identifiers: https://google.github.io/styleguide/tsguide.html#naming-style
      // and https://google.github.io/styleguide/tsguide.html#identifiers
      "@typescript-eslint/naming-convention": namingConvention(),

      // Exports: named exports only, and no mutable `export let`.
      // https://google.github.io/styleguide/tsguide.html#exports
      "no-restricted-exports": [
        "error",
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportNamedDeclaration[declaration.kind='let'], ExportNamedDeclaration[declaration.kind='var']",
          message:
            "Mutable exports are disallowed (Google TypeScript style). Export a getter instead of `export let` or `export var`.",
        },
        {
          selector: "PrivateIdentifier",
          message:
            "Private identifiers (`#field`) are disallowed (Google TypeScript style). Use the `private` modifier.",
        },
      ],
    },
  },
  {
    // Component functions in TSX are UpperCamelCase.
    // https://google.github.io/styleguide/tsguide.html#identifiers
    files: tsxFiles,
    rules: {
      "@typescript-eslint/naming-convention": namingConvention({ tsxComponents: true }),
    },
  },
  {
    // Kalshi labels and Masumi wire fields (Amounts) are external keys.
    files: ["packages/core/src/venues/kalshi.ts", "services/cardano-agents-ts/masumi.ts", "services/reliability/contract-masumi-escrow.ts", "services/reliability/contract-fake-mps.ts", "services/reliability/mps-seller.ts", "services/reliability/coworker-worker.test.ts"],
    rules: {
      "@typescript-eslint/naming-convention": namingConvention({ pascalRecordKeys: true }),
    },
  },
)
