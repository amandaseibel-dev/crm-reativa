-- Testes: valores de salário de outras pessoas só a Amanda lê
-- =============================================================================
-- COMO RODAR: cole no SQL editor. Só LÊ -- a tabela de resultado é temporária
-- e nenhum caso escreve em tabela do sistema. Pode rodar em produção.
--
-- COMO SIMULA O USUÁRIO: `set_config('request.jwt.claims', ...)` faz
-- `auth.jwt()` enxergar o token desejado, que é como os gates decidem quem
-- está falando; `set local role authenticated` faz a RLS valer de verdade.
-- Amanda precisa estar ativa em `public.usuarios`. O caso do DRE usa o
-- primeiro usuário ativo com perfil `diretoria` e é pulado se não houver.
--
-- O QUE ESTES TESTES PROTEGEM:
--   * token SEM e-mail (login anônimo) não passa nos gates do Fechamento de
--     Remuneração e de borderôs/importações -- e a RLS não devolve linha;
--   * backend (sem token) e service_role continuam passando;
--   * só a Amanda passa; Fernanda não;
--   * a diretoria recebe o DRE sem salário base por pessoa e sem a folha
--     detalhada; a Amanda recebe tudo.
-- =============================================================================
drop table if exists _t_salarios;
create temp table _t_salarios (n int, caso text, ok boolean, detalhe text);

do $teste$
declare
  v_ok boolean; v_n int; v_p jsonb; v_dir text; v_ano int := extract(year from current_date)::int;
  v_tem_calc boolean := to_regprocedure('public._dre_dados_calcula(integer)') is not null;
begin
  -- 1) token de usuário SEM e-mail (login anônimo): nenhum gate passa
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000","is_anonymous":true}', true);
  v_ok := public.usuario_pode_acessar_fechamento_remuneracao();
  insert into _t_salarios values (1, 'token sem e-mail: gate do Fechamento fecha', v_ok is false, 'gate='||v_ok);
  v_ok := public.app_pode_borderos_importacoes();
  insert into _t_salarios values (2, 'token sem e-mail: gate de bordero/importacao fecha', v_ok is false, 'gate='||v_ok);

  -- RLS de verdade, como role authenticated: a config do Fechamento vem vazia
  execute 'set local role authenticated';
  select count(*) into v_n from public.fechamento_remuneracao_config;
  execute 'reset role';
  insert into _t_salarios values (3, 'token sem e-mail: RLS nao devolve fechamento_remuneracao_config', v_n = 0, v_n||' linha(s)');

  -- 2) sem token nenhum (cron / SQL editor): backend passa
  perform set_config('request.jwt.claims', '', true);
  v_ok := public.usuario_pode_acessar_fechamento_remuneracao();
  insert into _t_salarios values (4, 'sem token (backend): gate do Fechamento passa', v_ok is true, 'gate='||v_ok);

  -- 3) service_role: passa
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_ok := public.usuario_pode_acessar_fechamento_remuneracao();
  insert into _t_salarios values (5, 'service_role: gate do Fechamento passa', v_ok is true, 'gate='||v_ok);

  -- 4) Amanda passa; Fernanda nao
  perform set_config('request.jwt.claims', '{"role":"authenticated","email":"amanda.seibel@aelbra.com.br"}', true);
  v_ok := public.usuario_pode_acessar_fechamento_remuneracao();
  insert into _t_salarios values (6, 'Amanda: gate do Fechamento passa', v_ok is true, 'gate='||v_ok);
  perform set_config('request.jwt.claims', '{"role":"authenticated","email":"cobranca04@aelbra.com.br"}', true);
  v_ok := public.usuario_pode_acessar_fechamento_remuneracao();
  insert into _t_salarios values (7, 'Fernanda: gate do Fechamento fecha', v_ok is false, 'gate='||v_ok);

  -- 5) DRE: diretoria sem salario por pessoa; Amanda com tudo
  if not v_tem_calc then
    insert into _t_salarios values (8, 'DRE (pulado: _dre_dados_calcula nao existe neste ambiente)', true, 'pulado');
  else
    select lower(u.email) into v_dir from public.usuarios u where u.perfil = 'diretoria' and u.ativo is true order by u.email limit 1;
    if v_dir is null then
      insert into _t_salarios values (8, 'DRE (pulado: nenhum usuario diretoria ativo)', true, 'pulado');
    else
      perform set_config('request.jwt.claims', format('{"role":"authenticated","email":"%s"}', v_dir), true);
      v_p := public.dre_snapshot(v_ano);
      insert into _t_salarios values (8, 'diretoria: DRE vem sem folha_detalhe', not (v_p ? 'folha_detalhe'),
        'chaves='||(select string_agg(k, ',') from jsonb_object_keys(v_p) k));
      select count(*) into v_n from jsonb_array_elements(coalesce(v_p -> 'funcionarios', '[]'::jsonb)) f where f ? 'salario_base';
      insert into _t_salarios values (9, 'diretoria: nenhum funcionario com salario_base', v_n = 0,
        v_n||' com salario de '||jsonb_array_length(coalesce(v_p -> 'funcionarios', '[]'::jsonb)));
      insert into _t_salarios values (10, 'diretoria: total mensal da folha continua (meses)', v_p ? 'meses',
        'meses='||coalesce(jsonb_array_length(v_p -> 'meses'), 0));

      perform set_config('request.jwt.claims', '{"role":"authenticated","email":"amanda.seibel@aelbra.com.br"}', true);
      v_p := public.dre_snapshot(v_ano);
      select count(*) into v_n from jsonb_array_elements(coalesce(v_p -> 'funcionarios', '[]'::jsonb)) f where f ? 'salario_base';
      insert into _t_salarios values (11, 'Amanda: DRE continua com folha_detalhe e salario_base',
        (v_p ? 'folha_detalhe') and v_n = jsonb_array_length(coalesce(v_p -> 'funcionarios', '[]'::jsonb)),
        'folha_detalhe='||(v_p ? 'folha_detalhe')||' funcionarios_com_salario='||v_n);
    end if;
  end if;

  perform set_config('request.jwt.claims', '', true);
end $teste$;

select n, caso, ok, detalhe from _t_salarios order by n;
