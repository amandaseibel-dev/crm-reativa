-- Historico importado para de entrar na fila operacional "Sem retorno".
--
-- O PROBLEMA: `aguardando_resposta` e UM booleano servindo DOIS consumidores.
-- `sem_retorno` (fila do operador: quem esta esperando resposta AGORA) e
-- `pendencias_resgate` (backlog do sync: quem ja estava esperando quando o
-- numero foi pareado). O `_trg_whatsapp_aguardando` marcava a flag em QUALQUER
-- INSERT de ENTRADA, sem olhar `new.origem` -- entao toda conversa importada
-- cuja ultima mensagem era do aluno caia na fila como demanda nova.
--
-- Nao e teoria: em producao, com um numero so, `sem_retorno` = 16, dos quais
-- 6 esperam por HISTORICO e 10 por mensagem real. Com o canal 2 o sync
-- despejaria o backlog inteiro de uma vez.
--
-- POR QUE NAO BASTA "nao marcar no sync": `pendencias_resgate` LE a mesma flag
-- (`origem_sync AND aguardando_resposta`), e `whatsapp_sync_concluir` grava
-- `pendencias_detectadas` a partir dela. Deixar de marcar zeraria o resgate
-- junto -- exatamente o mecanismo que se quer preservar.
--
-- A SOLUCAO: gravar QUEM causou a espera, nao so QUE ha espera.
-- `aguardando_origem` recebe a origem da mensagem que ligou a flag. Os dois
-- contadores passam a ler a mesma coluna com valores opostos, viram
-- mutuamente exclusivos, e a soma continua sendo o total que espera.
--
-- Repare que `origem_sync` (na conversa) NAO servia para isso: ela e fixada na
-- CRIACAO da conversa e nunca mais muda. Uma conversa nascida no sync que
-- depois recebe mensagem real continuava marcada -- por isso hoje as 9
-- "pendencias" se sobrepoem as 16 de "sem retorno" em vez de as complementar.
-- Com `aguardando_origem`, essa mesma conversa migra sozinha para a fila
-- operacional na primeira mensagem de verdade.
--
-- O sino ja fazia isso desde sempre: `_trg_whatsapp_notificar_mensagem` sai
-- cedo com `coalesce(new.origem,'') = 'SYNC_INICIAL'`. O que muda aqui e o
-- trigger irmao, que ficou de fora.

ALTER TABLE public.whatsapp_conversas
  ADD COLUMN IF NOT EXISTS aguardando_origem text;

COMMENT ON COLUMN public.whatsapp_conversas.aguardando_origem IS
  'Origem da mensagem que ligou aguardando_resposta. SYNC_INICIAL = backlog importado (resgate); TEMPO_REAL = demanda do operador. NULL quando nao ha espera.';

-- Backfill: deriva da ULTIMA mensagem de cada conversa que hoje espera, que e
-- justamente a que teria ligado a flag. `coalesce(...,'TEMPO_REAL')` mantem na
-- fila operacional qualquer caso sem origem conhecida -- some por excesso de
-- visibilidade, nunca por falta.
WITH ultima AS (
  SELECT DISTINCT ON (m.conversa_id) m.conversa_id, m.origem
  FROM public.whatsapp_mensagens m
  ORDER BY m.conversa_id, m.timestamp_wa DESC, m.id DESC
)
UPDATE public.whatsapp_conversas c
SET aguardando_origem = coalesce(u.origem, 'TEMPO_REAL')
FROM ultima u
WHERE u.conversa_id = c.id
  AND c.aguardando_resposta
  AND c.aguardando_origem IS NULL;

-- Conversa que espera mas nao tem mensagem nenhuma (nao deve existir; se
-- existir, fica com o operador).
UPDATE public.whatsapp_conversas
SET aguardando_origem = 'TEMPO_REAL'
WHERE aguardando_resposta AND aguardando_origem IS NULL;

CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_aguardando
  ON public.whatsapp_conversas (aguardando_origem, aguardando_desde)
  WHERE aguardando_resposta;

-- ---------------------------------------------------------------- trigger ---
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

  -- Mensagem mais velha que a ultima conhecida: so puxa o inicio da espera
  -- para tras. Nao decide origem -- quem manda e a mensagem mais recente.
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
        -- O relogio da espera continua sendo o do PRIMEIRO nao-respondido...
        aguardando_desde    = CASE
          -- ...com uma excecao: quando a conversa estava esperando por HISTORICO
          -- e chega mensagem REAL, ela e promovida para a fila operacional e o
          -- relogio recomeca AGORA. Sem isto ela entra na fila ja marcada como
          -- "esperando ha 300 dias" e envenena `espera_mais_antiga`, que e
          -- alarme de SLA. Foi o teste C5 em staging que expos isto.
          WHEN coalesce(aguardando_origem, 'TEMPO_REAL') =  'SYNC_INICIAL'
           AND coalesce(new.origem,        'TEMPO_REAL') <> 'SYNC_INICIAL'
          THEN new.timestamp_wa
          ELSE coalesce(aguardando_desde, new.timestamp_wa)
        END,
        aguardando_origem   = coalesce(new.origem, 'TEMPO_REAL'),
        atualizado_em       = now()
    WHERE id = new.conversa_id;

  ELSIF new.direcao = 'SAIDA' THEN
    IF coalesce(new.status, '') <> 'FALHOU' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_resposta = false,
          aguardando_desde    = NULL,
          aguardando_origem   = NULL,
          atualizado_em       = now()
      WHERE id = new.conversa_id;
    END IF;
  END IF;

  RETURN new;
