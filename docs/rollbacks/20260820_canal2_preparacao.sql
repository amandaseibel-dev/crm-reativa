-- ROLLBACK das duas migrations de preparacao do canal 2:
--   20260820140000_whatsapp_leads_unicidade_por_canal.sql
--   20260820140100_whatsapp_sync_nao_polui_fila.sql
--
-- Devolve producao ao estado imediatamente anterior. Os blocos de listagem,
-- resumo e supervisao abaixo sao COPIA LITERAL de
-- 20260820100100_whatsapp_arquivar_listagem_resumo.sql, o arquivo que criou o
-- estado atual -- nao foram redigitados.
--
-- VERIFICACAO: este arquivo foi APLICADO em staging (que estava com as duas
-- migrations) e os md5 de pg_get_functiondef das 6 funcoes ficaram iguais aos
-- de producao. Os hashes esperados estao ao lado de cada objeto.
--
-- ORDEM IMPORTA: as funcoes voltam ANTES de a coluna cair. Derrubar
-- `aguardando_origem` com o resumo novo ainda instalado deixa a Central com
-- erro de coluna inexistente ate a proxima linha rodar.
--
-- O QUE NAO E DESFEITO: os valores ja gravados em `aguardando_origem` somem com
-- a coluna. `aguardando_resposta` e `aguardando_desde` NAO sao tocados pelo
-- rollback -- ou seja, `sem_retorno` volta a somar o backlog, que e exatamente
-- o comportamento anterior.

-- ============================ 1. leads: unicidade so por telefone ============
-- md5 esperado de whatsapp_lead_registrar: c21f4f44a57daaed005504d378b76acf
--
-- ATENCAO -- ESTE PASSO NAO E OPCIONAL. Descoberto executando o rollback de
-- verdade em staging: com o canal 2 no ar, a mesma pessoa pode ter lead aberto
-- nos DOIS numeros. O indice antigo admite um lead aberto por telefone e
-- SO por telefone, entao recria-lo com esses pares presentes falha com
-- 23505 e o rollback inteiro nao aplica -- justo quando se precisa dele.
--
-- Entao o excedente e ENCERRADO antes, mantendo o mais antigo de cada telefone
-- e deixando registro em `observacao`. Nenhum lead e apagado: quem foi fechado
-- aqui aparece com a justificativa, e o atendimento pode ser retomado.
WITH ranqueado AS (
  SELECT id,
         row_number() OVER (PARTITION BY telefone_e164 ORDER BY registrado_em, id) AS pos
  FROM public.whatsapp_leads
  WHERE status <> 'ENCERRADO'
)
UPDATE public.whatsapp_leads l
SET status        = 'ENCERRADO',
    observacao    = coalesce(l.observacao || ' | ', '')
                    || 'Encerrado pelo rollback da preparacao do canal 2 em '
                    || now()::date
                    || ': o indice anterior admite so um lead aberto por telefone.',
    atualizado_em = now()
FROM ranqueado r
WHERE r.id = l.id AND r.pos > 1;

DROP INDEX IF EXISTS public.ux_whatsapp_leads_aberto;

CREATE UNIQUE INDEX ux_whatsapp_leads_aberto
  ON public.whatsapp_leads USING btree (telefone_e164)
  WHERE (status <> 'ENCERRADO'::text);

