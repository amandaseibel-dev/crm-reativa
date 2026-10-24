# Conciliação inteligente de pagamentos — diagnóstico

**Data:** 2026-10-24 · **Modo:** somente leitura (produção `ahattpqrjmhkzsmnbdzs`)
**Nada foi implementado, nenhuma migration aplicada, nenhum dado financeiro alterado.**

---

## 1. Diagnóstico: as 4 classes que você pediu já existem em produção

A separação dos itens 3 e 4 do pedido **já está entregue e aplicada**, nas PRs #737,
#746 e #748. As três migrations estão em PROD (`20261023101108`,
`20261023164204`, `20261023195246`).

| Classe pedida | Objeto em PROD | Itens | Valor |
|---|---|---:|---:|
| Pagamento identificado e baixa comprovada | `BAIXA_REGISTRADA_CRM` | 1.333 | R$ 1.049.429,98 |
| Pagamento identificado, baixa pendente | `BAIXA_PENDENTE` | 359 | R$ 279.208,14 |
| Divergência pagamento × título/acordo | `DIVERGENCIA` | 74 | R$ 99.902,38 |
| Pagamento sem identificação suficiente | `SEM_VINCULO` | 22 | R$ 27.564,25 |
| (fora da janela, decisão da gestão de 14/09) | `FORA_DA_JANELA` | 8.241 | R$ 11.244.042,94 |

Categorias **mutuamente exclusivas**, uma linha por pagamento, em
`vw_importacao_conferencia`, recortada por `pagamentos.importacao_id`. A tela é
`src/components/CentralPagamentosPorArquivo.jsx`, aba "arquivo" da Central de
Pagamentos, com link "decidir na fila →" para a fila única
(`PagamentosSemAluno.jsx`). As 455 pendências abertas batem exatamente com o
`pendentes` que o motor reporta.

**Não há o que recriar aqui.** A classificação está feita, é só leitura, e o
vocabulário de motivo é um só (reaproveitado de `vw_fila_pagamento_triagem`).

### O que cada fonte pode e não pode confirmar

Está documentado em `docs/integracoes/prime-mapa-fontes-verdade.md` e o código
já respeita:

- **Santander (arquivo importado)** — a **única** prova de recebimento. É a
  origem da linha em `pagamentos`.
- **Prime/ULBRA** — prova **existência, valor e vencimento** do título.
  **Nunca pagamento:** `financialStatement` não expõe situação nem saldo, e
  `paymentDate` vem preenchido em 100% das linhas, inclusive em título a vencer
  (0 nulos em 302.477 do portador 95). `conciliacao_liquidar_titulo_por_prime`
  exige gestão, aluno resolvido e dinheiro que cubra o que fecha.
- **CRM** — prova o **registro** da baixa (`parcelas.origem_baixa_ref`
  apontando para o pagamento, 1 para 1 estrito). Não prova recebimento, e o
  rótulo `BAIXA_REGISTRADA_CRM` carrega esse limite de propósito.

---

## 2. Lacunas reais, com evidência

### L1 · A classificação funciona; o encaminhamento não existe

A triagem declara uma ação para 88 pagamentos — e **nenhuma tela a oferece**.

| Evidência | Medição |
|---|---|
| `acao_sugerida` no frontend | aparece **só em testes** e em `QuitacaoSugerida.jsx`; `PagamentosSemAluno.jsx` não renderiza |
| `conciliacao_ja_paga_encerrar` | **0 chamadas no frontend** (resolve 46 itens, R$ 40.394,50) |
| `conciliacao_ja_paga_previa` | **0 chamadas no frontend** (a prévia de 8 evidências já está escrita) |
| `conciliacao_vincular_identidade_por_cpf` | **0 chamadas no frontend** |
| `conciliacao_consultar_portador_pendentes` | **0 chamadas no frontend** |

### L2 · A rodada roda e não sai nada

| Dia | Execuções | Processados | **Baixados** | Pendentes |
|---|---:|---:|---:|---:|
| 24/10 | 5 | 125 | **0** | 455 |
| 23/10 | 17 | 425 | **0** | 455 |
| 22/10 | 17 | 425 | **0** | 448 |
| 21/10 | 4 | 52 | **0** | 419 |

43 execuções, 1.027 processados, **zero baixas**, e a pendência subiu 419 → 455.

Causa estrutural medida: os jobs ativos 73/74/75 chamam
`fluxo_pagamentos_incremental`, que **não lê `fluxo_pagamentos_config`** e
**não executa etapa nenhuma**. Quem lê a configuração e chama as etapas é
`fluxo_pagamentos_rodar`, no **job 38 — `active = false`** (pausado desde o
incidente de 24/09).

