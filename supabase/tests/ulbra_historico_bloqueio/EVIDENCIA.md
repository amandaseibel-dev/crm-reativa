# Evidência de testes — reserva do histórico (ulbra_historico_reservar)

Registro do que foi executado e do resultado observado. As execuções são em banco DESCARTÁVEL local.

| prova | ambiente | resultado |
|---|---|---|
| migration + guarda + concorrência (`run.cjs`) | PostgreSQL 17.11 local | 11/11 |
| dia vazio: 200 tentativas, teto 150, inicial lido do banco | idem | 150 permitidas = contador final − inicial |
| dia parcialmente consumido: 22 de partida | idem | 128 permitidas; 20 + 2 + 128 = 150 |
| guarda via PostgREST real (`postgrest_guarda.cjs`) | PostgREST 16.5 (macOS arm64) + PostgreSQL 17.11 | 7/7 |
| servidor (Vitest, orçamento, bloqueio, Retry-After, gestão por e-mail) | Node + Vitest 2.1.9 | 57/57 |
| `deno check` do `index.ts` | Deno 2.1.4 | ok |

Binários PostgREST 16.5 (SHA-256, do asset oficial do release):
- linux x86-64 (usado no CI, conferido por `sha256sum -c`): `5099e7ada38f9f6846cd87c14c5f158b7c165f1e9959665ad412e61f4dceba95`
- macOS arm64: `d8095cb439de0a3151036df542139e7afca5cebb109ce7f1bae52b3a97e9846a`

## O que isto prova e o que não prova
- Prova: com PostgREST 16.5 e este SQL, o caminho de serviço passa pela guarda, e authenticated, anon e contexto ausente são recusados (inclusive a guarda isolada, com grant liberado de propósito, em banco descartável).
- NÃO prova: a configuração efetiva do projeto Supabase (versão do PostgREST, gateway, como o contexto é injetado). Isso só se confirma em staging do próprio projeto.
