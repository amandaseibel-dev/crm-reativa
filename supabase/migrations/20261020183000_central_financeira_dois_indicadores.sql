-- CENTRAL FINANCEIRA -- OS DOIS INDICADORES, SEPARADOS NA ORIGEM.
--
-- ORDEM DA GESTAO, 20/10/2026, literal: "Na Central Financeira, mantenha dois
-- indicadores distintos: conciliacao no CRM e baixa oficial no titulo/parcela.
-- Nao considere status BAIXADO como prova suficiente de pagamento ou baixa
-- oficial. Use essa distincao para desenhar a tela de conferencia." E tambem:
-- "Nao implemente baixa automatica sem validacao oficial."
--
-- ESTA MIGRATION E SOMENTE LEITURA. Cria duas VIEWS e nada mais: nenhum
-- insert, update, delete, backfill, gatilho, RPC de escrita ou coluna nova.
-- Nenhuma baixa automatica. Nenhuma heranca dono/caso.
--
-- -------------------------------------------------------------------------
-- A REGRA DURA: nao existe coluna que misture as duas fontes.
-- -------------------------------------------------------------------------
-- Cada coluna carrega no nome a tabela de onde saiu, e nenhuma coluna combina
-- duas tabelas:
--
--   crm_*     -> SO public.pagamentos          (a opiniao do motor de importacao)
--   baixa_*   -> SO public.baixas_pagamento    (a baixa oficial, com responsavel)
--   parcela_* -> SO public.parcelas            (o estado da obrigacao)
--
-- `baixa_oficial_existe` e booleano, mas deriva EXCLUSIVAMENTE de
-- baixas_pagamento -- nao olha status_conciliacao nem parcelas.status. Nao ha
-- nenhum "esta_baixado" nesta view, e e de proposito: `BAIXADO` em
-- status_conciliacao NAO prova baixa oficial, e a view nao da nenhum caminho
-- para confundir as duas coisas.
--
-- -------------------------------------------------------------------------
-- A CHAVE REAL ENTRE pagamentos E baixas_pagamento -- MEDIDA, NAO SUPOSTA
-- -------------------------------------------------------------------------
-- `public.pagamentos` NAO tem parcela_id, baixa_id nem solicitacao_link_id.
-- Nao existe chave direta. Leitura de producao em 20/10/2026, sobre as 10.565
-- linhas de pagamentos e as 3.737 de baixas_pagamento:
--
--   1) parcelas.origem_baixa_ref = pagamentos.id    -> das 1.237 linhas NAO
--      NULAS de origem_baixa_ref, 1.237 (100%) casam com um pagamento, com
--      1.237 valores distintos e ZERO repetido. E referencia explicita que o
--      gatilho de importacao gravou, e e a chave mais forte que existe.
--      O QUE ESSE 100% NAO DIZ: origem_baixa_ref e NULA em 15.313 das 16.550
--      parcelas -- a referencia existe em apenas 7,5% delas. O numero mede
--      precisao (quando existe, aponta certo), nao cobertura. A cobertura real
--      do vinculo esta em `vinculo_parcela_confianca`, onde SEM_PARCELA sao
--      9.250 dos 10.565 pagamentos (87,6%). Nao ler como "todo pagamento tem
--      baixa rastreavel": nao e isso.
--   2) parcelas.boleto = pagamentos.origem_vinculo_ref, quando
--      origem_vinculo = 'BOLETO_EXATO'. parcelas.boleto e unico: 16.521
--      parcelas, 2.162 com boleto nulo, 14.359 nao nulos e 14.359 distintos --
--      zero boleto em mais de uma parcela.
--   3) as duas regras casaram juntas em 977 pagamentos e DISCORDARAM em ZERO.
--      Por isso (1) tem precedencia sem prejuizo, e a discordancia, se algum
--      dia aparecer, vira 'CONFLITO_REF_X_BOLETO' na coluna de confianca em
--      vez de ser escondida por um coalesce.
--   4) chave fraca descartada: aluno/CPF + data_pagamento + valor_pago. Dos
--      9.250 pagamentos sem parcela resolvida, 8.824 nao tem nenhum candidato,
--      356 tem exatamente um e 70 tem dois ou mais; a propria chave se repete
--      em 399 combinacoes dentro de baixas_pagamento. Escolher "o mais
--      proximo" seria sorteio. Ela NAO vira vinculo: aparece como contagem em
--      `baixa_candidata_fraca_qtd`, que e pista para a gestao conferir, nunca
--      afirmacao de vinculo.
--   5) baixas_pagamento.aluno_id e text e pagamentos.aluno_id e uuid. Os 3.737
--      valores sao uuid em texto, mas o tipo divergente e por si um motivo
--      para nao ancorar a chave nele.
--
-- OUTRA CHAVE QUE NAO EXISTE, e que vale registrar para nao ser procurada de
-- novo: `baixas_pagamento` NAO TEM coluna `pagamento_id` (conferido no catalogo
-- em 20/10/2026). Ela viria da Fase 1 da rastreabilidade de baixa, que nao esta
-- em producao nem existe como arquivo no repositorio. Nada aqui depende dela.
--
-- E NAO CONFUNDIR OS DOIS PREFIXOS "origem_": `pagamentos.origem_vinculo*` e do
-- lado da CONCILIACAO (a opiniao do motor de importacao) e `parcelas.origem_baixa*`
-- e do lado da baixa na obrigacao. Sao fontes diferentes e nesta view moram em
-- colunas com prefixos diferentes (`crm_*` e `parcela_*`).
--
-- ACHADO QUE A GESTAO PRECISA DECIDIR (nao resolvido aqui, por ser escrita):
-- a chave 1 so existe porque o gatilho de importacao a gravou -- em 7,5% das
-- parcelas. Para os 9.250 pagamentos sem parcela resolvida nao ha nenhuma
-- referencia persistida. Criar essa referencia e ESCRITA e esta fora desta
-- entrega.
--
-- -------------------------------------------------------------------------
-- "BAIXA VIVA" -- DEFINICAO REUSADA, NAO INVENTADA
-- -------------------------------------------------------------------------
-- Viva = `devolvido_em is null`. E exatamente a regra que a trava
-- `_baixa_viva_unica_por_parcela()` (migration 20260922290000) ja usa em
-- producao; esta view nao cria um segundo conceito de baixa viva.
--
-- Por que NAO usar status_baixa para isso: medido em 20/10/2026, das 3.292
-- linhas 'REALIZADA' CINCO tem devolvido_em preenchido, e das 435 'DEVOLVIDA'
-- 429 tem baixado_em preenchido. Nem status_baixa nem baixado_em sozinhos
-- dizem se a baixa esta viva. Os dois continuam expostos em colunas proprias,
-- para que a divergencia apareca em vez de ser normalizada.
--
-- -------------------------------------------------------------------------
-- PERMISSAO: a view NAO carrega privilegio nenhum
-- -------------------------------------------------------------------------
-- security_invoker = true, o padrao do projeto desde 20260727170000. A view
-- respeita a RLS de quem consulta: a gestao (`usuario_e_gestao()`) ve tudo, e
-- um operador ve apenas o que as politicas dele ja permitiam.
--
-- CONSEQUENCIA QUE A TELA TRATA: um operador pode ver o pagamento dele e NAO
-- ver a parcela nem a baixa (politicas diferentes). Nesse caso a coluna de
-- baixa oficial leria "nao existe" por falta de visibilidade, nao por falta de
-- baixa -- justamente a confusao que esta frente existe para evitar. Por isso
-- a aba no frontend e restrita aos tres e-mails da gestao financeira, os
-- mesmos que `usuario_e_gestao()` aceita. A view nao tenta corrigir isso com
-- SECURITY DEFINER: elevar privilegio aqui abriria leitura financeira para
-- qualquer logado.
--
-- Rollback: supabase/rollbacks/20261020183000_central_financeira_dois_indicadores.rollback.sql
-- Idempotente: as duas views sao CREATE OR REPLACE VIEW.

