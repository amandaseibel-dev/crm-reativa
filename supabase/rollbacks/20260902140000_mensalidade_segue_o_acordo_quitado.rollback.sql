-- Desfaz 20260902140000_mensalidade_segue_o_acordo_quitado.sql
--
-- Volta o gatilho do vinculo e a RPC ao comportamento anterior (mensalidade
-- vinculada sempre NEGOCIADO/vinculada, mesmo em acordo ja pago) e devolve as
-- mensalidades reparadas ao estado que tinham antes, pelo backup.

create or replace function public.titulo_situacao_por_vinculo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_titulos uuid[] := array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null);
  v_titulo uuid;
  v_situacao text;
  v_status text;
  v_acordo uuid;
begin
  foreach v_titulo in array v_titulos loop
    select situacao, status into v_situacao, v_status
      from public.acordos_titulos where id = v_titulo;

    if upper(coalesce(v_situacao,'')) = 'PAGO'
       or lower(coalesce(v_status,'')) in ('quitada','paga') then
      continue;
    end if;

    select v.acordo_id into v_acordo
      from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
     where v.titulo_id = v_titulo
       and coalesce(v.ativo, true)
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     order by v.criado_em desc nulls last
     limit 1;

    if v_acordo is not null then
      update public.acordos_titulos
         set situacao = 'NEGOCIADO', status = 'vinculada',
             acordo_id = v_acordo, atualizado_em = now()
       where id = v_titulo
         and (coalesce(situacao,'') <> 'NEGOCIADO'
              or coalesce(status,'') <> 'vinculada'
              or acordo_id is distinct from v_acordo);
    else
      update public.acordos_titulos
         set situacao = 'ABERTO', status = 'em_aberto',
             acordo_id = null, atualizado_em = now()
       where id = v_titulo
         and (coalesce(situacao,'') <> 'ABERTO'
              or coalesce(status,'') <> 'em_aberto'
              or acordo_id is not null);
    end if;
  end loop;

  return coalesce(new, old);
end;
$function$;

create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_bloqueados uuid[];
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0));

  select aluno_id, upper(coalesce(status,'')) into v_aluno_acordo, v_status_acordo
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not (
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
      )
    );

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS','bloqueados', to_jsonb(v_bloqueados));
  end if;

  update public.acordos_titulos t
     set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
         vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
   where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n,
                             'status_acordo', v_status_acordo, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'acordo_id', p_acordo_id,
                            'status_acordo', v_status_acordo);
end;
$function$;

update public.acordos_titulos t
   set situacao = b.situacao, status = b.status, acordo_id = b.acordo_id,
       motivo_ajuste = b.motivo_ajuste, atualizado_em = now()
  from public._backup_titulo_acordo_quitado_20260902 b
 where t.id = b.id;

do $do$
declare r record;
begin
  for r in (select distinct aluno_id from public._backup_titulo_acordo_quitado_20260902
             where aluno_id is not null)
  loop
    begin perform public.recalcular_situacao_aluno(r.aluno_id, 'rollback_titulo_acordo_quitado');
    exception when others then null; end;
  end loop;
end $do$;

drop table if exists public._backup_titulo_acordo_quitado_20260902;