CREATE OR REPLACE FUNCTION public.whatsapp_lead_registrar(p_telefone text, p_nome text DEFAULT NULL::text, p_canal_id uuid DEFAULT NULL::uuid, p_assunto text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_e164 text := public.whatsapp_normalizar_telefone(p_telefone);
  v_id   uuid;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido';
  END IF;

  SELECT id INTO v_id FROM public.whatsapp_leads
  WHERE telefone_e164 = v_e164 AND status <> 'ENCERRADO';

  IF v_id IS NOT NULL THEN
    UPDATE public.whatsapp_leads
    SET nome          = coalesce(nullif(btrim(p_nome), ''), nome),
        assunto       = coalesce(nullif(btrim(p_assunto), ''), assunto),
        canal_id      = coalesce(p_canal_id, canal_id),
        atualizado_em = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.whatsapp_leads (telefone_e164, nome, canal_id, assunto, registrado_por)
  VALUES (v_e164, nullif(btrim(p_nome), ''), p_canal_id, nullif(btrim(p_assunto), ''), public.app_email())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ============================ 2. trigger da espera ==========================
-- md5 esperado: aa66f51d66b87cb55a34a357d4457087
CREATE OR REPLACE FUNCTION public._trg_whatsapp_aguardando()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ultima timestamptz;
BEGIN
  SELECT max(m.timestamp_wa) INTO v_ultima
  FROM public.whatsapp_mensagens m
  WHERE m.conversa_id = new.conversa_id;

  IF v_ultima IS NOT NULL AND new.timestamp_wa < v_ultima THEN
    IF new.direcao = 'ENTRADA' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_desde = least(coalesce(aguardando_desde, new.timestamp_wa), new.timestamp_wa)
      WHERE id = new.conversa_id AND aguardando_resposta;
    END IF;
    RETURN new;
  END IF;

  IF new.direcao = 'ENTRADA' THEN
    UPDATE public.whatsapp_conversas
    SET aguardando_resposta = true,
        aguardando_desde    = coalesce(aguardando_desde, new.timestamp_wa),
        atualizado_em       = now()
    WHERE id = new.conversa_id;

  ELSIF new.direcao = 'SAIDA' THEN
    IF coalesce(new.status, '') <> 'FALHOU' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_resposta = false,
          aguardando_desde    = NULL,
          atualizado_em       = now()
      WHERE id = new.conversa_id;
    END IF;
  END IF;

  RETURN new;
END;
$function$;

-- ============ 3. listagem, resumo e supervisao (literal do 20260820100100) ===
-- md5 esperados: listar 372d353db472f905885db9ea3be6a41c
--                resumo 783d6885fba617e5c983681ce50d2c73
--                supervisao 0e8d726c4236b015f85ad2d86f2f18bd
drop function if exists public.whatsapp_conversas_listar(text, uuid, text, integer, text);

create function public.whatsapp_conversas_listar(
  p_status text default null, p_canal_id uuid default null, p_busca text default null,
  p_limite integer default 100, p_responsavel text default null
)
returns table (
  id uuid, canal_id uuid, canal_apelido text, canal_numero text, telefone_e164 text,
  nome_perfil text, status text, responsavel_email text, responsavel_nome text,
  nao_lidas integer, aluno_id uuid, aluno_nome text, aluno_status text,
  ultima_mensagem_em timestamptz, ultima_mensagem_previa text,
  aguardando_resposta boolean, aguardando_desde timestamptz, origem_sync boolean,
  arquivada_em timestamptz, arquivada_por text
)
language sql stable security definer set search_path to 'public'
as $$
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
      OR (p_status = 'SEM_RETORNO'     AND c.aguardando_resposta)
      OR (p_status = 'NAO_LIDAS'       AND c.nao_lidas > 0)
      OR (p_status = 'SEM_RESPONSAVEL' AND c.responsavel_email IS NULL AND c.status <> 'ENCERRADO')
      -- `MINHAS` nao excluia ENCERRADO: conversa finalizada continuava na fila
      -- do operador. Corrigido junto, porque arquivamento herdaria o vazamento.
      OR (p_status = 'MINHAS'          AND c.responsavel_email = public.app_email()
                                       AND c.status <> 'ENCERRADO')
      OR (p_status NOT IN ('SEM_RETORNO','NAO_LIDAS','SEM_RESPONSAVEL','MINHAS','ARQUIVADAS')
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
    CASE WHEN p_status = 'SEM_RETORNO'  THEN c.aguardando_desde END ASC NULLS LAST,
    CASE WHEN p_status = 'ARQUIVADAS'   THEN c.arquivada_em     END DESC NULLS LAST,
    c.ultima_mensagem_em DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limite, 100), 300));
