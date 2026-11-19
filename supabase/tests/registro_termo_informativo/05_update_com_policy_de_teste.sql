-- Transição de tipo por UPDATE, com a policy de teste. Operador recusado pelo gatilho; gestão permitida.
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);
set role authenticated;
do $$
declare r text;
begin
  r := esperar_erro($q$update aluno_movimentacoes set tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO' where tipo = 'OBSERVACAO_TESTE' and registrado_por_email = 'operador.teste@exemplo.local'$q$, '42501');
  if r <> 'OK:42501' then raise exception 'FALHOU 9: operador conseguiu mudar a transição por UPDATE: %', r; end if;
  raise notice 'PASS 9: operador recusado na transição por UPDATE (42501)';
end $$;
reset role;
select set_config('request.jwt.claims', '{"email":"gestao.titular@exemplo.local","role":"authenticated"}', false);
set role authenticated;
do $$
declare n int;
begin
  update aluno_movimentacoes set tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO' where tipo = 'OBSERVACAO_TESTE' and registrado_por_email = 'operador.teste@exemplo.local';
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'FALHOU 10: gestão não conseguiu a transição (linhas=%)', n; end if;
  raise notice 'PASS 10: gestão faz a transição por UPDATE (2 linhas: seed e observação da preservação)';
end $$;
