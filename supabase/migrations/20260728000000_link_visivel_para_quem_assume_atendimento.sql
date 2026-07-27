-- Hotfix: LINK DE PAGAMENTO NAO DISPONIVEL APOS ASSUMIR ATENDIMENTO
-- -----------------------------------------------------------------------------
-- Sintoma (reproduzido em producao com BEGIN/ROLLBACK, claims de operador ativo):
--   um operador que ASSUME validamente o atendimento de um aluno de colega
--   (alunos.responsavel_atual_email = ele) NAO enxerga nem consegue marcar como
--   "enviado ao aluno" o link pronto daquele aluno. Reproducao: link 290e5e6b
--   (operador_email=cobranca10) com aluno cujo responsavel_atual passou a ser
--   cobranca03 -> SELECT como cobranca03 retorna 0 linhas.
--
-- Causa: as policies de links_pagamento chaveiam o acesso APENAS por
--   links_pagamento.operador_email (quem SOLICITOU o link) ou gestao. Assumir o
--   atendimento atualiza alunos.responsavel_atual_email / casos.operador_email,
--   mas NAO altera links_pagamento.operador_email (e nao deve -- assumir nao
--   muda o conteudo/valor do link). Logo o novo responsavel fica sem acesso.
--
-- Divergencia de responsavel (confirmada em producao):
--   links_pagamento.operador_email  = responsavel ORIGINAL (solicitante)
--   alunos.responsavel_atual_email  = quem assumiu o atendimento AGORA
--
-- Correcao SEGURA (RLS controla LINHAS, nao colunas):
--   1) SELECT: acrescenta ramo "responsavel atual do aluno" -> ele VE o link.
--      NAO se toca a policy generica de UPDATE (continua gestao OU dono), para
--      NAO permitir que o assumidor altere valor/url/forma/aluno/operador.
--   2) Envio do link deixa de ser UPDATE direto do cliente e passa a ser a RPC
--      marcar_link_enviado_ao_aluno(uuid): SECURITY DEFINER, altera SOMENTE os
--      campos de envio, com autorizacao e idempotencia internas.
--
-- NAO toca comprovantes, baixas, pagamentos, Storage, INSERT/DELETE, nem RPCs
-- financeiras. NAO amplia a policy de UPDATE de links_pagamento.
-- -----------------------------------------------------------------------------

-- 1) Helper: o usuario autenticado e o responsavel ATUAL do aluno do link?
--    (SECURITY DEFINER: le public.alunos sem recursao de RLS.)
create or replace function public.operador_assumiu_atendimento_do_link(p_aluno_id text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p_aluno_id is not null
    and public.app_email() <> ''
    and exists (
      select 1
      from public.alunos a
      where a.id = p_aluno_id::uuid
        and lower(coalesce(a.responsavel_atual_email, '')) = public.app_email()
    );
$function$;

revoke all on function public.operador_assumiu_atendimento_do_link(text) from public, anon;
grant execute on function public.operador_assumiu_atendimento_do_link(text) to authenticated, service_role;

-- 2) SELECT: gestao-fila OU dono (operador_email) OU quem assumiu o atendimento.
--    Somente leitura -- nao concede escrita de nenhum campo.
drop policy if exists links_pagamento_select on public.links_pagamento;
create policy links_pagamento_select on public.links_pagamento
  for select to authenticated
  using (
    (select public.usuario_e_gestao_fila())
    or lower(operador_email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    or public.operador_assumiu_atendimento_do_link(aluno_id)
  );

-- NOTA: a policy links_pagamento_update_authenticated NAO e alterada aqui.
-- Continua valendo (migracao 20260727234500): ativo AND (gestao OU
-- operador_email = eu). O responsavel que assumiu NAO ganha UPDATE generico.

-- 3) RPC de envio: unica via para marcar "enviado ao aluno".
--    Altera SOMENTE status/carimbos de envio; nunca valor, link, forma,
--    aluno_id, operador_email, adm_responsavel ou responsavel. Idempotente.
create or replace function public.marcar_link_enviado_ao_aluno(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me   text := public.app_email();
  v_link public.links_pagamento%rowtype;
begin
  -- Gate: autenticado + ativo/cadastrado. anon/inativo/sem cadastro caem aqui.
  if coalesce(v_me, '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'NAO_AUTENTICADO');
  end if;
  if not public.app_usuario_ativo() then
    return jsonb_build_object('ok', false, 'erro', 'USUARIO_INATIVO');
  end if;

  select * into v_link from public.links_pagamento where id = p_link_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'LINK_NAO_ENCONTRADO');
  end if;

  -- Autorizacao: gestao OU operador original (dono) OU responsavel atual do aluno.
  if not (
       public.usuario_e_gestao()
    or lower(coalesce(v_link.operador_email, '')) = v_me
    or public.operador_assumiu_atendimento_do_link(v_link.aluno_id)
  ) then
    return jsonb_build_object('ok', false, 'erro', 'SEM_PERMISSAO');
  end if;

  -- Precisa existir link pronto (nao "enviar" o que nao ha).
  if coalesce(v_link.link_pagamento, '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'SEM_LINK');
  end if;

  -- Idempotente: ja enviado -> nao reescreve, nao dispara trigger/historico.
  if v_link.status = 'LINK_ENVIADO_AO_ALUNO' then
    return jsonb_build_object('ok', true, 'ja_enviado', true, 'enviado_por', v_me);
  end if;

  -- So permite a transicao a partir de um estado pre-envio (nao regride baixa).
  if v_link.status not in ('LINK_GERADO', 'LINK_PRONTO_PARA_ENVIO', 'LINK_EM_ATENDIMENTO') then
    return jsonb_build_object('ok', false, 'erro', 'STATUS_INVALIDO', 'status', v_link.status);
  end if;

  -- Altera EXCLUSIVAMENTE os campos do envio. O trigger registrar_historico_
  -- link_update grava o historico com public.app_email() (ator real).
  update public.links_pagamento
     set status              = 'LINK_ENVIADO_AO_ALUNO',
         enviado_operador_em = now(),
         enviado_ao_aluno_em = now(),
         atualizado_em       = now()
   where id = p_link_id;

  return jsonb_build_object('ok', true, 'enviado_por', v_me);
end;
$function$;

revoke all on function public.marcar_link_enviado_ao_aluno(uuid) from public, anon;
grant execute on function public.marcar_link_enviado_ao_aluno(uuid) to authenticated;
