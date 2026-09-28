import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    // Plain ESM run directly by node. TypeScript files do not need this: type-aware
    // linting turns `no-undef` off, because tsc already reports unknown identifiers.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Type-aware linting is confined to .ts files: this config file itself is not part of
    // any tsconfig, and the project service errors rather than skipping when asked to
    // resolve a file it cannot find.
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Tuple/array indexing in the projection maths is provably in range, and
      // `noUncheckedIndexedAccess` already forces the assertion to be written.
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Test doubles routinely return a resolved value without awaiting anything.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Demos are browser glue, not library code.
    files: ['demo/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
