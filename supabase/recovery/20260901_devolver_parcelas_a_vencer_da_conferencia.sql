-- DEVOLVER AS PARCELAS A VENCER QUE A CONFERENCIA PAGOU SOZINHA.
--
-- Amanda, 01/09/2026: "baixou parcela a vencer errada... considerou a segunda
-- parcela pq nao tem a entrada e a premissa era bater o titulo".
--
-- O QUE ACONTECEU: `conferencia_vincular_pagamento` percorre as parcelas do
-- acordo do vencimento mais antigo para o mais novo e marca PAGO enquanto o
-- dinheiro cobrir a parcela inteira. Ela NAO olha se a parcela ja venceu.
--
-- Como a ENTRADA nao e importada, ela nao existe como parcela: o dinheiro da
-- entrada entrou pelo extrato e a funcao foi gastar ele na parcela 1, na 2, na
-- 3 -- chegou ate a parcela 9. Parcela que ninguem pagou ficou marcada como paga.
--
-- MEDIDO EM PROD (01/09/2026), baixas da Conferencia de 31/08 e 01/09:
--   parcelas ja vencidas marcadas    151   R$ 130.682,81   133 alunos
--   parcelas A VENCER marcadas       214   R$ 182.896,48    86 alunos   <-- ERRADO
--
-- COMO ESTAS 214 SAO IDENTIFICADAS: `pago_em` cai dentro da janela da baixa da
-- Conferencia daquele aluno (o gatilho `trg_parcela_pago_em_automatico` carimba
-- `pago_em` quando o status vira PAGO). Parcela paga de verdade antes disso tem
-- `pago_em` mais velho e nao entra no conjunto.
--
-- RODAR EM UMA TRANSACAO. O SELECT de conferencia vem primeiro; confira os
-- numeros acima antes de deixar o COMMIT passar.

begin;

create temp table _reverter on commit drop as
with conf as (
  select b.aluno_id::uuid aid, b.baixado_em
    from public.baixas_pagamento b
   where b.observacao_operador like 'Baixa pelo extrato do Santander%'
     and upper(coalesce(b.status_baixa,'')) = 'REALIZADA'
     and (b.baixado_em at time zone 'America/Sao_Paulo')::date >= date '2026-08-31'
)
select distinct p.id, p.acordo_id, a.aluno_id, p.numero, p.valor, p.vencimento
  from conf c
  join public.acordos a on a.aluno_id = c.aid
  join public.parcelas p on p.acordo_id = a.id
 where p.status = 'PAGO'
   and p.vencimento > current_date
   and p.pago_em between c.baixado_em - interval '10 seconds'
                     and c.baixado_em + interval '60 seconds';

-- CONFERENCIA: tem de bater com 214 parcelas / R$ 182.896,48 / 86 alunos.
select count(*) parcelas, round(sum(valor), 2) valor, count(distinct aluno_id) alunos
  from _reverter;

update public.parcelas p
   set status = 'A_VENCER',
       pago_em = null,
       observacao = coalesce(p.observacao, '')
                    || case when coalesce(p.observacao, '') = '' then '' else ' | ' end
                    || 'devolvida em 01/09/2026: a Conferencia de Pagamentos marcou como paga '
                    || 'uma parcela que ainda nao venceu (a entrada nao e importada, '
                    || 'e o dinheiro foi gasto nas parcelas seguintes)',
       atualizado_em = now()
  from _reverter r
 where p.id = r.id;

-- Saldo, situacao e criticidade de cada aluno tocado.
do $$
declare r record;
begin
  for r in select distinct aluno_id from _reverter loop
    begin
      perform public.recalcular_situacao_aluno(r.aluno_id, 'devolver_parcela_a_vencer');
    exception when others then null;
    end;
  end loop;
end $$;

commit;
