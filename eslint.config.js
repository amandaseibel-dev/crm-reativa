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
  // Os arquivos de configuracao da raiz rodam em Node, nao no browser: eles sao
  // lidos pelo vite/vitest antes de existir qualquer pagina. Sem este bloco,
  // ler `process.env` neles virava `no-undef` e a catraca do lint acusava
  // regressao — foi o que reprovou este proprio PR na primeira tentativa.
  {
    files: ["*.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
])
