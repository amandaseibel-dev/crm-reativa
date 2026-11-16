# Medição de caixa e saldo por semestre — 15/11/2026

Leitura somente de consulta (SELECT), no projeto Supabase `ahattpqrjmhkzsmnbdzs`.
Nenhuma função foi criada, nenhum snapshot foi atualizado, nada foi escrito.

## Consultas e resultados

1. Invariante da view de caixa contra `pagamentos`:
   `select count(*), sum(valor_pago) from efetividade_caixa_origem` e o mesmo sobre `pagamentos`.
   Resultado: 11.630 linhas e R$ 14.784.623,69 nos dois lados.

2. Caixa por semestre de origem, critério PROVADA + BAIXADO:
   - 2026/1: 639 pagamentos, R$ 535.206,14; fora do caixa: 1.340 pagamentos, R$ 3.314.532,12.
   - 2026/2: 594 pagamentos, R$ 653.066,80; fora do caixa: 84 pagamentos, R$ 120.444,29.
   - Sem origem determinada (INDETERMINADA): 8.675 pagamentos, R$ 9.908.460,55.

3. Carteira 2026/2 pelo classificador `carteira_2026_2_classificar()`:
   - 10.822 títulos, valor original R$ 17.232.872,41 (bate com `carteira_2026_2_contexto`).
   - Saldo fora de CANCELADO: R$ 16.042.642,07.
   - Conferência R$ 7.232.872,33; acadêmico R$ 111.923,90; (sem pendência removido do contrato: incluía CONVERTIDO e não é partição);
     acordos ativos R$ 239.654,71.
   - `carteira_2026_2_negociacoes().total.saldo` = R$ 245.326,06 = acordos ativos
     (R$ 239.654,71) + acordos cancelados (R$ 5.671,35). Não é o saldo total.

4. Fotografia 2026/1 `carteira_efetividade_ler('seis_linhas','2026','1')`: entrou R$ 21.710.447,29;
   em aberto R$ 9.055.032,58; negociado R$ 4.535.961,61; pago por rateio R$ 6.219.804,34.
   Snapshot com `atualizacao_pendente = true`. Os números são antigos e não foram recalculados.

## Limites declarados

- O custo do classificador de 2026/2 em produção não foi medido. A RPC o chama a cada leitura.
- O percentual é caixa confirmado identificado ÷ carteira original. Não é recuperação total.
- Os testes SQL usam stubs de view, classificador e fotografia. Não provam a execução contra
  a view real.

## Anexo — consultas exatas e saídas (leitura, 15/11/2026)

Saídas copiadas do retorno das consultas, sem arredondamento além do que o banco devolveu.

A. Caixa por semestre (critério PROVADA + BAIXADO):
```sql
select s.sem,
       count(*) filter (where coalesce(confianca='PROVADA' and status_conciliacao='BAIXADO',false)) pagamentos_confirmados,
       coalesce(sum(valor_pago) filter (where coalesce(confianca='PROVADA' and status_conciliacao='BAIXADO',false)),0) caixa_confirmado,
       count(*) filter (where not coalesce(confianca='PROVADA' and status_conciliacao='BAIXADO',false)) pagamentos_pendentes,
       coalesce(sum(valor_pago) filter (where not coalesce(confianca='PROVADA' and status_conciliacao='BAIXADO',false)),0) pendente_classificacao,
       max(data_pagamento) data_referencia
  from (values ('2026/1'),('2026/2')) s(sem)
  left join efetividade_caixa_origem e on e.semestre_origem = s.sem
 group by s.sem order by s.sem;
```
Saída: 2026/1 — 639 / 535206.14 / 1340 / 3314532.12 / 2026-11-13. 2026/2 — 594 / 653066.80 / 84 / 120444.29 / 2026-11-13.

B. Sem origem determinada:
```sql
select coalesce(sum(valor_pago),0), count(*) from efetividade_caixa_origem where confianca='INDETERMINADA';
```
Saída: 9908460.55 em 8675 pagamentos.

C. Carteira 2026/2 e saldo pelo classificador:
```sql
select count(*) titulos, round(sum(valor_original),2) carteira,
       round(sum(saldo) filter (where faixa<>'CANCELADO'),2) saldo_total_nao_cancelado,
       round(sum(saldo) filter (where faixa='EM_CONFERENCIA'),2) saldo_em_conferencia,
       round(sum(saldo) filter (where faixa='ACADEMICO'),2) saldo_academico,
       round(sum(saldo) filter (where acordo_id is not null and acordo_estado in ('regular','atraso','quebrado') and faixa<>'CANCELADO'),2) saldo_acordo_ativo
  from carteira_2026_2_classificar();
```
Saída: 10822 / 17232872.41 / 16042642.07 / 7232872.33 / 111923.90 / 8697845.84 / 239654.71.

D. Negociações 2026/2 (total):
```sql
select carteira_2026_2_negociacoes();
```
Saída (campo total): saldo 245326.06, negociado 1232903.01, recebido 987576.95.
Decomposição: saldo de acordos ativos 239654.71 (C) + cancelados 5671.35 = 245326.06.

