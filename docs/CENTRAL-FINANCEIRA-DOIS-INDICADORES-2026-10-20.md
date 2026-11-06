# Central Financeira — os dois indicadores, separados na origem

**Data:** 2026-10-20 · **Escopo:** somente leitura · **Migration:** criada e
**NÃO aplicada** · **PR:** sem merge.

Ordem da gestão, 20/10/2026, literal:

> "Na Central Financeira, mantenha dois indicadores distintos: conciliação no
> CRM e baixa oficial no título/parcela. Não considere status BAIXADO como prova
> suficiente de pagamento ou baixa oficial. Use essa distinção para desenhar a
> tela de conferência."

> "Não implemente baixa automática sem validação oficial."

---

## 1. A definição operacional de cada indicador

**Conciliação no CRM** — é a opinião do motor de importação do extrato sobre o
que ele conseguiu amarrar, gravada em `public.pagamentos.status_conciliacao`
(com `conciliacao_motivo` e `conciliacao_em`); **não é baixa, não tem
responsável e não quita obrigação nenhuma.**

**Baixa oficial no título/parcela** — é a linha viva em
`public.baixas_pagamento` para a parcela daquele pagamento, com responsável
(`baixado_por_email`), data (`baixado_em`) e a possibilidade de estorno
(`devolvido_em`); **viva = `devolvido_em` nulo**, exatamente a regra que a trava
`_baixa_viva_unica_por_parcela()` (migration `20260922290000`) já aplica em
produção.

São duas colunas separadas na view, com prefixos que impedem a confusão:
`crm_*` só sai de `pagamentos`, `baixa_*` só sai de `baixas_pagamento`,
`parcela_*` só sai de `parcelas`. **Não existe nenhuma coluna de síntese do tipo
"está baixado sim/não"**, e `baixa_oficial_existe` deriva exclusivamente de
`baixas_pagamento` — nunca olha `status_conciliacao` nem `parcelas.status`.

### A terceira coluna, que a medição obrigou a expor

Existe uma **terceira** fonte, e ignorá-la faria a tela gritar 1.236 casos
críticos que não são críticos: `parcelas.origem_baixa` / `origem_baixa_ref` /
`origem_baixa_em`. O gatilho de importação marca a parcela como `PAGO`
diretamente, **sem criar linha em `baixas_pagamento`**. Em 1.235 dos 1.236
pagamentos em que o CRM diz `BAIXADO` e não há baixa oficial, a parcela **já
está `PAGO`** — ou seja, o dinheiro chegou na obrigação e **ninguém assinou a
baixa**. Isso entra na view como `parcela_*`, em colunas próprias, e na tela
como contexto visualmente discreto. **Não é a baixa oficial.**

---

## 2. A chave real entre `pagamentos` e `baixas_pagamento` — medida

`public.pagamentos` **não tem** `parcela_id`, `baixa_id` nem
`solicitacao_link_id`. **Não existe chave direta.** O que existe, medido em
produção em 20/10/2026 sobre as 10.565 linhas de `pagamentos` e as 3.737 de
`baixas_pagamento`:

| # | Regra | Força medida |
|---|---|---|
| 1 | `parcelas.origem_baixa_ref = pagamentos.id` | das **1.237 linhas não nulas**, 1.237 (100%) casam com um pagamento, 1.237 valores distintos, zero repetido. Referência explícita gravada pelo gatilho de importação. **Mede precisão, não cobertura** — ver o aviso abaixo |
| 2 | `parcelas.boleto = pagamentos.origem_vinculo_ref` (com `origem_vinculo = 'BOLETO_EXATO'`) | `parcelas.boleto` é **único**: 16.521 parcelas, 2.162 nulas, 14.359 não nulas e **14.359 distintas** |
| 3 | as duas juntas | casaram juntas em **977** pagamentos e **discordaram em ZERO** |
| 4 | `CPF + data_pagamento + valor_pago` | **DESCARTADA.** Dos 9.250 pagamentos sem parcela resolvida, 8.824 não têm nenhum candidato, 356 têm exatamente um e **70 têm dois ou mais**; a própria chave se repete em **399** combinações dentro de `baixas_pagamento` |
| 5 | `aluno_id` | `baixas_pagamento.aluno_id` é `text` e `pagamentos.aluno_id` é `uuid` (os 3.737 valores são uuid em texto). Tipo divergente é, por si, motivo para não ancorar a chave nele |

### O que o "100%" da regra 1 NÃO diz

`parcelas.origem_baixa_ref` é **nula em 15.313 das 16.550 parcelas**: a
referência existe em apenas **7,5%** delas. O 100% mede **precisão** — quando a
referência existe, ela aponta para um pagamento real — e **não cobertura**. Ler
esse número como "todo pagamento tem baixa rastreável" seria errado. A cobertura
real está na tabela abaixo: `SEM_PARCELA` são **9.250 dos 10.565 pagamentos
(87,6%)**.

