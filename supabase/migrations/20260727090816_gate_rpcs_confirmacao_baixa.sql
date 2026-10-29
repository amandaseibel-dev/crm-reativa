-- ============================================================================
-- Migration: gate de segurança nas RPCs da Fila de Confirmação de baixa
-- Data.......: 2026-07-27
-- Branch.....: security/gate-rpcs-confirmacao-baixa
--
-- ESCOPO (somente estas 2 RPCs):
--   public.concluir_baixa_pagamento(p_baixa_id uuid, p_responsavel_nome text,
--                                   p_responsavel_email text)
--   public.devolver_baixa_pagamento(p_baixa_id uuid, p_motivo_devolucao text,
--                                   p_responsavel_nome text, p_responsavel_email text)
--
-- Objetivo: impedir que operador/anon/sem-cadastro/inativo executem a
--   conclusão (baixa realizada) ou a devolução da baixa chamando a RPC
--   diretamente pela API, mesmo com o GRANT EXECUTE atual a `authenticated`.
--
-- Regra do gate (prepended, nada mais alterado):
--   * PERMITIDO: gestão financeira autorizada = public.usuario_e_gestao()
--     (Amanda = amanda.seibel, Fernanda = cobranca04, Amanda ADM = cobranca07)
--     E usuário ativo = public.app_usuario_ativo().
--   * BLOQUEADO: operador, anon, e-mail sem cadastro em public.usuarios e
--     usuário inativo.
--   * PRESERVADO: service_role (auth.role() = 'service_role') e backend direto
--     postgres/cron/migrations (sem JWT de usuário => auth.jwt() is null).
--
-- Preservação: SECURITY DEFINER, SET search_path = public, toda a lógica,
--   auditoria (aluno_movimentacoes / notificacoes), status e retorno (void)
--   permanecem idênticos ao original. Somente o bloco de gate foi acrescentado
--   logo após o `begin`. Nenhuma tabela, grant, frontend ou outra RPC alterada.
--
-- Idempotente (CREATE OR REPLACE). NÃO aplicar migration/merge/deploy.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. concluir_baixa_pagamento
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concluir_baixa_pagamento(p_baixa_id uuid, p_responsavel_nome text, p_responsavel_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aluno_id text;
  v_aluno_nome text;
  v_operador_nome text;
  v_operador_email text;
begin
  -- ------------------------------------------------------------------------
  -- GATE DE SEGURANÇA (security/gate-rpcs-confirmacao-baixa)
  -- Somente gestão financeira autorizada + ativa: Amanda, Fernanda, Amanda ADM.
  -- operador / anon / sem cadastro / inativo: bloqueados.
  -- service_role e backend direto (postgres/cron/migrations): preservados.
  -- ------------------------------------------------------------------------
  if not (
       auth.role() = 'service_role'
    or auth.jwt() is null
    or (public.usuario_e_gestao() and public.app_usuario_ativo())
  ) then
    raise exception 'Acesso negado: apenas a gestao financeira (Amanda, Fernanda, Amanda ADM) pode concluir baixas.'
      using errcode = '42501';
  end if;

  select
    aluno_id,
    aluno_nome,
    operador_origem_nome,
    operador_origem_email
  into
    v_aluno_id,
    v_aluno_nome,
    v_operador_nome,
    v_operador_email
  from public.baixas_pagamento
  where id = p_baixa_id;

  update public.baixas_pagamento
  set
    status_baixa = 'BAIXA_REALIZADA',
    baixado_por_nome = p_responsavel_nome,
    baixado_por_email = p_responsavel_email,
    baixado_em = now(),
    atualizado_em = now()
  where id = p_baixa_id;

  update public.alunos
  set
    status_baixa_pagamento = 'BAIXA_REALIZADA',
    status_jornada = 'BAIXA_REALIZADA',
    status_atual = 'BAIXA_REALIZADA',
    status_acionamento = 'BAIXA_REALIZADA',
    proxima_acao = 'AVISAR_OPERADOR_BAIXA_REALIZADA',
    fila_destino = 'OPERADOR_ORIGEM',
    registrado_por_nome = p_responsavel_nome,
    registrado_por_email = p_responsavel_email,
    registrado_em = now()
  where id::text = v_aluno_id;

  insert into public.aluno_movimentacoes (
    aluno_id,
    tipo,
    descricao,
    status_novo,
    registrado_por_nome,
    registrado_por_email,
    registrado_em,
    baixa_pagamento_id
  )
  values (
    v_aluno_id,
    'BAIXA_REALIZADA',
    'Baixa de pagamento realizada por Amanda.',
    'BAIXA_REALIZADA',
    p_responsavel_nome,
    p_responsavel_email,
    now(),
    p_baixa_id
  );

  insert into public.notificacoes (
    usuario_destino_nome,
    usuario_destino_email,
    tipo,
    titulo,
    mensagem,
    aluno_id,
    baixa_id,
    url_destino
  )
  values (
    v_operador_nome,
    v_operador_email,
    'BAIXA_REALIZADA',
    'Baixa realizada',
    'A baixa de pagamento de ' || coalesce(v_aluno_nome, 'aluno') || ' foi realizada.',
    v_aluno_id,
    p_baixa_id,
    '/fila-operacional'
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- 2. devolver_baixa_pagamento
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.devolver_baixa_pagamento(p_baixa_id uuid, p_motivo_devolucao text, p_responsavel_nome text, p_responsavel_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aluno_id text;
  v_aluno_nome text;
  v_operador_nome text;
  v_operador_email text;
begin
  -- ------------------------------------------------------------------------
  -- GATE DE SEGURANÇA (security/gate-rpcs-confirmacao-baixa)
  -- Somente gestão financeira autorizada + ativa: Amanda, Fernanda, Amanda ADM.
  -- operador / anon / sem cadastro / inativo: bloqueados.
  -- service_role e backend direto (postgres/cron/migrations): preservados.
  -- ------------------------------------------------------------------------
  if not (
       auth.role() = 'service_role'
    or auth.jwt() is null
    or (public.usuario_e_gestao() and public.app_usuario_ativo())
  ) then
    raise exception 'Acesso negado: apenas a gestao financeira (Amanda, Fernanda, Amanda ADM) pode devolver baixas.'
      using errcode = '42501';
  end if;

  select
    aluno_id,
    aluno_nome,
    operador_origem_nome,
    operador_origem_email
  into
    v_aluno_id,
    v_aluno_nome,
    v_operador_nome,
    v_operador_email
  from public.baixas_pagamento
  where id = p_baixa_id;

  update public.baixas_pagamento
  set
    status_baixa = 'BAIXA_DEVOLVIDA',
    devolvido_por_nome = p_responsavel_nome,
    devolvido_por_email = p_responsavel_email,
    devolvido_em = now(),
    motivo_devolucao = p_motivo_devolucao,
    atualizado_em = now()
  where id = p_baixa_id;

  update public.alunos
  set
    status_baixa_pagamento = 'BAIXA_DEVOLVIDA',
    status_jornada = 'BAIXA_DEVOLVIDA',
    status_atual = 'BAIXA_DEVOLVIDA',
    status_acionamento = 'BAIXA_DEVOLVIDA',
    proxima_acao = 'CORRIGIR_COMPROVANTE',
    fila_destino = 'OPERADOR_ORIGEM',
    registrado_por_nome = p_responsavel_nome,
    registrado_por_email = p_responsavel_email,
    registrado_em = now()
  where id::text = v_aluno_id;

  insert into public.aluno_movimentacoes (
    aluno_id,
    tipo,
    descricao,
    status_novo,
    registrado_por_nome,
    registrado_por_email,
    registrado_em,
    baixa_pagamento_id,
    motivo_devolucao
  )
  values (
    v_aluno_id,
    'BAIXA_DEVOLVIDA',
    'Baixa devolvida ao operador. Motivo: ' || coalesce(p_motivo_devolucao, '-'),
    'BAIXA_DEVOLVIDA',
    p_responsavel_nome,
    p_responsavel_email,
    now(),
    p_baixa_id,
    p_motivo_devolucao
  );

  insert into public.notificacoes (
    usuario_destino_nome,
    usuario_destino_email,
    tipo,
    titulo,
    mensagem,
    aluno_id,
    baixa_id,
    url_destino
  )
  values (
    v_operador_nome,
    v_operador_email,
    'BAIXA_DEVOLVIDA',
    'Baixa devolvida',
    'A baixa de pagamento de ' || coalesce(v_aluno_nome, 'aluno') || ' foi devolvida. Motivo: ' || coalesce(p_motivo_devolucao, '-'),
    v_aluno_id,
    p_baixa_id,
    '/fila-operacional'
  );
end;
$function$;

commit;