E. Fotografia 2026/1:
```sql
select carteira_efetividade_ler('seis_linhas','2026','1');
```
Saída: entrou 21710447.29 com 14979 títulos; em_aberto 9055032.58; negociado 4535961.61; pago (rateio) 6219804.34; `atualizacao_pendente = true`.

F. Percentuais derivados (caixa ÷ carteira, em %):
- 2026/1: 535206.14 ÷ 21710447.29 × 100 = 2,46 → 2,5%.
- 2026/2: 653066.80 ÷ 17232872.41 × 100 = 3,79 → 3,8%.
Observação: o denominador de 2026/2 inclui títulos cancelados (a carteira original soma todos). Os percentuais são de fontes com datas diferentes: 2026/1 é fotografia desatualizada, 2026/2 é leitura ao vivo.


## Anexo G — reconciliação dos 11.630 pagamentos (todos os semestres, sem origem)

Consulta (leitura):
```sql
select coalesce(semestre_origem,'(sem origem)') sem, confianca, count(*) n, round(sum(valor_pago),2) valor
  from efetividade_caixa_origem group by 1,2 order by 1,2;
```
Saída e soma: sem origem INDETERMINADA 8.675 / R$ 9.908.460,55; 2024/1 22 / R$ 21.654,71; 2024/2 18 / R$ 17.202,54;
2025/1 84 / R$ 60.160,71; 2025/2 174 / R$ 153.895,83; 2026/1 1.979 / R$ 3.849.738,26; 2026/2 678 / R$ 773.511,09.
Total: 11.630 pagamentos e R$ 14.784.623,69, igual à view. Os 298 pagamentos que faltavam são 2024 e 2025
(22 + 18 + 84 + 174), somando R$ 252.913,79.

## Anexo H — privilégios efetivos (leitura)

Corrigido pelo Anexo K (medição direta com `has_function_privilege`). Não usar a versão anterior deste anexo.
A RPC nova é restrita a `authenticated` por grant; `PUBLIC`, `anon` e `service_role` são revogados
(quando o papel existe). Ver a migration.

## Anexo I — definição de usuario_e_gestao() em produção

Leitura de `pg_get_functiondef`: retorna `lower(coalesce(auth.jwt()->>'email',''))` contra a lista fixa de
amanda.seibel, cobranca04 e cobranca07. Não verifica `usuarios.ativo`. As três contas existem em `usuarios`
com `ativo = true`. A RPC acrescenta a checagem de `ativo` e não aceita diretoria.


## Anexo J — custo em leitura (corrigido)

Medições em transação `read only`, com `explain (analyze, summary)`:
- Classificador de 2026/2 (`carteira_2026_2_classificar()`, 10.822 linhas): 2.436,551 ms.
- Consulta equivalente de negociado de 2026/2 (sem tabela temporária): 2.362,733 ms; resultado idêntico ao da
  função: negociado 1.232.903,01; recebido 987.576,95; saldo 245.326,06; 784 títulos; 637 CPFs; 693 acordos.
- SELECT completo (classificador, negociado e contagem de caixa) com `statement_timeout` de 8 s: 4.571,787 ms.
  O classificador aparece duas vezes nessa medição; a RPC chama uma vez.
- Lacuna declarada: a agregação de caixa por semestre não foi medida isoladamente (só a contagem da view). A
  medição não é da RPC criada, que não existe em produção.
- A tentativa anterior de 8 s que falhou no classificador não se repetiu com a mesma consulta.
- Causa da função escritora: `carteira_2026_2_negociacoes()` cria `_n22` com `create temp table ... on commit drop`.
  É temporária da transação, não compartilhada. A RPC não a usa mais.

## Anexo K — ACL medida em produção (leitura, `has_function_privilege`, 15/11/2026)

Consulta somente leitura. Resultado:
- `carteira_2026_2_classificar()`: authenticated = false; anon = false; PUBLIC = false; service_role = true.
- `carteira_2026_2_negociacoes()`: authenticated = true (já existia; portão interno de gestão ou diretoria).
- `carteira_2026_2_detalhe(text,int,int)`: authenticated = true (já existia; portão interno de gestão ou diretoria).

Correção: o Anexo H dizia que authenticated tinha EXECUTE em `carteira_2026_2_classificar()`. Isso estava errado,
e a medição acima mostra o contrário. A exposição de `carteira_2026_2_negociacoes()` e `carteira_2026_2_detalhe()`
a diretoria é pré-existente e fora desta PR.


## Anexo L — medição do corpo completo (leitura, read only, timeout 8 s)

Consulta equivalente ao corpo da RPC para 2026/2 (a migration referencia o classificador uma vez; a consulta medida usa `materialized` para forçar avaliação única):
- Tempo total do SELECT completo (`explain analyze`, Execution Time): 4.370,921 ms.
- Chamadas efetivas ao classificador: 1 (`Function Scan on carteira_2026_2_classificar ... loops=1`).
- Resultados (equivalência com a RPC esperada): carteira 17.232.872,41 em 10.822 títulos; saldo total
  16.042.642,07; negociado 1.232.903,01; recebido 987.576,95; saldo de acordos 245.326,06; 784 títulos;
  637 CPFs; 693 acordos; caixa 2026/2 653.066,80 em 594 pagamentos.
- A RPC não foi criada em produção. A medição é do SELECT equivalente.
