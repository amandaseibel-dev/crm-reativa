-- Devolver a solicitação ao operador para validar a correção.
-- Gestão -> AGUARDANDO_VALIDACAO. Operador confirma (FEITA) ou reabre (REABERTO).

alter table public.sugestoes
  add column if not exists retorno_operador text,
  add column if not exists validado_em timestamptz;

-- Lista as solicitações do próprio operador (para acompanhar/validar).
create or replace function public.listar_minhas_solicitacoes()
returns table (
  id uuid,
  area text,
  tipo text,
  tela text,
  descricao text,
  prioridade text,
  status text,
  observacao_tratativa text,
  retorno_operador text,
  criado_em timestamptz,
  status_em timestamptz
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.area, s.tipo, s.tela, s.descricao, s.prioridade,
         coalesce(s.status, 'NOVA') as status,
         s.observacao_tratativa, s.retorno_operador, s.criado_em, s.status_em
  from public.sugestoes s
  where lower(coalesce(s.autor_email, '')) = public.app_email()
    and public.app_usuario_ativo()
  order by s.criado_em desc
  limit 200;
$$;

revoke all on function public.listar_minhas_solicitacoes() from public, anon;
grant execute on function public.listar_minhas_solicitacoes() to authenticated;

-- Operador valida: p_ok=true confirma correção (FEITA); false reabre (REABERTO).
create or replace function public.validar_correcao(p_id uuid, p_ok boolean, p_comentario text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean := false;
begin
  update public.sugestoes s
     set status = case when p_ok then 'FEITA' else 'REABERTO' end,
         retorno_operador = case when p_ok then s.retorno_operador else nullif(btrim(coalesce(p_comentario, '')), '') end,
         validado_em = case when p_ok then now() else s.validado_em end,
         status_em = now(),
         status_por = public.app_email()
   where s.id = p_id
     and lower(coalesce(s.autor_email, '')) = public.app_email()
     and s.status = 'AGUARDANDO_VALIDACAO'
     and public.app_usuario_ativo();
  get diagnostics v_ok = row_count;
  return v_ok > 0;
end;
$$;

revoke all on function public.validar_correcao(uuid, boolean, text) from public, anon;
grant execute on function public.validar_correcao(uuid, boolean, text) to authenticated;
