-- Arquivar conversa na Central. APLICADA E TESTADA EM STAGING, nao em producao.
--
-- POR QUE COLUNA E NAO STATUS: `status` (NOVO/EM_ATENDIMENTO/RESPONDIDO/
-- ENCERRADO) e excludente. Usa-lo para arquivar apagaria o estado real da
-- conversa, e o desarquivamento nao teria como devolver o que era antes.
-- Arquivamento e ORTOGONAL: uma conversa pode estar respondida E arquivada.
--
-- Timestamp em vez de booleano da auditoria de graca — quando e por quem.
alter table public.whatsapp_conversas
  add column if not exists arquivada_em  timestamptz,
  add column if not exists arquivada_por text;

create index if not exists ix_whatsapp_conversas_arquivadas
  on public.whatsapp_conversas (arquivada_em desc) where arquivada_em is not null;

comment on column public.whatsapp_conversas.arquivada_em is
  'Arquivamento MANUAL. null = ativa. Entrada nova do aluno limpa este campo (reabertura por demanda), saida nossa nao.';

create or replace function public.whatsapp_arquivar_conversa(p_conversa_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.app_usuario_ativo() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  -- NAO toca em status, responsavel, nao_lidas nem historico.
  update public.whatsapp_conversas
     set arquivada_em  = coalesce(arquivada_em, now()),
         arquivada_por = coalesce(arquivada_por, public.app_email()),
         atualizado_em = now()
   where id = p_conversa_id and arquivada_em is null;
end;
$$;

create or replace function public.whatsapp_desarquivar_conversa(p_conversa_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.app_usuario_ativo() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  update public.whatsapp_conversas
     set arquivada_em = null, arquivada_por = null, atualizado_em = now()
   where id = p_conversa_id and arquivada_em is not null;
end;
$$;

revoke all on function public.whatsapp_arquivar_conversa(uuid) from public, anon;
revoke all on function public.whatsapp_desarquivar_conversa(uuid) from public, anon;
grant execute on function public.whatsapp_arquivar_conversa(uuid) to authenticated;
grant execute on function public.whatsapp_desarquivar_conversa(uuid) to authenticated;
