-- =============================================================================
-- ULBRA — teto ACUMULADO de uma campanha de coleta, atômico e independente do dia.
-- PENDENTE. NÃO APLICAR sem autorização expressa da gestão.
--
-- Problema: `chamadas_dia` zera na virada do dia e duas execuções concorrentes
-- leem o mesmo valor antes de gravar — o teto autorizado (ex.: 110 para
-- novembro) poderia ser ultrapassado ou renovado.
--
-- Solução: a execução RESERVA chamadas antes de sair (linha de estado travada
-- com FOR UPDATE), e devolve o que não usou ao terminar. Reserva conta
-- tentativas e falhas, porque acontece antes da chamada. Se a execução cair
-- antes de devolver, o reservado fica gasto (conservador: nunca ultrapassa).
-- O teto nunca sobe para a mesma campanha; só uma campanha com OUTRO id começa
-- do zero — decisão manual, nunca a virada do dia.
--
-- Escrita só por service_role (a função ulbra-sincronizar). Nenhum grant a
-- authenticated/anon/public.
-- =============================================================================
alter table public.ulbra_sync_estado
  add column if not exists campanha_id text,
  add column if not exists campanha_teto integer,
  add column if not exists campanha_reservadas integer not null default 0,
  add column if not exists campanha_iniciada_em timestamptz;

create or replace function public.ulbra_sync_campanha_reservar(p_campanha text, p_teto integer, p_pedido integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   text;
  v_teto integer;
  v_res  integer;
  v_conc integer;
begin
  if coalesce(btrim(p_campanha), '') = '' or p_teto is null or p_teto < 1 or p_pedido is null or p_pedido < 0 then
    return jsonb_build_object('ok', false, 'motivo', 'PARAMETROS_INVALIDOS');
  end if;
  select campanha_id, campanha_teto, campanha_reservadas into v_id, v_teto, v_res
    from public.ulbra_sync_estado where id for update;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'ESTADO_AUSENTE');
  end if;
  if v_id is distinct from p_campanha then
    -- campanha nova: começa do zero com o teto pedido
    v_teto := p_teto; v_res := 0;
    update public.ulbra_sync_estado
       set campanha_id = p_campanha, campanha_teto = v_teto, campanha_reservadas = 0, campanha_iniciada_em = now()
     where id;
  else
    -- mesma campanha: o teto NUNCA sobe
    v_teto := least(coalesce(v_teto, p_teto), p_teto);
  end if;
  v_conc := greatest(0, least(p_pedido, v_teto - coalesce(v_res, 0)));
  update public.ulbra_sync_estado
     set campanha_teto = v_teto, campanha_reservadas = coalesce(v_res, 0) + v_conc
   where id;
  return jsonb_build_object('ok', true, 'campanha', p_campanha, 'teto', v_teto,
    'concedido', v_conc, 'reservadas', coalesce(v_res, 0) + v_conc, 'restante', v_teto - (coalesce(v_res, 0) + v_conc));
end;
$$;

create or replace function public.ulbra_sync_campanha_devolver(p_campanha text, p_nao_usadas integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text; v_teto integer; v_res integer;
begin
  select campanha_id, campanha_teto, campanha_reservadas into v_id, v_teto, v_res
    from public.ulbra_sync_estado where id for update;
  if not found or v_id is distinct from p_campanha then
    return jsonb_build_object('ok', false, 'motivo', 'CAMPANHA_DIFERENTE');
  end if;
  v_res := greatest(0, coalesce(v_res, 0) - greatest(0, coalesce(p_nao_usadas, 0)));
  update public.ulbra_sync_estado set campanha_reservadas = v_res where id;
  return jsonb_build_object('ok', true, 'campanha', p_campanha, 'teto', v_teto, 'reservadas', v_res, 'restante', coalesce(v_teto, 0) - v_res);
end;
$$;

revoke all on function public.ulbra_sync_campanha_reservar(text, integer, integer) from public, anon, authenticated;
revoke all on function public.ulbra_sync_campanha_devolver(text, integer) from public, anon, authenticated;
grant execute on function public.ulbra_sync_campanha_reservar(text, integer, integer) to service_role;
grant execute on function public.ulbra_sync_campanha_devolver(text, integer) to service_role;
