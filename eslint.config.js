import js from '@eslint/js';
import typescript from 'typescript-eslint';

export default typescript.config(
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.ts', 'scripts/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**']
  },
  // Architecture enforcement: lib/ must have ZERO TENEX imports
  {
    files: ['src/lib/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@/services', '@/services/*', '@/utils', '@/utils/*', '@/nostr', '@/nostr/*', '@/agents', '@/agents/*', '@/tools', '@/tools/*', '@/llm', '@/llm/*', '@/conversations', '@/conversations/*', '@/events', '@/events/*', '@/daemon', '@/daemon/*', '@/commands', '@/commands/*', '@/prompts', '@/prompts/*'],
            message: 'lib/ must not import from TENEX-specific modules. Use only pure utilities from lib/, Node.js builtins, or third-party libraries. See docs/ARCHITECTURE.md for details.'
          }
        ]
      }]
    }
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
        allowDirectConstAssertionInArrowFunctions: true,
        allowConciseArrowFunctionExpressionsStartingWithVoid: true
      }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      'quotes': ['error', 'double', { avoidEscape: true }],
      'no-console': 'off',
      'no-debugger': 'error'
    }
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      'quotes': ['error', 'double', { avoidEscape: true }],
      'no-console': 'off'
    }
  }
);