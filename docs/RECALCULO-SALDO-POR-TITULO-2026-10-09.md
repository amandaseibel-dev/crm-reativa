# Recálculo de saldo por título — aluno sem caso (09/10/2026)

> **Sem dado pessoal.** Repositório público, §7 de
> [`PREMISSA_SEGURANCA_PROJETO.md`](seguranca/PREMISSA_SEGURANCA_PROJETO.md).

**Estado:** código e SQL **propostos em PR**. As duas migrations estão em
`supabase/aguardando_aprovacao/` e **não foram aplicadas**. Nada em produção foi
alterado por esta frente.

## O defeito, medido

| | alunos | valor em títulos cobráveis |
|---|---|---|
| `saldo_total` **nulo** | **485** | **R$ 692.047,04** |
| `saldo_total` **zero** | 22 | R$ 70.179,08 |
| saldo preenchido (saudáveis) | 13.090 | R$ 45.434.183,12 |

Os **13** alunos do borderô 723 que motivaram a frente (**R$ 79.856,84**) são um
subconjunto dos 485. **A inconsistência é sistêmica, não daquele borderô.**

Dívida que existe em `acordos_titulos` e não aparece no campo que a carteira, as
filas e os indicadores leem — 39 funções do banco leem `alunos.saldo_total`.

## A causa: nada recalcula o saldo de um aluno sem caso

Duas metades da mesma coisa.

**1. `acordos_titulos` não tem gatilho de recálculo.** Todas as outras tabelas
financeiras têm:

| tabela | gatilho |
|---|---|
| `acordos` | `trg_recalc_acordo` |
| `parcelas` | `trg_recalc_parcela` |
| `baixas_pagamento` | `trg_recalc_baixa` |
| `solicitacoes_confirmacao_pagamento` | `trg_recalc_conf` |
| `termos_acordo` | `trg_recalc_termo_ins` / `_upd` |
| `acordo_titulo_vinculo` | `trg_recalc_vinculo_ins` / `_upd` |
| **`acordos_titulos`** | **nenhum** |

O borderô grava mensalidade em `acordos_titulos` — e só ali. Nenhum gatilho
dispara.

**2. A virada diária varre `from public.casos c`.** `recalcular_situacao_virada_diaria`
itera sobre casos; quem não tem caso não está na varredura, e por isso nem a
virada do dia seguinte corrige. (Dos 14 CPFs do borderô, a única com saldo
calculado foi a que estava em atendimento: algum outro evento disparou o
recálculo. Os outros 13 ficaram como estavam.)

`recalcular_situacao_aluno` **já sabe somar título** — o bloco `v_tit_val` lê
`acordos_titulos` pela regra canônica (ABERTO/NEGOCIADO, `status <> quitada`,
`tipo_boleto <> 'Acordo'`, sem vínculo a acordo vivo, não superado por acordo).
**Não há regra nova nesta frente**: o que faltava era chamar a função.

## A correção: fila, não recálculo dentro do gatilho

`recalcular_situacao_aluno` faz várias consultas por aluno. O borderô 723 tem
2.155 linhas e grava em lotes de 500 — recalcular dentro do gatilho seriam até
500 execuções da função dentro de **uma** instrução, com risco real de estourar
o tempo da requisição e derrubar uma importação financeira pela metade.

Então:

1. **gatilho de INSTRUÇÃO** (não de linha) em `acordos_titulos`, com tabela de
   transição, fazendo uma escrita barata: enfileira os `aluno_id` **distintos**
   em `recalculo_saldo_pendente` (RLS deny-all, sem grant);
2. **`recalculo_saldo_pendente_processar(p_limite, p_lote)`** drena a fila
   chamando a função canônica. Só gestão/`service_role`. Idempotente: a linha
   sai da fila quando o recálculo passa e **fica** quando falha;
3. **o importador drena no mesmo ato**, em voltas de 500 com teto de 10, para o
   saldo já estar certo quando a operadora abrir a tela. Fail-soft: saldo é
   campo derivado e não derruba a importação, que é o ato financeiro.

A fila é durável — se o dreno não rodar, o pendente continua registrado.

## Reflexos validados (leitura em produção, antes de aplicar)

Projeção para os 13:

| | |
|---|---|
| saldo_total projetado | **R$ 79.856,84** |
| saldo_vencido projetado | R$ 79.856,84 (todos os títulos já vencidos) |
| viriam para `COBRANCA_VENCIDA` | 13 |
| casos afetados | **0** (nenhum dos 13 tem caso) |
| abaixo do mínimo de fila (R$ 5,00) | 0 — nenhum é escondido como resíduo |
| em `carteira_operador` | **0** — nenhuma carteira muda de tamanho |
| já tinham `situacao_operacional` ou `data_retorno` | **0** |

O ajuste **só acrescenta** informação: nada é deslocado de fila, nenhum
responsável muda, nenhum campo humano é sobrescrito. `recalcular_situacao_aluno`
escreve em `casos` e `alunos` (criticidade, situação, próxima ação, saldos,
retorno) — **nunca** em título, acordo, parcela, pagamento, baixa, movimentação
ou solicitação.

## Testes

`supabase/tests/recalculo_saldo_por_titulo.test.js` — **14 casos**, com a
migration rodando inteira num Postgres de verdade e descartável:

- a fila nasce com RLS ligada **e forçada**, sem grant a `anon`/`authenticated`;
- os três gatilhos são de **instrução**, não de linha;
- 6 títulos do mesmo aluno numa instrução → **1** linha de fila (e os 6 títulos
  continuam 6: nada duplicado, nada perdido);
- 500 alunos numa instrução → 500 linhas, uma por aluno;
- `UPDATE` e `DELETE` também enfileiram; título sem `aluno_id` não entra;
- o dreno preenche saldo e esvazia a fila; **não altera título** (mesma contagem
  e mesmo valor depois); é idempotente; não inventa saldo para boleto do próprio
  acordo nem para título `quitada`;
- **quem falha fica na fila**, não desaparece;
- o dreno recusa quem não é gestão nem `service_role`, recusa limite fora da
  faixa, e `anon` não tem `execute`.

O `recalcular_situacao_aluno` é **dublado** no teste, e o cabeçalho do arquivo
diz por quê: são 13 mil caracteres dependendo de uma dezena de tabelas, e é
função que já está em produção e esta frente não toca. O dublê soma pela mesma
regra canônica — o que se prova aqui é a **ligação**, que é o que esta frente
constrói.

## Pendências

1. **Aplicar as duas migrations** (estrutural e retroativa dos 13) depende de
   autorização. A retroativa tem portão: aborta se a regra não achar exatamente
   13, se a dívida se mover, se aparecer caso, ou se o saldo somado não fechar
   em R$ 79.856,84. Rollback ao lado.
2. **Os outros 472 alunos** (485 − 13) continuam com saldo nulo, R$ 612.190,20.
   O dreno resolve todos com uma chamada maior, mas isso é população muito maior
   e merece decisão própria — pode mover gente para a fila.
3. **A virada diária continua varrendo `from casos`.** Ligar o dreno à virada
   (ou a um cron próprio) é o passo que fecha o buraco para sempre; não entra
   aqui porque exigiria reescrever `recalcular_situacao_virada_diaria`, função de
   produção que esta frente não toca.