-- ---------------------------------------------------------------------------
-- 1) A view de leitura: uma linha por pagamento, as fontes separadas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_central_financeira_pagamento_indicadores AS
WITH ref AS (
  -- Chave 1: a referencia explicita que o gatilho de importacao gravou na
  -- parcela. Agregado por chave (nao lateral correlacionada) para o plano virar
  -- hash join: origem_baixa_ref nao tem indice, e um subselect por linha faria
  -- 10.565 varreduras de parcelas.
  SELECT origem_baixa_ref                                   AS chave,
         count(*)                                           AS qtd,
         (array_agg(id ORDER BY id))[1]                      AS parcela_id
    FROM public.parcelas
   WHERE origem_baixa_ref IS NOT NULL
   GROUP BY 1
),
bol AS (
  -- Chave 2: boleto completo. Unico entre os nao nulos (medido acima).
  SELECT boleto                                             AS chave,
         count(*)                                           AS qtd,
         (array_agg(id ORDER BY id))[1]                      AS parcela_id
    FROM public.parcelas
   WHERE boleto IS NOT NULL
   GROUP BY 1
),
viva AS (
  -- A baixa VIVA da parcela. `qtd` fica exposta: a trava garante no maximo uma,
  -- e se alguma linha historica violar isso a tela mostra em vez de esconder.
  SELECT parcela_id,
         count(*)                                                                   AS qtd,
         (array_agg(id                ORDER BY baixado_em DESC NULLS LAST, id))[1]   AS baixa_id,
         (array_agg(status_baixa      ORDER BY baixado_em DESC NULLS LAST, id))[1]   AS status_baixa,
         (array_agg(baixado_em        ORDER BY baixado_em DESC NULLS LAST, id))[1]   AS baixado_em,
         (array_agg(baixado_por_email ORDER BY baixado_em DESC NULLS LAST, id))[1]   AS baixado_por_email,
         (array_agg(recebido_em       ORDER BY baixado_em DESC NULLS LAST, id))[1]   AS recebido_em,
         (array_agg(valor_pago        ORDER BY baixado_em DESC NULLS LAST, id))[1]   AS valor_pago
    FROM public.baixas_pagamento
   WHERE parcela_id IS NOT NULL
     AND devolvido_em IS NULL
   GROUP BY 1
),
devolvida AS (
  SELECT parcela_id,
         count(*)                                                                    AS qtd,
         max(devolvido_em)                                                           AS ultima_em,
         (array_agg(motivo_devolucao ORDER BY devolvido_em DESC NULLS LAST))[1]       AS motivo
    FROM public.baixas_pagamento
   WHERE parcela_id IS NOT NULL
     AND devolvido_em IS NOT NULL
   GROUP BY 1
),
fraca AS (
  -- A chave DESCARTADA, contada de proposito. Serve para dizer "existe uma
  -- baixa parecida, confira" -- nunca para afirmar vinculo.
  SELECT regexp_replace(coalesce(aluno_cpf, ''), '\D', '', 'g')  AS cpf_norm,
         data_pagamento,
         valor_pago,
         count(*)                                                AS qtd
    FROM public.baixas_pagamento
   WHERE data_pagamento IS NOT NULL
   GROUP BY 1, 2, 3
)
SELECT
  -- o pagamento, para a gestao decidir
  g.id                                                            AS pagamento_id,
  g.aluno_id,
  g.aluno_nome,
  g.cpf,
  g.data_pagamento,
  g.valor_pago,
  g.titulo_numero,
  g.numero_parcela_completo,

  -- FONTE A -- conciliacao no CRM. So public.pagamentos.
  g.status_conciliacao                                            AS crm_status_conciliacao,
  g.conciliacao_motivo                                            AS crm_conciliacao_motivo,
  g.conciliacao_em                                                AS crm_conciliacao_em,
  g.origem_vinculo                                                AS crm_origem_vinculo,
  g.origem_vinculo_ref                                            AS crm_origem_vinculo_ref,
  -- Quantos dias a opiniao do CRM esta parada. Cai para data_pagamento quando
  -- nunca houve conciliacao (8.955 linhas em 20/10/2026 tem status nulo).
  (current_date - coalesce(g.conciliacao_em::date, g.data_pagamento)) AS crm_dias_parado,

  -- O VINCULO, com a fraqueza na cara.
  coalesce(ref.parcela_id, bol.parcela_id)                        AS parcela_id,
  CASE
    WHEN ref.parcela_id IS NOT NULL AND bol.parcela_id IS NOT NULL
         AND ref.parcela_id <> bol.parcela_id             THEN 'CONFLITO_REF_X_BOLETO'
    WHEN ref.parcela_id IS NOT NULL AND bol.parcela_id IS NOT NULL
                                                          THEN 'ALTA_REF_E_BOLETO'
    WHEN ref.parcela_id IS NOT NULL                       THEN 'ALTA_REF_IMPORTACAO'
    WHEN bol.parcela_id IS NOT NULL                       THEN 'ALTA_BOLETO_EXATO'
    ELSE                                                       'SEM_PARCELA'
  END                                                             AS vinculo_parcela_confianca,
  -- Quantas das duas regras casaram (0, 1 ou 2) -- nao e numero de parcelas.
  (CASE WHEN ref.parcela_id IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN bol.parcela_id IS NOT NULL THEN 1 ELSE 0 END)      AS vinculo_parcela_regras_casadas,
  -- > 1 significa chave repetida na origem (hoje: zero em ambas as regras).
  greatest(coalesce(ref.qtd, 0), coalesce(bol.qtd, 0))            AS vinculo_parcela_chave_repetida,

  -- FONTE B -- baixa oficial. So public.baixas_pagamento.
  (viva.baixa_id IS NOT NULL)                                     AS baixa_oficial_existe,
  viva.baixa_id                                                   AS baixa_oficial_id,
  coalesce(viva.qtd, 0)                                           AS baixa_oficial_vivas_qtd,
  viva.status_baixa                                               AS baixa_oficial_status_baixa,
  viva.baixado_em                                                 AS baixa_oficial_em,
  viva.baixado_por_email                                          AS baixa_oficial_por_email,
  viva.recebido_em                                                AS baixa_oficial_recebido_em,
  viva.valor_pago                                                 AS baixa_oficial_valor_pago,
  coalesce(devolvida.qtd, 0)                                      AS baixa_devolvida_qtd,
  devolvida.ultima_em                                             AS baixa_devolvida_ultima_em,
  devolvida.motivo                                                AS baixa_devolvida_motivo,
  -- Pista, nao vinculo (ver chave 4 no cabecalho).
  CASE WHEN coalesce(ref.parcela_id, bol.parcela_id) IS NULL
       THEN coalesce(fraca.qtd, 0) ELSE 0 END                     AS baixa_candidata_fraca_qtd,

  -- FONTE C -- o estado da obrigacao. So public.parcelas. NAO e a baixa
  -- oficial: a parcela pode estar PAGO por gatilho de importacao, sem nenhuma
  -- linha em baixas_pagamento, e e justamente esse o caso de 1.235 pagamentos.
  pr.status                                                       AS parcela_status,
  pr.origem_baixa                                                 AS parcela_origem_baixa,
  pr.origem_baixa_em                                              AS parcela_origem_baixa_em,
  pr.acordo_id                                                    AS parcela_acordo_id