$$;

grant execute on function public.whatsapp_conversas_listar(text, uuid, text, integer, text) to authenticated;

-- Contadores: arquivada nao entra em nenhuma fila operacional.
drop function if exists public.whatsapp_resumo();

create function public.whatsapp_resumo()
returns table (sem_retorno integer, esperando_mais_1h integer, esperando_mais_24h integer,
  espera_mais_antiga timestamptz, nao_lidas integer, sem_responsavel integer,
  em_atendimento integer, minhas integer, pendencias_resgate integer, arquivadas_nao_lidas integer)
language sql stable security definer set search_path to 'public'
as $$
  SELECT
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND c.aguardando_desde < now() - interval '1 hour')::integer,
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND c.aguardando_desde < now() - interval '24 hours')::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL),
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NULL), 0)::integer,
    count(*) FILTER (WHERE c.responsavel_email IS NULL AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO' AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.responsavel_email = public.app_email() AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.origem_sync AND c.aguardando_resposta AND c.arquivada_em IS NULL)::integer,
    -- Arquivada com nao lida NAO volta para a fila, mas nao pode ficar muda:
    -- este numero e o que o chip "Arquivadas" mostra.
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NOT NULL), 0)::integer
  FROM public.whatsapp_conversas c
  WHERE public.app_usuario_ativo() AND c.status <> 'ENCERRADO';
$$;

grant execute on function public.whatsapp_resumo() to authenticated;

-- Gestao PRECISA ver arquivadas, senao arquivar vira mecanismo de ocultacao.
drop function if exists public.whatsapp_supervisao();

create function public.whatsapp_supervisao()
returns table (responsavel_email text, responsavel_nome text, em_atendimento integer,
  aguardando_resposta integer, nao_lidas integer, encerradas_hoje integer,
  espera_mais_antiga timestamptz, arquivadas integer, arquivadas_nao_lidas integer)
language sql stable security definer set search_path to 'public'
as $$
  SELECT
    coalesce(c.responsavel_email, '(sem responsavel)'),
    coalesce(c.responsavel_nome,  '(sem responsavel)'),
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO' AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL)::integer,
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NULL), 0)::integer,
    count(*) FILTER (WHERE c.status = 'ENCERRADO'
                       AND c.atualizado_em >= date_trunc('day', now()))::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL),
    count(*) FILTER (WHERE c.arquivada_em IS NOT NULL)::integer,
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NOT NULL), 0)::integer
  FROM public.whatsapp_conversas c
  WHERE public.usuario_e_gestao()
  GROUP BY 1, 2
  ORDER BY 4 DESC, 3 DESC;
$$;

grant execute on function public.whatsapp_supervisao() to authenticated;

-- ============================ 4. fecho do sync ==============================
-- md5 esperado: 4baa254e2c1610db2c0a5f5ae604faac
CREATE OR REPLACE FUNCTION public.whatsapp_sync_concluir(p_sync_id uuid, p_erro text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_canal_id uuid;
  v_pend     integer;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT canal_id INTO v_canal_id FROM public.whatsapp_sync_execucoes WHERE id = p_sync_id;
  IF v_canal_id IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO v_pend
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = v_canal_id AND c.origem_sync AND c.aguardando_resposta;

  UPDATE public.whatsapp_sync_execucoes
  SET status                = CASE WHEN p_erro IS NULL THEN 'CONCLUIDA' ELSE 'FALHOU' END,
      concluido_em          = now(),
      pendencias_detectadas = v_pend,
      erro                  = p_erro
  WHERE id = p_sync_id;

  IF p_erro IS NULL THEN
    UPDATE public.whatsapp_canais SET sync_inicial_em = now() WHERE id = v_canal_id;
  END IF;
END;
$function$;

-- ============================ 5. so entao a coluna ==========================
DROP INDEX IF EXISTS public.ix_whatsapp_conversas_aguardando;
ALTER TABLE public.whatsapp_conversas DROP COLUMN IF EXISTS aguardando_origem;
