# F1.a — Classificação da fila de Confirmação de Pagamento por evidência

**17/10/2026. Função só leitura, APLICADA em produção** na versão
`20261017170411`, depois da autorização da gestão. Ela não escreve em lugar
nenhum: nenhum INSERT, UPDATE ou DELETE, nenhuma coluna nova, nenhum gatilho
tocado, nenhum dado alterado.

SQL em
[`supabase/migrations/20261017170411_f1a_confirmacao_classificar_por_evidencia.sql`](../supabase/migrations/20261017170411_f1a_confirmacao_classificar_por_evidencia.sql),
rollback em
[`supabase/rollbacks/20261017170411_f1a_confirmacao_classificar_por_evidencia.rollback.sql`](../supabase/rollbacks/20261017170411_f1a_confirmacao_classificar_por_evidencia.rollback.sql).

A medição abaixo foi feita **duas vezes**: antes de aplicar, rodando o corpo da
função como consulta pura, e depois de aplicar, chamando a função pelo portão —
com resultado idêntico.

## Fonte de verdade consultada antes

Obrigatório por `CLAUDE.md`: `docs/integracoes/README.md` →
`prime-mapa-fontes-verdade.md`. O que ela determina e que governa o desenho:

- **"Caixa efetivamente recebido: Santander, NUNCA `paidAmount` da Prime."**
- **"Situação do título (pago / em aberto / cancelado) e saldo em aberto: NÃO
  EXPOSTA"** pela API Prime.
- `financialStatement[].paymentDate` vem preenchido inclusive em título que o
  CRM mantém ABERTO — "não inferir: presença de `paymentDate` = pagamento".

Por isso **nenhuma classe lê a Prime**. É a mesma doutrina da migration
`20261009181925` (`confirmacao_exige_pagamento_comprovado`, em produção desde
09/10/2026): importar arquivo não comprova pagamento.

## As quatro classes nas 271 solicitações abertas

| Classe | Motivo | Solicitações | Valor informado |
|---|---|---:|---:|
| PAGAMENTO_INFORMADO | `INFORMADO_SEM_TITULO_PROVADO` | 55 | R$ 98.898,32 |
| **BAIXA_CONFIRMADA** | — | **0** | — |
| DIVERGENCIA | `MOTOR_CONTRADIZ` | 58 | R$ 78.310,88 |
| DIVERGENCIA | `BAIXA_PARCIAL` | 1 | R$ 1.160,15 |
| DESCONHECIDA | `MOTOR_NUNCA_RODOU` | 138 | R$ 157.896,81 |
| DESCONHECIDA | `MOTOR_NAO_ACHOU_PARCELA` | 13 | R$ 140.911,52 |
| DESCONHECIDA | `SEM_LINHA_NO_ARQUIVO` | 6 | R$ 4.894,11 |
| **Total** | | **271** | **R$ 482.071,79** |

## Por que "baixa confirmada" é zero — e por que isso não invalida a regra

Zero poderia significar duas coisas opostas: ou nada está provado, ou a regra é
inútil porque nunca classifica nada. **O grupo de controle separa as duas.**
Rodando o mesmo classificador sobre as solicitações **encerradas**:

| Bloco | PAGAMENTO_INFORMADO | BAIXA_CONFIRMADA | DIVERGENCIA | DESCONHECIDA |
|---|---:|---:|---:|---:|
| Encerradas | 97 | **689** | 28 | 3.448 |
| Abertas | 55 | **0** | 59 | 157 |

A regra discrimina: produz 689 "baixa confirmada", **todas** no bloco encerrado
e **nenhuma** no aberto. A causa é mecânica e foi verificada: o gatilho
`trg_pagamento_baixado_encerra_confirmacao` chama
`confirmacao_encerrar_por_pagamento`, e a etapa `encerrar_confirmacao_processada`
está **ligada** em `fluxo_pagamentos_config`. Ou seja: **a prova fecha o item**.
O que fica aberto é, por construção, o que ainda não tem prova.

## Dois erros meus no caminho, corrigidos antes de concluir

