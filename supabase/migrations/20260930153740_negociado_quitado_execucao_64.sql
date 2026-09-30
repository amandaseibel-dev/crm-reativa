-- ============================================================================
-- EXECUCAO da reconciliacao historica NEGOCIADO -> QUITADO.
-- Populacao autorizada: 64 mensalidades | 43 alunos | 43 acordos | R$ 41.152,16
-- Impressao digital dos IDs (md5 ordenado): e7e8f4ae30bb546ebcb506766f545307
-- Contexto: backend sem JWT (current_user = postgres), o mesmo caminho que o
-- cron usa. Nenhuma identidade de pessoa e forjada.
-- ============================================================================

-- 1) BACKUP por ID, antes de qualquer escrita. Sem PITR, e a unica volta.
create table if not exists public._backup_negociado_quitado_20260930 as
select t.id                as titulo_id,
       to_jsonb(t)         as titulo_inteiro,
       t.situacao          as situacao_antes,
       t.status            as status_antes,
       t.acordo_id         as acordo_id_antes,
       t.motivo_ajuste     as motivo_antes,
       t.saldo_corrigido   as saldo_antes,
       t.valor_em_aberto   as valor_em_aberto_antes,
       t.aluno_id          as aluno_id,
       a.id                as acordo_vinculado,
       a.status            as acordo_status_antes,
       a.numero_acordo,
       (select jsonb_agg(to_jsonb(v)) from public.acordo_titulo_vinculo v
         where v.titulo_id = t.id)  as vinculos,
       (select jsonb_agg(to_jsonb(p)) from public.parcelas p
         where p.acordo_id = a.id)  as parcelas,
       (select to_jsonb(al) from public.alunos al where al.id = t.aluno_id) as aluno_antes,
       now() as salvo_em
  from public.acordos_titulos t
  join lateral (
    select v.acordo_id from public.acordo_titulo_vinculo v
     join public.acordos a2 on a2.id = v.acordo_id
    where v.titulo_id = t.id and coalesce(v.ativo,true)
      and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
    order by v.criado_em desc nulls last limit 1) va on true
  join public.acordos a on a.id = va.acordo_id
 where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
   and upper(coalesce(a.status,'')) = 'QUITADO'
   and not exists (select 1 from public.parcelas p where p.acordo_id = va.acordo_id
                     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'))
   and coalesce(t.tipo_boleto,'') <> 'Acordo'
   and t.origem_liquidacao is null
   and t.origem_encerramento is null;

-- 2) TRAVA DA POPULACAO: quantidade, alunos, acordos, valor e CONJUNTO DE IDS.
do $do$
declare v_q int; v_al int; v_ac int; v_vl numeric; v_dg text;
begin
  select count(*), count(distinct aluno_id), count(distinct acordo_vinculado),
         round(sum(coalesce((titulo_inteiro->>'valor_original')::numeric,0)),2),
         md5(string_agg(titulo_id::text, ',' order by titulo_id))
    into v_q, v_al, v_ac, v_vl, v_dg
    from public._backup_negociado_quitado_20260930;

  raise notice 'BACKUP: % mensalidades, % alunos, % acordos, R$ %, digital %',
    v_q, v_al, v_ac, v_vl, v_dg;

  if v_q  <> 64       then raise exception 'ABORTA: % mensalidades, autorizado 64', v_q; end if;
  if v_al <> 43       then raise exception 'ABORTA: % alunos, autorizado 43', v_al; end if;
  if v_ac <> 43       then raise exception 'ABORTA: % acordos, autorizado 43', v_ac; end if;
  if v_vl <> 41152.16 then raise exception 'ABORTA: valor %, autorizado 41152.16', v_vl; end if;
  if v_dg <> 'e7e8f4ae30bb546ebcb506766f545307' then
    raise exception 'ABORTA: conjunto de IDs divergente (%)', v_dg;
  end if;

  if exists (select 1 from public._backup_negociado_quitado_20260930 b
              join public.baixas_pagamento p on p.acordo_id = b.acordo_vinculado
             where p.devolvido_em is not null) then
    raise exception 'ABORTA: ha baixa devolvida (estorno) na cadeia dos acordos';
  end if;