FROM public.pagamentos g
LEFT JOIN ref ON ref.chave = g.id::text
LEFT JOIN bol ON g.origem_vinculo = 'BOLETO_EXATO' AND bol.chave = g.origem_vinculo_ref
LEFT JOIN public.parcelas pr  ON pr.id        = coalesce(ref.parcela_id, bol.parcela_id)
LEFT JOIN viva                ON viva.parcela_id      = coalesce(ref.parcela_id, bol.parcela_id)
LEFT JOIN devolvida           ON devolvida.parcela_id = coalesce(ref.parcela_id, bol.parcela_id)
LEFT JOIN fraca ON coalesce(ref.parcela_id, bol.parcela_id) IS NULL
               AND fraca.cpf_norm       = regexp_replace(coalesce(g.cpf, ''), '\D', '', 'g')
               AND fraca.data_pagamento = g.data_pagamento
               AND fraca.valor_pago     = g.valor_pago;

ALTER VIEW public.vw_central_financeira_pagamento_indicadores SET (security_invoker = true);

COMMENT ON VIEW public.vw_central_financeira_pagamento_indicadores IS
  'Central Financeira: uma linha por pagamento com as DUAS dimensoes em colunas separadas -- crm_* vem so de pagamentos, baixa_* so de baixas_pagamento, parcela_* so de parcelas. Nao existe coluna que misture as fontes: BAIXADO em status_conciliacao nao prova baixa oficial. Vinculo a parcela por parcelas.origem_baixa_ref = pagamentos.id e, em seguida, parcelas.boleto = origem_vinculo_ref (BOLETO_EXATO); a forca do vinculo fica em vinculo_parcela_confianca. Baixa viva = devolvido_em nulo, a mesma regra de _baixa_viva_unica_por_parcela(). Somente leitura.';

