# Histórico ULBRA isolado — pacote de implantação (sem aplicação)

**Status:** preparado. Não aplicado. Não publicado. Não mesclado.

## Relação entre PRs
- **#913** (`feat/ulbra-historico-e-resposta`, head `1655f425`): preservada, com conexão, OAuth, prévia e envio. Não é alterada por esta PR.
- **Esta PR** (`feat/ulbra-historico-isolado`, a partir da `main` em `f7b36033`): somente histórico.
- **#919:** autorização documental da migration `20261110100000`. Os hashes da migration e do rollback abaixo são **os mesmos** registrados nela.

## Por que a #913 não serve como está
No head `1655f425`, a trava de OAuth/envio é só técnica (variável `ULBRA_ENVIO_REAL` ausente e migrations de conexão `.pendente`). A interface não isola:
- `src/pages/CentralUlbra.jsx` chama `conexaoIniciar`, `envioPrevia` e `envioConfirmar`, e é montada em `/central-ulbra` (liberada para operadores);
- `src/App.jsx` monta a rota `/ulbra/conectado` (retorno OAuth);
- `src/components/ConversaUlbra.jsx` tem o botão "Confirmar envio".

## Artefatos de banco (hashes conferidos)
| Artefato | SHA-256 | Bytes | Origem |
|---|---|---|---|
| `supabase/aguardando_aprovacao/20261110100000_ulbra_historico_orcamento.sql.pendente` | `163f3b551bd62f18dca519310b76e0cb58d78f4235bde7cff7ff7210bc82622b` | 2620 | igual à #913 e à #919 |
| `supabase/aguardando_aprovacao/20261110100000_ulbra_historico_orcamento.rollback.sql` | `1aa486a119b5fe86e2fc8b304308ff1f784b22db9094946e52ecd775cd18b801` | 201 | igual à #913 e à #919 |

## Mudanças de código nesta PR
- `supabase/functions/ulbra-historico/index.ts`, `historico.ts`, `historico.test.ts`: reaproveitados da #913.
- `supabase/functions/ulbra-historico/leitura.ts`: lógica de leitura que antes era importada de `ulbra-conversa/leitura.ts`, agora no módulo do próprio histórico. Nenhuma referência a `ulbra-conversa` restou.
- `historico.ts`: um comentário reescrito (a palavra "OAuth" virou "autorização externa"), sem efeito no código.
- `supabase/functions/ulbra-historico/ausencia.test.ts`: prova estática de que `index.ts`, `historico.ts` e `leitura.ts` não contêm conexão, envio, OAuth, `ULBRA_ENVIO_REAL` nem `ulbra-conversa`.
- `src/utils/ulbraHistoricoCliente.js` (+ teste): cliente somente leitura, com `lerHistorico`, `mapearHistorico` e `MOTIVOS_HISTORICO`. Sem conexão, prévia, envio ou OAuth.
- `src/components/HistoricoUlbraLeitura.jsx` (+ teste): painel somente leitura, com consulta só por clique. **Não montado em nenhuma rota nesta PR.**

## Garantias testadas
- Montar o painel ou trocar a conversa não chama a função (zero chamadas externas).
- Um clique gera exatamente uma chamada.
- O painel não renderiza controles de conexão, envio ou autorização.
- O código do cliente, do painel e da função não referencia conexão, envio ou OAuth.
- Autorização por aluno e reserva de orçamento antes da chamada externa: cobertas pelos 18 testes de `historico.test.ts`.

## Verificação local (worktree isolado)
- Testes do histórico (função): 21 passam (18 de `historico.test.ts` + 3 de `ausencia.test.ts`).
- Testes do painel e do cliente: 8 passam.
- `deno check supabase/functions/ulbra-historico/index.ts` com Deno 2.1.4: passa.

## Ordem de implantação (somente com aprovação nova e específica)
1. Aplicar `20261110100000_ulbra_historico_orcamento.sql.pendente` (SHA-256 `163f3b55…`).
2. Publicar a função `ulbra-historico`.
3. Piloto de **até três chamadas** de leitura, por clique, em alunos autorizados.
4. Montar o painel em rota: decisão separada, fora desta aprovação.

## Reversão
1. Remover a função `ulbra-historico` do projeto.
2. Aplicar `20261110100000_ulbra_historico_orcamento.rollback.sql` (SHA-256 `1aa486a1…`).
3. Não há rota montada nesta PR: nada a desmontar no frontend.

## Autorização
A autorização de implantação vinculada ao head da #913 **não se transfere** para esta PR. A implantação exige aprovação nova.
