-- ROLLBACK da regularização de public.usuario_e_gestao() — NÃO-OP, por desenho.
--
-- A regularização não remove função de produção: a função já existe em produção e é dependência de
-- políticas RLS e de funções. Remover reabriria o acesso ou quebraria políticas. Por isso este rollback
-- não altera nada. Se a regularização criou a função em um banco novo, a remoção exige decisão específica
-- (a função tem dependentes; `drop function` falha sem CASCADE, e CASCADE removeria políticas).
begin;
do $$
begin
  raise notice 'rollback da regularização de usuario_e_gestao(): não-op por desenho; nada removido';
end
$$;
commit;
