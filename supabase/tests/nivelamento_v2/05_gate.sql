-- GATE (sessao autenticada). Roda POR ULTIMO na suite: SET SESSION AUTHORIZATION
-- nao muda a sessao de volta no PGlite; no Postgres real o reset funciona.
\set ON_ERROR_STOP on

-- ---------------------------------------- 8. GATE: SEM JWT NAO AUTORIZA ----
-- Sessao muda em comandos de nivel superior (nao dentro de DO/funcao).
-- anon: sem privilegio de EXECUTE; se chegar ao gate, o gate recusa (42501).
set session authorization anon;
do $$
begin
  begin
    perform public.nivelamento_reposicao_por_baixas(1);
    raise exception 'FALHOU: anon executou a reposicao';
  exception when sqlstate '42501' then
    raise notice 'OK: anon recusado (42501)';
  end;
end $$;
reset session authorization;

-- authenticated sem gestao (JWT de operador): recusado pelo gate.
set session authorization authenticated;
select set_config('teste.email', 'opa@t.local', false);
do $$
begin
  begin
    perform public.nivelamento_reposicao_por_baixas(1);
    raise exception 'FALHOU: operador comum executou a reposicao';
  exception when sqlstate '42501' then
    raise notice 'OK: operador autenticado sem gestao recusado (42501)';
  end;
end $$;
select set_config('teste.email', '', false);
reset session authorization;

-- authenticated com gestao (JWT amanda): passa o gate.
set session authorization authenticated;
select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
select public.nivelamento_reposicao_por_baixas(1);
select set_config('teste.email', '', false);
reset session authorization;
do $$ begin raise notice 'OK: gestao autenticada passa o gate'; end $$;

-- ------------------------------ 13. GATE DAS calibragem_* (familia alterada) --
set session authorization anon;
do $$
begin
  begin
    perform public.calibragem_teste_gate();
    raise exception 'FALHOU: calibragem sem JWT passou';
  exception when sqlstate '42501' then
    raise notice 'OK: calibragem_* sem JWT agora e recusada (gate corrigido)';
  end;
end $$;
reset session authorization;