Duas armadilhas de nome, registradas para não serem reabertas:

- **`baixas_pagamento` não tem coluna `pagamento_id`** (conferido no catálogo em
  20/10/2026). Ela viria da Fase 1 da rastreabilidade de baixa, que não está em
  produção nem existe como arquivo no repositório. Nada aqui depende dela.
- **`pagamentos.origem_vinculo*` e `parcelas.origem_baixa*` são coisas
  diferentes**: o primeiro é do lado da **conciliação** (a opinião do motor de
  importação), o segundo é do lado da **baixa na obrigação**. Nesta view eles
  moram em prefixos distintos (`crm_*` e `parcela_*`) exatamente para não serem
  confundidos.

**Decisão:** a regra 1 tem precedência, a 2 entra em seguida, e a discordância —
hoje zero — aparece como `CONFLITO_REF_X_BOLETO` na coluna
`vinculo_parcela_confianca` em vez de ser escondida por um `coalesce`. A regra 4
**não vira vínculo**: aparece como contagem em `baixa_candidata_fraca_qtd`, que a
tela rotula explicitamente como "não é vínculo, só pista para conferir".
Escolher "o mais próximo" entre dois candidatos seria sorteio, não prova.

### Cobertura do vínculo (todas as datas, 20/10/2026)

| Confiança | Pagamentos | Valor |
|---|---:|---:|
| `ALTA_REF_E_BOLETO` | 977 | R$ 696.651,79 |
| `ALTA_REF_IMPORTACAO` | 260 | R$ 236.302,42 |
| `ALTA_BOLETO_EXATO` | 78 | R$ 92.181,30 |
| `CONFLITO_REF_X_BOLETO` | 0 | R$ 0,00 |
| `SEM_PARCELA` | **9.250** | R$ 12.537.926,21 |
| **total** | **10.565** | **R$ 13.563.061,72** |

### ACHADO ESTRUTURAL: as duas trilhas quase não se encostam

- dos 3.360 registros de `baixas_pagamento` que têm `parcela_id`, **3.259
  (R$ 5.378.505,79) estão em parcelas que NENHUM pagamento da tabela
  `pagamentos` resolve**;
- no sentido inverso, só **31** pagamentos (R$ 35.501,86) têm baixa oficial viva
  na parcela resolvida — de 10.565;
- e **8.955 pagamentos (R$ 12.306.066,08) nunca receberam opinião nenhuma de
  conciliação** (`status_conciliacao` nulo): 84,8% da tabela.

Ou seja: a baixa oficial nasce do comprovante (fluxo do operador/gestão) e a
conciliação nasce do extrato, e hoje **são duas populações quase disjuntas**.
Esse é o motivo de fundo pelo qual os dois números divergiam tanto — não é um
bug de cálculo, é a ausência de uma referência persistida entre as duas trilhas
para 9.250 pagamentos.

---

## 3. Medição de cada classe de exceção em produção

Leitura de 20/10/2026, somente leitura. **Janela de 30 dias** = `data_pagamento`
entre 2026-09-20 e 2026-10-20 (1.240 pagamentos, R$ 1.009.275,18).

| Risco | Classe | Qtd (todas as datas) | Valor | Qtd (30 dias) | Valor (30 dias) |
|---|---|---:|---:|---:|---:|
| 1 CRÍTICO | `BAIXADO_SEM_BAIXA_OFICIAL` | **1.236** | **R$ 932.440,38** | **912** | **R$ 726.945,72** |
| 2 ALTO | `BAIXA_DEVOLVIDA_SEM_NOVA` | 69 | R$ 27.764,97 | 59 | R$ 24.057,31 |
| 3 ALTO | `PARCELA_JA_PAGA` | 66 | R$ 79.042,97 | 49 | R$ 55.083,40 |
| 4 MÉDIO | `AGUARDANDO_ACORDO_PARADO` (> 7 dias) | 217 | R$ 165.023,96 | 190 | R$ 149.196,61 |
| 5 BAIXO | `BAIXA_OFICIAL_SEM_CONCILIACAO_BAIXADO` | 30 | R$ 34.988,03 | 28 | R$ 34.675,80 |
| — | **pagamentos distintos em exceção** | **1.519** | **R$ 1.176.507,31** | **1.151** | **R$ 931.225,73** |

A soma das classes (1.618) é maior que os pagamentos distintos (1.519) porque um
pagamento pode cair em mais de uma classe — a view de exceções devolve **uma
linha por (pagamento, classe)**, de propósito, para que o contador de cada classe
seja o número inteiro dela.

### Decomposição da classe 1 — o que ela é de fato

Comparar sem decompor seria o erro: as 1.236 linhas **não** são 1.236 títulos em
aberto.

