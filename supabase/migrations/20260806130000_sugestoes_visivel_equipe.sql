-- Erros visíveis para a equipe: operador marca e todos veem que já foi reportado.
-- A lista é anônima (não expõe quem reportou) via RPC com colunas seguras.

alter table public.sugestoes
  add column if not exists visivel_equipe boolean not null default false;

create index if not exists idx_sugestoes_visivel_erro
  on public.sugestoes (criado_em desc)
  where visivel_equipe and tipo = 'Erro';

create or replace function public.listar_erros_reportados()
returns table (
  id uuid,
  area text,
  tela text,
  descricao text,
  prioridade text,
  status text,
  criado_em timestamptz,
  status_em timestamptz
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.area, s.tela, s.descricao, s.prioridade,
         coalesce(s.status, 'NOVA') as status, s.criado_em, s.status_em
  from public.sugestoes s
  where s.tipo = 'Erro'
    and s.visivel_equipe = true
    and public.app_usuario_ativo()
  order by s.criado_em desc
  limit 200;
$$;

revoke all on function public.listar_erros_reportados() from public, anon;
grant execute on function public.listar_erros_reportados() to authenticated;
