-- Acoes Massivas: a previa para de mentir sobre o tamanho da base.
--
-- Amanda, 02/09: "eu puxo casos nunca acionados e nas acoes vem 14 casos, vem
-- sempre muito poucos" e "tudo que estiver fora dos 15 dias sem acionamento
-- precisa aparecer para acoes".
--
-- TRES DEFEITOS, medidos em producao no mesmo dia.
--
-- 1. O CORTE ACONTECE ANTES DOS FILTROS. A funcao devolvia `p_limite` linhas
--    (Quantidade x 3) e so DEPOIS o front descartava quem nao tem o contato do
--    canal escolhido e quem esta abaixo do valor minimo. Com Quantidade 100 o
--    banco devolvia 300 nunca-acionados, o front jogava fora 156 (52%) e
--    sobravam 144 -- de 905 que existem. Com Quantidade menor, sobram 14. O
--    numero na tela nunca disse quantos alunos existem: disse quantos
--    sobreviveram ao corte cego. Agora canal e faixa de valor entram no proprio
--    SQL, antes do LIMIT.
--
-- 2. A TELA NAO SABIA O TOTAL. `total_elegiveis_acoes_massivas` so recebe o
--    canal -- ignora ano, unidade, curso, bordero, dias sem contato e nunca
--    acionado. O contador do topo era um numero global que nao conversava com
--    o filtro montado logo abaixo. A previa passa a devolver
--    `total_elegivel_filtros`: quantos alunos atendem EXATAMENTE aos filtros da
--    tela, sem limite. Quantidade volta a ser o que sempre deveria ter sido --
--    o tamanho do disparo, nao o tamanho da base.
--
-- 3. QUEM TEM DONO NAO APARECIA. A base so admitia `responsavel_atual_email IS
--    NULL` (ou nunca acionado). Um aluno parado ha 40 dias na carteira de um
--    operador era invisivel para as acoes massivas. Sao 116 alunos hoje fora
--    dos 15 dias, 94 deles com telefone. Regra da Amanda: passou do prazo sem
--    acionamento, entra na acao -- tendo dono ou nao. So vale quando o filtro
--    de dias esta preenchido; sem ele, nada muda.
--
-- E O VALOR DE QUEM TEM DONO VINHA ZERO. O join era
-- `LEFT JOIN casos c ON c.aluno_id = a.id AND c.operador_email IS NULL`: para
-- aluno COM dono nao casava linha nenhuma e o valor saia 0, entao ele morria no
-- piso de R$ 100 mesmo se entrasse pela regra nova. Passa a ser LATERAL sem a
-- condicao de dono (e com LIMIT 1, para aluno com mais de um caso nao duplicar
-- a linha).
--
-- NAO MUDA: o gate de gestao, a exclusao de quem esta em confirmacao de
-- pagamento, o mascaramento de nome/telefone/e-mail, a exclusao de acordo ativo
-- e de encerrado operacional, e o piso de R$ 100 (que o front continua impondo).
--
-- FICA REGISTRADO, NAO CORRIGIDO AQUI: `casos.total_em_aberto` -- a regua de
-- valor desta tela -- bate com o saldo canonico em 41,9% dos casos e subestima
-- 43% na media. Entre os nunca acionados, 191 alunos (17%) ficam abaixo do piso
-- de R$ 100 por causa disso e nao aparecem. Trocar a regua muda QUEM recebe
-- comunicacao em massa, entao nao entra de carona numa correcao de contagem.

-- A assinatura antiga (10 parametros) TEM de sair. `create or replace` com
-- parametros a mais cria uma SOBRECARGA, e a chamada por nome do PostgREST --
-- que manda so os 10 originais -- ficaria ambigua entre as duas, derrubando a
-- tela com "function is not unique".
drop function if exists public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text);

