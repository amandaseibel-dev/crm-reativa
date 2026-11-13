-- ROLLBACK da R5 v2 (20261112235600): restaura a definicao da #941 (MD5 52f8ca6c4e4428e9dc5d0912e2b9751a).
-- Ordem: 1) este rollback; 2) depois o rollback da #941 (20261112235500), que exige 8f94a168...
-- ACL nao e alterada pelo patch, portanto nao ha GRANT a restaurar.
BEGIN;

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo') IS DISTINCT FROM '885583bc6a45d7e3c77d7add841ac11b' THEN
    RAISE EXCEPTION 'Universo nao esta na definicao R5 validada; rollback recusado.';
  END IF;
END $g$;

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$r0a$  val_acordo as materialized (
    select a.aluno_id, sum(p.valor) as v
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where a.status = 'ATIVO' and p.status = 'VENCIDA'
       and p.vencimento is not null and p.vencimento <= v_hoje
       and (v_ids is null or a.aluno_id = any(v_ids))
       -- [R5-4] aluno sem titulo e sem mensalidade so entra por R5: so essas parcelas cobram
       and (exists (select 1 from tit t0 where t0.aluno_id = a.aluno_id)
            or exists (select 1 from val_mens vm0 where vm0.aluno_id = a.aluno_id)
            or p.id in (select pr.parcela_id from parc_r5 pr))
$r0a$,
$r0b$  val_acordo as materialized (
    select a.aluno_id, sum(p.valor) as v
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where a.status = 'ATIVO' and p.status = 'VENCIDA'
       and p.vencimento is not null and p.vencimento <= v_hoje
       and (v_ids is null or a.aluno_id = any(v_ids))
$r0b$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$r1a$  -- [R5] parcela de acordo ATIVO VENCIDA com evidencia de exigibilidade (criterio 12/11/2026).
  -- Vencimento ja passado (F1). Boleto comparado sem zeros a esquerda (chave do pagamento).
  -- Qualquer evidencia de pagamento ou liquidacao, inclusive de pagamento sem aluno, bloqueia.
  parc_r5 as materialized (
    select a.aluno_id, p.id as parcela_id, extract(year from p.vencimento)::int as ano
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
      join public.alunos al on al.id = a.aluno_id
     where a.status = 'ATIVO' and p.status = 'VENCIDA'
       and p.vencimento is not null and p.vencimento <= v_hoje
       and p.pago_em is null
       and coalesce(p.boleto_confiavel, false) = true
       and a.saldo > 0
       and ltrim(coalesce(p.boleto, ''), '0') <> ''
       and p.renegociada_no_acordo_id is null
       and (v_ids is null or a.aluno_id = any(v_ids))
       and not exists (select 1 from public.pagamentos pg
                        where (pg.aluno_id = a.aluno_id or pg.aluno_id is null)
                          and (ltrim(coalesce(pg.numero_parcela_completo, ''), '0') = ltrim(p.boleto, '0')
                               or ltrim(coalesce(pg.titulo_numero, ''), '0') = ltrim(p.boleto, '0')))
       and not exists (select 1 from public.pagamentos pg
                        where pg.aluno_id = a.aluno_id
                          and pg.data_pagamento >= p.vencimento - 10)
       and not exists (select 1 from public.prime_extrato pe
                        where ltrim(coalesce(pe.boleto, ''), '0') = ltrim(p.boleto, '0')
                          and pe.liquidado_em is not null)
       and not exists (select 1 from public.acordos_titulos t
                        where t.aluno_id = a.aluno_id
                          and ltrim(coalesce(t.documento, ''), '0') = ltrim(p.boleto, '0')
                          and (upper(coalesce(t.situacao, '')) in ('PAGO', 'EM_CONFIRMACAO')
                               or lower(coalesce(t.status, '')) = 'quitada'))
       and not exists (select 1 from public.acordos a2
                         join public.parcelas p2 on p2.acordo_id = a2.id
                        where a2.aluno_id = a.aluno_id
                          and p2.id <> p.id
                          and abs(p2.vencimento - p.vencimento) <= 5
                          and (p2.pago_em is not null
                               or upper(coalesce(p2.status, '')) in ('PAGA', 'PAGO', 'QUITADA')
                               or (ltrim(coalesce(p2.boleto, ''), '0') <> ''
                                   and exists (select 1 from public.pagamentos pg
                                                where (pg.aluno_id = a.aluno_id or pg.aluno_id is null)
                                                  and (ltrim(coalesce(pg.numero_parcela_completo, ''), '0') = ltrim(p2.boleto, '0')
                                                       or ltrim(coalesce(pg.titulo_numero, ''), '0') = ltrim(p2.boleto, '0'))))))
       and not exists (select 1 from public.prime_extrato pe
                        where regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g') <> ''
                          and regexp_replace(coalesce(pe.cpf, ''), '\D', '', 'g') = regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g')
                          and pe.liquidado_em >= p.vencimento - 10)
  ),
  pre_base as (
    select aluno_id, ano, true  as via_tit, false as via_r5 from tit
    union all
    -- [R5-3] parcela sem R5 nao contribui com ano para aluno que nao tem titulo
    select aluno_id, ano, false as via_tit, false as via_r5 from parc
     where aluno_id in (select t0.aluno_id from tit t0)
    union all
    select aluno_id, ano, false as via_tit, true  as via_r5 from parc_r5
  ),
  -- [R5-1] o saldo de caso (total_em_aberto) nao autoriza mais aluno so-parcela.
  base as materialized (
    select x.aluno_id, array_agg(distinct x.ano order by x.ano) as anos
      from pre_base x
     group by x.aluno_id
    having bool_or(x.via_tit)
        or bool_or(x.via_r5)
$r1a$,
$r1b$  pre_base as (
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
$r1b$, 1);

DO $m$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo') IS DISTINCT FROM '52f8ca6c4e4428e9dc5d0912e2b9751a' THEN
    RAISE EXCEPTION 'Rollback R5 nao restaurou o MD5 da #941.';
  END IF;
END $m$;

COMMIT;
