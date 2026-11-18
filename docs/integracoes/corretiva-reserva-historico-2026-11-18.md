> **HISTÓRICO DE REVISÃO — NÃO É O PROCEDIMENTO VIGENTE.** Ordem, configuração e aprovações deste documento foram substituídas pelo `docs/integracoes/implantacao-leitura-historico-VIGENTE.md`. Em caso de conflito, vale o procedimento vigente.

# Corretiva da RPC de reserva do histórico (`ulbra_historico_reservar`) — pacote separado, NÃO aplicado

**Status:** preparado para revisão. **Nada foi aplicado em produção.** Aplicação exige aprovação específica da gestão.
**Independente do piloto de leitura:** a corretiva fecha uma exposição de defesa em profundidade da RPC que JÁ existe em produção. Pode ser decidida e aplicada antes, separadamente.

## 1. Estado atual (fonte versionada)
- A função `public.ulbra_historico_reservar(text,date,integer,integer,integer)` é criada pela migration `20261110100000_ulbra_historico_orcamento` (já aplicada; ledger `20261112111006`; `supabase/ledger/2026-11/INDICE.tsv`).
- Características da versão aplicada: `SECURITY DEFINER`, `search_path = public, pg_temp`, grants só para `service_role` (revoke de `public`, `anon`, `authenticated`). **Sem portão interno**: a função não verifica o papel de quem chama.
- Observado por leitura em 16/11 (não versionado): EXECUTE restrito. Não reconferido nesta revisão.

## 2. O que a corretiva muda
Arquivo: `supabase/aguardando_aprovacao/20261116150000_ulbra_historico_reservar_portao_interno.sql.pendente`.
- Recria a função (`create or replace`) com um portão no início: se `auth.role()` não for `service_role`, lança `42501` (`acesso negado à reserva do histórico`).
- Mantém o corpo de reserva e os grants mínimos; a pós-conferência do próprio arquivo verifica `anon` e `authenticated`.
- Pré-condição: aborta se a função não existir ou se já tiver o portão.

## 3. Efeito sobre o chamador legítimo
A `ulbra-conversa` chama a RPC com o cliente de `service_role`. Com o portão, `auth.role()` devolve `service_role` nesse caminho, então a chamada legítima **continua permitida**. A corretiva bloqueia chamadas de outros papéis caso um `EXECUTE` seja concedido por engano. Não altera o comportamento da leitura para o operador.

## 4. Hashes (sha256 completo, do blob `HEAD` desta revisão)
| Arquivo | sha256 |
| --- | --- |
| `20261116150000_ulbra_historico_reservar_portao_interno.sql.pendente` | `1b448d8b0c2be6b5feca9e1900fa772b919c22da62d0752540e20cbd02f58402` |
| `20261116150000_ulbra_historico_reservar_portao_interno.rollback.sql` | `be7b2c64ad7d7e0c4dddb1627a3989678dcbd80537edfd59814f2538e2517113` |

## 5. Verificações
- **Local, banco descartável em memória (PGlite), nesta revisão:** `node supabase/tests/ulbra_historico_portao/run.mjs <raiz>`: todas as asserções passaram. Resultado observado: `service_role` permitido; `authenticated` negado; `anon` negado; portão recusa `authenticated` mesmo com EXECUTE concedido; grants de `anon` e `authenticated` sem EXECUTE.
- **CI:** job `ulbra-historico-portao-pglite` (mesmo runner). O resultado do CI é o do head; não é afirmado aqui antes da conclusão.
- **Limite:** PGlite não é Postgres real; `auth.role()` foi simulado. Em produção, o comportamento de `auth.role()` precisa ser conferido na validação pós-aplicação.
- **Pós-aplicação (passo de validação):** definição contém o portão; `authenticated` e `anon` sem EXECUTE; `service_role` com EXECUTE; registro em `schema_migrations` com versão gerada e `name`.

## 6. Ordem
- Depende apenas de `20261110100000` (aplicada). Não depende de `20261111140000` nem de `20261117120000`.
- Deve estar **aplicada e verificada antes da publicação de `ulbra-conversa`** (a função nova usa a RPC com service_role).

## 7. Rollback
- `supabase/aguardando_aprovacao/20261116150000_ulbra_historico_reservar_portao_interno.rollback.sql` recria a função **sem o portão** (versão aplicada).
- **NÃO é recuperação automática.** Restaura a exposição de defesa em profundidade. Executar só com decisão expressa da gestão.
- Não se aplica ao rollback de `20261110100000` (que apagaria `ulbra_historico_uso`).

## 8. Recuperação se a aplicação falhar
- Se a pré-condição abortar: nada é alterado (a migration é transacional pelo mecanismo; confirmar pelo resultado).
- Se a validação pós-aplicação falhar: desfazer com o `.rollback.sql` apenas com decisão expressa; até lá, manter `ulbra-conversa` não publicada.

## 9. Decisão pendente
Aplicar a corretiva antes do piloto (recomendado pela premissa de portão interno) ou aceitar formalmente a ausência do portão. A segunda opção exige decisão da gestão; este pacote não a pressupõe.