Consequência: `encerrar_ja_paga_conferida` está `ligado = true` na configuração
e **ninguém a executa**.

### L3 · Decisão sem saída: 33 pagamentos em limbo, R$ 83.203,30

| Decisão na fila | Itens | Valor | Período | Com parcela apontando |
|---|---:|---:|---|---:|
| `RESOLVIDO_AUTOMATICO` | 19 | R$ 29.278,47 | 17–23/09 | **0** |
| `FEITO` | 9 | R$ 50.893,76 | 29/09 | **0** |
| `ENCERRADO_GESTAO` | 5 | R$ 3.031,07 | 18/09 | **0** |

`conciliacao_feito` e `conciliacao_ja_paga_encerrar` gravam **só** a decisão na
fila (`sem_efeito_financeiro: true`) e **não tocam
`pagamentos.status_conciliacao`**. O pagamento fica decidido na fila e pendente
no motor, para sempre: a tela o esconde (predicado `decisao is not null`), a
rodada o pula, e o indicador continua contando.

O CHECK `pagamentos_status_conciliacao_valido` permite 8 valores e **nenhum é
terminal sem baixa**.

**Isto ordena as etapas:** qualquer botão de encaminhamento que feche a fila sem
baixa produz mais limbo. Os 19 em limbo são exatamente o resultado de
`conciliacao_ja_paga_encerrar` ter rodado.

### L4 · 59,6% da pendência não tem porta de saída por decisão de negócio

| Subcategoria | Itens | Valor |
|---|---:|---:|
| `consulta_portador` (etapa desligada em 15/09) | **271** | **R$ 215.344,57** |
| `ja_paga_conferir_e_encerrar` | 46 | R$ 40.394,50 |
| `escolher_aluno_sugerido` | 42 | R$ 23.469,07 |
| `decidida_mas_ainda_pendente` | 33 | R$ 83.203,30 |
| `acordo_sem_parcela_livre` | 23 | R$ 3.894,14 |
| `acordo_ausente_no_crm` | 22 | R$ 27.564,25 |
| demais (cancelado, paga antes, reemitido, valor) | 18 | R$ 12.804,94 |

Os 271 são **53% do dinheiro pendente** e dependem de religar
`consulta_portador`, que exige autorização expressa da gestão. **Nenhuma etapa
de código resolve isso** — é decisão, e precisa ser dita como tal.

### L5 · Prevenção de duplicidade está desligada de fato

`pagamentos_detectar_suspeita_duplicidade(p_importacao_id)` existe e
**ninguém a chama**: `projecao_importar_pagamentos` não a invoca, e a busca por
chamadores no banco devolve apenas a própria função.

`pagamento_suspeita_duplicidade` tem **9 linhas, todas detectadas em
11/09/2026** — nenhuma em 43 dias, enquanto 1.788 pagamentos entraram na janela.

### L6 · Rastreabilidade por arquivo é pelo nome, não pelo conteúdo

`importacoes` tem `arquivo_nome` e **nenhuma coluna de digital, caminho ou
bytes**. A `santander-importar` **calcula** a digital do conteúdo, usa-a para
recusar divergência entre prévia e confirmação, devolve-a na resposta — e
**descarta**. O arquivo não é preservado.

A importação de **acordos** ganhou exatamente isso em 24/10
(`importacoes_acordos.arquivo_sha256`, `arquivo_path`, `arquivo_bytes`,
migration `20261024114622`). O padrão existe e está testado; falta aplicá-lo ao
arquivo de pagamentos.

Secundário, mas medido: **714 pagamentos (R$ 1.062.023,14)** têm
`importacao_id` nulo e por isso **não aparecem na conferência por arquivo**.
Todos de 01–20/07, todos com `status_conciliacao` nulo (já estariam em
`FORA_DA_JANELA`).

### L7 · Permissão por perfil não existe no fluxo de pagamentos

`usuario_e_gestao()` é uma allowlist de **3 e-mails cravados na função**. Todas
as leituras (conferência por arquivo, fila, triagem) e todas as decisões passam
por ela. **O operador não vê nada.**

`usuarios.perfil` existe, com 16 pessoas em 8 perfis (7 operadores ativos) —
e o fluxo de pagamentos o ignora.

---

## 3. Proposta em etapas

