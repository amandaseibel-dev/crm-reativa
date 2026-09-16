-- Testes: sem login, nada de RPC
-- =============================================================================
-- COMO RODAR: cole no SQL editor. Só LÊ -- a tabela de resultado é temporária.
-- Pode rodar em produção. Funções que não existem no ambiente são puladas.
--
-- COMO SIMULA: `set local role anon` + claims {"role":"anon"} é exatamente o
-- que chega pelo PostgREST quando alguém usa a chave pública sem sessão. Os
-- resultados são acumulados em memória e gravados depois do `reset role`,
-- porque anon/authenticated não escrevem na tabela temporária do postgres.
--
-- O QUE ESTES TESTES PROTEGEM:
--   * chamador sem login não executa RPC nenhuma das 47 (aqui: as 4 sem trava
--     interna + 2 do WhatsApp);
--   * usuário logado continua executando (dias_uteis, sistema_sob_carga);
--   * a view consulta_financeira_por_aluno respeita a RLS (security_invoker);
--   * _mapa_casca_20260902 tem RLS e não é lida por usuário logado.
-- =============================================================================
drop table if exists _t_sem_login;
create temp table _t_sem_login (n int, caso text, ok boolean, detalhe text);

do $teste$
declare
  v_n int := 0; v_txt text; v_fn text; v_chamada text; i int;
  v_res text[] := '{}';
  v_alvos text[][] := array[
    ['aluno_matricula_semestres(uuid)', 'select count(*) from public.aluno_matricula_semestres(''00000000-0000-0000-0000-000000000000'')'],
    ['aluno_contatos_sincronizar(uuid)', 'select public.aluno_contatos_sincronizar(''00000000-0000-0000-0000-000000000000'')'],
    ['dias_uteis(date,date)',           'select public.dias_uteis(current_date, current_date + 7)'],
    ['sistema_sob_carga()',             'select public.sistema_sob_carga()'],
    ['whatsapp_conversas_listar(text,uuid,text,integer,text,text)', 'select count(*) from public.whatsapp_conversas_listar(null, null, null, 5, null, null)'],
    ['whatsapp_canais_listar()',        'select count(*) from public.whatsapp_canais_listar()']
  ];
begin
  -- 1) sem login: cada chamada tem de cair em "permission denied" (42501)
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  for i in 1 .. array_length(v_alvos, 1) loop
    v_fn := v_alvos[i][1]; v_chamada := v_alvos[i][2];
    v_n := v_n + 1;
    if to_regprocedure('public.' || v_fn) is null then
      v_res := v_res || (v_n || '|sem login: ' || v_fn || ' (pulado: nao existe aqui)|t|pulado');
      continue;
    end if;
    begin
      execute v_chamada;
      v_res := v_res || (v_n || '|sem login: ' || v_fn || ' nega|f|EXECUTOU');
    exception when insufficient_privilege then
      v_res := v_res || (v_n || '|sem login: ' || v_fn || ' nega|t|' || sqlstate || ' ' || left(sqlerrm, 60));
    when others then
      v_res := v_res || (v_n || '|sem login: ' || v_fn || ' nega|f|' || sqlstate || ' ' || left(sqlerrm, 80));
    end;
  end loop;
  execute 'reset role';

  -- 2) logado (Amanda): as duas utilitárias continuam funcionando
  perform set_config('request.jwt.claims', '{"role":"authenticated","email":"amanda.seibel@aelbra.com.br"}', true);
  execute 'set local role authenticated';
  v_n := v_n + 1;
  if to_regprocedure('public.dias_uteis(date,date)') is null then
    v_res := v_res || (v_n || '|logado: dias_uteis (pulado: nao existe aqui)|t|pulado');
  else
    begin
      execute 'select public.dias_uteis(current_date, current_date + 7)' into v_txt;
      v_res := v_res || (v_n || '|logado: dias_uteis executa|t|' || v_txt || ' dias');
    exception when others then
      v_res := v_res || (v_n || '|logado: dias_uteis executa|f|' || sqlstate || ' ' || left(sqlerrm, 80));
    end;
  end if;
  v_n := v_n + 1;
  if to_regprocedure('public.sistema_sob_carga()') is null then
    v_res := v_res || (v_n || '|logado: sistema_sob_carga (pulado: nao existe aqui)|t|pulado');
  else
    begin
      execute 'select (public.sistema_sob_carga() ? ''sob_carga'')::text' into v_txt;
      v_res := v_res || (v_n || '|logado: sistema_sob_carga executa|' || (v_txt = 'true') || '|tem sob_carga=' || v_txt);
    exception when others then
      v_res := v_res || (v_n || '|logado: sistema_sob_carga executa|f|' || sqlstate || ' ' || left(sqlerrm, 80));
    end;
  end if;

  -- 4) tabela de apoio: usuário logado não lê
  v_n := v_n + 1;
  if to_regclass('public._mapa_casca_20260902') is null then
    v_res := v_res || (v_n || '|_mapa_casca_20260902 (pulado: nao existe)|t|pulado');
  else
    begin
      execute 'select count(*) from public._mapa_casca_20260902' into v_txt;
      v_res := v_res || (v_n || '|logado: _mapa_casca_20260902 nega|f|LEU ' || v_txt);
    exception when insufficient_privilege then
      v_res := v_res || (v_n || '|logado: _mapa_casca_20260902 nega|t|' || sqlstate);
    end;
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- grava o que foi acumulado (agora como postgres)
  for i in 1 .. coalesce(array_length(v_res, 1), 0) loop
    insert into _t_sem_login
      select split_part(v_res[i], '|', 1)::int, split_part(v_res[i], '|', 2), split_part(v_res[i], '|', 3)::boolean, split_part(v_res[i], '|', 4);
  end loop;

  -- 3) view respeita RLS (catálogo, lido como postgres)
  v_n := v_n + 1;
  if to_regclass('public.consulta_financeira_por_aluno') is null then
    insert into _t_sem_login values (v_n, 'view consulta_financeira_por_aluno (pulado: nao existe)', true, 'pulado');
  else
    select coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'off')
      into v_txt from pg_class c where c.oid = 'public.consulta_financeira_por_aluno'::regclass;
    insert into _t_sem_login values (v_n, 'view consulta_financeira_por_aluno com security_invoker', v_txt in ('true','on'), 'security_invoker=' || v_txt);
  end if;
  v_n := v_n + 1;
  if to_regclass('public._mapa_casca_20260902') is not null then
    insert into _t_sem_login select v_n, '_mapa_casca_20260902 com RLS', c.relrowsecurity, 'rls=' || c.relrowsecurity
      from pg_class c where c.oid = 'public._mapa_casca_20260902'::regclass;
  end if;
end $teste$;

select n, caso, ok, detalhe from _t_sem_login order by n;
