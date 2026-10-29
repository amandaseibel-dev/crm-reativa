-- ============================================================================
-- 3/3 -- VALIDACAO. 100% SELECT. Rodar ANTES e DEPOIS e comparar.
-- ============================================================================
-- Nao altera nada. Pode rodar em producao a vontade.
-- ============================================================================

-- 1) POPULACAO ELEGIVEL (esperado: 64 antes, 0 depois)
with elegivel as (
  select t.id, t.aluno_id, t.valor_original, va.acordo_id
    from public.acordos_titulos t
    join lateral (select v.acordo_id from public.acordo_titulo_vinculo v
      join public.acordos a2 on a2.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true)
        and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
      order by v.criado_em desc nulls last limit 1) va on true
    join public.acordos a on a.id=va.acordo_id
   where upper(coalesce(t.situacao,''))='NEGOCIADO'
     and upper(coalesce(a.status,''))='QUITADO'
     and not exists (select 1 from public.parcelas p where p.acordo_id=va.acordo_id
                       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'))
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and t.origem_liquidacao is null and t.origem_encerramento is null)
select '1_elegiveis' as medida, count(*)::text as mensalidades,
       count(distinct aluno_id)::text as alunos, count(distinct acordo_id)::text as acordos,
       to_char(coalesce(sum(valor_original),0),'FM999G999G990D00') as valor
from elegivel;

-- 2) PANORAMA POR SITUACAO (a comparacao antes/depois por status)
select '2_por_situacao' as medida, situacao, count(*) as titulos,
       to_char(sum(coalesce(valor_original,0)),'FM999G999G990D00') as valor
from public.acordos_titulos group by 2 order by 3 desc;

-- 3) CRUZAMENTO mensalidade x status do acordo vinculado
select '3_cruzamento' as medida,
       coalesce(upper(a.status),'(sem vinculo vivo)') as status_acordo,
       t.situacao as situacao_mensalidade, count(*) as titulos
from public.acordos_titulos t
left join lateral (select v.acordo_id from public.acordo_titulo_vinculo v
   join public.acordos a2 on a2.id=v.acordo_id
   where v.titulo_id=t.id and coalesce(v.ativo,true)
     and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last limit 1) va on true
left join public.acordos a on a.id=va.acordo_id
where t.situacao in ('NEGOCIADO','PAGO')
group by 2,3 order by 2,3;

-- 4) INTEGRIDADE: nada criado, nada apagado (tem de ser IGUAL antes e depois)
select '4_integridade' as medida,
       (select count(*) from public.acordos)               as acordos,
       (select count(*) from public.parcelas)              as parcelas,
       (select count(*) from public.parcelas where upper(coalesce(status,''))='PAGO') as parcelas_pagas,
       (select count(*) from public.acordo_titulo_vinculo) as vinculos,
       (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo,true)) as vinculos_ativos,
       (select count(*) from public.pagamentos)            as pagamentos,
       (select count(*) from public.baixas_pagamento where devolvido_em is null) as baixas_vivas,
       (select to_char(sum(coalesce(valor_original,0)),'FM999G999G990D00') from public.acordos_titulos) as soma_valor_original,
       (select to_char(sum(coalesce(saldo_corrigido,0)),'FM999G999G990D00') from public.acordos_titulos) as soma_saldo_corrigido;

-- 5) SALDO GLOBAL (tem de ser IGUAL: NEGOCIADO-com-vinculo-vivo e PAGO estao
--    os dois FORA da conta de saldo nas duas funcoes oficiais)
select '5_saldo' as medida,
       to_char(sum(coalesce(saldo_total,0)),'FM999G999G990D00')   as saldo_total,
       to_char(sum(coalesce(saldo_vencido,0)),'FM999G999G990D00') as saldo_vencido,
       count(*) filter (where coalesce(saldo_total,0) > 0)        as alunos_com_saldo
from public.alunos;

-- 6) O QUE PERMANECE EM NEGOCIADO, e por que
select '6_permanece' as medida,
  case
    when va.acordo_id is null then 'sem acordo vivo (cancelado/quebrado/orfao)'
    when upper(a.status)='QUITADO' and coalesce(t.tipo_boleto,'')='Acordo' then 'boleto do proprio acordo: nunca foi divida'
    when upper(a.status)='QUITADO' then 'acordo QUITADO mas com parcela viva'
    when exists (select 1 from public.parcelas p where p.acordo_id=va.acordo_id
                   and upper(coalesce(p.status,''))='PAGO') then 'acordo ATIVO, pago em parte: ainda ha saldo'
    else 'acordo ATIVO, nada pago ainda'
  end as motivo,
  count(*) as mensalidades, count(distinct t.aluno_id) as alunos,
  to_char(sum(coalesce(t.valor_original,0)),'FM999G999G990D00') as valor
from public.acordos_titulos t
left join lateral (select v.acordo_id from public.acordo_titulo_vinculo v
   join public.acordos a2 on a2.id=v.acordo_id
   where v.titulo_id=t.id and coalesce(v.ativo,true)
     and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last limit 1) va on true
left join public.acordos a on a.id=va.acordo_id
where upper(coalesce(t.situacao,''))='NEGOCIADO'
group by 2 order by 3 desc;

-- 7) A CONSULTA FINAL EXIGIDA: NEGOCIADO + pagamento integral comprovado.
--    Esperado DEPOIS: zero.
select '7_sobra_proibida' as medida, count(*) as deve_ser_zero
from public.acordos_titulos t
join lateral (select v.acordo_id from public.acordo_titulo_vinculo v
   join public.acordos a2 on a2.id=v.acordo_id
   where v.titulo_id=t.id and coalesce(v.ativo,true)
     and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last limit 1) va on true
join public.acordos a on a.id=va.acordo_id
where upper(coalesce(t.situacao,''))='NEGOCIADO'
  and upper(coalesce(a.status,''))='QUITADO'
  and not exists (select 1 from public.parcelas p where p.acordo_id=va.acordo_id
                    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'))
  and coalesce(t.tipo_boleto,'') <> 'Acordo'
  and t.origem_liquidacao is null and t.origem_encerramento is null;

-- 8) O REGISTRO DA CORRECAO (so existe depois)
select '8_log' as medida, lote, count(*) as mensalidades,
       count(distinct aluno_id) as alunos, count(distinct acordo_id) as acordos,
       to_char(sum(coalesce(valor_original,0)),'FM999G999G990D00') as valor,
       min(executado_em)::text as executado_em, min(executado_por) as por
from public.mensalidade_reconciliacao_log group by 2 order by 7;

-- 9) PROVA de que o vinculo e o historico ficaram: cada mensalidade corrigida
--    continua com vinculo ATIVO para o MESMO acordo, e o motivo diz a origem.
select '9_historico' as medida,
  count(*) as corrigidas,
  count(*) filter (where exists (select 1 from public.acordo_titulo_vinculo v
     where v.titulo_id=l.titulo_id and v.acordo_id=l.acordo_id and coalesce(v.ativo,true))) as com_vinculo_ativo_mesmo_acordo,
  count(*) filter (where t.acordo_id = l.acordo_id) as com_acordo_id_preservado,
  count(*) filter (where t.motivo_ajuste like '%quitada junto com o acordo%') as motivo_diz_que_foi_o_acordo,
  count(*) filter (where t.valor_original is distinct from l.valor_original) as valor_alterado_deve_ser_zero
from public.mensalidade_reconciliacao_log l
join public.acordos_titulos t on t.id = l.titulo_id;