-- ---------------------------------------------------------------------------
-- 2) A lista de excecoes, derivada da view acima, classificada por risco.
-- ---------------------------------------------------------------------------
-- Uma linha por (pagamento, classe): um pagamento pode cair em mais de uma
-- classe, e contar cada classe inteira e o que a gestao pediu. Quem quiser
-- "pagamentos distintos em excecao" usa count(distinct pagamento_id).
--
-- O CORTE DE N DIAS DA CLASSE AGUARDANDO_ACORDO = 7, e ele e robusto.
-- Distribuicao real dos 281 AGUARDANDO_ACORDO em 20/10/2026, por dias desde
-- conciliacao_em: 0-3 -> 10 (o maior e 1 dia), 4-7 -> 54, 8-14 -> 67 (o menor
-- e 11 dias), 15-30 -> 128, 30+ -> 22. A faixa de 8, 9 e 10 dias esta VAZIA,
-- entao qualquer N entre 7 e 10 seleciona exatamente o mesmo conjunto: 217
-- pagamentos, R$ 165.023,96. O corte nao depende de calibragem fina; 7 e o
-- menor valor que nao racha nenhuma faixa e equivale a uma semana.
--
-- CLASSE QUE NAO EXISTE AQUI, DE PROPOSITO: pagamento em parcela ou acordo
-- CANCELADO. Essa fila e da PR #694, que esta bloqueada por decisao da gestao.
-- Nao reimplemento. O unico pagamento que hoje esta nessa situacao e
-- conciliado como BAIXADO continua aparecendo em
-- 'BAIXADO_SEM_BAIXA_OFICIAL', porque atende a definicao dessa classe -- mas
-- nao ha nenhuma classe, filtro ou contador por parcela cancelada.
CREATE OR REPLACE VIEW public.vw_central_financeira_pagamento_excecoes AS
WITH v AS (
  SELECT * FROM public.vw_central_financeira_pagamento_indicadores
),
classificado AS (
  -- 1) A DIVERGENCIA PERIGOSA: o CRM diz que acabou e nao existe baixa oficial.
  SELECT v.*,
         1                                        AS risco,
         'CRITICO'                                AS risco_rotulo,
         'BAIXADO_SEM_BAIXA_OFICIAL'              AS classe,
         'Conciliado BAIXADO no CRM e sem baixa oficial viva' AS classe_rotulo,
         CASE
           WHEN v.parcela_id IS NULL
             THEN 'Nao ha parcela vinculada: o CRM baixou sem obrigacao identificada'
           WHEN v.parcela_status = 'PAGO'
             THEN 'Parcela esta PAGO por ' || coalesce(v.parcela_origem_baixa, 'origem nao registrada')
                  || ', sem linha em baixas_pagamento: falta a trilha de quem assinou'
           ELSE 'Parcela esta ' || coalesce(v.parcela_status, 'sem status')
                || ': a obrigacao nao esta quitada'
         END                                      AS classe_motivo
    FROM v
   WHERE v.crm_status_conciliacao = 'BAIXADO'
     AND v.baixa_oficial_existe IS FALSE

  UNION ALL

  -- 2) Baixa estornada e ninguem refez. O dinheiro entrou e nao ha baixa viva.
  SELECT v.*, 2, 'ALTO',
         'BAIXA_DEVOLVIDA_SEM_NOVA',
         'Baixa devolvida e sem baixa nova depois',
         v.baixa_devolvida_qtd || ' baixa(s) devolvida(s), ultima em '
         || coalesce(to_char(v.baixa_devolvida_ultima_em, 'DD/MM/YYYY HH24:MI'), 'data nao registrada')
         || '; motivo: ' || coalesce(nullif(btrim(v.baixa_devolvida_motivo), ''), 'nao registrado')
    FROM v
   WHERE v.baixa_devolvida_qtd > 0
     AND v.baixa_oficial_existe IS FALSE

  UNION ALL

  -- 3) O motor recusou porque a parcela ja estava paga. Dinheiro sem obrigacao
  --    aberta pede conferencia: pode ser duplicidade real de pagamento.
  SELECT v.*, 3, 'ALTO',
         'PARCELA_JA_PAGA',
         'Conciliacao recusou: parcela ja estava paga',
         coalesce(nullif(btrim(v.crm_conciliacao_motivo), ''), 'motivo nao registrado')
    FROM v
   WHERE v.crm_status_conciliacao = 'PARCELA_JA_PAGA'

  UNION ALL

  -- 4) Esperando acordo ha mais de uma semana (ver justificativa do N acima).
  SELECT v.*, 4, 'MEDIO',
         'AGUARDANDO_ACORDO_PARADO',
         'Aguardando acordo ha mais de 7 dias',
         v.crm_dias_parado || ' dias desde '
         || CASE WHEN v.crm_conciliacao_em IS NULL THEN 'o pagamento' ELSE 'a ultima conciliacao' END
    FROM v
   WHERE v.crm_status_conciliacao = 'AGUARDANDO_ACORDO'
     AND v.crm_dias_parado > 7

  UNION ALL

  -- 5) As duas fontes discordam no sentido inverso: a baixa oficial existe e a
  --    conciliacao nao diz BAIXADO. Risco financeiro baixo, mas e divergencia
  --    de leitura entre as duas fontes e por isso entra na lista.
  SELECT v.*, 5, 'BAIXO',
         'BAIXA_OFICIAL_SEM_CONCILIACAO_BAIXADO',
         'Baixa oficial existe e a conciliacao nao diz BAIXADO',
         'Baixa oficial em '
         || coalesce(to_char(v.baixa_oficial_em, 'DD/MM/YYYY HH24:MI'), 'data nao registrada')
         || ' por ' || coalesce(nullif(btrim(v.baixa_oficial_por_email), ''), 'origem nao registrada')
         || '; conciliacao no CRM: ' || coalesce(v.crm_status_conciliacao, 'sem status')
    FROM v
   WHERE v.baixa_oficial_existe IS TRUE
     AND coalesce(v.crm_status_conciliacao, '(sem status)') <> 'BAIXADO'
)
SELECT * FROM classificado;

