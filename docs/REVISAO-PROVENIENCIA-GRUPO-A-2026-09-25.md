# Revisão independente da prova de proveniência — grupo A

**25/09/2026 · leitura de produção · NADA APLICADO**

Revisão pedida antes de apresentar o grupo A como comprovadamente quitado pelo
acordo. Refiz a classificação **do zero**, com predicados próprios, sem partir da
lista do pacote de 24/09 — e depois comparei.

Projeto: `ahattpqrjmhkzsmnbdzs` (produção). Todas as consultas `SELECT`.

---

## 1. Primeiro, o número: não são 500

| figura | onde apareceu | situação |
|---|---|---|
| 521 | primeira contagem (538 − 17) | **errada**, superada |
| 500 | segunda contagem | **errada**, superada |
| **492** | após a prova de causalidade | **confirmada por esta revisão** |

O diagnóstico de 24/09 já havia corrigido os dois números. Esta revisão fecha em
**492**, pelo mesmo caminho e independentemente.

---

## 2. O ponto de partida está certo: `now()` não prova causa

`public.audit_log`:

```
id          bigint       -- sequencial
tabela      text
operacao    text
registro_id text
usuario     text
dados_antes  jsonb
dados_depois jsonb
criado_em   timestamptz  DEFAULT now()
```

`now()` em Postgres é o instante **da transação**, não do comando. Dois eventos
com `criado_em` idêntico estão na mesma transação — e **nada além disso**. Não
dizem qual causou qual, nem excluem um terceiro processo que tenha escrito os
dois.

O que existe de ordenação real é o **`id`**, que é sequencial e reflete a ordem
dos comandos dentro da transação. Não há `txid` gravado: a igualdade de
`criado_em` é o único identificador de transação disponível. Esse é o limite
honesto da evidência, e é por isso que o timestamp **não pode ser a prova
principal** — só o recorte dentro do qual a ordem e o conteúdo passam a valer.

---

## 3. Reconstrução independente

### 3.1 População

Título com `situacao = PAGO` cujo `acordo_id` aponta para acordo `ATIVO`:

| | |
|---|---:|
| títulos | **538** |
| acordos | 167 |
| valor | **R$ 844.254,89** |
| `tipo_boleto = 'Acordo'` | 17 |
| `origem_liquidacao` não nula | **0** |
| `origem_encerramento` não nula | **0** |

### 3.2 Assinatura de campos alterados no evento que produziu o PAGO de hoje

Para cada título, o **último** evento de `audit_log` que levou `situacao` a
`PAGO`, e o conjunto exato de chaves cujo valor mudou entre `dados_antes` e
`dados_depois`:

| assinatura | títulos | é boleto do acordo | motivo nomeia **este** acordo | valor |
|---|---:|---:|---:|---:|
| `atualizado_em, situacao, status` | 265 | 17 | 0 | R$ 570.701,25 |
| `atualizado_em, motivo_ajuste, situacao, status` | 173 | 0 | **173** | R$ 173.773,28 |
| `atualizado_em, situacao` | 74 | 0 | 0 | R$ 91.598,39 |
| `acordo_id, atualizado_em, motivo_ajuste, situacao, status` | 21 | 0 | 21 | R$ 8.181,97 |
| `atualizado_em, motivo_ajuste, saldo_corrigido, situacao, status, valor_em_aberto` | 5 | 0 | 0 | R$ 0,00 |
| | **538** | | | |

**Nenhum título sem evento. Nenhuma assinatura desconhecida.** 538 fecha sem
resto — o que importa, porque assinatura não reconhecida deveria virar exceção,
não entrar no lote por omissão.

### 3.3 A janela por `audit_log.id`

Para cada título, procurei o evento de `acordos` que levou **aquele** acordo a
`QUITADO`, na mesma transação e com `id` menor que o do título; e o evento do
**próximo** acordo quitado na mesma transação.

| grupo | títulos | sem evento de acordo→QUITADO na transação | fora da janela | dentro da janela |
|---|---:|---:|---:|---:|
| A1 | 173 | 0 | **0** | 173 |
| A2 (antes de tirar E2) | 322 | 0 | **0** | 322 |
| C | 17 | 0 | 0 | 17 |
| D | 21 | **21** | 0 | 0 |
| E1 | 5 | **5** | 0 | 0 |

Duas leituras importantes:

