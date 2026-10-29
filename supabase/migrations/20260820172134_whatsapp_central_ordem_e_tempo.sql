-- Central: a conversa com interacao mais recente fica no topo, e passa a
-- existir filtro por tempo sem interacao.
--
-- QUAL CAMPO REPRESENTA "ULTIMA INTERACAO REAL" -- e por que nao `atualizado_em`:
--
-- Auditei quem escreve cada campo. `atualizado_em` e mexido por TREZE funcoes:
-- arquivar, desarquivar, assumir, transferir, marcar lida, encerrar, reabrir,
-- vincular aluno, retirar responsavel, os dois preparos de envio e o trigger de
-- espera. Ou seja: acao administrativa faria a conversa pular para o topo sem
-- ninguem ter falado nada.
--
-- `ultima_mensagem_em` e escrito por UMA unica funcao,
-- `whatsapp_registrar_mensagem`, e so quando uma mensagem entra de verdade.
-- E ela usa `greatest(coalesce(ultima_mensagem_em, v_ts), v_ts)`, entao
-- historico do SYNC_INICIAL -- que chega com data antiga -- nao consegue
-- inflar a posicao de ninguem. E o campo certo, e ja existe.
--
-- ORDENACAO: `ultima_mensagem_em DESC` passa a valer em TODOS os filtros.
--
-- MUDANCA DE COMPORTAMENTO QUE VALE DIZER EM VOZ ALTA: "Sem retorno" e
-- "Resgate" ordenavam por `aguardando_desde ASC` -- quem espera ha mais tempo
-- primeiro, uma fila de SLA. Agora seguem a regra do WhatsApp: mais recente no
-- topo. Foi pedido explicitamente. Quem trabalhava a fila de tras para frente
-- vai sentir a diferenca; `aguardando_desde` continua na resposta, entao a tela
-- segue mostrando ha quanto tempo cada um espera.
--
-- O indice `ix_whatsapp_conversas_ordem (ultima_mensagem_em DESC NULLS LAST)`
-- ja existia: a ordenacao nova nasce indexada.

DROP FUNCTION IF EXISTS public.whatsapp_conversas_listar(text, uuid, text, integer, text);

CREATE FUNCTION public.whatsapp_conversas_listar(
  p_status text DEFAULT NULL,
  p_canal_id uuid DEFAULT NULL,
  p_busca text DEFAULT NULL,
  p_limite integer DEFAULT 100,
  p_responsavel text DEFAULT NULL,
  -- ATE_1_DIA | 2_3_DIAS | 4_7_DIAS | 8_15_DIAS | 16_30_DIAS | MAIS_30_DIAS
  p_tempo_sem_interacao text DEFAULT NULL
)
RETURNS TABLE(id uuid, canal_id uuid, canal_apelido text, canal_numero text,
              telefone_e164 text, nome_perfil text, status text,
              responsavel_email text, responsavel_nome text, nao_lidas integer,
              aluno_id uuid, aluno_nome text, aluno_status text,
              ultima_mensagem_em timestamp with time zone, ultima_mensagem_previa text,
              aguardando_resposta boolean, aguardando_desde timestamp with time zone,
              origem_sync boolean, arquivada_em timestamp with time zone, arquivada_por text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
    -- ARQUIVADA SAI DE TUDO, menos da aba propria.
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
    -- TEMPO SEM INTERACAO: medido em `ultima_mensagem_em`, o mesmo campo da
    -- ordenacao. Usar `atualizado_em` aqui faria uma conversa "rejuvenescer"
    -- porque alguem a arquivou ou trocou o responsavel.
    AND (
      p_tempo_sem_interacao IS NULL
      OR (p_tempo_sem_interacao = 'ATE_1_DIA'
          AND c.ultima_mensagem_em >= now() - interval '1 day')
      OR (p_tempo_sem_interacao = '2_3_DIAS'
          AND c.ultima_mensagem_em <  now() - interval '1 day'
          AND c.ultima_mensagem_em >= now() - interval '3 days')
      OR (p_tempo_sem_interacao = '4_7_DIAS'
          AND c.ultima_mensagem_em <  now() - interval '3 days'
          AND c.ultima_mensagem_em >= now() - interval '7 days')
      OR (p_tempo_sem_interacao = '8_15_DIAS'
          AND c.ultima_mensagem_em <  now() - interval '7 days'
          AND c.ultima_mensagem_em >= now() - interval '15 days')
      OR (p_tempo_sem_interacao = '16_30_DIAS'
          AND c.ultima_mensagem_em <  now() - interval '15 days'
          AND c.ultima_mensagem_em >= now() - interval '30 days')
      OR (p_tempo_sem_interacao = 'MAIS_30_DIAS'
          AND c.ultima_mensagem_em <  now() - interval '30 days')
    )
    AND (
      f.termo IS NULL
      OR c.nome_perfil ILIKE '%' || f.termo || '%'
      OR c.aluno_nome  ILIKE '%' || f.termo || '%'
      OR (f.digitos <> '' AND c.telefone_e164 ILIKE '%' || f.digitos || '%')
      -- CPF, matricula e nome do aluno chegam por JOIN em `alunos`. NADA disso
      -- e copiado para `whatsapp_conversas`: o dado ja existe num lugar so, e
      -- duplicar PII para facilitar busca seria o oposto de minimizacao.
      OR (c.aluno_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.alunos a
            WHERE a.id = c.aluno_id
              AND (
                -- CPF por prefixo a partir de 6 digitos: permite buscar parcial
                -- sem que um telefone de 11 digitos passe a casar com CPF pelo
                -- meio, que era o risco de usar '%...%' aqui.
                (length(f.digitos) >= 6
                 AND regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') LIKE f.digitos || '%')
                OR a.matricula ILIKE '%' || f.termo || '%'
                OR a.nome      ILIKE '%' || f.termo || '%'
              )))
    )
  -- MAIS RECENTE NO TOPO, em todos os filtros e tambem em "Todos os numeros",
  -- onde as conversas dos dois canais entram na MESMA ordenacao cronologica.
  ORDER BY c.ultima_mensagem_em DESC NULLS LAST, c.id
  LIMIT greatest(1, least(coalesce(p_limite, 100), 300));
$function$;

GRANT EXECUTE ON FUNCTION public.whatsapp_conversas_listar(text, uuid, text, integer, text, text) TO authenticated;
