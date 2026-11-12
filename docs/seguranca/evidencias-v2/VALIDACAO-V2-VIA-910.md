# Evidência de validação da CONTINUIDADE v2 (#894) — complementar

Esta nota **não substitui** o check obrigatório do head desta PR (`13f76862`). Registra
a prova já obtida de que o mesmo conteúdo foi executado em CI.

## Hashes (SHA-256) dos arquivos da v2 — conferidos antes e depois deste commit

| arquivo | SHA-256 |
|---|---|
| `supabase/aguardando_aprovacao/20261109120000_whatsapp_continuidade_v2.sql.pendente` | `385a835e42aa7c4da4d63d748f07b834ffb66b7490a12273e6f124a7d5d7d386` |
| `supabase/aguardando_aprovacao/20261109120000_whatsapp_continuidade_v2.rollback.sql` | `4edee0c78a10e1c69c46b8f0c533908e4d1da72d02a54e6282df3ef24053c7b8` |

Nenhum arquivo SQL, rollback ou teste foi alterado por este commit.

## Execução em CI com o mesmo conteúdo

- PR #910 (empilhada sobre esta), head `49336f66`, run `43188679382`: **19 de 19 jobs `success`**.
  - job "whatsapp continuidade v2 (postgres isolado)": https://github.com/amandaseibel-dev/crm-reativa/actions/runs/43188679382/job/131082195917
  - job "whatsapp cota 10 por operador (postgres isolado)": https://github.com/amandaseibel-dev/crm-reativa/actions/runs/43188679382/job/131082196002
- Os 7 arquivos da v2 têm o mesmo blob em `13f76862` e em `49336f66`.

## Correção documental deste commit

A nota anterior sobre a v2 atribuía a `authenticated` um `EXECUTE` que a versão final não
concede. A versão final não concede `EXECUTE` a `authenticated` e a verificação final da
migration falha se isso mudar.
