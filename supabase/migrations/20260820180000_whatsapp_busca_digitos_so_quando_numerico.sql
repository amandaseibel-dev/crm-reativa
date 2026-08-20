-- Busca com letras NAO deve virar busca por telefone.
--
-- SINTOMA: procurar "zzzz-nao-existe-999" devolvia 6 conversas. A extracao de
-- digitos pegava o "999" e casava com qualquer telefone que o contivesse no
-- meio. Comportamento antigo (a extracao ja era assim antes da ordenacao nova),
-- exposto agora pelo caso de teste "busca inexistente retorna lista vazia".
--
-- REGRA: os digitos so entram na busca por telefone/CPF quando o termo E um
-- numero -- ou seja, quando sobra vazio depois de tirar digitos e os
-- separadores usuais de telefone e CPF (+ - . ( ) / espaco). "Maria" e
-- "MAT20250001" continuam sendo busca de texto; "+55 51 99999-9999" e
-- "123.456.789-00" continuam sendo busca numerica.
--
-- Unica mudanca em relacao a 20260820170000: o CASE no CTE `filtro`.
CREATE OR REPLACE FUNCTION public.whatsapp_conversas_listar(
  p_status text DEFAULT NULL, p_canal_id uuid DEFAULT NULL, p_busca text DEFAULT NULL,
  p_limite integer DEFAULT 100, p_responsavel text DEFAULT NULL,
  p_tempo_sem_interacao text DEFAULT NULL)
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
    SELECT
      nullif(btrim(coalesce(p_busca, '')), '') AS termo,
      CASE
        WHEN btrim(regexp_replace(coalesce(p_busca, ''), '[0-9+()./\-\s]', '', 'g')) = ''
        THEN regexp_replace(coalesce(p_busca, ''), '\D', '', 'g')
        ELSE ''
      END AS digitos
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
      p_tempo_sem_interacao IS NULL
      OR (p_tempo_sem_interacao = 'ATE_1_DIA'    AND c.ultima_mensagem_em >= now() - interval '1 day')
      OR (p_tempo_sem_interacao = '2_3_DIAS'     AND c.ultima_mensagem_em <  now() - interval '1 day'
                                                 AND c.ultima_mensagem_em >= now() - interval '3 days')
      OR (p_tempo_sem_interacao = '4_7_DIAS'     AND c.ultima_mensagem_em <  now() - interval '3 days'
                                                 AND c.ultima_mensagem_em >= now() - interval '7 days')
      OR (p_tempo_sem_interacao = '8_15_DIAS'    AND c.ultima_mensagem_em <  now() - interval '7 days'
                                                 AND c.ultima_mensagem_em >= now() - interval '15 days')
      OR (p_tempo_sem_interacao = '16_30_DIAS'   AND c.ultima_mensagem_em <  now() - interval '15 days'
                                                 AND c.ultima_mensagem_em >= now() - interval '30 days')
      OR (p_tempo_sem_interacao = 'MAIS_30_DIAS' AND c.ultima_mensagem_em <  now() - interval '30 days')
    )
    AND (
      f.termo IS NULL
      OR c.nome_perfil ILIKE '%' || f.termo || '%'
      OR c.aluno_nome  ILIKE '%' || f.termo || '%'
      OR (f.digitos <> '' AND c.telefone_e164 ILIKE '%' || f.digitos || '%')
      OR (c.aluno_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.alunos a
            WHERE a.id = c.aluno_id
              AND (
                (length(f.digitos) >= 6
                 AND regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') LIKE f.digitos || '%')
                OR a.matricula ILIKE '%' || f.termo || '%'
                OR a.nome      ILIKE '%' || f.termo || '%'
              )))
    )
  ORDER BY c.ultima_mensagem_em DESC NULLS LAST, c.id
  LIMIT greatest(1, least(coalesce(p_limite, 100), 300));
$function$;