- **A1 e A2: nenhum título fora da janela e nenhum escrito antes do seu acordo.**
  É o padrão de gatilho — o `UPDATE` do título roda dentro dos AFTER triggers do
  `UPDATE` daquele acordo. Um backfill em bloco (`update acordos…;` depois
  `update acordos_titulos…`) poria todos os títulos depois de todos os acordos, e
  não é o que se vê.
- **D e E1 não têm evento de acordo→QUITADO na transação.** Não foi o acordo que
  os quitou. Isto é prova pelo lado negativo, e vale mais do que a ausência de
  assinatura: confirma que a separação não é estética.

### 3.4 Valor tocado depois, e liquidação independente

| grupo | títulos | valor mexido em evento **posterior** | pagamento próprio | conferência | solicitação |
|---|---:|---:|---:|---:|---:|
| A1 | 173 | **0** | 0 | 0 | 0 |
| A2 | 322 | **3** | 0 | 0 | 0 |
| C | 17 | 0 | 0 | 0 | 0 |
| D | 21 | 0 | 0 | 0 | 0 |
| E1 | 5 | 0 | 0 | 0 | 0 |

Os **3** de A2 com valor mexido depois são o grupo **E2**: o PAGO veio do acordo,
mas um evento posterior zerou `saldo_corrigido` e `valor_em_aberto`. O estado de
hoje tem duas causas sobrepostas — saem do lote.

**A2 = 322 − 3 = 319.**

Nenhum título dos 538 tem registro independente de liquidação: `origem_liquidacao`
e `origem_encerramento` nulas, zero casamento em `pagamentos.titulo_numero`, zero
em `conferencia_pagamentos.titulo_numero`, zero em
`solicitacoes_confirmacao_pagamento.titulo_id`. É o que torna o **grupo B vazio**,
e é uma afirmação verificável, não uma suposição.

### 3.5 Vínculo coerente dentro do grupo A

Risco que precisava ser descartado: se a coluna `acordo_id` e a tabela
`acordo_titulo_vinculo` discordassem (como no caso Suelen), a proveniência
gravaria o acordo errado.

| | |
|---|---:|
| grupo A | **492** |
| sem vínculo ativo | **0** |
| com mais de um vínculo ativo | **0** |
| vínculo apontando para acordo diferente da coluna | **0** |

A divergência do tipo Suelen **não ocorre** dentro dos 492.

---

## 4. Correção que esta revisão faz na prova

O diagnóstico de 24/09 afirma, sobre a evidência de conteúdo:

> *"O conjunto exato de campos alterados naquele UPDATE casa com uma função
> conhecida, **e só uma**"*

**Isso está mais forte do que os dados sustentam.** Levantei as funções que
escrevem `situacao = 'PAGO'` em `acordos_titulos`: são **13**, e **três** delas
gravam o texto `quitada junto com o acordo`:

| função | grava o motivo com o nº do acordo | zera saldo |
|---|---|---|
| `_titulo_quita_com_o_acordo` | sim | não |
| `titulo_reavaliar` | sim | não |
| `vincular_titulos_acordo` | sim | não |
| `quitar_e_encerrar_caso` | não | **sim** |
| (outras 9) | não | não |

Ou seja: a assinatura **não identifica uma única função**. O que ela identifica é
uma **família** — e é aqui que a conclusão sobrevive:

1. **`vincular_titulos_acordo` grava `acordo_id` no mesmo UPDATE** (está
   vinculando). Os 492 não têm `acordo_id` na assinatura: o vínculo já existia
   antes da quitação. Quem tem `acordo_id` na assinatura são exatamente os 21 do
   grupo D.
2. **`_titulo_quita_com_o_acordo` e `titulo_reavaliar` são ambos disparados por
   gatilho na transição de status do acordo** — `trg_titulo_quita_com_o_acordo` e
   `trg_acordo_status_reavalia_titulos`, os dois `after update of status on
   acordos`. Qualquer das duas que tenha escrito, **a causa é a mesma**: aquele
   acordo virando QUITADO.
3. **A janela (§3.3) fecha o argumento.** O evento do título está entre o evento
   do seu acordo e o do próximo — o que só acontece se o `UPDATE` do título rodou
   dentro dos AFTER triggers daquele `UPDATE` de acordo.

**Conclusão:** a causalidade se sustenta, mas por um motivo ligeiramente
diferente do afirmado. Não é "a assinatura aponta uma função"; é **"a assinatura
exclui o caminho de vínculo e de quitação manual, e a janela prende o evento
dentro da transição daquele acordo"**. Recomendo corrigir a frase no diagnóstico.

