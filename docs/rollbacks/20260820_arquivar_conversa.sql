-- ROLLBACK de Arquivados (migrations 20260820100000 / 100100 / 100200).
--
-- Restaura as QUATRO funcoes ao estado de producao em 20/08/2026 e remove as
-- colunas. Verificado: aplicado em staging e comparado por md5 de
-- `pg_get_functiondef` contra producao — as quatro batem byte a byte.
--
-- Impressoes de PRODUCAO antes da mudanca:
--   whatsapp_conversas_listar    4f7eb30b3c9961e871e16b840a33e975  (2704 bytes)
--   whatsapp_registrar_mensagem  7067ab8c2f27eea18b32bbdb739502d8  (3779 bytes)
--   whatsapp_resumo              4bc52ec51cc84c77b09518f9b6e95dfe  (1233 bytes)
--   whatsapp_supervisao          ce8571aab9174270b85081e90418d9ad   (953 bytes)
--
-- ORDEM: funcoes primeiro, colunas por ultimo. As funcoes novas referenciam
-- `arquivada_em`; derrubar a coluna antes deixaria a Central quebrada na janela
-- entre um comando e outro.

-- 1) LISTAGEM ---------------------------------------------------------------
drop function if exists public.whatsapp_conversas_listar(text, uuid, text, integer, text);

create function public.whatsapp_conversas_listar(
  p_status text default null, p_canal_id uuid default null, p_busca text default null,
  p_limite integer default 100, p_responsavel text default null)
returns table (id uuid, canal_id uuid, canal_apelido text, canal_numero text,
  telefone_e164 text, nome_perfil text, status text, responsavel_email text,
  responsavel_nome text, nao_lidas integer, aluno_id uuid, aluno_nome text,
  aluno_status text, ultima_mensagem_em timestamptz, ultima_mensagem_previa text,
  aguardando_resposta boolean, aguardando_desde timestamptz, origem_sync boolean)
language sql stable security definer set search_path to 'public'
as $$
  WITH filtro AS (
    SELECT nullif(btrim(coalesce(p_busca, '')), '')            AS termo,
           regexp_replace(coalesce(p_busca, ''), '\D', '', 'g') AS digitos
  )
  SELECT
    c.id, c.canal_id, k.apelido, k.display_phone_number,
    c.telefone_e164, c.nome_perfil,
    c.status, c.responsavel_email, c.responsavel_nome, c.nao_lidas,
    c.aluno_id, c.aluno_nome, c.aluno_status,
    c.ultima_mensagem_em, c.ultima_mensagem_previa,
    c.aguardando_resposta, c.aguardando_desde, c.origem_sync
  FROM public.whatsapp_conversas c
  JOIN public.whatsapp_canais k ON k.id = c.canal_id
  CROSS JOIN filtro f
  WHERE public.app_usuario_ativo()
    AND (
      p_status IS NULL
      OR (p_status = 'SEM_RETORNO'     AND c.aguardando_resposta)
      OR (p_status = 'NAO_LIDAS'       AND c.nao_lidas > 0)
      OR (p_status = 'SEM_RESPONSAVEL' AND c.responsavel_email IS NULL AND c.status <> 'ENCERRADO')
      OR (p_status = 'MINHAS'          AND c.responsavel_email = public.app_email())
      OR (p_status NOT IN ('SEM_RETORNO','NAO_LIDAS','SEM_RESPONSAVEL','MINHAS')
          AND c.status = p_status)
    )
    AND (p_canal_id IS NULL OR c.canal_id = p_canal_id)
    AND (p_responsavel IS NULL OR c.responsavel_email = p_responsavel)
    AND (
      f.termo IS NULL
      OR c.nome_perfil ILIKE '%' || f.termo || '%'
      OR c.aluno_nome  ILIKE '%' || f.termo || '%'
      OR (f.digitos <> '' AND c.telefone_e164 ILIKE '%' || f.digitos || '%')
      OR (c.aluno_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.alunos a
            WHERE a.id = c.aluno_id
              AND (
                (f.digitos <> '' AND regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') = f.digitos)
                OR a.matricula ILIKE f.termo
              )
          ))
    )
  ORDER BY
    CASE WHEN p_status = 'SEM_RETORNO' THEN c.aguardando_desde END ASC NULLS LAST,
    c.ultima_mensagem_em DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limite, 100), 300));
