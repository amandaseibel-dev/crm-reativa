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

## Botão "Histórico" na Central (PR dependente desta, branch `feat/ulbra-historico-botao-central`)
- `src/utils/ulbraHistorico.js`: porta `HISTORICO_DISPONIVEL = false` e `podeVerHistorico(linha, ehGestao)` — só linha com `aluno_id` (CPF confirmado) e só gestão ou o responsável da linha (`minha`). A função reconfere no servidor; a porta de tela evita oferecer um clique que seria negado.
- `src/components/MensageriaPeriodo.jsx` (visão Mensageria de `/central-ulbra`): nas duas seções, a linha elegível ganha o botão **Histórico**, que só abre o painel `HistoricoUlbraLeitura` (zero chamada). A leitura é o clique **"Carregar histórico"** dentro do painel: 1 chamada por página; recusas da função (`SALDO_DESATUALIZADO`, `SALDO_SEM_INFORMACAO`, `LIMITE_OPERADOR_DIA`, `RESERVA_GLOBAL`, `SEM_PERMISSAO_NA_CONVERSA`, `IDENTIDADE_NAO_CONFIRMADA`) viram texto, sem repetição. Com a porta desligada a tela é **idêntica à de hoje**: nenhum botão, nenhuma chamada, mesmo aviso.
- Testes: `MensageriaPeriodo.historico.test.jsx` (4) e `ulbraHistorico.test.js` (4) — porta desligada sem botão; operador só na própria linha; gestão em toda linha com CPF; abrir painel não chama; 1 clique = 1 chamada; recusa sem repetição. Os 32 testes de `CentralUlbra.test.jsx` seguem passando.
- **Ligar a porta** (`HISTORICO_DISPONIVEL = true`) é uma PR de uma linha, só depois dos passos 1–3 abaixo.

## Ordem de implantação (somente com aprovação nova e específica)
1. Aplicar `20261110100000_ulbra_historico_orcamento.sql.pendente` (SHA-256 `163f3b55…`). A linha M1 em `docs/seguranca/migracoes-aprovadas.tsv` (PR #919) é por **hash**, e o hash é o mesmo nesta PR: tecnicamente cobre estes bytes até `2026-11-13T21:00:00Z`. A **aprovação expressa** da aplicação a partir desta PR é separada e ainda não foi dada.
2. Publicar a função `ulbra-historico` (`verify_jwt = true`); conferir que o segredo `ULBRA_MCP_TOKEN` existe no projeto (só existência).
3. Piloto de **até três chamadas** de leitura, por clique, em alunos autorizados.
4. Merge desta PR e da PR do botão (porta desligada): nada muda na tela.
5. PR de uma linha ligando `HISTORICO_DISPONIVEL`.

## Reversão
1. Desligar a porta (`HISTORICO_DISPONIVEL = false`): o botão some, nenhuma chamada sai da tela.
2. Remover a função `ulbra-historico` do projeto.
3. Aplicar `20261110100000_ulbra_historico_orcamento.rollback.sql` (SHA-256 `1aa486a1…`).

## Autorização
A autorização de implantação vinculada ao head da #913 **não se transfere** para esta PR. A implantação exige aprovação nova.