| # | Etapa | Toca dinheiro? | Depende de |
|---|---|---|---|
| **1** | **Saída terminal para pendência decidida sem baixa** | não (status de controle) | autorização da gestão |
| 2 | Encaminhamento: a ação declarada vira botão (88 itens) | não | Etapa 1 |
| 3 | Detector de duplicidade ligado à importação | não | — |
| 4 | Digital + arquivo preservado na importação de pagamentos | não | — |
| 5 | Leitura por perfil: operador vê o próprio arquivo/pendência | não | — |
| 6 | Indicador honesto: pendência viva × decidida sem saída | não | Etapa 1 |
| — | *Religar `consulta_portador`* (271 itens, R$ 215 mil) | **sim** | **decisão de negócio, não código** |

Nenhuma etapa cria fila nova, tela nova de decisão, ou regra financeira nova.
Todas reusam `vw_fila_pagamento_triagem`, `vw_importacao_conferencia`,
`fila_pagamento_sem_vinculo` e as funções de decisão que já existem.

---

## 4. Primeira etapa recomendada

### Etapa 1 — Saída terminal para a pendência decidida sem baixa

**Por que primeiro.** É pré-requisito das Etapas 2 e 6. Hoje, fechar a fila sem
baixa produz um pagamento eternamente pendente; wire o botão antes disso e os 46
`ja_paga` viram 46 novos limbos, somando aos 33 atuais.

**Escopo**

1. Um valor terminal novo em `status_conciliacao` (ex. `ENCERRADO_SEM_BAIXA`) e
   o `CHECK pagamentos_status_conciliacao_valido` ampliado.
2. Uma função com portão de gestão que move o pagamento para o terminal
   **somente** quando a linha da fila já tem `decisao` e a auditoria registra
   `sem_efeito_financeiro: true`. Sem baixa, sem parcela, sem acordo, sem saldo.
3. `vw_fila_pagamento_triagem` e `vw_importacao_conferencia` passando a
   reconhecer o terminal (a subcategoria `decidida_mas_ainda_pendente` esvazia).
4. Backfill dos 33 — **em passo separado e com autorização própria**, com
   backup por id e SQL de reversão (não há PITR).

**Riscos**

- **Blast radius do campo:** 35 funções, 2 views e 6 arquivos do frontend leem
  `status_conciliacao`. O predicado perigoso é
  `status_conciliacao is not null and <> 'BAIXADO'`, que hoje significa
  "pendente" e passaria a incluir o terminal. Cada ocorrência tem de ser
  enumerada e conferida antes da migration, não depois.
- **O número cai.** O `pendentes` do motor vai de 455 para 422 no backfill.
  Precisa ser anunciado à operação, não descoberto por ela.
- **Semântica.** O terminal diz "pendência encerrada por decisão humana, sem
  efeito financeiro". Não diz pagamento conferido no banco. O nome tem de
  carregar esse limite, como `BAIXA_REGISTRADA_CRM` carrega o dele.
- **Sem risco financeiro direto:** nenhuma parcela, acordo, saldo ou baixa é
  tocada. O que muda é um campo de controle da conciliação.

---

# Anexo · Mapa dos consumidores de `status_conciliacao`

Levantado em 24/10/2026 contra produção (`ahattpqrjmhkzsmnbdzs`), somente
leitura. É a base de risco da Etapa 1: um valor novo no campo só é seguro se
todo mundo que o lê continuar certo.

## Censo

| Onde | Quantos |
|---|---:|
| Funções em `public` cujo corpo menciona `status_conciliacao` | **35** |
| Views que mencionam | **2** (`vw_fila_pagamento_triagem`, `vw_importacao_conferencia`) |
| Arquivos do frontend (fora de testes) | **6** |
| CHECK que restringe os valores | 1 (`pagamentos_status_conciliacao_valido`, 8 valores) |

## O predicado perigoso, e por que 5 das 6 ocorrências não precisam de nada

`status_conciliacao is not null and <> 'BAIXADO'` é o jeito que este sistema
escreve "pendente". Seis funções o usam. Quem conta como pendente um pagamento
que já tem saída, mente.

| Função | Onde o predicado aparece | Já exclui `decisao is not null`? | Precisa mudar? |
|---|---|---|---|
| `conciliacao_reprocessar` | seleção do laço | **sim** | não |
| `fluxo_pagamentos_incremental` | seleção do lote | **sim** | não |
| `fluxo_pagamentos_incremental` | **contador `v_pend`** | **não** | **SIM** |
| `parcela_paga_antes_apos_importar_acordos` | seleção do motor | **sim** | não |
| `parcela_paga_antes_reconstruir_pendentes` | seleção | **sim** | não |
| `parcela_paga_antes_previa` | expressão "é pendente" | **sim** | não |
| `projecao_nao_baixados` | classificação do relatório | **sim** — classifica `decisao is not null` como `DECIDIDA` **antes** de olhar o status | não |

