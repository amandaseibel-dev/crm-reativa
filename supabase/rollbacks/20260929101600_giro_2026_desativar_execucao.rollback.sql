-- ROLLBACK de 20260929101600_giro_2026_desativar_execucao.sql
-- Religa o giro. ATENCAO: religado, ele volta a montar pool e a retirar caso de
-- operador SEM olhar a janela dos 10 dias -- foi assim em 10/09.

do $rb$
declare
  v_def text := pg_get_functiondef('public.calibragem_simular_giro_2026(jsonb)'::regprocedure);
  v_novo text := '  -- GIRO_DESATIVADO em 29/09/2026: nao havera novo giro de carteira.
  raise exception ''Giro de carteira desativado. Nenhuma simulacao nova de GIRO_2026 e criada; o historico de 10/09 continua intacto.''
    using errcode = ''42501'';
';
begin
  if position('GIRO_DESATIVADO' in v_def) = 0 then
    raise notice 'calibragem_simular_giro_2026 ja esta religada; nada a fazer.';
  else
    execute replace(v_def, v_novo, '');
  end if;
end $rb$;

do $rb$
declare
  v_def text := pg_get_functiondef('public.calibragem_executar_giro_lote_impl(uuid,integer)'::regprocedure);
  v_novo text := '  -- GIRO_DESATIVADO em 29/09/2026: nao havera novo giro de carteira.
  raise exception ''Giro de carteira desativado. Nenhuma simulacao de GIRO_2026 e executada; o historico de 10/09 continua intacto.''
    using errcode = ''42501'';
';
begin
  if position('GIRO_DESATIVADO' in v_def) = 0 then
    raise notice 'calibragem_executar_giro_lote_impl ja esta religada; nada a fazer.';
  else
    execute replace(v_def, v_novo, '');
  end if;
end $rb$;
