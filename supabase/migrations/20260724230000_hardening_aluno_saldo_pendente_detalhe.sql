-- Hardening de acesso da RPC public.aluno_saldo_pendente_detalhe.
--
-- Motivacao: a funcao e SECURITY DEFINER (ignora RLS de acordos/parcelas) e
-- estava com EXECUTE aberto a PUBLIC/anon e SEM nenhuma checagem interna de
-- autorizacao -- qualquer chamador, inclusive anonimo, obtinha o financeiro de
-- qualquer aluno. Esta migration:
--   1) revoga EXECUTE de PUBLIC/anon (mantem authenticated e service_role);
--   2) adiciona checagem interna de autorizacao usando auth.uid()/auth.jwt()
--      (NUNCA e-mail vindo do frontend), preservando assinatura e retorno.
--
-- Regras de autorizacao:
--   - Contexto interno/backend (cron, triggers SECURITY DEFINER, service_role):
--     liberado -- a funcao e reusada pelo fluxo de quitacao/zerado e nao pode
--     quebrar. Detectado por ausencia de request JWT ou role=service_role.
--   - anon / sem sessao de usuario: negado.
--   - gestao (gerencia, administrativo), supervisao (supervisor) e os e-mails de
--     usuario_e_gestao() (Amanda, Fernanda, Amanda Borges): liberados p/ qualquer aluno.
--   - operador: somente aluno sob sua responsabilidade (alunos.responsavel_atual_email)
--     ou com acesso operacional legitimo (caso/acordo atribuido a ele).
--   - Negacao e sempre generica (mesmo erro), sem revelar se o aluno existe.
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT). Rollback em
-- supabase/rollbacks/20260724230000_hardening_aluno_saldo_pendente_detalhe_down.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cpf text;
  v_titulos_abertos numeric := 0;
  v_titulos_orfaos  numeric := 0;
  v_parcelas_valor  numeric := 0;
  v_parcelas_qtd    int := 0;
  v_conf_pendentes  int := 0;
  v_total           numeric := 0;
  -- Autorizacao (resolvida por auth.uid()/auth.jwt(), nunca por dado do frontend).
  v_req_claims text := current_setting('request.jwt.claims', true); -- null fora de request PostgREST
  v_role       text := lower(coalesce(auth.jwt() ->> 'role', ''));
  v_uid        uuid := auth.uid();
  v_email      text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_perfil     text;
  v_interno    boolean;
  v_autorizado boolean := false;
begin
  -- 1) Contexto interno/backend confiavel: cron, triggers e chamadas internas
  --    (sem request JWT) e chamadas com service_role. NUNCA cobre anon.
  v_interno := (v_req_claims IS NULL) OR (v_role = 'service_role');

  if not v_interno then
    -- 2) Request de usuario: exige sessao autenticada. anon cai aqui.
    if v_uid is null or v_role = 'anon' then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;

    -- Perfil do chamador pela identidade do token (auth.uid()), nao pelo frontend.
    select u.perfil into v_perfil
      from public.usuarios u
     where u.id = v_uid and u.ativo = true;

    if public.usuario_e_gestao()
       or v_perfil in ('gerencia', 'administrativo', 'supervisor') then
      v_autorizado := true;
    elsif v_perfil = 'operador' and v_email <> '' then
      v_autorizado :=
        exists (select 1 from public.alunos a
                 where a.id = p_aluno_id
                   and lower(coalesce(a.responsavel_atual_email, '')) = v_email)
        or exists (select 1 from public.casos c
                    where c.aluno_id = p_aluno_id
                      and lower(coalesce(c.operador_email, '')) = v_email)
        or exists (select 1 from public.acordos ac
                    where ac.aluno_id = p_aluno_id
                      and lower(coalesce(ac.operador_responsavel_email, '')) = v_email);
    end if;

    if not v_autorizado then
      -- Negacao generica: nao revela se o aluno existe.
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
  end if;

  -- ===== A partir daqui, comportamento e retorno ORIGINAIS (inalterados). =====
  if p_aluno_id is null then
    return jsonb_build_object('erro','aluno_id nulo','tem_pendencia', true, 'total', null);
  end if;

  select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0')
    into v_cpf from public.alunos where id = p_aluno_id;

  -- Titulos com obrigacao viva. A regra decisiva e o VINCULO, nao a situacao:
  -- titulo amarrado a acordo nao cancelado ja esta representado pelas parcelas.
  select
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
     and not exists (
       select 1
         from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id
          and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     );

  select count(*), coalesce(sum(coalesce(p.valor,0)),0)
    into v_parcelas_qtd, v_parcelas_valor
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  v_total := v_titulos_abertos + v_titulos_orfaos + v_parcelas_valor;

  return jsonb_build_object(
    'aluno_id',            p_aluno_id,
    'titulos_abertos',     round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada',  p_ignorar_confirmacao_id,
    'total',               round(v_total, 2),
    'tem_pendencia',        (v_total > 0.005 or v_conf_pendentes > 0)
  );
end;
$function$;

-- Grants: fecha PUBLIC/anon, mantem apenas authenticated e service_role.
REVOKE ALL ON FUNCTION public.aluno_saldo_pendente_detalhe(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aluno_saldo_pendente_detalhe(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.aluno_saldo_pendente_detalhe(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aluno_saldo_pendente_detalhe(uuid, uuid) TO service_role;

COMMIT;
