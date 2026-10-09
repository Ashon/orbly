import eslint from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      'build/',
      'coverage/',
      'release/',
      'data/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Build scripts, configs and test fixtures that run on Node
    files: ['**/*.mjs', '**/*.cjs', '*.config.*', 'apps/*/*.config.*'],
    languageOptions: { globals: globals.node },
  },
  {
    // Prettier wraps code at 80 columns; this holds comments to it as well.
    // Strings, template literals, regexes and URLs may run longer.
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/max-len': [
        'error',
        {
          code: 80,
          tabWidth: 2,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  }
)