ALTER VIEW public.vw_central_financeira_pagamento_excecoes SET (security_invoker = true);

COMMENT ON VIEW public.vw_central_financeira_pagamento_excecoes IS
  'Central Financeira: excecoes derivadas de vw_central_financeira_pagamento_indicadores, uma linha por (pagamento, classe) -- um pagamento pode cair em mais de uma classe. Risco 1 CRITICO BAIXADO_SEM_BAIXA_OFICIAL, 2 ALTO BAIXA_DEVOLVIDA_SEM_NOVA, 3 ALTO PARCELA_JA_PAGA, 4 MEDIO AGUARDANDO_ACORDO_PARADO (>7 dias; a faixa de 8 a 10 dias esta vazia, entao qualquer N de 7 a 10 da o mesmo conjunto), 5 BAIXO BAIXA_OFICIAL_SEM_CONCILIACAO_BAIXADO. NAO tem classe de parcela/acordo CANCELADO: essa fila e da PR #694. Somente leitura.';

-- ---------------------------------------------------------------------------
-- 3) Permissao de leitura. View NAO herda os grants das tabelas de origem.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.vw_central_financeira_pagamento_indicadores TO authenticated;
GRANT SELECT ON public.vw_central_financeira_pagamento_excecoes     TO authenticated;
