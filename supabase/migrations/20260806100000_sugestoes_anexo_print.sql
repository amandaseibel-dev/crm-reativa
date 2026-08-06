-- Central de Dúvidas e Sugestões: permite anexar print do erro.
-- 1) Colunas de anexo na tabela sugestoes.
-- 2) Bucket privado sugestoes-prints.
-- 3) Políticas: qualquer usuário ativo insere; só gestão lê (trata os erros).

alter table public.sugestoes
  add column if not exists anexo_path text,
  add column if not exists anexo_nome text;

insert into storage.buckets (id, name, public)
values ('sugestoes-prints', 'sugestoes-prints', false)
on conflict (id) do nothing;

drop policy if exists sugestoes_print_insert on storage.objects;
create policy sugestoes_print_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'sugestoes-prints' and app_usuario_ativo());

drop policy if exists sugestoes_print_select on storage.objects;
create policy sugestoes_print_select
  on storage.objects for select to authenticated
  using (bucket_id = 'sugestoes-prints' and usuario_e_gestao_fila());
