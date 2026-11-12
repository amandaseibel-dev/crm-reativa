-- Achado 2 do Guardiao (#934): impacto do criterio de DATA do sinal (c) de
-- pagamento nao baixado. SOMENTE LEITURA em producao, 12/11/2026. Sem escrita.
--
-- Variante A (atual do Juridico): liquidado > venc.+30 e liquidado >= created_at::date
--   (mesma regra das Acoes Massivas, acoes_massivas_exclui_liquidados_no_prime).
-- Variante C (canonica da conciliacao Prime, Grupo A, 20260918150000):
--   liquidado > venc.+30 E liquidado >= importacao E liquidado <> dia da importacao
--   E liquidado <= data da coleta E liquidado <= hoje.
--
-- O grupo academico e replicado inline (_juridico_grupo nao existe em producao).
-- Universo = mesmo da consulta de N1 (docs/juridico/consultas-n1-n4-2026-11-12.sql),
-- sem o filtro de pagamento de (a) e (b): so o sinal (c) muda entre A e C.
-- Exemplos: IDs e boletos mascarados; sem nome, CPF ou matricula.

with alg as materialized (
  select al.*, case upper(translate(btrim(coalesce(al.situacao_academica,'')), 'íÍ', 'II'))
    when 'FORMADO' then 'FORMADO' when 'CONCLUIDO' then 'FORMADO' when 'TRANCADO' then 'TRANCADO'
    when 'TRANCAMENTO INSTITUCIONAL' then 'TRANCADO' when 'CANCELADO' then 'EVADIDO' when 'DESVINCULADO' then 'EVADIDO'
    when 'CANCELAMENTO INSTITUCIONAL' then 'EVADIDO' else null end as grp
    from public.alunos al),
tit as materialized (
  select t.aluno_id as tid, sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2)) as v, count(*)::int as n
    from public.acordos_titulos t
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and coalesce(lower(t.status),'') <> 'quitada'
     and coalesce(t.tipo_boleto,'') <> 'Acordo' and t.origem_encerramento is null
     and t.vencimento >= date '2025-01-01' and t.vencimento < (now() at time zone 'America/Sao_Paulo')::date
     and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
     and not exists (select 1 from public.acordo_titulo_vinculo v join public.acordos a on a.id = v.acordo_id
                      where v.titulo_id = t.id and coalesce(v.ativo, true) and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
   group by t.aluno_id),
