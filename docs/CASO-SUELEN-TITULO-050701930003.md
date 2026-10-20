# Caso Suelen Rossi Machado — título 050701930003

**25/09/2026 · leitura de produção · NADA APLICADO · NENHUMA OPÇÃO ESCOLHIDA**

Arquivo separado de propósito: este caso não entra em nenhum lote. O SQL
correspondente (`supabase/aguardando_aprovacao/20260924_4_suelen_titulo_050701930003.sql.pendente`)
tem **zero comandos de escrita executáveis** — só o bloco de conferência, 100%
`SELECT`. As duas opções estão escritas e **as duas estão comentadas**.

---

## 1. Os fatos, conferidos em produção

| | |
|---|---|
| título | `caa99e1e-4f70-48c6-9a37-0993e75fa306` |
| documento | `050701930003` |
| situação / status | `NEGOCIADO` / `vinculada` |
| valor | **R$ 428,72** |
| vencimento | 28/10/2026 |
| `tipo_boleto` | **`Acordo`** |
| `acordos_titulos.acordo_id` | **3528 — ATIVO** |
| `acordo_titulo_vinculo` | **3609 — CANCELADO** (linha `ativo = true`) |

As duas representações do vínculo **discordam**. É a única divergência desse
tipo relevante aqui: dentro dos 492 do grupo A não existe nenhuma
([revisão](REVISAO-PROVENIENCIA-GRUPO-A-2026-09-25.md), §3.5).

## 2. Qual é o acordo certo: 3528

A prova não depende de data nem de valor isolado — depende de **número de
boleto**, que é identificador:

1. O documento `050701930003` é `'0' + 50701930003`, e `50701930003` é o
   `parcelas.boleto` da **parcela 2 do acordo 3528**: R$ 428,72, vencimento
   28/10/2026, `A_VENCER`. Número, valor e vencimento batem os três.
2. **3609 é duplicata de 3528.** Mesmo `valor_total` (R$ 1.714,89), mesma
   quantidade de parcelas (4), criado em 27/08 13:31 e cancelado em 27/08 14:47
   — **1h16 depois**. Todas as suas parcelas estão `CANCELADA`, e nenhuma delas
   tem número de boleto.
3. **O dinheiro está no 3528:** entrada de R$ 1.000,00 paga em 25/08 e parcela 1
   de R$ 428,72 paga em 08/09. O 3609 nunca recebeu nada.

## 3. Onde a dobra existe — e onde não existe

Isto precisa ser dito por função, porque **as duas funções de saldo tratam este
título de formas diferentes**:

| função | filtra `tipo_boleto <> 'Acordo'` | o título conta hoje? |
|---|---|---|
| `aluno_saldo_pendente_detalhe` | **sim** | **não** — já está fora |
| `saude_carteira_panorama` | não | **sim** — conta R$ 428,72 |
| `carteira_2026_1_classificar` | não | sim, no balde "Negociado" |

A parcela 2 do 3528 conta nas três (acordo ATIVO, parcela `A_VENCER`).

**Logo: a dobra de R$ 428,72 é real em `saude_carteira_panorama`** (e o valor
aparece duas vezes: como título negociado órfão e como parcela do acordo), **e
não existe em `aluno_saldo_pendente_detalhe`**, que é a função da ficha do aluno.

Por que o título é "órfão" para o panorama: o `not exists` dele procura vínculo
ativo para acordo **não cancelado**. O vínculo da Suelen aponta para o 3609, que
está `CANCELADO` — então o teste passa e o título entra na conta.

## 4. Como ficou preso (audit_log do título)

| quando | o que aconteceu |
|---|---|
| 31/08 22:29 | rotina vincula ao **3609**, que já estava cancelado |
| 01/09 00:07 | volta a `ABERTO` |
| 01/09 17:24 | rotina vincula ao **3528**, mas **pela coluna** `acordo_id` |
| 09/09 12:26 | volta a `ABERTO` |
| 10/09 14:44 | Amanda vincula de novo ao **3528**, também pela coluna |

A linha de `acordo_titulo_vinculo` **nunca saiu do 3609**. É daí que vem a
divergência: a coluna foi corrigida três vezes, a tabela de vínculo nenhuma.

---

## 5. As duas opções, lado a lado

Nenhuma está escolhida. Nenhuma é executável no estado atual do arquivo.

| | **Opção 1** — mover o vínculo para o 3528 | **Opção 2** — marcar `situacao = DUPLICADA` |
|---|---|---|
| **parcela** | nenhuma parcela alterada. A parcela 2 do 3528 segue `A_VENCER`, R$ 428,72, venc 28/10 | idêntico: nenhuma parcela alterada |
| **saldo — `aluno_saldo_pendente_detalhe`** | **R$ 0,00 de efeito**: o título já está fora por `tipo_boleto = 'Acordo'` | **R$ 0,00 de efeito**, pelo mesmo motivo |
| **saldo — `saude_carteira_panorama`** | **−R$ 428,72**: passa a existir vínculo ativo para acordo não cancelado, e o `not exists` exclui o título | **−R$ 428,72**: `DUPLICADA` sai do filtro `situacao in (ABERTO, NEGOCIADO)` |
| **vínculo** | a linha passa a apontar para o **3528**; coluna e tabela ficam **iguais** | a linha **continua no 3609 cancelado**; a divergência permanece de pé |
| **exibição no CRM** | segue na lista de mensalidades com tag "Negociado" e a linha "vinculada ao acordo — não somada de novo no total" | sai da leitura de dívida da ficha; tag "Fora da conta", fundo neutro |
| **composição do acordo** | o boleto da parcela aparece ao lado das parcelas do **mesmo** acordo — exatamente o que a rotina de 01/09 registrou como problema | o título sai da composição; quem abre o acordo vê só as parcelas |
| **efetividade (`carteira_2026_1_classificar`)** | continua no balde "Negociado" | sai do balde "Negociado" |
| **o que fica sem resolver** | o título segue com `tipo_boleto = 'Acordo'` dentro da lista de mensalidades | a divergência de vínculo continua, e pode reaparecer na próxima rotina que leia `acordo_titulo_vinculo` |
| **reversão** | trivial — rollback pronto, por id | trivial — rollback pronto, por id |

### As duas podem ser combinadas

Mover o vínculo **e** marcar `DUPLICADA` resolve os dois resíduos: a coluna e a
tabela passam a concordar, e o título sai da leitura de dívida. É a única
combinação que não deixa ponta solta — mas é **duas** decisões, e nenhuma está
tomada.

### O que nenhuma das duas faz

- Não toca em parcela, pagamento, baixa, acordo ou valor.
- Não mexe em autoria histórica.
- Não altera o saldo da ficha do aluno (`aluno_saldo_pendente_detalhe`).

---

## 6. Correção que esta revisão faz no diagnóstico de 24/09

O diagnóstico apresenta o efeito de cada opção como **"−R$ 428,72"** no saldo,
sem qualificar. Medido: isso vale para `saude_carteira_panorama` e para
`carteira_2026_1_classificar`, e **não** vale para
`aluno_saldo_pendente_detalhe`, onde o efeito é **zero** porque o título já é
excluído por `tipo_boleto = 'Acordo'`.

A diferença importa na hora de conferir o antes/depois: quem olhar o saldo da
ficha da aluna **não vai ver mudança nenhuma**, e isso é o esperado, não um sinal
de que a correção falhou.
