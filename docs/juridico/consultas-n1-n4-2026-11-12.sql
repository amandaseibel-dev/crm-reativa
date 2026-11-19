-- Análise somente leitura do critério de pagamento não baixado (N1/N2 da #934).
-- Rodada em PRODUÇÃO (ahattpqrjmhkzsmnbdzs) em 12/11/2026. Nenhuma escrita.
-- O grupo acadêmico está replicado inline porque _juridico_grupo só existe no
-- arquivo da migration 20261112180000 (não aplicada). Mesma regra da migration.
--
-- Saída: uma linha por medida. Sn = regra cumulativa:
--   S0 antiga: NEGOCIADO em (a) e (c), extrato em qualquer linha
--   S1 sem NEGOCIADO em (a)
--   S2 sem NEGOCIADO em (c)
--   S3 + prazo (liquidado > vencimento+30 e >= data de criação), qualquer linha
--   S4 atual: prazo + ÚLTIMO registro do extrato
-- O universo replica _juridico_candidatos ANTES do filtro de pagamento e SEM o
-- portão canônico; a coluna 'portao' mede o que o portão retira depois.

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
ab as materialized (select distinct t.aluno_id from public.acordos_titulos t join public.pagamentos pg on pg.aluno_id = t.aluno_id and pg.titulo_numero = t.documento
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and coalesce(lower(t.status),'') <> 'quitada' and coalesce(t.tipo_boleto,'') <> 'Acordo' and t.aluno_id in (select aid from univ)),
ng as materialized (select distinct t.aluno_id from public.acordos_titulos t join public.pagamentos pg on pg.aluno_id = t.aluno_id and pg.titulo_numero = t.documento
   where upper(coalesce(t.situacao,'')) = 'NEGOCIADO' and coalesce(lower(t.status),'') <> 'quitada' and coalesce(t.tipo_boleto,'') <> 'Acordo' and t.aluno_id in (select aid from univ)),
bb as materialized (select distinct a.aluno_id from public.parcelas p join public.acordos a on a.id = p.acordo_id
   join public.pagamentos pg on pg.aluno_id = a.aluno_id and (pg.numero_parcela_completo = p.boleto or pg.titulo_numero = p.boleto)
   where a.aluno_id in (select aid from univ) and upper(coalesce(a.status,'')) = 'ATIVO' and upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA') and coalesce(btrim(p.boleto),'') <> ''),
ext_any as materialized (select t.aluno_id, upper(coalesce(t.situacao,'')) as sit, t.vencimento, t.created_at, e.liquidado_em, e.valor_pago
   from public.acordos_titulos t join public.prime_extrato e on e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf
   where t.aluno_id in (select aid from univ) and coalesce(lower(t.status),'') <> 'quitada' and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and e.liquidado_em is not null and coalesce(e.valor_pago,0) > 0),
ext_last as materialized (select t.aluno_id, upper(coalesce(t.situacao,'')) as sit, t.vencimento, t.created_at, e.liquidado_em, e.valor_pago
   from public.acordos_titulos t join lateral (select e.liquidado_em, e.valor_pago from public.prime_extrato e
          where e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf order by e.coletado_em desc limit 1) e on true
   where t.aluno_id in (select aid from univ) and coalesce(lower(t.status),'') <> 'quitada' and coalesce(t.tipo_boleto,'') <> 'Acordo'),
c1 as (select distinct aluno_id from ext_any where sit in ('ABERTO','NEGOCIADO')),
c2 as (select distinct aluno_id from ext_any where sit = 'ABERTO'),
c3 as (select distinct aluno_id from ext_any where sit = 'ABERTO' and liquidado_em > vencimento + 30 and liquidado_em >= created_at::date),
c4 as (select distinct aluno_id from ext_last where sit = 'ABERTO' and liquidado_em is not null and coalesce(valor_pago,0) > 0 and liquidado_em > vencimento + 30 and liquidado_em >= created_at::date),
f as (
  select u.aid, u.grupo, u.v_mens, u.v_aco,
    exists(select 1 from ab where ab.aluno_id = u.aid) as a_ab,
    exists(select 1 from ng where ng.aluno_id = u.aid) as a_ng,
    exists(select 1 from bb where bb.aluno_id = u.aid) as b,
    exists(select 1 from c1 where c1.aluno_id = u.aid) as c_1,
    exists(select 1 from c2 where c2.aluno_id = u.aid) as c_2,
    exists(select 1 from c3 where c3.aluno_id = u.aid) as c_3,
    exists(select 1 from c4 where c4.aluno_id = u.aid) as c_4,
    public.aluno_bloqueio_administrativo(u.aid) is not null as portao
  from univ u)
select 'universo' k, count(*)::numeric n, sum(v_mens+v_aco) v from f
union all select 'portao_canonico_retira', count(*), sum(v_mens+v_aco) from f where portao
union all select 'universo_sem_portao', count(*), sum(v_mens+v_aco) from f where not portao
union all select 'S0 antiga', count(*), sum(v_mens+v_aco) from f where a_ng or b or c_1
union all select 'S1 sem NEG em (a)', count(*), sum(v_mens+v_aco) from f where a_ab or b or c_1
union all select 'S2 sem NEG em (c)', count(*), sum(v_mens+v_aco) from f where a_ab or b or c_2
union all select 'S3 + prazo (qualquer linha)', count(*), sum(v_mens+v_aco) from f where a_ab or b or c_3
union all select 'S4 atual (ultimo registro)', count(*), sum(v_mens+v_aco) from f where a_ab or b or c_4
union all select 'S4 bloqueados FORMADO', count(*), 0 from f where (a_ab or b or c_4) and grupo='FORMADO'
union all select 'S4 bloqueados TRANCADO', count(*), 0 from f where (a_ab or b or c_4) and grupo='TRANCADO'
union all select 'S4 bloqueados EVADIDO', count(*), 0 from f where (a_ab or b or c_4) and grupo='EVADIDO'
union all select 'SO_NEG (bloquearia se NEG voltasse a (a))', count(*), sum(v_mens+v_aco) from f where a_ng and not (a_ab or b or c_4)
union all select 'S4 com portao (retirados depois)', count(*), sum(v_mens+v_aco) from f where (a_ab or b or c_4) and portao
-- Alunos que so saem por NEGOCIADO no sinal (c): S1 - S2
union all select 'NEG_so_em_c: total', count(*), sum(v_mens+v_aco) from f where c_1 and not c_2 and not (a_ab or b)
union all select 'NEG_so_em_c: com acordo ATIVO', count(*), sum(v_mens+v_aco) from f where c_1 and not c_2 and not (a_ab or b) and exists(select 1 from public.acordos x where x.aluno_id = f.aid and upper(coalesce(x.status,''))='ATIVO')
union all select 'NEG_so_em_c: com acordo quebrado (v_aco>0)', count(*), sum(v_mens+v_aco) from f where c_1 and not c_2 and not (a_ab or b) and v_aco > 0
union all select 'NEG_so_em_c: com acordo CANCELADO', count(*), sum(v_mens+v_aco) from f where c_1 and not c_2 and not (a_ab or b) and exists(select 1 from public.acordos x where x.aluno_id = f.aid and upper(coalesce(x.status,''))='CANCELADO')
union all select 'NEG_so_em_c: com acordo QUITADO', count(*), sum(v_mens+v_aco) from f where c_1 and not c_2 and not (a_ab or b) and exists(select 1 from public.acordos x where x.aluno_id = f.aid and upper(coalesce(x.status,''))='QUITADO')
union all select 'NEG_so_em_c: sem nenhum acordo', count(*), sum(v_mens+v_aco) from f where c_1 and not c_2 and not (a_ab or b) and not exists(select 1 from public.acordos x where x.aluno_id = f.aid);
