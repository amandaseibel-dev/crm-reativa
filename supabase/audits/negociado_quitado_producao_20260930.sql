-- CORPOS DE PRODUCAO, lidos de ahattpqrjmhkzsmnbdzs em 30/09/2026.
-- Copia literal de pg_get_functiondef. NAO EDITAR A MAO: este arquivo e a
-- bancada dos testes -- ele existe para que o teste rode o motor REAL, nao uma
-- reescrita conveniente dele. Se producao mudar, recapture e rode os testes.

create or replace function public.titulo_reavaliar(p_titulo uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_situacao text; v_status text; v_acordo_atual uuid;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_acordo_bloqueio uuid; v_status_bloqueio text;
begin
  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) = 'cancelada' then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then
    select coalesce(
        (select v.acordo_id from public.acordo_titulo_vinculo v
          where v.titulo_id = p_titulo
          order by v.criado_em desc nulls last limit 1),
        v_acordo_atual)
      into v_acordo_bloqueio;

    if v_acordo_bloqueio is not null then
      select upper(coalesce(status,'')) into v_status_bloqueio
        from public.acordos where id = v_acordo_bloqueio;
    end if;

    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')
       and exists (
         select 1
           from (select v.acordo_id from public.acordo_titulo_vinculo v
                  where v.titulo_id = p_titulo
                 union
                 select v_acordo_atual) c
          where c.acordo_id is not null
            and (exists (select 1 from public.parcelas p
                          where p.acordo_id = c.acordo_id
                            and upper(coalesce(p.status,'')) = 'PAGO')
                 or exists (select 1 from public.baixas_pagamento b
                             where b.acordo_id = c.acordo_id
                               and b.devolvido_em is null))) then
      return;
    end if;
  end if;

  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

create or replace function public._titulo_situacao_e_status_coerentes()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$function$;

create or replace function public.titulo_situacao_por_vinculo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_titulo uuid;
begin
  foreach v_titulo in array
    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return coalesce(new, old);
end;
$function$;

create or replace function public._acordo_status_reavalia_titulos()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_titulo uuid;
begin
  for v_titulo in
    select distinct t.id from public.acordos_titulos t
     where t.acordo_id = new.id
    union
    select distinct v.titulo_id from public.acordo_titulo_vinculo v
     where v.acordo_id = new.id
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return null;
end;
$function$;