$$;

-- 2) RESUMO -----------------------------------------------------------------
drop function if exists public.whatsapp_resumo();

create function public.whatsapp_resumo()
returns table (sem_retorno integer, esperando_mais_1h integer, esperando_mais_24h integer,
  espera_mais_antiga timestamptz, nao_lidas integer, sem_responsavel integer,
  em_atendimento integer, minhas integer, pendencias_resgate integer)
language sql stable security definer set search_path to 'public'
as $$
  SELECT
    count(*) FILTER (WHERE c.aguardando_resposta)::integer,
    count(*) FILTER (WHERE c.aguardando_resposta
                       AND c.aguardando_desde < now() - interval '1 hour')::integer,
    count(*) FILTER (WHERE c.aguardando_resposta
                       AND c.aguardando_desde < now() - interval '24 hours')::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta),
    coalesce(sum(c.nao_lidas), 0)::integer,
    count(*) FILTER (WHERE c.responsavel_email IS NULL)::integer,
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO')::integer,
    count(*) FILTER (WHERE c.responsavel_email = public.app_email())::integer,
    count(*) FILTER (WHERE c.origem_sync AND c.aguardando_resposta)::integer
  FROM public.whatsapp_conversas c
  WHERE public.app_usuario_ativo()
    AND c.status <> 'ENCERRADO';
$$;

-- 3) SUPERVISAO -------------------------------------------------------------
drop function if exists public.whatsapp_supervisao();

create function public.whatsapp_supervisao()
returns table (responsavel_email text, responsavel_nome text, em_atendimento integer,
  aguardando_resposta integer, nao_lidas integer, encerradas_hoje integer,
  espera_mais_antiga timestamptz)
language sql stable security definer set search_path to 'public'
as $$
  SELECT
    coalesce(c.responsavel_email, '(sem responsavel)'),
    coalesce(c.responsavel_nome,  '(sem responsavel)'),
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO')::integer,
    count(*) FILTER (WHERE c.aguardando_resposta)::integer,
    coalesce(sum(c.nao_lidas), 0)::integer,
    count(*) FILTER (WHERE c.status = 'ENCERRADO'
                       AND c.atualizado_em >= date_trunc('day', now()))::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta)
  FROM public.whatsapp_conversas c
  WHERE public.usuario_e_gestao()
  GROUP BY 1, 2
  ORDER BY 4 DESC, 3 DESC;
$$;

