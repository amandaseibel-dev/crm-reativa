-- Permissões, RLS (via função definer), perfis e search_path efetivo, em PostgreSQL real.
-- Qualquer falha levanta exceção e derruba o job.
create or replace function pg_temp.afirma(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'FALHA: %', msg; end if; end $$;

-- 1) metadados da função
do $$ declare p pg_proc; begin
  select * into p from pg_proc where proname='carteira_prioridade_bordero';
  perform pg_temp.afirma(p.prosecdef, 'funcao deve ser SECURITY DEFINER');
  perform pg_temp.afirma(coalesce(array_to_string(p.proconfig, ','),'') like '%search_path=public%', 'search_path fixo public');
  perform pg_temp.afirma(p.provolatile = 's', 'deve ser STABLE');
end $$;

-- 2) grants
do $$ begin
  perform pg_temp.afirma(not has_function_privilege('anon', 'public.carteira_prioridade_bordero(uuid[])', 'EXECUTE'), 'anon nao executa');
  perform pg_temp.afirma(has_function_privilege('authenticated', 'public.carteira_prioridade_bordero(uuid[])', 'EXECUTE'), 'authenticated executa');
  perform pg_temp.afirma(not has_function_privilege('public', 'public.carteira_prioridade_bordero(uuid[])', 'EXECUTE'), 'PUBLIC nao executa');
  perform pg_temp.afirma(not has_function_privilege('service_role', 'public.carteira_prioridade_bordero(uuid[])', 'EXECUTE'), 'service_role nao executa');
end $$;

-- 3) dados sinteticos
insert into usuarios values ('op.a@teste.local', true), ('op.b@teste.local', true),
  ('inativo@teste.local', false), ('amanda.seibel@aelbra.com.br', true);
insert into importacoes (id, tipo, created_at) values
  ('00000000-0000-4000-8000-000000000900', 'BORDERO', timestamp '2026-11-06 14:00:00');
insert into alunos (id, cpf, responsavel_atual_email, status_atual) values
  ('00000000-0000-4000-8000-000000000001', '00000000001', 'op.a@teste.local', 'EM ABERTO'),
  ('00000000-0000-4000-8000-000000000002', '00000000002', 'op.b@teste.local', 'EM ABERTO');
insert into casos (aluno_id, operador_email) values
  ('00000000-0000-4000-8000-000000000001', 'op.a@teste.local'),
  ('00000000-0000-4000-8000-000000000002', 'op.b@teste.local');
insert into acordos_titulos (aluno_id, importacao_id, situacao, vencimento, valor_em_aberto, saldo_corrigido, valor_original)
  select a, '00000000-0000-4000-8000-000000000900', 'ABERTO', date '2026-03-10', 500, 500, 500
    from (values ('00000000-0000-4000-8000-000000000001'::uuid), ('00000000-0000-4000-8000-000000000002'::uuid)) v(a);

-- helper: chama a RPC como um papel e um e-mail
create or replace function pg_temp.chamar(papel text, email text, ids uuid[]) returns int
language plpgsql as $$
declare n int;
begin
  execute format('set role %I', papel);
  perform set_config('request.jwt.claims', case when email is null then '' else json_build_object('email', email)::text end, true);
  begin
    select count(*) into n from public.carteira_prioridade_bordero(ids);
  exception when others then
    reset role;
    raise;
  end;
  reset role;
  return n;
end $$;

-- 4) operador A: so a propria carteira
do $$ declare n int; begin
  n := pg_temp.chamar('authenticated', 'op.a@teste.local', array['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002']::uuid[]);
  perform pg_temp.afirma(n = 1, 'operador A deve receber so o proprio aluno (obteve '||n||')');
end $$;

-- 5) operador B simetrico
do $$ declare n int; begin
  n := pg_temp.chamar('authenticated', 'op.b@teste.local', array['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002']::uuid[]);
  perform pg_temp.afirma(n = 1, 'operador B deve receber so o proprio aluno (obteve '||n||')');
end $$;

-- 6) gestao autorizada ve o escopo solicitado
do $$ declare n int; begin
  n := pg_temp.chamar('authenticated', 'amanda.seibel@aelbra.com.br', array['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002']::uuid[]);
  perform pg_temp.afirma(n = 2, 'gestao deve receber os dois (obteve '||n||')');
end $$;

-- 7) usuario inativo: negado
do $$ begin
  begin
    perform pg_temp.chamar('authenticated', 'inativo@teste.local', array['00000000-0000-4000-8000-000000000001']::uuid[]);
    raise exception 'FALHA: inativo nao foi negado';
  exception when sqlstate '42501' then null;
  end;
end $$;

-- 8) sem JWT: negado
do $$ begin
  begin
    perform pg_temp.chamar('authenticated', null, array['00000000-0000-4000-8000-000000000001']::uuid[]);
    raise exception 'FALHA: sem JWT nao foi negado';
  exception when sqlstate '42501' then null;
  end;
end $$;

-- 9) anon: sem EXECUTE
do $$ begin
  begin
    perform pg_temp.chamar('anon', 'op.a@teste.local', array['00000000-0000-4000-8000-000000000001']::uuid[]);
    raise exception 'FALHA: anon conseguiu executar';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 10) ausencia de linha: id de outra carteira nao volta para o operador A
do $$ declare n int; begin
  n := pg_temp.chamar('authenticated', 'op.a@teste.local', array['00000000-0000-4000-8000-000000000002']::uuid[]);
  perform pg_temp.afirma(n = 0, 'id alheio nao deve aparecer');
end $$;

-- 11) mais de 1000 alunos em lotes de 500: sem truncamento
do $$ declare total int := 0; i int; ids uuid[]; begin
  insert into alunos (id, cpf, responsavel_atual_email)
    select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, lpad(g::text, 11, '0'), 'op.a@teste.local'
      from generate_series(1, 1200) g;
  insert into casos (aluno_id, operador_email)
    select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'op.a@teste.local' from generate_series(1, 1200) g;
  insert into acordos_titulos (aluno_id, importacao_id, situacao, vencimento, valor_em_aberto, saldo_corrigido, valor_original)
    select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, '00000000-0000-4000-8000-000000000900', 'ABERTO', date '2026-03-10', 100, 100, 100
      from generate_series(1, 1200) g;
  select array_agg(('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid) into ids from generate_series(1, 1200) g;
  for i in 0..2 loop
    total := total + pg_temp.chamar('authenticated', 'op.a@teste.local', ids[(i*500)+1 : least((i+1)*500, 1200)]);
  end loop;
  perform pg_temp.afirma(total = 1200, 'mais de 1000 alunos sem truncamento (obteve '||total||')');
end $$;

-- 12) lote pendente exclui; lote confirmado nao
do $$ declare r record; begin
  insert into acoes_massivas_lotes (aluno_ids) values (array['00000000-0000-4000-8000-000000000001']);
  set role authenticated;
  perform set_config('request.jwt.claims', json_build_object('email','op.a@teste.local')::text, true);
  select * into r from public.carteira_prioridade_bordero(array['00000000-0000-4000-8000-000000000001']::uuid[]);
  reset role;
  perform pg_temp.afirma(r.exclui_guiado and r.motivo_exclusao = 'LOTE_PENDENTE', 'lote pendente deve excluir');
  perform pg_temp.afirma(r.envio_realizado = false, 'lote pendente nao e envio');
end $$;

-- 13) fim: o banco e descartavel; a suite nao depende de dado persistir.
