-- Listagem, contadores e supervisao cientes de arquivamento.
--
-- ARQUIVO SEPARADO DE PROPOSITO: na primeira tentativa isto vinha junto com o
-- resumo numa migration so. O resumo falhou por mudanca de tipo de retorno e
-- derrubou a transacao INTEIRA — a listagem nunca foi instalada, e so os testes
-- pegaram, porque o resumo filtrava certo e a lista continuava mostrando a
-- conversa arquivada. Migration pequena e o que evita esse tipo de meia-aplicacao.
--
-- Aplicada e testada em staging. Ainda NAO em producao.

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
