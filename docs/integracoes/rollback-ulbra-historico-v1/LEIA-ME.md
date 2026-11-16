# Rollback da Edge Function `ulbra-historico` — versão 1 (publicada em 12/11/2026 11:36:41Z)

Esta pasta guarda, **byte a byte**, o código que está publicado em produção como
`ulbra-historico` v1 (`verify_jwt = true`), baixado com
`supabase functions download ulbra-historico --project-ref ahattpqrjmhkzsmnbdzs` em
12/11/2026 19:1xZ. Conferir com `shasum -a 256 -c SHA256SUMS` dentro desta pasta.

| arquivo publicado | sha256 | igual a |
|---|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `2e50b8de076ae048834cdf810d0053790691142b29432a59f9020112442f1e79` | #913 `9d750005`/`1655f425` |
| `supabase/functions/ulbra-historico/historico.ts` | `4836a2e5173c4eca17d25add216dbd4cd9428a02eb86037f98342f0ec597d36c` | #913 |
| `supabase/functions/ulbra-conversa/leitura.ts` (dependência importada) | `20cc12d353c7278c9951208d740312831bffe92fcf2533856474be01bbb2f05f` | #913 e #928 (`ulbra-historico/leitura.ts`) |

## Como voltar para esta versão (só com autorização específica)

Depois de uma republicação pela #928, se for preciso voltar:

```bash
cd docs/integracoes/rollback-ulbra-historico-v1 && shasum -a 256 -c SHA256SUMS
```

```bash
cd docs/integracoes/rollback-ulbra-historico-v1 && npx -y supabase@2.122.1 functions deploy ulbra-historico --project-ref ahattpqrjmhkzsmnbdzs
```

Sem `--no-verify-jwt`: a função exige JWT. Conferir depois com `get_edge_function`:
`verify_jwt = true` e os três hashes acima. A pasta tem o `supabase/config.toml` mínimo
que o CLI pede; nada mais é lido daqui.

Alternativa sem deploy: retirar a função do projeto (`supabase functions delete
ulbra-historico`) — a Central não a chama enquanto `HISTORICO_DISPONIVEL = false`.