Verificação no código, para ancorar a assinatura em algo que não é forma de dado:

- `_titulo_quita_com_o_acordo` escreve `situacao`, `status`, `motivo_ajuste`
  (concatenando `'quitada junto com o acordo ' || new.numero_acordo`) e
  `atualizado_em`, com `where t.acordo_id = new.id and coalesce(t.tipo_boleto,'')
  <> 'Acordo'` — **exatamente a assinatura de A1**, e o número gravado é o do
  acordo que disparou o gatilho.
- `titulos_por_status_acordo` escreve **só** `situacao` e `atualizado_em`, com
  `join acordo_titulo_vinculo v on v.acordo_id = new.id` e **sem** filtrar
  `tipo_boleto` — **exatamente a assinatura de A2**, e a origem dos 17 do grupo C.
  O `status` que aparece em parte de A2 vem do gatilho de coerência
  `_titulo_situacao_e_status_coerentes`; nas linhas de agosto, anteriores a ele, o
  `status` nem mudou — o que explica a variante `atualizado_em, situacao`.

---

## 5. Resultado da revisão

| grupo | o que é | prova que o sustenta | títulos | valor | destino |
|---|---|---|---:|---:|---|
| **A1** | motivo nomeia **este** acordo; sem `acordo_id` no evento; dentro da janela; valor intocado; sem liquidação independente | conteúdo + ordem + ausência de valor + ausência de liquidação | **173** | R$ 173.773,28 | volta a NEGOCIADO |
| **A2** | assinatura de `titulos_por_status_acordo`; motivo intacto; dentro da janela; valor intocado antes e depois; sem liquidação independente | idem | **319** | R$ 656.268,85 | volta a NEGOCIADO |
| | **A = A1 + A2** | | **492** | **R$ 830.042,13** | |
| **B** | pagamento ou baixa própria | — | **0** | — | — |
| **C** | `tipo_boleto = 'Acordo'` — nunca foi dívida | conteúdo do título | 17 | R$ 6.030,79 | **exceção** |
| **D** | `acordo_id` gravado no mesmo UPDATE + motivo Prime portador 195; **nenhum** evento de acordo→QUITADO na transação | ordem (ausência) + conteúdo | 21 | R$ 8.181,97 | **exceção** |
| **E1** | `saldo_corrigido` e `valor_em_aberto` zerados no próprio evento; sem evento de acordo na transação | conteúdo + ordem (ausência) | 5 | R$ 0,00 | **exceção** |
| **E2** | PAGO veio do acordo, mas evento **posterior** mexeu no valor | ordem (posterior) | 3 | R$ 0,00 | **exceção** |
| | **exceções** | | **46** | R$ 14.212,76 | |
| | **total** | | **538** | R$ 844.254,89 | |

**Nenhum título mudou de grupo em razão desta revisão.** Os 492 se sustentam;
as 46 exceções continuam fora. Se algum título tivesse falhado numa das quatro
evidências, ele sairia para exceção — não saiu nenhum, e não havia assinatura
desconhecida para decidir.

E o grupo **G1** (65 títulos NEGOCIADO em acordo QUITADO, R$ 41.642,41) **não
depende de prova de causalidade**: é a regra de hoje aplicada a registro que o
motor nunca visitou. Os 44 acordos têm 58 parcelas, todas PAGO.

---

## 6. O que continua sendo limite, e não deve ser apresentado como prova

Registro explícito, para não se perder na próxima leitura:

1. **Não existe `txid` no `audit_log`.** "Mesma transação" é inferida por
   `criado_em` igual. É forte na prática (precisão de microssegundo) mas é
   inferência.
2. **`audit_log` não grava qual função escreveu.** A atribuição é por assinatura
   de campos + janela, nunca por identidade declarada. Se alguém criar uma
   função nova com a mesma assinatura, a inferência enfraquece — e é por isso que
   o arquivo 1 do pacote passa a gravar **proveniência explícita**
   (`quitacao_origem`), para que a próxima geração não dependa de arqueologia.
3. **A prova é sobre o estado de hoje**, a partir do *último* evento que levou a
   PAGO. Um título que foi a PAGO, voltou e foi de novo tem só o último evento
   avaliado — que é o correto para decidir o estado atual, mas não descreve a
   história inteira.
4. **Os guards do arquivo 3 recalculam as quatro evidências no momento da
   aplicação.** Se a base tiver mudado entre 25/09 e a execução, a transação
   aborta. Isto vale mais do que a lista: a lista é a fotografia, o guard é a
   regra.
