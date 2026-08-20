-- ROLLBACK de 20260820170000_whatsapp_central_ordem_e_tempo.sql
--
-- Devolve `whatsapp_conversas_listar` a assinatura de 5 parametros e a
-- ordenacao anterior: "Sem retorno" e "Resgate" voltam a listar quem espera ha
-- mais tempo PRIMEIRO (fila de SLA), e "Arquivadas" volta a ordenar pela data
-- de arquivamento.
--
-- ORDEM IMPORTA: o frontend novo manda `p_tempo_sem_interacao`. Se ele estiver
-- publicado quando isto rodar, a chamada falha com "function does not exist" e
-- a Central para de listar. Reverta o frontend ANTES, ou junto.
--
-- Nao ha dado a desfazer: a migration nao criou tabela, coluna nem indice.
-- `ix_whatsapp_conversas_ordem` ja existia antes e continua sendo usado.

DROP FUNCTION IF EXISTS public.whatsapp_conversas_listar(text, uuid, text, integer, text, text);

CREATE FUNCTION public.whatsapp_conversas_listar(
  p_status text DEFAULT NULL, p_canal_id uuid DEFAULT NULL, p_busca text DEFAULT NULL,
  p_limite integer DEFAULT 100, p_responsavel text DEFAULT NULL)
RETURNS TABLE(id uuid, canal_id uuid, canal_apelido text, canal_numero text,
              telefone_e164 text, nome_perfil text, status text,
              responsavel_email text, responsavel_nome text, nao_lidas integer,
              aluno_id uuid, aluno_nome text, aluno_status text,
              ultima_mensagem_em timestamp with time zone, ultima_mensagem_previa text,
              aguardando_resposta boolean, aguardando_desde timestamp with time zone,
              origem_sync boolean, arquivada_em timestamp with time zone, arquivada_por text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH filtro AS (
    SELECT nullif(btrim(coalesce(p_busca, '')), '')            AS termo,
           regexp_replace(coalesce(p_busca, ''), '\D', '', 'g') AS digitos
  )
  SELECT
    c.id, c.canal_id, k.apelido, k.display_phone_number,
    c.telefone_e164, c.nome_perfil, c.status, c.responsavel_email, c.responsavel_nome,
    c.nao_lidas, c.aluno_id, c.aluno_nome, c.aluno_status,
    c.ultima_mensagem_em, c.ultima_mensagem_previa,
    c.aguardando_resposta, c.aguardando_desde, c.origem_sync,
    c.arquivada_em, c.arquivada_por
  FROM public.whatsapp_conversas c
  JOIN public.whatsapp_canais k ON k.id = c.canal_id
  CROSS JOIN filtro f
  WHERE public.app_usuario_ativo()
    AND (CASE WHEN p_status = 'ARQUIVADAS' THEN c.arquivada_em IS NOT NULL
              ELSE c.arquivada_em IS NULL END)
    AND (
      p_status IS NULL
      OR p_status = 'ARQUIVADAS'
      OR (p_status = 'SEM_RETORNO'     AND c.aguardando_resposta
                                       AND coalesce(c.aguardando_origem,'TEMPO_REAL') <> 'SYNC_INICIAL')
      OR (p_status = 'RESGATE'         AND c.aguardando_resposta
                                       AND coalesce(c.aguardando_origem,'TEMPO_REAL') =  'SYNC_INICIAL')
      OR (p_status = 'NAO_LIDAS'       AND c.nao_lidas > 0)
      OR (p_status = 'SEM_RESPONSAVEL' AND c.responsavel_email IS NULL AND c.status <> 'ENCERRADO')
      OR (p_status = 'MINHAS'          AND c.responsavel_email = public.app_email()
                                       AND c.status <> 'ENCERRADO')
      OR (p_status NOT IN ('SEM_RETORNO','RESGATE','NAO_LIDAS','SEM_RESPONSAVEL','MINHAS','ARQUIVADAS')
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
              AND ((f.digitos <> '' AND regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') = f.digitos)
                   OR a.matricula ILIKE f.termo)))
    )
  ORDER BY
    CASE WHEN p_status IN ('SEM_RETORNO','RESGATE') THEN c.aguardando_desde END ASC NULLS LAST,
    CASE WHEN p_status = 'ARQUIVADAS'   THEN c.arquivada_em     END DESC NULLS LAST,
    c.ultima_mensagem_em DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limite, 100), 300));
$function$;

GRANT EXECUTE ON FUNCTION public.whatsapp_conversas_listar(text, uuid, text, integer, text) TO authenticated;
