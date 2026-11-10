alter table public.ulbra_sync_estado
  add column if not exists offset_pendente integer;

comment on column public.ulbra_sync_estado.offset_pendente is
  'Índice, na lista ordenada da Mensageria, da primeira mensagem com em <= piso_pendente. Dica de posição de leitura: validada pela coleta antes de usar. Null quando o ciclo fechou a janela.';

create or replace function public.ulbra_sync_posicao_gravar(p_offset integer)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.ulbra_sync_estado
     set offset_pendente = case when p_offset is null or p_offset < 0 then null else p_offset end
   where id;
$$;

comment on function public.ulbra_sync_posicao_gravar(integer) is
  'Grava a posição de leitura do backlog para o próximo ciclo. Só service_role (ulbra-sincronizar).';

revoke all on function public.ulbra_sync_posicao_gravar(integer) from public, anon, authenticated;
grant execute on function public.ulbra_sync_posicao_gravar(integer) to service_role;