1. **Variável de corroboração quebrada.** Usei `parcelas.status = 'quitada'`
   para corroborar a baixa, e o resultado deu zero em todas as classes. O
   vocabulário de `parcelas` é `PAGO` / `VENCIDA` / `A_VENCER` / `CANCELADA` /
   `SUSPENSA` / `RENEGOCIADA` — `quitada` é de outra tabela. O "zero" era bug
   meu, não achado.
2. **Nome de classe errado.** Chamei de "motor nunca olhou" um grupo onde
   existem 91 registros em `baixa_automatica_log`. A tabela tem 12.099
   `SEM_PARCELA` contra 4 `BAIXADA` e 2 `ERRO` — o motor rodou e não achou onde
   aplicar. São duas situações com ações diferentes, e agora são dois motivos
   separados (`MOTOR_NAO_ACHOU_PARCELA` × `MOTOR_NUNCA_RODOU`).

## O que a medição revelou e serve para F1.b / F1.c

- **265 das 271** solicitações abertas já têm `titulo_numero` na própria linha
  do arquivo, somando 356 linhas de pagamento. O título não precisa ser
  descoberto: ele já está importado e é descartado na agregação por
  (nome, data) que `trg_pagamentos_gerar_confirmacao` faz.
- **11 solicitações têm `valor_informado` diferente da soma das linhas do
  arquivo** (3 em `MOTOR_NAO_ACHOU_PARCELA`, 6 em `SEM_LINHA_NO_ARQUIVO`, 2 em
  `MOTOR_CONTRADIZ`). Nas 6 sem linha é esperado; nas outras 5 é sinal próprio
  de divergência e merece olhar.
- As 138 de `MOTOR_NUNCA_RODOU` são o passivo de jul/ago, importado antes de
  `trg_pagamento_vincula_identificador` existir.

## O que esta etapa não faz

Não grava a classe, não confirma, não rejeita, não quita, não baixa, não
vincula, e **não tira nem devolve ninguém da cobrança** —
`alunos_em_confirmacao_pendente()` continua lendo `status`, que não muda.

**O rateio não entra aqui.** O rateio medido em 09/10 (um pagamento de base
R$ 950,16 aparecendo como prova de quatro títulos somando R$ 2.388,27) vale para
quem usa `pagamentos` como prova **de um título**. A classe BAIXA_CONFIRMADA usa
o veredito que o motor já carimbou na linha, não um casamento novo. O rateio
volta a ser obrigatório em **F1.c**, quando `titulo_id` passar a ser gravado.

## Conferido depois de aplicar

| Checagem | Resultado |
|---|---|
| Versão registrada | `20261017170411` |
| `statements` de produção × arquivo | md5 `4e6e51ef25d2dd1841ef5ac76c48fdff`, 11.087 bytes, **iguais** |
| `prosrc` da função no banco × corpo do arquivo | md5 `c6252dbdc59f8876bea09af4f9d2e6e9`, 4.710 bytes, **iguais** |
| Volatilidade / `SECURITY DEFINER` | `STABLE`, `prosecdef = true` |
| ACL | `postgres`, `authenticated`, `service_role` — **sem PUBLIC, sem anon** |
| Portão interno | chamada sem JWT de gestão recusa com **42501** |
| Comentário | preservado pelo `apply_migration` |
| Saída pela função, como gestão | idêntica à medição acima (271) |

O número da versão **não derivou**: o arquivo foi renomeado para a versão que o
`apply_migration` carimbou, então repositório e produção usam o mesmo número —
diferente dos drifts de `20261007093130`, `20261007111401`, `20261007111415` e
`20261016115142`. No ledger a entrada vai com `arquivo = '-'`, pela regra do
`LEIA-ME`: o par executável já está versionado em `supabase/migrations/`.

## O que continua pendente

- **Nenhum consumidor em tela.** Levar a classe para a fila toca
  `ConferenciaPagamentos.jsx`, arquivo do **PR #673**, ainda aberto — decidir a
  ordem antes de mexer.
- **Sem teste automatizado.** Esta entrega não trouxe
  `supabase/tests/*.test.js`; a classificação foi provada por medição em
  produção e por grupo de controle, não por teste versionado.
- **F1.b, F1.c e F1.e não começaram** e não entram neste registro.
