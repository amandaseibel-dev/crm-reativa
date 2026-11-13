-- ROLLBACK da R5 (20261112235600): restaura a definicao da #941 (MD5 52f8ca6c4e4428e9dc5d0912e2b9751a).
-- Ordem: 1) rollback desta; 2) so depois o rollback da #941 (20261112235500), que exige 8f94a168...
BEGIN;

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo') IS DISTINCT FROM '78e55b9a43598129831b18ff62e50e40' THEN
    RAISE EXCEPTION 'Universo nao esta na definicao R5 validada; rollback recusado.';
  END IF;
END $g$;

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$r1$  -- R5 (decisao 12/11/2026): parcela de acordo ATIVO vencida que, sozinha, sustenta o aluno.
  -- Exige boleto confiavel e a ausencia de qualquer evidencia de pagamento ou liquidacao.
  -- Parcela com vencimento futuro nao entra (mesmo criterio F1 da CTE parc).
  parc_r5 as materialized (
    select a.aluno_id, extract(year from p.vencimento)::int as ano
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
      join public.alunos al on al.id = a.aluno_id
     where a.status = 'ATIVO' and p.status = 'VENCIDA'
       and p.vencimento is not null and p.vencimento <= v_hoje
       and p.pago_em is null
       and coalesce(p.boleto_confiavel, false) = true
       and a.saldo > 0
       and coalesce(btrim(p.boleto), '') <> ''
       and p.renegociada_no_acordo_id is null
       and (v_ids is null or a.aluno_id = any(v_ids))
       and not exists (select 1 from public.pagamentos pg
                        where pg.aluno_id = a.aluno_id
                          and (pg.numero_parcela_completo = p.boleto or pg.titulo_numero = p.boleto))
       and not exists (select 1 from public.prime_extrato pe
                        where pe.boleto = p.boleto and pe.liquidado_em is not null)
       and not exists (select 1 from public.acordos_titulos t
                        where t.aluno_id = a.aluno_id
                          and ltrim(t.documento, '0') = ltrim(p.boleto, '0')
                          and (upper(coalesce(t.situacao, '')) = 'PAGO' or lower(coalesce(t.status, '')) = 'quitada'))
       and not exists (select 1 from public.pagamentos pg
                        where pg.aluno_id = a.aluno_id
                          and pg.data_pagamento >= p.vencimento - 10)
       and not exists (select 1 from public.acordos a2
                         join public.parcelas p2 on p2.acordo_id = a2.id
                        where a2.aluno_id = a.aluno_id
                          and p2.id <> p.id
                          and abs(p2.vencimento - p.vencimento) <= 5
                          and (p2.pago_em is not null
                               or upper(coalesce(p2.status, '')) in ('PAGA', 'PAGO', 'QUITADA')
                               or exists (select 1 from public.pagamentos pg
                                           where pg.aluno_id = a.aluno_id
                                             and p2.boleto is not null
                                             and (pg.numero_parcela_completo = p2.boleto or pg.titulo_numero = p2.boleto))))
       and not exists (select 1 from public.prime_extrato pe
                        where regexp_replace(coalesce(pe.cpf, ''), '\D', '', 'g') = regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g')
                          and pe.liquidado_em >= p.vencimento - 10)
  ),
  pre_base as (
    select aluno_id, ano, true  as via_tit, false as via_r5 from tit
    union all
    select aluno_id, ano, false as via_tit, false as via_r5 from parc
    union all
    select aluno_id, ano, false as via_tit, true  as via_r5 from parc_r5
  ),
  base as materialized (
    select x.aluno_id, array_agg(distinct x.ano order by x.ano) as anos
      from pre_base x
      left join public.casos c on c.aluno_id = x.aluno_id and c.encerrado_operacional is not true
     group by x.aluno_id
    having bool_or(x.via_tit)
        or bool_or(x.via_r5)
        or coalesce(max(c.total_em_aberto), 0) > 0
$r1$,
$r2$  pre_base as (
    select aluno_id, ano, true  as via_tit from tit
    union all
    select aluno_id, ano, false as via_tit from parc
  ),
  base as materialized (
    select x.aluno_id, array_agg(distinct x.ano order by x.ano) as anos
      from pre_base x
      left join public.casos c on c.aluno_id = x.aluno_id
     group by x.aluno_id
    having bool_or(x.via_tit)
        or coalesce(max(c.total_em_aberto), 0) > 0
$r2$, 1);

DO $m$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo') IS DISTINCT FROM '52f8ca6c4e4428e9dc5d0912e2b9751a' THEN
    RAISE EXCEPTION 'Rollback R5 nao restaurou o MD5 da #941.';
  END IF;
END $m$;

COMMIT;
