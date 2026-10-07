import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
    }
  },
  {
    // The chassis never names a tool: a `packages/chassis-*` package is the
    // generic half, consumed BY a tool's packages and never the reverse. A
    // consumer's internal scope (`@app/*` in the template and the tools built
    // from it, `@slideless/*` in Slideless) is unreachable from here.
    files: ['packages/chassis-*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@app/*', '@slideless/*'],
              message:
                'The chassis never names the tool: packages/chassis-* may not import a consumer package (the tool depends on the chassis, never the reverse).'
            }
          ]
        }
      ]
    }
  },
  {
    // The chassis client and the chassis CLI are the client side of the
    // split: no database layer, no routes entry (it pulls Hono), no server.
    files: ['packages/chassis-sdk/src/**/*.ts', 'packages/chassis-cli/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@app/*', '@slideless/*'],
              message:
                'The chassis never names the tool: packages/chassis-* may not import a consumer package (the tool depends on the chassis, never the reverse).'
            },
            {
              group: ['@antasphere/chassis-db', '@antasphere/chassis-db/*'],
              message: 'Clients never touch the database layer.'
            },
            {
              group: ['@antasphere/chassis-contract/routes', '@antasphere/chassis-contract/routes/*'],
              message: 'The routes entry pulls Hono — clients import the contract root only.'
            },
            {
              group: ['@antasphere/chassis-server', '@antasphere/chassis-server/*'],
              message: 'The chassis server is server-side code — clients never import it.'
            }
          ]
        }
      ]
    }
  }
);
