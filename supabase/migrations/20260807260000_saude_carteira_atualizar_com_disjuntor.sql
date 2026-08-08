-- Disjuntor no refresh da Saude da Carteira (pesado ~65s, cron 2h + sob demanda).
-- Sob carga: ADIA o refresh (retorna skipped) em vez de empilhar. Skip seguro (MV so defasa).
CREATE OR REPLACE FUNCTION public.saude_carteira_atualizar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_t0 timestamptz := clock_timestamp(); v_ms int;
begin
  if auth.jwt() is not null and not public.usuario_e_gestao() then
    raise exception 'Apenas gestao pode atualizar a base de indicadores.' using errcode='42501';
  end if;

  if (public.sistema_sob_carga()->>'sob_carga')::boolean then
    return jsonb_build_object('skipped', true, 'motivo', 'sistema_sob_carga', 'medido_em', now());
  end if;

  refresh materialized view concurrently public.mv_saude_carteira;
  v_ms := extract(milliseconds from clock_timestamp()-v_t0)::int;
  update public.saude_carteira_mv_meta set atualizado_em=now(), duracao_ms=v_ms where id;
  return jsonb_build_object('atualizado_em', now(), 'duracao_ms', v_ms);
end; $function$;