create or replace function public.acoes_massivas_previa(
  p_ano_vencimento text default null,
  p_limite integer default 6000,
  p_dias_minimo_sem_contato integer default null,
  p_apenas_nunca_acionado boolean default false,
  p_unidade text default null,
  p_curso text default null,
  p_apenas_ja_acionado boolean default false,
  p_situacao_academica text default null,
  p_importacao_ids uuid[] default null,
  p_matricula text default null,
  p_canal text default null,
  p_valor_min numeric default null,
  p_valor_max numeric default null
)
returns jsonb
language plpgsql
stable security definer
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
  -- Conjunto COMPLETO que atende aos filtros da tela -- sem limite. E daqui que
  -- sai o total honesto; `base` e so a fatia que a tela vai listar.
  filtrado AS MATERIALIZED (
    SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
           nullif(btrim(a.situacao_academica),'') AS situacao_academica,
           nullif(btrim(a.curso),'')              AS curso,
           a.unidade,
           COALESCE(c.total_em_aberto, 0) AS valor,
           CASE
             WHEN public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO' THEN 'Aguardando confirmação financeira'
             WHEN a.id::text IN (SELECT aluno_id FROM sol_conf) THEN 'Aguardando confirmação financeira'
             ELSE NULL END AS motivo_conf
    FROM public.alunos a
    -- LATERAL sem a condicao de dono: aluno com responsavel tambem tem valor.
    -- LIMIT 1 para nao duplicar a linha de quem tem mais de um caso.
    LEFT JOIN LATERAL (
      SELECT c2.total_em_aberto
      FROM public.casos c2
      WHERE c2.aluno_id = a.id
      ORDER BY c2.total_em_aberto DESC NULLS LAST
      LIMIT 1
    ) c ON true
    WHERE (
            a.responsavel_atual_email IS NULL
            -- Ter dono nao quer dizer estar sendo trabalhado.
            OR (p_apenas_nunca_acionado AND a.data_ultimo_acionamento IS NULL)
            -- Passou do prazo sem acionamento: entra na acao, tendo dono ou nao.
            OR (p_dias_minimo_sem_contato IS NOT NULL
                AND a.data_ultimo_acionamento IS NOT NULL
                AND a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
          )
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
      AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
      AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
      AND (p_unidade IS NULL OR a.unidade = ANY(string_to_array(p_unidade, '|')))
      AND (p_matricula IS NULL OR (
        CASE WHEN EXISTS (
               SELECT 1 FROM public.prime_contratos pc
                WHERE pc.cpf = lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0')
                  AND pc.valid_from >= public.semestre_corrente_inicio()
                  AND pc.status = 'Confirmado')
             THEN 'CONFIRMADA' ELSE 'NAO_CONFIRMADA' END = p_matricula))
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
      -- Canal e valor entram AQUI, antes do corte. Era o que fazia a tela
      -- devolver um punhado de linhas e parecer que a base tinha acabado.
      AND (p_canal IS NULL
           OR (upper(p_canal) = 'WHATSAPP'
               AND nullif(regexp_replace(coalesce(a.telefone,''),'\D','','g'),'') IS NOT NULL)
           OR (upper(p_canal) = 'EMAIL'
               AND btrim(coalesce(a.email,'')) <> '' AND position('@' in btrim(a.email)) > 1))
      AND (p_valor_min IS NULL OR COALESCE(c.total_em_aberto, 0) >= p_valor_min)
      AND (p_valor_max IS NULL OR COALESCE(c.total_em_aberto, 0) <= p_valor_max)
  ),
  base AS MATERIALIZED (
    SELECT * FROM filtrado
    ORDER BY data_ultimo_acionamento ASC NULLS FIRST
    LIMIT p_limite
  ),
  masc AS (
    SELECT id, data_ultimo_acionamento, valor, motivo_conf, nome,
           situacao_academica, curso, unidade,
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
        'unidade', unidade,
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
    'total_excluidos_confirmacao', (SELECT count(*) FROM masc WHERE motivo_conf IS NOT NULL),
    -- Quantos alunos atendem aos filtros da tela, sem limite nenhum.
    'total_elegivel_filtros', (SELECT count(*) FROM filtrado WHERE motivo_conf IS NULL)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

revoke all on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric) from public, anon;
grant execute on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric) to authenticated, service_role;