aco as materialized (
  select s.aluno_id as aid, sum(s.saldo) filter (where s.vencidas > 0) as v_quebrado
    from (select a.aluno_id, a.id,
                 coalesce(sum(p.valor) filter (where upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')), 0) as saldo,
                 count(*) filter (where upper(coalesce(p.status,'')) = 'VENCIDA') as vencidas
            from public.acordos a left join public.parcelas p on p.acordo_id = a.id
           where upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
           group by a.aluno_id, a.id) s
   group by s.aluno_id),
univ as materialized (
  select al.id as aid, al.grp as grupo, coalesce(tit.v,0) as v_mens, coalesce(aco.v_quebrado,0) as v_aco
    from alg al left join tit on tit.tid = al.id left join aco on aco.aid = al.id
   where al.grp is not null
     and coalesce(tit.v,0) + coalesce(aco.v_quebrado,0) > 0
     and upper(replace(coalesce(al.status_atual,''),' ','_')) not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA')
     and upper(replace(coalesce(al.status_jornada,''),' ','_')) not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA')
     and not exists (select 1 from public.acordos_titulos t2 where t2.aluno_id = al.id and upper(coalesce(t2.situacao,'')) = 'EM_CONFIRMACAO')
     and not exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = al.id::text and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
),
-- sinal (c): ultimo registro do extrato por titulo ABERTO (mesma regra da funcao em producao)
ult as materialized (
  select t.aluno_id, t.id as titulo_id, t.documento, t.vencimento, t.created_at, e.liquidado_em, e.valor_pago, e.coletado_em
    from public.acordos_titulos t
    join lateral (select e.liquidado_em, e.valor_pago, e.coletado_em from public.prime_extrato e
                   where e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf
                   order by e.coletado_em desc limit 1) e on true
   where t.aluno_id in (select aid from univ)
     and upper(coalesce(t.situacao,'')) = 'ABERTO' and coalesce(lower(t.status),'') <> 'quitada'
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and e.liquidado_em is not null and coalesce(e.valor_pago,0) > 0),
regra_a as materialized (
  select distinct aluno_id, titulo_id, documento, vencimento, created_at, liquidado_em, valor_pago, coletado_em
    from ult
   where liquidado_em > vencimento + 30 and liquidado_em >= created_at::date),
regra_c as materialized (
  select distinct aluno_id, titulo_id, documento, vencimento, created_at, liquidado_em, valor_pago, coletado_em
    from ult
   where liquidado_em > vencimento + 30
     and liquidado_em >= created_at::date
     and liquidado_em <> created_at::date
     and liquidado_em <= coletado_em::date
     and liquidado_em <= (now() at time zone 'America/Sao_Paulo')::date),
-- artefato: liquidado no proprio dia da importacao (A barra, C nao)
artefato as (select distinct aluno_id from regra_a where liquidado_em = created_at::date),
-- depois da coleta: liquidado depois da data da coleta (A barra, C nao)
pos_coleta as (select distinct aluno_id from regra_a where liquidado_em > coletado_em::date),
-- outros sinais (a) e (b) e pagamento: iguais nas duas variantes; ficam fora da comparacao
outros as (
  select u.aid from univ u
   where exists (select 1 from public.acordos_titulos t join public.pagamentos pg on pg.aluno_id = t.aluno_id and pg.titulo_numero = t.documento
                  where t.aluno_id = u.aid and upper(coalesce(t.situacao,'')) = 'ABERTO' and coalesce(lower(t.status),'') <> 'quitada' and coalesce(t.tipo_boleto,'') <> 'Acordo')
      or exists (select 1 from public.parcelas p join public.acordos a on a.id = p.acordo_id
                  join public.pagamentos pg on pg.aluno_id = a.aluno_id and (pg.numero_parcela_completo = p.boleto or pg.titulo_numero = p.boleto)
                  where a.aluno_id = u.aid and upper(coalesce(a.status,'')) = 'ATIVO' and upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA') and coalesce(btrim(p.boleto),'') <> '')
),
f as (
  select u.aid, u.grupo, u.v_mens, u.v_aco,
    exists(select 1 from outros o where o.aid = u.aid) as outro,
    exists(select 1 from regra_a r where r.aluno_id = u.aid) as ca,
    exists(select 1 from regra_c r where r.aluno_id = u.aid) as cc,
    exists(select 1 from artefato x where x.aluno_id = u.aid) as e_artefato,
    exists(select 1 from pos_coleta x where x.aluno_id = u.aid) as e_pos_coleta
  from univ u)
select 'universo' k, count(*)::numeric n, sum(v_mens+v_aco) v from f
union all select 'A atual: barrados so pelo sinal (c)', count(*), sum(v_mens+v_aco) from f where not outro and ca
union all select 'C canonica: barrados so pelo sinal (c)', count(*), sum(v_mens+v_aco) from f where not outro and cc
union all select 'MUDA: barrado em A, liberado em C', count(*), sum(v_mens+v_aco) from f where not outro and ca and not cc
union all select 'MUDA: barrado em C, liberado em A', count(*), sum(v_mens+v_aco) from f where not outro and cc and not ca
union all select 'MUDA: artefato (liquidado = dia da importacao)', count(*), sum(v_mens+v_aco) from f where not outro and e_artefato
union all select 'MUDA: liquidado depois da coleta', count(*), sum(v_mens+v_aco) from f where not outro and e_pos_coleta
union all select 'MUDA por grupo FORMADO', count(*), sum(v_mens+v_aco) from f where not outro and ca and not cc and grupo='FORMADO'
union all select 'MUDA por grupo TRANCADO', count(*), sum(v_mens+v_aco) from f where not outro and ca and not cc and grupo='TRANCADO'
union all select 'MUDA por grupo EVADIDO', count(*), sum(v_mens+v_aco) from f where not outro and ca and not cc and grupo='EVADIDO';

-- ---------------------------------------------------------------------------
-- Base geral (sem recorte do Juridico): todos os titulos ABERTOS com liquidacao
-- no extrato. Valor = valor_original. Origem dos numeros 564/517/57 do relatorio.
-- ---------------------------------------------------------------------------
with ult as materialized (
  select t.aluno_id, t.id as titulo_id, t.documento, t.vencimento, t.created_at, t.valor_original, e.liquidado_em, e.valor_pago, e.coletado_em
    from public.acordos_titulos t
    join lateral (select e.liquidado_em, e.valor_pago, e.coletado_em from public.prime_extrato e
                   where e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf
                   order by e.coletado_em desc limit 1) e on true
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and coalesce(lower(t.status),'') <> 'quitada'
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and e.liquidado_em is not null and coalesce(e.valor_pago,0) > 0),
a as (select * from ult where liquidado_em > vencimento + 30 and liquidado_em >= created_at::date),
c as (select * from a where liquidado_em <> created_at::date and liquidado_em <= coletado_em::date and liquidado_em <= (now() at time zone 'America/Sao_Paulo')::date)
select 'A_regra_atual' k, count(distinct aluno_id)::text alunos, count(*)::text titulos, round(sum(valor_original),2)::text valor from a
union all select 'C_data_canonica', count(distinct aluno_id)::text, count(*)::text, round(sum(valor_original),2)::text from c
union all select 'artefato_liq_eq_importacao', count(distinct aluno_id)::text, count(*)::text, round(sum(valor_original),2)::text from a where liquidado_em = created_at::date
union all select 'liq_depois_coleta', count(distinct aluno_id)::text, count(*)::text, round(sum(valor_original),2)::text from a where liquidado_em > coletado_em::date
union all select 'liq_futuro', count(distinct aluno_id)::text, count(*)::text, round(sum(valor_original),2)::text from a where liquidado_em > (now() at time zone 'America/Sao_Paulo')::date;

-- Exemplos mascarados (sem nome, CPF ou matricula): ver a saida da consulta acima e
--   select left(aluno_id::text,8), right(documento,4), vencimento, created_at::date, liquidado_em, coletado_em::date
--     from a where liquidado_em = created_at::date limit 3;   (rodar dentro da mesma CTE)
