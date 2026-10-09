import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // O gateway do WhatsApp roda em Node, não no browser: `process` e `Buffer`
  // são globais legítimos ali. Sem este bloco o eslint os acusa de `no-undef`,
  // e cada arquivo Node novo entrava na catraca do lint como regressão.
  {
    files: ['services/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
