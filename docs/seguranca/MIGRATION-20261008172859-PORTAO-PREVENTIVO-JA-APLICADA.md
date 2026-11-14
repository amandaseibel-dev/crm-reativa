# Migration `20261008172859` — já aplicada em produção (NÃO reaplicar)

`supabase/migrations/20261008172859_preventivo_portao_angela_e_gustavo.sql` é o
**texto exato** registrado em `supabase_migrations.schema_migrations` (versão
`20261008172859`, nome `preventivo_portao_angela_e_gustavo`), versionado só para
o repositório refletir o banco.

## Prova de equivalência (leitura em 13/11/2026)

| Item | Ledger de produção | Arquivo do repositório |
|---|---|---|
| Tamanho | 3.681 bytes (`octet_length`) | 3.681 bytes |
| MD5 (UTF-8, sem quebra de linha final) | `4f9df95fe4c94a0abbcba173a204a770` | `4f9df95fe4c94a0abbcba173a204a770` |

Conferir de novo: `md5 -q supabase/migrations/20261008172859_*.sql` e, no banco,
`select md5(statements[1]) from supabase_migrations.schema_migrations where version='20261008172859'`.
O arquivo NÃO termina em quebra de linha, de propósito: é assim que o ledger o guardou.

## O que isto NÃO é
- Não é para executar: o banco já tem a função, o comentário e os grants.
- O ledger já contém a versão, então `supabase db push`/`migration up` a trata como aplicada.
- Nenhum job do CI aplica migration (o workflow só roda a catraca e testes em Postgres isolado).

## Reversão
`supabase/rollbacks/20261008172859_preventivo_portao_angela_e_gustavo.rollback.sql`.

## Pendência separada
Acesso da diretoria no frontend (`EMAILS_PREVENTIVO` e `/preventivo` em
`DIRETORIA_ROTAS`, `src/App.jsx`): PR própria, não faz parte desta.
