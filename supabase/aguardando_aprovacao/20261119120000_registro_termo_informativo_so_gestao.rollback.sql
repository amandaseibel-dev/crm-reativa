-- REVERSÃO do registro termo informativo (PENDENTE; NÃO APLICADA)
-- Remove somente o gatilho e a função criados por 20261119120000. Não apaga movimentações gravadas
-- (o histórico é preservado), não altera alunos, grants nem policies.

begin;

do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'trg_registro_termo_informativo_so_gestao' and not tgisinternal) then
    drop trigger trg_registro_termo_informativo_so_gestao on public.aluno_movimentacoes;
  end if;
  if to_regprocedure('public.registro_termo_informativo_so_gestao()') is not null then
    drop function public.registro_termo_informativo_so_gestao();
  end if;
end $$;

commit;
