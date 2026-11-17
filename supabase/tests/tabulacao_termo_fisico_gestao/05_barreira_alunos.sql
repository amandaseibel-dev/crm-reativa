-- Barreira de estado em alunos, executada por um papel de LOGIN (session_user = app_teste).
-- A função de produção deixa passar session_user in ('postgres', ...), então o teste
-- precisa de outra sessão. Requer a migração aplicada (linhas do catálogo somente_gestao).
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);

do $$
begin
  begin
    update public.alunos set status_atual = 'TERMO_FISICO_ARQUIVADO'
     where id = 'a0000000-0000-0000-0000-000000000042';
    raise exception 'FALHOU: barreira de alunos não recusou TERMO_FISICO_ARQUIVADO no estado';
  exception when sqlstate '42501' then
    raise notice 'PASS: barreira de alunos recusa código restrito no estado do aluno (42501)';
  end;
end $$;

do $$
begin
  update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042';
  raise notice 'PASS: barreira de alunos permite código comum';
end $$;