-- 4) REGISTRAR MENSAGEM -----------------------------------------------------
-- CAMINHO DE TODA MENSAGEM QUE ENTRA. Se este comando falhar, a recepcao para.
-- Rodar sozinho e conferir antes de seguir para o passo 5.
--
-- A formatacao abaixo reproduz a de PRODUCAO caractere a caractere: verificado
-- por md5 de `pg_get_functiondef` aplicado em staging. Nao "arrumar" o
-- alinhamento — isso quebraria a conferencia.
CREATE OR REPLACE FUNCTION public.whatsapp_registrar_mensagem(p_sessao_chave text, p_telefone text, p_nome_perfil text, p_wamid text, p_direcao text, p_tipo text, p_texto text, p_midia_id text, p_midia_mime text, p_timestamp timestamp with time zone, p_payload jsonb, p_origem text DEFAULT 'TEMPO_REAL'::text, p_enviado_por text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_canal_id    uuid;
  v_conversa_id uuid;
  v_e164        text := public.whatsapp_normalizar_telefone(p_telefone);
  v_previa      text;
  v_ident       record;
  v_ts          timestamptz := coalesce(p_timestamp, now());
  v_sync        boolean := (coalesce(p_origem,'TEMPO_REAL') = 'SYNC_INICIAL');
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'whatsapp_registrar_mensagem: acesso negado' USING ERRCODE = '42501';
  END IF;

  IF p_direcao NOT IN ('ENTRADA','SAIDA') THEN
    RAISE EXCEPTION 'direcao invalida: %', p_direcao;
  END IF;

  SELECT id INTO v_canal_id
  FROM public.whatsapp_canais
  WHERE sessao_chave = p_sessao_chave;

  IF v_canal_id IS NULL THEN
    RAISE EXCEPTION 'canal desconhecido para sessao %', p_sessao_chave;
  END IF;
  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido: %', p_telefone;
  END IF;

  SELECT id INTO v_conversa_id
  FROM public.whatsapp_conversas
  WHERE canal_id = v_canal_id AND telefone_e164 = v_e164;

  IF v_conversa_id IS NULL THEN
    SELECT * INTO v_ident FROM public.whatsapp_identificar_aluno(v_e164);

    INSERT INTO public.whatsapp_conversas (
      canal_id, telefone_e164, nome_perfil, status,
      aluno_id, aluno_nome, aluno_status, aluno_candidatos, aluno_identificado_em,
      origem_sync
    ) VALUES (
      v_canal_id, v_e164, p_nome_perfil, 'NOVO',
      v_ident.aluno_id, v_ident.aluno_nome, v_ident.situacao, v_ident.candidatos, now(),
      v_sync
    )
    RETURNING id INTO v_conversa_id;
  END IF;

  v_previa := left(coalesce(nullif(btrim(p_texto), ''),
                            '[' || coalesce(p_tipo, 'midia') || ']'), 120);

  INSERT INTO public.whatsapp_mensagens (
    conversa_id, wamid, direcao, tipo, texto, midia_id, midia_mime,
    status, enviado_por_email, origem, timestamp_wa, payload
  ) VALUES (
    v_conversa_id, p_wamid, p_direcao, coalesce(p_tipo, 'text'), p_texto,
    p_midia_id, p_midia_mime, p_status, p_enviado_por,
    coalesce(p_origem, 'TEMPO_REAL'), v_ts, p_payload
  )
  ON CONFLICT (wamid) DO NOTHING;

  IF NOT FOUND THEN
    RETURN v_conversa_id;
  END IF;

  UPDATE public.whatsapp_conversas
  SET ultima_mensagem_em     = greatest(coalesce(ultima_mensagem_em, v_ts), v_ts),
      ultima_mensagem_previa = CASE
                                 WHEN ultima_mensagem_em IS NULL OR v_ts >= ultima_mensagem_em
                                 THEN v_previa ELSE ultima_mensagem_previa
                               END,
      nome_perfil            = coalesce(p_nome_perfil, nome_perfil),
      nao_lidas              = CASE
                                 WHEN p_direcao = 'ENTRADA' AND NOT v_sync THEN nao_lidas + 1
                                 WHEN p_direcao = 'SAIDA'                  THEN 0
                                 ELSE nao_lidas
                               END,
      status                 = CASE
                                 WHEN p_direcao = 'ENTRADA' AND status = 'ENCERRADO' THEN 'NOVO'
                                 WHEN p_direcao = 'SAIDA'   AND status = 'NOVO'      THEN 'RESPONDIDO'
                                 ELSE status
                               END,
      atualizado_em          = now()
  WHERE id = v_conversa_id;

  RETURN v_conversa_id;
END;
$function$;

-- 5) COLUNAS ----------------------------------------------------------------
-- POR ULTIMO, e so depois de conferir que as quatro funcoes voltaram. Isto
-- APAGA quem arquivou o que — nao ha como recuperar depois.
-- Se a intencao for so desligar a funcionalidade, PARE no passo 4: sem as
-- funcoes novas, as colunas ficam inertes e o dado continua la.
drop index if exists public.ix_whatsapp_conversas_arquivadas;
alter table public.whatsapp_conversas
  drop column if exists arquivada_em,
  drop column if exists arquivada_por;
