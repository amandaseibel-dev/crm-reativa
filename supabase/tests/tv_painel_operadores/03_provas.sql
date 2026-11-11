-- PROVAS: grants, portão, regras e valores em centavos.
\set ON_ERROR_STOP on

-- 1) definição: SECURITY DEFINER com search_path fixo
select public.afirmar(p.prosecdef, 'função é SECURITY DEFINER')
  from pg_proc p where p.proname = 'tv_painel_operadores';
select public.afirmar(array_to_string(p.proconfig, ',') like '%search_path=public%', 'search_path fixo em public')
  from pg_proc p where p.proname = 'tv_painel_operadores';

-- 2) grants: anon e PUBLIC sem EXECUTE (o default privileges daria), authenticated com
select public.afirmar(not has_function_privilege('anon', 'public.tv_painel_operadores()', 'execute'), 'anon NÃO executa');
select public.afirmar(has_function_privilege('authenticated', 'public.tv_painel_operadores()', 'execute'), 'authenticated executa');
select public.afirmar(not exists (
  select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.proname = 'tv_painel_operadores' and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'PUBLIC sem EXECUTE');

-- 3) portão: autenticado fora da allowlist → 42501
set role authenticated;
select set_config('teste.email', 'cobranca05@aelbra.com.br', false);
do $$
begin
  perform public.tv_painel_operadores();
  raise exception 'FALHOU: operador fora da allowlist leu o painel';
exception when insufficient_privilege then
  raise notice 'ok: fora da allowlist recebe 42501';
end $$;
select set_config('teste.email', '', false);
do $$
begin
  perform public.tv_painel_operadores();
  raise exception 'FALHOU: sem e-mail leu o painel';
exception when insufficient_privilege then
  raise notice 'ok: sem e-mail recebe 42501';
end $$;

-- 4) conta da TV lê; confere cada bloco
select set_config('teste.email', 'painel.tv@reativa.local', false);
create temp table r as select public.tv_painel_operadores() j;
create temp table ontem_no_mes as
  select (date_trunc('month', d - 1) = date_trunc('month', d)) v from public.teste_hoje h;

select public.afirmar((select j->'referencia'->>'hoje' from r) = (select to_char(d, 'YYYY-MM-DD') from public.teste_hoje h),
  'referência de hoje = data de Brasília');
select public.afirmar((select j->'referencia'->>'fuso' from r) = 'America/Sao_Paulo', 'fuso declarado');

-- totais da empresa, em centavos (todos os operadores, inclusive fora da allowlist)
select public.afirmar((select (j->'mes'->>'honorarios')::numeric from r)
  = 14237.54 + case when (select v from ontem_no_mes) then 1.00 else 0 end, 'honorários do mês em centavos');
select public.afirmar((select (j->'mes'->>'recuperado')::numeric from r)
  = 157356.51 + case when (select v from ontem_no_mes) then 10.00 else 0 end, 'recuperado do mês em centavos');
select public.afirmar((select (j->'hoje'->>'honorarios')::numeric from r) = 14227.54, 'honorários de hoje sem retroativo');
select public.afirmar((select (j->'hoje'->>'recuperado')::numeric from r) = 157256.51, 'recuperado de hoje sem retroativo');
select public.afirmar((select (j->'mes'->>'meta_honorario')::numeric from r) = 122400, 'meta vem de metas_projecao');
select public.afirmar((select (j->'mes'->>'dias_uteis_mes')::int from r)
  = (select public.dias_uteis(date_trunc('month', d)::date, (date_trunc('month', d) + interval '1 month - 1 day')::date) from public.teste_hoje h),
  'dias úteis do mês pelo calendário do CRM');
select public.afirmar((select (j->'mes'->>'dias_uteis_ate_hoje')::int from r)
  = (select public.dias_uteis(date_trunc('month', d)::date, d) from public.teste_hoje h), 'dias úteis até hoje (inclui hoje)');

-- pódio de reconhecimento: ordem por honorário acumulado, SEM valor
select public.afirmar((select jsonb_agg(x->>'nome') from r, jsonb_array_elements(j->'podio_mes') x)
  = '["Rafaella Souza","Luana Lima","João Silva"]'::jsonb, 'pódio: Rafaella, Luana, João');
select public.afirmar(not exists (select 1 from r, jsonb_array_elements(j->'podio_mes') x where x ? 'valor'),
  'pódio não devolve valor');
select public.afirmar((select j->'lider_honorarios_mes'->>'nome' from r) = 'Rafaella Souza', 'líder do mês');
select public.afirmar(not ((select j->'lider_honorarios_mes' from r) ? 'valor'), 'líder não devolve valor');

-- top honorário em UM pagamento (separado do acumulado); fora da allowlist não entra
select public.afirmar((select jsonb_agg(jsonb_build_array(x->>'nome', (x->>'valor')::numeric)) from r, jsonb_array_elements(j->'top_honorario_pagamento_mes') x)
  = '[["Rafaella Souza",2907.12],["Luana Lima",1012.39],["João Silva",200.02]]'::jsonb, 'top honorário em pagamento único');

-- top recuperado ACUMULADO no mês por operador
select public.afirmar((select jsonb_agg(jsonb_build_array(x->>'nome', (x->>'valor')::numeric)) from r, jsonb_array_elements(j->'top_recuperado_mes') x)
  = '[["Rafaella Souza",40100.00],["Luana Lima",13717.21],["João Silva",3500.30]]'::jsonb, 'top recuperado acumulado');

-- top pagamentos de HOJE (quantidade, sem retroativo, sem ontem)
select public.afirmar((select jsonb_agg(jsonb_build_array(x->>'nome', (x->>'qtd')::int)) from r, jsonb_array_elements(j->'top_pagamentos_hoje') x)
  = '[["Mauricio Reis",4],["João Silva",3],["Luana Lima",2]]'::jsonb, 'top pagamentos de hoje');

-- top acordos de HOJE: sem cancelado, sem duplicado, sem "sem responsável", sem oculto,
-- e a fronteira de meia-noite é a de Brasília
select public.afirmar((select jsonb_agg(jsonb_build_array(x->>'nome', (x->>'qtd')::int)) from r, jsonb_array_elements(j->'top_acordos_hoje') x)
  = '[["Allan Costa",3],["João Silva",2],["Mauricio Reis",1]]'::jsonb, 'top acordos de hoje');

-- só leitura: nada mudou nas tabelas
select public.afirmar((select count(*) from public.pagamentos) = 13, 'pagamentos intactos');
select public.afirmar((select count(*) from public.acordos) = 16, 'acordos intactos');
reset role;
