# Republicação de `ulbra-historico` a partir da #928 — PREPARADA, NÃO EXECUTADA

Preparada em 12/11/2026 às 16h de Brasília. **Nenhum deploy, SQL, merge ou chamada à
ULBRA.** A gestão aprovou preparar; executar exige autorização própria.

## 1. O que está em produção (conferido em 12/11, somente leitura)

| item | estado |
|---|---|
| migration `20261110100000_ulbra_historico_orcamento` | **aplicada** às 11:10:06Z como versão `20261112111006`; sha256 `163f3b55…622b` = autorizado (#919) = arquivo da #928; ledger em `supabase/ledger/2026-11/20261112111006__*` |
| `ulbra_historico_uso` | RLS ligada, 0 policies, ACL só `postgres`/`service_role`, **0 linhas** |
| `ulbra_historico_reservar(text,date,int,int,int)` | definer, `search_path` fixo, EXECUTE só `service_role` |
| Edge Function `ulbra-historico` | **v1**, ACTIVE, `verify_jwt = true`, publicada às 11:36:41Z com os arquivos da **#913** (hashes abaixo) |
| segredos (só existência) | `ULBRA_MCP_TOKEN` presente; `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` são do próprio projeto |
| piloto | **não rodou** (0 linhas de uso) |
| coleta em massa | parada desde 11/11 20:31Z (429); `cron` = 0 |
| OAuth / envio | nada publicado; migration `20261111140000` não aplicada; `ulbra-conversa` não existe no projeto |
| porta de tela | `HISTORICO_DISPONIVEL = false` (#933, não mesclada) |

## 2. Publicada × #928: equivalência funcional comprovada por diff

Fonte publicada baixada com `supabase functions download` (cópia em
`docs/integracoes/rollback-ulbra-historico-v1/`). Diff completo contra
`origin/feat/ulbra-historico-isolado` (#928, head `8079684a`):

| arquivo | publicada (v1) | #928 | diferença |
|---|---|---|---|
| `index.ts` | `2e50b8de…1e79` | `4b966eef…d689` | **1 linha**: `import type … from "../ulbra-conversa/leitura.ts"` → `"./leitura.ts"` (só tipo) |
| `historico.ts` | `4836a2e5…d36c` | `2e03d87b…754a` | **2 linhas**: o mesmo import (`../ulbra-conversa/leitura.ts` → `./leitura.ts`) e, na constante `ALCANCE`, a palavra "OAuth" → "autorização externa" (texto devolvido na resposta; não decide nada) |
| `leitura.ts` | `20cc12d3…f05f` (em `ulbra-conversa/`) | `20cc12d3…f05f` (em `ulbra-historico/`) | **idêntico**, só muda a pasta |

Nenhuma linha de decisão muda: JWT obrigatório (`verify_jwt = true` + `auth.getUser`),
cadastro ativo, identidade por vínculo `alta_cpf` lido agora, permissão (dono único da
carteira, responsável único do atendimento ou perfil amplo), **saldo desatualizado
bloqueia** (`SALDO_VALIDADE_MS = 15 min`; fotografia vencida renova por 1 `meu_acesso`
reservado antes), **reserva atômica antes de cada chamada** (`LIMITE_OPERADOR_DIA = 20`,
`RESERVA_GLOBAL = 100`), 429 → `ULBRA_LIMITE` → `ULBRA_INDISPONIVEL` sem repetição, cache
de 5 min por conversa, página de 20. Ganho da republicação: a função deixa de depender de
um arquivo da pasta `ulbra-conversa` (OAuth/envio), que não existe no projeto nem na
`main`; o bundle publicado hoje carrega esse arquivo só porque o deploy veio da #913.

## 3. Plano de publicação (cada passo com a sua autorização; nada executado)

Pré-condições: #928 mesclada na `main`; banco sem timeouts por 30 min
(`sistema_sob_carga = false`, nenhum "canceling statement due to statement timeout" no
log); esta PR mesclada (ledger e status).

1. **Checkout limpo da `origin/main`** (não do checkout de trabalho) e conferir os três
   hashes da #928 na tabela acima.
2. **Publicar** sem `--no-verify-jwt`:

   ```bash
   npx -y supabase@2.122.1 functions deploy ulbra-historico --project-ref ahattpqrjmhkzsmnbdzs
   ```

3. **Conferir** com `get_edge_function`: versão 2, `verify_jwt = true`, arquivos
   `ulbra-historico/index.ts`, `historico.ts`, `leitura.ts` com os hashes da #928 e
   **nenhum** arquivo de `ulbra-conversa/`.
4. **Zero chamadas**: publicar não chama a ULBRA; a função só chama por requisição
   autenticada. A porta de tela segue desligada.
5. **Piloto de até 3 chamadas** (autorização própria, só com banco normal): 1
   `meu_acesso` na primeira leitura (fotografia do saldo vencida), 1 `ler_conversa` pelo
   operador responsável, 0 pelo operador alheio (negado antes da reserva), 1 pela gestão.
   Conferir `ulbra_historico_uso` depois: 3 reservas, nenhuma a mais.
6. **Só então** PR de uma linha ligando `HISTORICO_DISPONIVEL`.

## 4. Rollback

- Função: `docs/integracoes/rollback-ulbra-historico-v1/LEIA-ME.md` (redeploy da v1 a
  partir da cópia conferida por `SHA256SUMS`, ou retirada da função).
- Banco: `20261110100000_ulbra_historico_orcamento.rollback.sql` (sha256
  `1aa486a1…8b801`), **não executada**; só depois de retirar a função; a tabela está
  vazia.

## 5. Fora deste plano

Reaplicar migration (proibido: a versão já existe), OAuth, envio, coleta em massa,
vínculo automático por nome, ligar a porta antes do piloto.