| Situação da parcela | Qtd | Valor |
|---|---:|---:|
| `PAGO`, baixada por `GATILHO_IMPORTACAO` — falta a trilha de quem assinou | 1.234 | R$ 931.267,51 |
| `PAGO`, baixada por `ADM` — mesma coisa | 1 | R$ 908,92 |
| `CANCELADA` — a obrigação não está quitada | 1 | R$ 263,95 |
| sem parcela vinculada | 0 | R$ 0,00 |

**Nenhum** caso de "CRM diz BAIXADO e a parcela segue aberta". O risco real desta
classe, hoje, é **ausência de trilha de responsável** sobre R$ 932.176,43 — não
título não quitado. A view traz isso na coluna `classe_motivo`, por linha.

### Por que N = 7 dias na classe 4, e por que o número não é frágil

Distribuição real dos 281 `AGUARDANDO_ACORDO`, por dias desde `conciliacao_em`:

| Faixa | Qtd | Valor | menor | maior |
|---|---:|---:|---:|---:|
| 0–3 | 10 | R$ 11.912,58 | 0 | 1 |
| 4–7 | 54 | R$ 44.578,76 | 4 | 7 |
| 8–14 | 67 | R$ 30.609,87 | **11** | 14 |
| 15–30 | 128 | R$ 121.711,77 | 15 | 29 |
| 30+ | 22 | R$ 12.702,32 | 32 | 35 |

**A faixa de 8, 9 e 10 dias está vazia.** Qualquer N entre 7 e 10 seleciona
exatamente o mesmo conjunto: 217 pagamentos, R$ 165.023,96. O corte não depende
de calibragem fina; 7 é o menor valor que não racha nenhuma faixa e equivale a
uma semana de operação.

### Como reproduzir cada número

Depois que a migration for aplicada, uma consulta por classe:

```sql
-- uma linha por classe, com quantidade e valor
select risco, risco_rotulo, classe, count(*) qtd, sum(valor_pago) valor
  from public.vw_central_financeira_pagamento_excecoes
 where data_pagamento between date '2026-09-20' and date '2026-10-20'
 group by 1, 2, 3
 order by 1;

-- e a classe 1 decomposta pelo que de fato aconteceu com a obrigação
select parcela_status, parcela_origem_baixa, count(*), sum(valor_pago)
  from public.vw_central_financeira_pagamento_excecoes
 where classe = 'BAIXADO_SEM_BAIXA_OFICIAL'
 group by 1, 2 order by 3 desc;
```

**Enquanto a migration não estiver aplicada**, os mesmos números saem rodando o
corpo da view como CTE — é literalmente o `SELECT` que está em
`supabase/migrations/20261020183000_central_financeira_dois_indicadores.sql`,
sem nenhuma alteração. Foi assim que esta medição foi feita, em conexão de
leitura.

---

## 4. Critérios de aceite

| Critério | Estado |
|---|---|
| A view existe como arquivo e **não** foi aplicada | `supabase/migrations/20261020183000_central_financeira_dois_indicadores.sql` existe; `apply_migration` **não** foi chamado, nenhum `db push`, conexão de leitura |
| Rollback irmão | `supabase/rollbacks/20261020183000_central_financeira_dois_indicadores.rollback.sql` |
| A tela mostra os dois indicadores sem misturar | dois painéis com cor, selo e borda próprios; duas colunas da tabela com fundo e borda distintos; a parcela entra como contexto discreto |
| Cada classe tem contagem e valor medidos em produção | tabela da seção 3, nas duas janelas |
| Testes passam no CI | 20 testes de banco em Postgres real (`supabase/tests/central_financeira_dois_indicadores.test.js`) + 8 testes de guarda do painel (`src/components/CentralFinanceiraIndicadores.test.js`). O número que vale é o do CI |
| Zero caminho de escrita | a migration só tem `CREATE VIEW` / `ALTER VIEW` / `GRANT SELECT` (teste F1 reprova qualquer DML, função, gatilho ou `SECURITY DEFINER`); as views não são atualizáveis (teste F2); o painel não tem `rpc`, `insert`, `update`, `delete`, `form` nem botão de ação (testes de guarda) |
| Zero sobreposição com #694 / #696 / #698 | nenhuma classe, filtro ou contador por parcela/acordo cancelado; nenhum toque no botão de Análise F1.b; nenhuma herança dono/caso |

### Permissão: a view não carrega privilégio nenhum

`security_invoker = true` (padrão do projeto desde `20260727170000`) +
`GRANT SELECT TO authenticated`. A view respeita a RLS de quem consulta: a
gestão (`usuario_e_gestao()`) vê tudo, o operador vê o que as políticas dele já
permitiam.

