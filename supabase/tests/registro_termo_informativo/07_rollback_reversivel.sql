-- Reversibilidade: após o ROLLBACK da migration (postgres), o operador volta a gravar o tipo (gatilho removido).
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);
set role authenticated;
insert into aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_em)
  values ('a0000000-0000-0000-0000-000000000042','REGISTRO_TERMO_FISICO_INFORMATIVO','teste após rollback','operador.teste@exemplo.local',now());
do $$ begin raise notice 'PASS 11: após rollback, gatilho removido (operador grava o tipo)'; end $$;
