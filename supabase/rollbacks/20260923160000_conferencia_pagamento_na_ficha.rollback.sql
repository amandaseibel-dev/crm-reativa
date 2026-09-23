-- ROLLBACK de 20260923160000_conferencia_pagamento_na_ficha.sql
--
-- Devolve `conciliacao_feito`, `conciliacao_rejeitar` e `pagamentos_sem_aluno`
-- aos corpos que estavam em producao ANTES desta migration -- lidos de
-- `pg_get_functiondef` em 23/09/2026, antes de aplicar.
--
-- O QUE ESTE ROLLBACK NAO FAZ, DE PROPOSITO: nao apaga as movimentacoes
-- `CONFERENCIA_PAGAMENTO` ja gravadas. Elas sao historico de decisao humana --
-- apagar seria perder a prova de quem decidiu o que, e a ficha passaria a
-- mentir por omissao. Se a intencao for mesmo removê-las, isso e uma decisao
-- separada, com backup antes.
--
-- Depois deste rollback, FEITO e REJEITAR voltam a gravar em dois lugares
-- (fila + auditoria) e a fila volta a nao devolver acordo, evidencias e saldo.
-- A tela que espera esses tres campos passa a mostrar "—" neles; nada quebra.

create or replace function public.conciliacao_feito(
  p_pagamento_id uuid, p_conclusao text, p_observacao text default null::text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb; v_obs text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Concluir pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  if coalesce(trim(p_conclusao),'') = '' then
    raise exception 'FEITO exige a conclusao escolhida.' using errcode = '23514';
  end if;
  v_obs := nullif(trim(coalesce(p_observacao,'')), '');
  if p_conclusao = 'OUTRO_CONFIRMADO' and v_obs is null then
    raise exception 'A conclusao "outro motivo confirmado" exige observacao.' using errcode = '23514';
  end if;

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO'); end if;
  if v_st = 'BAIXADO' then return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO'); end if;

  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao,
                      'quantidade_tentativas', f.quantidade_tentativas,
                      'primeira_tentativa_em', f.primeira_tentativa_em)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  update public.fila_pagamento_sem_vinculo
     set decisao = 'FEITO',
         conclusao = p_conclusao,
         decidido_por = coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'concluido pela gestao (' || p_conclusao || ')'
           || case when v_obs is null then '' else ': ' || v_obs end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'CONCLUSAO_ABORTADA: a linha da fila mudou durante a conclusao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_FEITO_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'conclusao', p_conclusao, 'observacao', v_obs,
                             'decisao', 'FEITO', 'sem_efeito_financeiro', true));

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'FEITO', 'conclusao', p_conclusao, 'estado_anterior', v_antes);
end;
$function$;

create or replace function public.conciliacao_rejeitar(
  p_pagamento_id uuid, p_motivo text, p_observacao text default null::text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb; v_obs text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Rejeitar pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  if coalesce(trim(p_motivo),'') = '' then
    raise exception 'REJEITAR exige motivo.' using errcode = '23514';
  end if;
  v_obs := nullif(trim(coalesce(p_observacao,'')), '');
  if p_motivo = 'OUTRO' and v_obs is null then
    raise exception 'O motivo "outro" exige observacao.' using errcode = '23514';
  end if;

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO'); end if;
  if v_st = 'BAIXADO' then return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO'); end if;

  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao,
                      'quantidade_tentativas', f.quantidade_tentativas,
                      'primeira_tentativa_em', f.primeira_tentativa_em)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  -- REJEITAR NAO APAGA E NAO DESFAZ PAGAMENTO. A unica escrita e a decisao.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'REJEITADO',
         motivo_rejeicao = p_motivo,
         decidido_por = coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'rejeitado pela gestao (' || p_motivo || ')'
           || case when v_obs is null then '' else ': ' || v_obs end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'REJEICAO_ABORTADA: a linha da fila mudou durante a rejeicao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_REJEITADA_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'motivo_rejeicao', p_motivo, 'observacao', v_obs,
                             'decisao', 'REJEITADO', 'sem_efeito_financeiro', true,
                             'pagamento_preservado', true));

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'REJEITADO', 'motivo_rejeicao', p_motivo, 'estado_anterior', v_antes);
end;
$function$;

drop function if exists public.pagamentos_sem_aluno(text, boolean);

create or replace function public.pagamentos_sem_aluno(
  p_mes text default null::text, p_todos_os_meses boolean default false)
 returns table(
   pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
   titulo_numero text, numero_parcela_completo text, valor_pago numeric,
   valor_honorario numeric, operador_nome text, operador_email text,
   motivo text, candidatos integer, motivo_financeiro text, sugestoes jsonb,
   detectado_em timestamp with time zone, importacao_id uuid, arquivo_nome text,
   status_conciliacao text, tem_aluno boolean)
 language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    coalesce(p.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome,
    p.status_conciliacao,
    (p.aluno_id is not null)
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  where (p.aluno_id is null or f.pagamento_id is not null)
    and not exists (select 1 from public.fila_pagamento_sem_vinculo fd
                     where fd.pagamento_id = p.id and fd.decisao is not null)
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$function$;

revoke all on function public.pagamentos_sem_aluno(text, boolean) from public, anon;
grant execute on function public.pagamentos_sem_aluno(text, boolean) to authenticated, service_role;

drop function if exists public._conferencia_pagamento_na_ficha(uuid, text, text, text, text);

do $prova$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.proname='_conferencia_pagamento_na_ficha') then
    raise exception 'ROLLBACK: a funcao da ficha ainda existe';
  end if;
  if (select prosrc from pg_proc where oid='public.conciliacao_feito(uuid,text,text)'::regprocedure)
       like '%_conferencia_pagamento_na_ficha%' then
    raise exception 'ROLLBACK: conciliacao_feito ainda chama a ficha';
  end if;
end
$prova$;