**Consequência tratada na tela:** um operador pode ver o pagamento dele e **não**
ver a parcela nem a baixa (são políticas diferentes). Nesse caso a coluna de
baixa oficial leria "não existe" **por falta de visibilidade, não por falta de
baixa** — justamente a confusão que esta frente existe para desfazer. Por isso a
aba é restrita aos três e-mails da gestão financeira, os mesmos que
`usuario_e_gestao()` aceita. A view **não** resolve isso com `SECURITY DEFINER`:
elevar privilégio aqui abriria leitura financeira para qualquer logado.

---

## 5. O que explicitamente NÃO está no escopo

- **Aplicar a migration.** Ela vai no PR como arquivo. Aplicar é decisão da
  gestão.
- **Qualquer escrita.** Nenhuma baixa, nenhuma conciliação, nenhum backfill,
  nenhum vínculo criado, nenhum `UPDATE` em `parcelas`, `pagamentos` ou
  `baixas_pagamento`. Nenhuma baixa automática, por ordem expressa.
- **Fila de pagamento em parcela ou acordo CANCELADO.** Essa classe existe e
  **pertence à PR #694** (32 pagamentos, R$ 88.502,95, migration não aplicada),
  que está bloqueada por decisão da gestão. Não há aqui classe, filtro nem
  contador por cancelamento. O único pagamento que hoje está nessa situação e é
  conciliado como `BAIXADO` continua aparecendo em `BAIXADO_SEM_BAIXA_OFICIAL`,
  porque atende à definição dessa classe — e a tela mostra `parcela CANCELADA`
  no motivo, sem criar fila para isso.
- **PR #696** (ocultar o botão Análise F1.b) e **PR #698** (reconciliação
  dono/caso; a herança dono/caso fica **desligada**): nada aqui as toca nem
  depende delas.
- **Criar a referência que falta** entre pagamento e parcela para os 9.250
  `SEM_PARCELA` — é escrita, e é a decisão da seção 6.
- **Motor de análise F1.b**, que já está inteiro em produção e não é o problema.
- **Qualquer ação em massa**, exportação ou acionamento.

---

## 6. Achados que exigem escrita ou decisão da gestão (não resolvidos aqui)

1. **Não existe referência persistida entre pagamento e parcela para 9.250 dos
   10.565 pagamentos.** A chave forte só existe porque o gatilho de importação a
   gravou em 1.237 casos — **7,5% das 16.550 parcelas**. Criar essa referência para o resto é escrita e precisa
   de regra de aceitação — a chave fraca por CPF+data+valor é ambígua em 399
   combinações e não serve.
2. **R$ 932.176,43 de parcela paga sem trilha de baixa oficial** (1.235 casos). A
   obrigação está `PAGO`, mas não há responsável, data de baixa nem
   comprovante em `baixas_pagamento`. Decidir o que fazer com o passivo — aceitar
   como baixa de máquina, ou exigir assinatura — é decisão da gestão, não de
   código.
3. **5 linhas de `baixas_pagamento` com `status_baixa = 'REALIZADA'` e
   `devolvido_em` preenchido**, e **429 com `status_baixa = 'DEVOLVIDA'` e
   `baixado_em` preenchido**. A view usa `devolvido_em` (a regra da trava em
   produção) e expõe `status_baixa` ao lado, para a divergência aparecer. Sanear
   o campo é escrita.
4. **8.955 pagamentos sem nenhuma conciliação** (`status_conciliacao` nulo,
   R$ 12.306.066,08). Eles antecedem o motor. A view os mostra como
   "(sem conciliação)" e eles não caem em classe nenhuma — nenhuma classe foi
   inventada para eles sem a gestão decidir o que significam.
5. **A tela é da gestão, não do operador**, pelo motivo de RLS da seção 4. Se a
   gestão quiser que o operador veja a sua própria fatia, isso exige decidir o
   que mostrar quando ele não pode ver a baixa — e não pode ser resolvido
   calando a diferença.

---

## Arquivos desta entrega

| Arquivo | O que é |
|---|---|
| `supabase/migrations/20261020183000_central_financeira_dois_indicadores.sql` | as duas views, `security_invoker`, `GRANT SELECT`. **NÃO aplicada** |
| `supabase/rollbacks/20261020183000_central_financeira_dois_indicadores.rollback.sql` | derruba as duas views; nenhum dado vive nelas |
| `supabase/tests/central_financeira_dois_indicadores.test.js` | 20 testes em Postgres real (PGlite) sobre a migration real |
| `src/components/CentralFinanceiraIndicadores.jsx` | o painel somente leitura |
| `src/components/CentralFinanceiraIndicadores.test.js` | 8 testes de guarda: nenhum caminho de escrita, as fontes não se misturam, portão da gestão |
| `src/pages/ConferenciaPagamentos.jsx` | só a montagem do painel (import + uma linha de JSX) |
