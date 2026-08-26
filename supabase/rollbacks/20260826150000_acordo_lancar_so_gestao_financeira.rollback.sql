-- Rollback: volta a deixar o operador lançar acordo para o aluno dele.
--
-- Só faça isso se a operação passar a lançar acordo no dia a dia. Enquanto o
-- lançamento for da gestão financeira, esta política aberta é um furo: a regra
-- volta a valer só enquanto a pessoa usar o botão da tela.

drop policy if exists acordos_insert on public.acordos;

create policy acordos_insert on public.acordos
for insert
with check (
  (not eh_painel())
  and app_usuario_ativo()
  and (
    usuario_e_gestao()
    or (
      ((coalesce(operador_responsavel_email, '') = '') or (lower(operador_responsavel_email) = app_email()))
      and exists (
        select 1 from public.alunos a
        where a.id = acordos.aluno_id
          and ((coalesce(a.responsavel_atual_email, '') = '') or (lower(a.responsavel_atual_email) = app_email()))
      )
    )
  )
);
