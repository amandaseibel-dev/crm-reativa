-- Sessão do OPERADOR (app_teste). Existe UPDATE em aluno_movimentacoes para authenticated, mas NÃO há policy de UPDATE
-- (como em produção). Logo a transição não altera nenhuma linha, e o trigger nem chega a ser acionado.
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);
set role authenticated;
do $$
declare n int; t text;
begin
  update aluno_movimentacoes set tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO' where tipo = 'OBSERVACAO_TESTE' and registrado_por_email = 'operador.teste@exemplo.local';
  get diagnostics n = row_count;
  select count(*)::text into t from aluno_movimentacoes where tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO' and registrado_por_email = 'operador.teste@exemplo.local';
  if n <> 0 then raise exception 'FALHOU 8: operador alterou linhas sem policy de UPDATE (n=%)', n; end if;
  raise notice 'PASS 8: sem policy de UPDATE, operador não muda movimentação existente (linhas=%)', n;
end $$;