end
$do$;

-- 3) A EXECUCAO. As guardas internas da RPC abortam tudo se algo sair da regra.
do $do$
declare v_r jsonb;
begin
  v_r := public.mensalidade_reconciliar_negociado_quitado(true);
  raise notice 'RESULTADO: %', v_r;

  if (v_r->>'modo') <> 'aplicado' then
    raise exception 'ABORTA: modo inesperado %', v_r->>'modo';
  end if;
  if (v_r->>'mensalidades')::int <> 64 then
    raise exception 'ABORTA: a RPC tratou %, autorizado 64', v_r->>'mensalidades';
  end if;
  if (v_r->>'alterados')::int <> 64 then
    raise exception 'ABORTA: % alteradas, esperado 64', v_r->>'alterados';
  end if;
  if (v_r->>'valor')::numeric <> 41152.16 then
    raise exception 'ABORTA: valor % <> 41152.16', v_r->>'valor';
  end if;
end
$do$;

-- 4) CONFERENCIA FINAL, ainda dentro da transacao.
do $do$
declare v_sobra int; v_log int; v_vinc int; v_acid int; v_val int; v_parc int;
begin
  select count(*) into v_sobra
    from public.acordos_titulos t
    join lateral (select v.acordo_id from public.acordo_titulo_vinculo v
       join public.acordos a2 on a2.id = v.acordo_id
      where v.titulo_id = t.id and coalesce(v.ativo,true)
        and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
      order by v.criado_em desc nulls last limit 1) va on true
    join public.acordos a on a.id = va.acordo_id
   where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
     and upper(coalesce(a.status,'')) = 'QUITADO'
     and not exists (select 1 from public.parcelas p where p.acordo_id = va.acordo_id
                       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'))
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and t.origem_liquidacao is null and t.origem_encerramento is null;
  if v_sobra <> 0 then
    raise exception 'ABORTA: sobraram % NEGOCIADO com quitacao comprovada', v_sobra;
  end if;

  select count(*) into v_log from public.mensalidade_reconciliacao_log;
  if v_log <> 64 then raise exception 'ABORTA: log com % linhas, esperado 64', v_log; end if;

  select count(*) into v_vinc from public.mensalidade_reconciliacao_log l
   where exists (select 1 from public.acordo_titulo_vinculo v
                  where v.titulo_id = l.titulo_id and v.acordo_id = l.acordo_id
                    and coalesce(v.ativo,true));
  if v_vinc <> 64 then raise exception 'ABORTA: so % vinculos ativos preservados', v_vinc; end if;

  select count(*) into v_acid from public.mensalidade_reconciliacao_log l
    join public.acordos_titulos t on t.id = l.titulo_id
   where t.acordo_id = l.acordo_id;
  if v_acid <> 64 then raise exception 'ABORTA: so % com acordo_id preservado', v_acid; end if;

  select count(*) into v_val from public.mensalidade_reconciliacao_log l
    join public.acordos_titulos t on t.id = l.titulo_id
   where t.valor_original is distinct from l.valor_original;
  if v_val <> 0 then raise exception 'ABORTA: % titulos com valor alterado', v_val; end if;

  -- as parcelas dos 43 acordos continuam todas PAGO, item a item
  select count(*) into v_parc from public.parcelas p
   where p.acordo_id in (select acordo_vinculado from public._backup_negociado_quitado_20260930)
     and upper(coalesce(p.status,'')) <> 'PAGO';
  if v_parc <> 0 then raise exception 'ABORTA: % parcelas sairam de PAGO', v_parc; end if;

  raise notice 'CONFERENCIA FINAL OK';
end
$do$;