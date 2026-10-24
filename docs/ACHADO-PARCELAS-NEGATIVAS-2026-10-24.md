# ACHADO — duas parcelas vivas de valor negativo

**Data:** 2026-10-24 · **Natureza:** SOMENTE LEITURA · **PROD:** `ahattpqrjmhkzsmnbdzs`

**Nada foi corrigido.** Por decisão da gestão, este achado é registrado e não
tratado nesta etapa. Nenhuma parcela, acordo, pagamento ou saldo foi alterado.

## Como apareceu

Na validação da migration `20261024113549` (filtros de curso e semestre da
Minha Carteira), uma ficha voltou com `acordo_indeterminado = −0,02`. O meu
teste sintético assertava zero valores negativos e a produção não é zero, então
fui ver de onde vinha o sinal.

**Não é defeito da função.** Ela soma `parcelas.valor` fielmente; o negativo
está no dado.

## O que existe na base

Duas parcelas **vivas** (`parcela_viva(status)` verdadeiro) com valor negativo,
somando **−R$ 0,06**:

| Parcela | Valor | Status | Vencimento | Acordo | nº ULBRA | Status do acordo | Parcelas no acordo | Responsável da ficha |
|---|---:|---|---|---|---|---|---:|---|
| `3e89442a-5785-4aea-a0d3-8b64d4323c09` | **−0,04** | VENCIDA | 2026-01-21 | `d82daef2-8faf-4f71-b96d-76847731c562` | **50223** | **ATIVO** | **1** | (sem responsável) |
| `188977d7-253f-4c47-8b6b-1a57adba9e5f` | **−0,02** | VENCIDA | 2026-03-23 | `160761d2-99d7-4d82-abf5-b606c4f07d3d` | **56356** | **ATIVO** | **1** | `cobranca11@aelbra.com.br` |

## O que é estranho, e é mais do que centavos

O valor é irrisório, mas a **forma** não é:

1. **Cada acordo tem UMA parcela só, e ela é o acordo inteiro.** `soma_do_acordo`
   = `soma_vivas` = o próprio valor negativo. Não é um ajuste de arredondamento
   convivendo com parcelas positivas: é um acordo cujo **saldo total é
   negativo**.
2. **Os dois acordos estão `ATIVO`** — não quitados, não cancelados. Pela regra
   em vigor, acordo ATIVO com parcela viva é dívida a cobrar.
3. **A parcela está `VENCIDA`**, com vencimento em janeiro e março de 2026. Ou
   seja: há meses o sistema carrega duas cobranças vencidas de valor negativo.
4. **Uma delas está na carteira de um operador** (`cobranca11@`). Pela RPC nova,
   essa ficha aparece com `acordo_indeterminado = −0,02` — o operador vê dois
   centavos negativos de "dívida".

## O que isto NÃO é

- **Não é efeito das migrations desta frente.** As duas aplicadas
  (`20261023204232` e `20261024113549`) têm `tem_escrita_ou_drop = false` e um
  único statement de `create or replace function`, verificado no próprio
  registro do Supabase. Elas não escreveram em tabela alguma.
- **Não é novo.** Os vencimentos são de 2026-01-21 e 2026-03-23; o dado
  antecede esta frente em meses.
- **Não é material em valor.** −R$ 0,06 no total.

## Por que ainda assim vale registrar

Porque um acordo ATIVO de saldo negativo é um estado que nenhuma regra prevê, e
ele atravessa as telas de saldo sem ninguém notar — foi preciso uma função nova
assertar "nenhum valor negativo" para ele aparecer. Se existem dois hoje, o
caminho que os criou pode criar outros, e aí o valor deixa de ser irrisório.

**A pergunta que fica, e que este documento não responde:** o que gerou uma
parcela única de valor negativo? As hipóteses plausíveis são um ajuste de
centavos aplicado sobre uma parcela já quitada, ou uma reconstrução de acordo
que rateou sobras. Determinar isso exige olhar a trilha de cada acordo, e **não
foi feito** — está fora do que a gestão autorizou nesta etapa.

## Como reconferir

```sql
select p.id, p.valor, p.status, p.vencimento,
       ac.id acordo_id, ac.numero_ulbra, ac.status acordo_status,
       (select count(*) from public.parcelas x where x.acordo_id = ac.id) parcelas_do_acordo,
       (select round(sum(x.valor),2) from public.parcelas x where x.acordo_id = ac.id) soma_do_acordo
  from public.parcelas p
  join public.acordos ac on ac.id = p.acordo_id
 where public.parcela_viva(p.status) and p.valor < 0
 order by p.valor;
```

## Encaminhamento sugerido, para decisão da gestão

Nada aqui é para ser executado sem autorização própria.

1. **Investigar a origem** dos dois acordos na trilha (`audit_log`,
   `aluno_movimentacoes`), para saber se o caminho que os criou está vivo.
2. **Decidir o desfecho** de cada um: encerrar o acordo, zerar a parcela ou
   deixar como está e apenas suprimir o sinal negativo na exibição.
3. **Avaliar uma guarda** que recuse parcela de valor negativo na entrada, se a
   investigação mostrar que o caminho segue aberto.

Enquanto isso, a RPC da Minha Carteira continua mostrando o dado como ele é —
sem esconder o sinal, porque esconder transformaria um dado estranho num dado
invisível.