O terminal só é alcançável por pagamento que **já tem decisão na fila** (é
pré-condição da função). Logo, todo predicado que já exclui a linha decidida
continua correto sem uma linha de mudança. Sobra uma exceção: o contador
`v_pend` da rodada, que não filtra decisão e por isso publica os encerrados
como pendentes em `fluxo_pagamentos_execucoes.resultado->>'pendentes'`.

**É o único ponto do fluxo automático que a Etapa 1 encosta**, e é um indicador,
não um comportamento: a expressão só conta. A seleção do lote, os tetos, a
trava, a espera e a reserva ficam byte a byte como estão. O portão 6.4 da
migration prova pelo texto que o patch caiu no contador e não na seleção.

## As duas views

| View | Efeito do terminal | O que a Etapa 1 faz |
|---|---|---|
| `vw_fila_pagamento_triagem` | a CTE `base` o deixaria entrar e ele cairia em `decidida_mas_ainda_pendente` | **sai da triagem**: uma linha somada na `base` |
| `vw_importacao_conferencia` | sem tratamento cairia em `NAO_CLASSIFICADO` e o fechamento por arquivo passaria a mentir | **ganha categoria própria** `ENCERRADO_SEM_EFEITO_FINANCEIRO`, antes de `FORA_DA_JANELA`; e `triagem_motivo` passa a `coalesce(t.motivo, f.motivo)`, para o texto da pendência original não desaparecer da tela |

Nenhuma das duas muda de colunas: `create or replace view` com a mesma lista,
gerada a partir dos arquivos versionados (#737 e #746) e não redigitada.

## Frontend

| Arquivo | O que faz com o campo | Precisa mudar na Etapa 1? |
|---|---|---|
| `src/pages/PagamentosSemAluno.jsx` | lê a fila e a triagem; a triagem já não traz o terminal | não |
| `src/components/projecao/NaoBaixadosRejeitados.jsx` | mostra o relatório de `projecao_nao_baixados`, que já diz `DECIDIDA` | não |
| `src/utils/relatorioNaoBaixados.js` | formata o mesmo relatório | não |
| `src/utils/conciliacaoPagamento.js` | rótulos e chamada de `conciliacao_encerrar` | não |
| `src/pages/ConferenciaPrime.jsx` | lê status para exibir | não |
| `src/components/RegistrarAcordoAvista.*` | lê status para exibir | não |

## Gatilhos de `pagamentos` num UPDATE de `status_conciliacao`

Conferidos com `pg_get_triggerdef` em 24/10/2026:

| Gatilho | Condição | Dispara no terminal? |
|---|---|---|
| `trg_pagamento_baixado_encerra_confirmacao` | `WHEN new = 'BAIXADO' and old is distinct from 'BAIXADO'` | **não** |
| `trg_pagamento_matricula` | `UPDATE OF dados` | não |
| `trg_pagamento_nome_do_operador` | `UPDATE OF operador_email, operador_nome` | não |
| `trg_efetividade_invalidar_pagamentos` | `FOR EACH STATEMENT` | **sim** — invalida o cache da Efetividade, com guarda de exceção própria. Efeito esperado de qualquer escrita em `pagamentos`, não efeito financeiro |
| `trg_audit` (`fn_audit_generic`) | `AFTER INSERT/UPDATE/DELETE` | **sim** — grava o antes/depois. É parte do histórico que a etapa precisa preservar |

Nenhum gatilho de `pagamentos` toca parcela, acordo, título, saldo ou baixa em
resposta a esta transição.

## As três provas que a função exige, e o que cada uma barra

| Prova | Barra | Medido nos 33 |
|---|---|---|
| decisão na fila, em `FEITO` / `RESOLVIDO_AUTOMATICO` / `ENCERRADO_GESTAO`, com `decidido_em` | pendência aberta, e valor de decisão futuro que signifique outra coisa | 33 passam |
| nenhuma `parcelas.origem_baixa_ref` apontando | pagamento que TEM baixa e cujo destino é `BAIXADO` | 33 passam (zero com parcela) |
| `auditoria` da decisão com `sem_efeito_financeiro = true` | decisão sem procedência | **32 passam, 1 recusado** |

O recusado é um `RESOLVIDO_AUTOMATICO` sem nenhuma linha de auditoria. A recusa
é desejada: caso sem procedência é para uma pessoa olhar, não para entrar no
bolo.
