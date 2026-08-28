-- Acao massiva alcanca quem NUNCA foi acionado, mesmo tendo dono.
--
-- Amanda, 27/08/2026: "precisa conferir nas acoes massivas pq nao esta
-- carregando todos os casos" -- e, escolhendo o caminho: "a".
--
-- O BURACO. A previa so considerava aluno com `responsavel_atual_email IS NULL`.
-- E intencional -- a acao massiva existe para alcancar quem nao esta na carteira
-- de ninguem. Mas isso criou um vao onde gente cai e nao sai:
--
--     tem dono            -> a acao massiva nao pega ("ja e trabalhado")
--     nunca foi acionado  -> mas ninguem trabalhou
--
-- Sao 1.138 alunos nesse estado, 1.076 com telefone. So no semestre corrente
-- (2026/2) sao 160 dos 377 nunca tocados -- gente que ainda esta na faculdade,
-- onde a chance de recuperar e a maior da carteira.
--
-- NAO PUS REGRA DE DIAS, e testei antes de decidir. A ideia era exigir que o
-- caso estivesse com o dono ha mais de 10 dias, para nao roubar caso recem
-- atribuido. Mas `responsavel_atual_em` e ZERADO pelo nivelamento a cada
-- redistribuicao: dos 1.138, so 87 passariam -- nao por terem sido
-- trabalhados, e sim porque o relogio reiniciou. A regra mediria o
-- nivelamento, nao o abandono.
--
-- O criterio certo ja existe: `caso_dentro_prazo_fidelizacao` protege por
-- data_ultimo_acionamento, e quem nunca foi acionado NAO E PROTEGIDO -- por isso
-- lidera o card "risco de perder". Nao ha nada para proteger aqui.
--
-- COMO LIGA, sem mexer na assinatura: o alcance acompanha o filtro que ela ja
-- usa na tela. Com "Apenas nunca acionado" marcado, o dono deixa de importar.
-- Sem o filtro, tudo segue como antes: so quem nao tem dono.
--
-- Nenhum outro criterio muda: acordo ativo, encerrado operacional, quitado,
-- retorno futuro e confirmacao de pagamento continuam excluindo.


create or replace function public.acoes_massivas_previa(
  p_ano_vencimento text default null,
  p_limite integer default 6000,
  p_dias_minimo_sem_contato integer default null,
  p_apenas_nunca_acionado boolean default false,
  p_unidade text default null,
  p_curso text default null,
  p_apenas_ja_acionado boolean default false,
  p_situacao_academica text default null,
  p_importacao_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
DECLARE
  v_result jsonb;
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
BEGIN
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;

  WITH sol_conf AS MATERIALIZED (
    SELECT DISTINCT s.aluno_id FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  base AS MATERIALIZED (
    SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
           nullif(btrim(a.situacao_academica),'') AS situacao_academica,
           nullif(btrim(a.curso),'')              AS curso,
           COALESCE(c.total_em_aberto, 0) AS valor,
           CASE
             WHEN public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO' THEN 'Aguardando confirmação financeira'
             WHEN a.id::text IN (SELECT aluno_id FROM sol_conf) THEN 'Aguardando confirmação financeira'
             ELSE NULL END AS motivo_conf
    FROM public.alunos a
    LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
    -- Sem dono, OU nunca acionado quando a busca e justamente por nunca
    -- acionado: ter dono nao quer dizer estar sendo trabalhado.
    WHERE (a.responsavel_atual_email IS NULL
           OR (p_apenas_nunca_acionado AND a.data_ultimo_acionamento IS NULL))
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
      AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
      AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
      AND (p_unidade IS NULL OR a.unidade = p_unidade)
      AND (p_curso   IS NULL OR a.curso   = p_curso)
      AND (p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'') = p_situacao_academica)
      AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
      AND NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO')
      AND (p_ano_vencimento IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at WHERE at.aluno_id = a.id AND at.situacao = 'ABERTO'
          AND at.vencimento BETWEEN (p_ano_vencimento || '-01-01')::date AND (p_ano_vencimento || '-12-31')::date))
      AND (p_importacao_ids IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at3
        WHERE at3.aluno_id = a.id AND at3.importacao_id = ANY(p_importacao_ids)))
      AND (NOT p_apenas_nunca_acionado OR a.data_ultimo_acionamento IS NULL)
      AND (NOT p_apenas_ja_acionado    OR a.data_ultimo_acionamento IS NOT NULL)
      AND (p_dias_minimo_sem_contato IS NULL OR a.data_ultimo_acionamento IS NULL
        OR a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
    ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
    LIMIT p_limite
  ),
  masc AS (
    SELECT id, data_ultimo_acionamento, valor, motivo_conf, nome,
           situacao_academica, curso,
           nullif(regexp_replace(coalesce(telefone,''),'\D','','g'),'') AS tel_dig,
           btrim(coalesce(email,'')) AS email_t
    FROM base
  )
  SELECT jsonb_build_object(
    'elegiveis', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'nome', split_part(coalesce(nome,'-'),' ',1) || ' ***',
        'situacao_academica', situacao_academica,
        'curso', curso,
        'tem_telefone', (tel_dig IS NOT NULL),
        'tem_email',    (email_t <> '' AND position('@' in email_t) > 1),
        'telefone_mascarado', CASE WHEN tel_dig IS NULL THEN NULL
                                   WHEN length(tel_dig) >= 4 THEN '••••'||right(tel_dig,4) ELSE '••••' END,
        'email_mascarado',    CASE WHEN email_t <> '' AND position('@' in email_t) > 1
                                   THEN left(email_t,1)||'•••@'||split_part(email_t,'@',2) ELSE NULL END,
        'data_ultimo_acionamento', data_ultimo_acionamento, 'valor', valor)
      ORDER BY data_ultimo_acionamento ASC NULLS FIRST) FROM masc WHERE motivo_conf IS NULL), '[]'::jsonb),
    'excluidos_confirmacao', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'aluno', split_part(COALESCE(nome, '-'), ' ', 1) || ' ***', 'motivo', motivo_conf)
      ORDER BY nome) FROM masc WHERE motivo_conf IS NOT NULL), '[]'::jsonb),
    'total_excluidos_confirmacao', (SELECT count(*) FROM masc WHERE motivo_conf IS NOT NULL)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
