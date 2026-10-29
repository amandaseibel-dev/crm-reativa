-- DISJUNTOR (wiring): envolve as 6 RPCs pesadas de gestao com exigir_capacidade().
-- Padrao wrapper: renomeia original -> _impl (logica intacta), cria wrapper de mesmo
-- nome que chama o disjuntor e repassa. Revoga acesso direto ao _impl (sem bypass).

-- 1) calibragem_simular_nivelamento(jsonb)
alter function public.calibragem_simular_nivelamento(jsonb) rename to calibragem_simular_nivelamento_impl;
revoke execute on function public.calibragem_simular_nivelamento_impl(jsonb) from authenticated, anon, public;
create function public.calibragem_simular_nivelamento(p_criterio jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.exigir_capacidade('simular nivelamento');
  return public.calibragem_simular_nivelamento_impl(p_criterio);
end $$;
revoke all on function public.calibragem_simular_nivelamento(jsonb) from public;
grant execute on function public.calibragem_simular_nivelamento(jsonb) to authenticated, service_role;

-- 2) calibragem_executar_nivelamento_lote(uuid,integer)  (mass-move; mantem timeout 90s)
alter function public.calibragem_executar_nivelamento_lote(uuid,integer) rename to calibragem_executar_nivelamento_lote_impl;
revoke execute on function public.calibragem_executar_nivelamento_lote_impl(uuid,integer) from authenticated, anon, public;
create function public.calibragem_executar_nivelamento_lote(p_id uuid, p_tamanho integer)
returns jsonb language plpgsql security definer set search_path to 'public' set statement_timeout to '90s' as $$
begin
  perform public.exigir_capacidade('executar nivelamento em lote');
  return public.calibragem_executar_nivelamento_lote_impl(p_id, p_tamanho);
end $$;
revoke all on function public.calibragem_executar_nivelamento_lote(uuid,integer) from public;
grant execute on function public.calibragem_executar_nivelamento_lote(uuid,integer) to authenticated, service_role;

-- 3) calibragem_diagnostico_sem_negociacao(integer)
alter function public.calibragem_diagnostico_sem_negociacao(integer) rename to calibragem_diagnostico_sem_negociacao_impl;
revoke execute on function public.calibragem_diagnostico_sem_negociacao_impl(integer) from authenticated, anon, public;
create function public.calibragem_diagnostico_sem_negociacao(p_ano integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.exigir_capacidade('diagnostico sem negociacao');
  return public.calibragem_diagnostico_sem_negociacao_impl(p_ano);
end $$;
revoke all on function public.calibragem_diagnostico_sem_negociacao(integer) from public;
grant execute on function public.calibragem_diagnostico_sem_negociacao(integer) to authenticated, service_role;

-- 4) dashboard_gestao_geral(integer)
alter function public.dashboard_gestao_geral(integer) rename to dashboard_gestao_geral_impl;
revoke execute on function public.dashboard_gestao_geral_impl(integer) from authenticated, anon, public;
create function public.dashboard_gestao_geral(p_dias integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.exigir_capacidade('dashboard gestao');
  return public.dashboard_gestao_geral_impl(p_dias);
end $$;
revoke all on function public.dashboard_gestao_geral(integer) from public;
grant execute on function public.dashboard_gestao_geral(integer) to authenticated, service_role;

-- 5) saude_carteira_resumo(jsonb)
alter function public.saude_carteira_resumo(jsonb) rename to saude_carteira_resumo_impl;
revoke execute on function public.saude_carteira_resumo_impl(jsonb) from authenticated, anon, public;
create function public.saude_carteira_resumo(p_filtros jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.exigir_capacidade('saude da carteira (resumo)');
  return public.saude_carteira_resumo_impl(p_filtros);
end $$;
revoke all on function public.saude_carteira_resumo(jsonb) from public;
grant execute on function public.saude_carteira_resumo(jsonb) to authenticated, service_role;

-- 6) saude_da_base()
alter function public.saude_da_base() rename to saude_da_base_impl;
revoke execute on function public.saude_da_base_impl() from authenticated, anon, public;
create function public.saude_da_base()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.exigir_capacidade('saude da base');
  return public.saude_da_base_impl();
end $$;
revoke all on function public.saude_da_base() from public;
grant execute on function public.saude_da_base() to authenticated, service_role;