END;
$function$;

-- ----------------------------------------------------------------- resumo ---
CREATE OR REPLACE FUNCTION public.whatsapp_resumo()
RETURNS TABLE(sem_retorno integer, esperando_mais_1h integer, esperando_mais_24h integer,
              espera_mais_antiga timestamp with time zone, nao_lidas integer,
              sem_responsavel integer, em_atendimento integer, minhas integer,
              pendencias_resgate integer, arquivadas_nao_lidas integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH c AS (
    SELECT v.*,
           coalesce(v.aguardando_origem, 'TEMPO_REAL') = 'SYNC_INICIAL' AS e_resgate
    FROM public.whatsapp_conversas v
    WHERE public.app_usuario_ativo() AND v.status <> 'ENCERRADO'
  )
  SELECT
    -- A fila do operador agora conta so quem espera por mensagem REAL.
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND NOT c.e_resgate)::integer,
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND NOT c.e_resgate
                       AND c.aguardando_desde < now() - interval '1 hour')::integer,
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND NOT c.e_resgate
                       AND c.aguardando_desde < now() - interval '24 hours')::integer,
    -- "Espera mais antiga" e um alarme de SLA: historico de 2023 tornaria o
    -- numero permanentemente vermelho e sem sentido.
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                                      AND NOT c.e_resgate),
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NULL), 0)::integer,
    count(*) FILTER (WHERE c.responsavel_email IS NULL AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO' AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.responsavel_email = public.app_email() AND c.arquivada_em IS NULL)::integer,
    -- Complemento exato do primeiro contador, nao mais um conjunto que o
    -- atravessa: sem_retorno + pendencias_resgate = total que espera.
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND c.e_resgate)::integer,
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NOT NULL), 0)::integer
  FROM c;
$function$;

-- ---------------------------------------------------------------- listagem ---
-- O contador de resgate ja existia na tela, mas sem filtro que abrisse a lista.
-- Tirar essas conversas de SEM_RETORNO sem criar RESGATE as deixaria contadas
-- e inalcancaveis. O filtro nasce junto com a separacao.
CREATE OR REPLACE FUNCTION public.whatsapp_conversas_listar(
  p_status text DEFAULT NULL, p_canal_id uuid DEFAULT NULL, p_busca text DEFAULT NULL,
  p_limite integer DEFAULT 100, p_responsavel text DEFAULT NULL)
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
      -- `MINHAS` nao excluia ENCERRADO: conversa finalizada continuava na fila
      -- do operador. Corrigido junto, porque arquivamento herdaria o vazamento.
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

-- ------------------------------------------------------- fecho do sync ---
CREATE OR REPLACE FUNCTION public.whatsapp_sync_concluir(p_sync_id uuid, p_erro text DEFAULT NULL)
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

  -- Passa a contar o que o sync REALMENTE deixou esperando, e nao toda conversa
  -- que um dia nasceu de um sync.
  SELECT count(*) INTO v_pend
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = v_canal_id
    AND c.aguardando_resposta
    AND coalesce(c.aguardando_origem, 'TEMPO_REAL') = 'SYNC_INICIAL';

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

-- -------------------------------------------------------------- supervisao ---
-- A coluna "aguardando resposta" da gestao le a mesma flag. Se ela continuasse
-- somando o backlog, o supervisor veria um numero e o operador outro para a
-- mesma fila.
CREATE OR REPLACE FUNCTION public.whatsapp_supervisao()
RETURNS TABLE(responsavel_email text, responsavel_nome text, em_atendimento integer,
              aguardando_resposta integer, nao_lidas integer, encerradas_hoje integer,
              espera_mais_antiga timestamp with time zone, arquivadas integer,
              arquivadas_nao_lidas integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    coalesce(c.responsavel_email, '(sem responsavel)'),
    coalesce(c.responsavel_nome,  '(sem responsavel)'),
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO' AND c.arquivada_em IS NULL)::integer,
    count(*) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                       AND coalesce(c.aguardando_origem,'TEMPO_REAL') <> 'SYNC_INICIAL')::integer,
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NULL), 0)::integer,
    count(*) FILTER (WHERE c.status = 'ENCERRADO'
                       AND c.atualizado_em >= date_trunc('day', now()))::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta AND c.arquivada_em IS NULL
                                      AND coalesce(c.aguardando_origem,'TEMPO_REAL') <> 'SYNC_INICIAL'),
    count(*) FILTER (WHERE c.arquivada_em IS NOT NULL)::integer,
    coalesce(sum(c.nao_lidas) FILTER (WHERE c.arquivada_em IS NOT NULL), 0)::integer
  FROM public.whatsapp_conversas c
  WHERE public.usuario_e_gestao()
  GROUP BY 1, 2
  ORDER BY 4 DESC, 3 DESC;
$function$;
