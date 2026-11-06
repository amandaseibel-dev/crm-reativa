-- =============================================================================
-- EXECUCAO PELO SQL EDITOR — RUNBOOK §11
-- migration: 20261106120000_tabulacao_retorno_financeiro
-- versao pretendida: 20261106120000
-- projeto: ahattpqrjmhkzsmnbdzs (PRODUCAO)
--
-- EXECUCAO E ACAO EXCLUSIVAMENTE HUMANA (§11). Nenhum agente executa isto.
--
-- md5 do conteudo entre os delimitadores $reg$ (o que o BLOCO A registra e o
-- BLOCO B executa): a40bbba74e26a9c33bbbf8103568d48e
-- sha256 do mesmo conteudo: 6820f9677922181f5fce7d087f33c31d47de5270091a6f7d83022dc55e2e7340
--
-- O conteudo abaixo e o arquivo
--   supabase/aguardando_aprovacao/20261106120000_tabulacao_retorno_financeiro.sql.pendente
-- SEM o `begin;`/`commit;` proprio dele: o bloco unico do §11 ja abre e fecha a
-- transacao, e um commit aninhado confirmaria a transacao externa antes do fim.
-- Nada mais foi alterado.
--
-- PASSO 1 — PRE-CONDICAO. Rodar ISOLADO, antes, e so prosseguir se bater:
--   -- Criterio: ja_registrada = false  E  linha_no_catalogo = 'AUSENTE'
--   SELECT
--     EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
--              WHERE version = '20261106120000')                      AS ja_registrada,
--     COALESCE((SELECT 'EXISTE' FROM public.tabulacoes
--                WHERE codigo = 'RETORNO_FINANCEIRO'), 'AUSENTE')     AS linha_no_catalogo;
--
-- PASSO 4 — VALIDACAO. Rodar ISOLADO, depois:
--   -- As seis validacoes pedidas pela gestao. Todas tem de bater.
--   SELECT codigo,
--          ativa                 AS ativa_esperado_true,
--          somente_gestao        AS somente_gestao_esperado_true,
--          retorno_modo          AS retorno_modo_esperado_NENHUM,
--          retorno_dias_uteis    AS dias_esperado_null,
--          bloqueia_acionamento  AS bloqueia_esperado_false,
--          efeito_desfecho       AS efeito_esperado_null,
--          grupo, ordem, sistema
--     FROM public.tabulacoes
--    WHERE codigo = 'RETORNO_FINANCEIRO';
--   SELECT version, name,
--          md5(array_to_string(statements, E'\n')) AS md5_prod,
--          octet_length(array_to_string(statements, E'\n')) AS bytes
--     FROM supabase_migrations.schema_migrations WHERE version = '20261106120000';
-- =============================================================================

BEGIN;

-- == LOCK =====================================================================
SELECT pg_advisory_xact_lock(hashtext('migration_20261106120000'));

-- == BLOCO A: guard duplo + identidade + registro ==============================
DO $$
DECLARE
  v_md5_aprovado  CONSTANT text := 'a40bbba74e26a9c33bbbf8103568d48e';
  v_versao        CONSTANT text := '20261106120000';
  v_nome          CONSTANT text := '20261106120000_tabulacao_retorno_financeiro';
  v_conteudo      text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_versao
  ) THEN
    RAISE EXCEPTION 'GUARDA: versao % ja registrada em schema_migrations', v_versao;
  END IF;

  v_conteudo := $reg$-- Tabulação "Retorno do financeiro" -- só gestão (pedido da gestão, 06/11/2026)
--
-- O QUE FAZ: insere UMA linha em public.tabulacoes. Nada mais.
--
-- Sem coluna nova: `somente_gestao` já existe na tabela desde o catálogo
-- original e já está `true` para sete tabulações (Cancelamento definitivo,
-- Suspensão, Jurídico, Antecipação de semestre e as três confirmações de
-- alegação). Esta migration apenas acrescenta a oitava.
--
-- Sem prazo próprio (`retorno_modo = 'NENHUM'`), como as outras do grupo
-- FINANCEIRO: quem carimba aqui registra o desfecho de uma solicitação ao
-- financeiro, não combina data com o aluno -- o caso volta pelo motor da fila.
-- Decisão da gestão em 06/11/2026.
--
-- NÃO É o status de texto "Retorno do financeiro recebido", que a RPC
-- `financeiro_registrar_retorno` escreve sozinha a partir da Fila do
-- Financeiro. Este é o CÓDIGO que a gestão escolhe no <select> da ficha e da
-- Minha Carteira.
--
-- NÃO MEXE EM AGENDAMENTO: a regra do catálogo (17/08/2026) é que editar a
-- lista não reescreve `data_retorno` de ninguém. Não há backfill, trigger nem
-- cron relendo o catálogo -- a tabulação nova só vale a partir da próxima
-- tabulação de cada aluno.
--
-- SEM GRANT NOVO, SEM RLS NOVA, SEM FUNÇÃO NOVA: é INSERT de dado numa tabela
-- que já existe, com RLS ligada e só policy de SELECT; `authenticated` segue
-- apenas lendo e a escrita segue só pelas RPCs `tabulacao_salvar/desativar/
-- reativar`, com o portão `usuario_pode_editar_tabulacoes()`.
--
-- `sistema = false`: a gestão pode editar rótulo/ordem pela tela /tabulacoes,
-- como escolheu em 17/08/2026 para todas.
--
-- ORDEM DE DEPLOY -- ESTE SQL PRIMEIRO, O FRONT DEPOIS.
-- O <option> do `<select>` NÃO vem do catálogo: a fonte real é o array
-- `STATUS_FINALIZACAO`, duplicado nas telas, e o rótulo vem de um dicionário
-- no próprio JSX. Publicar o front antes deste INSERT oferece a tabulação com
-- rótulo e tudo, e grava em `alunos.status_*` um código que não existe no
-- catálogo. O portão de gestão (`TABULACOES_SO_GESTAO`) é lista literal, então
-- ele funciona nas duas ordens -- mas o código órfão no banco, não.
--
-- ROLLBACK: 20261106120000_tabulacao_retorno_financeiro.rollback.sql


insert into public.tabulacoes (
  codigo,
  rotulo,
  ordem,
  grupo,
  retorno_modo,
  retorno_dias_uteis,
  proxima_acao,
  ativa,
  somente_gestao,
  sistema,
  bloqueia_acionamento,
  exige_processo,
  efeito_desfecho,
  criado_por
) values (
  'RETORNO_FINANCEIRO',
  'Retorno do financeiro',
  340,                      -- logo depois de BAIXA_DEVOLVIDA (330), no grupo FINANCEIRO
  'FINANCEIRO',
  'NENHUM',
  null,
  'CONTATAR',
  true,
  true,                     -- SÓ GESTÃO: usuario_e_gestao() = Amanda, Fernanda, Amanda ADM
  false,
  false,                    -- não tira caso de cobrança
  false,                    -- não exige número de processo
  null,                     -- não devolve nem suspende parcela
  'migration 20261106120000'
)
-- DO NOTHING, NÃO `do update`. A linha é da gestão depois de criada:
-- `sistema = false` existe justamente para ela poder mudar rótulo e ordem pela
-- tela /tabulacoes, e um `do update` reaplicado desfaria essa edição. Pior:
-- `ativa = excluded.ativa` REATIVARIA a tabulação depois do rollback, que
-- desativa. Reaplicar esta migration não pode ressuscitar nada.
on conflict (codigo) do nothing;

-- VIGIA: a tabulação não pode nascer aberta ao operador. Se `somente_gestao`
-- não ficou true, a migration não entrega o que foi pedido -- aborta.
--
-- Com `do nothing`, este vigia também pega o caso "a linha já existe em outro
-- estado" -- por exemplo depois do rollback, que deixa `ativa = false`. Falhar
-- alto ali é o comportamento certo: reaplicar a migration não deve ressuscitar
-- em silêncio uma tabulação que alguém desativou de propósito.
do $$
declare
  v_ativa boolean;
  v_gestao boolean;
begin
  select ativa, somente_gestao into v_ativa, v_gestao
    from public.tabulacoes
   where codigo = 'RETORNO_FINANCEIRO';

  if not found then
    raise exception 'RETORNO_FINANCEIRO nao foi inserida';
  end if;

  if not v_gestao then
    raise exception
      'RETORNO_FINANCEIRO esta com somente_gestao = false: ficaria visivel ao operador';
  end if;

  if not v_ativa then
    raise exception
      'RETORNO_FINANCEIRO ja existe DESATIVADA (ativa = false). Reaplicar nao reativa: '
      'se a intencao e religar, faca um UPDATE explicito e registre o motivo.';
  end if;

  if not exists (
    select 1 from public.tabulacoes
     where codigo = 'RETORNO_FINANCEIRO'
       and grupo = 'FINANCEIRO'
       and retorno_modo = 'NENHUM'
       and retorno_dias_uteis is null
  ) then
    raise exception 'RETORNO_FINANCEIRO nao ficou em FINANCEIRO/NENHUM sem prazo';
  end if;
end
$$;$reg$;

  IF md5(v_conteudo) <> v_md5_aprovado THEN
    RAISE EXCEPTION 'GUARDA DE IDENTIDADE: md5(conteudo)=% md5(aprovado)=%',
      md5(v_conteudo), v_md5_aprovado;
  END IF;

  INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
  VALUES (v_versao, v_nome, ARRAY[v_conteudo]);
END $$;

-- == BLOCO B: a migration ======================================================
-- Tabulação "Retorno do financeiro" -- só gestão (pedido da gestão, 06/11/2026)
--
-- O QUE FAZ: insere UMA linha em public.tabulacoes. Nada mais.
--
-- Sem coluna nova: `somente_gestao` já existe na tabela desde o catálogo
-- original e já está `true` para sete tabulações (Cancelamento definitivo,
-- Suspensão, Jurídico, Antecipação de semestre e as três confirmações de
-- alegação). Esta migration apenas acrescenta a oitava.
--
-- Sem prazo próprio (`retorno_modo = 'NENHUM'`), como as outras do grupo
-- FINANCEIRO: quem carimba aqui registra o desfecho de uma solicitação ao
-- financeiro, não combina data com o aluno -- o caso volta pelo motor da fila.
-- Decisão da gestão em 06/11/2026.
--
-- NÃO É o status de texto "Retorno do financeiro recebido", que a RPC
-- `financeiro_registrar_retorno` escreve sozinha a partir da Fila do
-- Financeiro. Este é o CÓDIGO que a gestão escolhe no <select> da ficha e da
-- Minha Carteira.
--
-- NÃO MEXE EM AGENDAMENTO: a regra do catálogo (17/08/2026) é que editar a
-- lista não reescreve `data_retorno` de ninguém. Não há backfill, trigger nem
-- cron relendo o catálogo -- a tabulação nova só vale a partir da próxima
-- tabulação de cada aluno.
--
-- SEM GRANT NOVO, SEM RLS NOVA, SEM FUNÇÃO NOVA: é INSERT de dado numa tabela
-- que já existe, com RLS ligada e só policy de SELECT; `authenticated` segue
-- apenas lendo e a escrita segue só pelas RPCs `tabulacao_salvar/desativar/
-- reativar`, com o portão `usuario_pode_editar_tabulacoes()`.
--
-- `sistema = false`: a gestão pode editar rótulo/ordem pela tela /tabulacoes,
-- como escolheu em 17/08/2026 para todas.
--
-- ORDEM DE DEPLOY -- ESTE SQL PRIMEIRO, O FRONT DEPOIS.
-- O <option> do `<select>` NÃO vem do catálogo: a fonte real é o array
-- `STATUS_FINALIZACAO`, duplicado nas telas, e o rótulo vem de um dicionário
-- no próprio JSX. Publicar o front antes deste INSERT oferece a tabulação com
-- rótulo e tudo, e grava em `alunos.status_*` um código que não existe no
-- catálogo. O portão de gestão (`TABULACOES_SO_GESTAO`) é lista literal, então
-- ele funciona nas duas ordens -- mas o código órfão no banco, não.
--
-- ROLLBACK: 20261106120000_tabulacao_retorno_financeiro.rollback.sql


insert into public.tabulacoes (
  codigo,
  rotulo,
  ordem,
  grupo,
  retorno_modo,
  retorno_dias_uteis,
  proxima_acao,
  ativa,
  somente_gestao,
  sistema,
  bloqueia_acionamento,
  exige_processo,
  efeito_desfecho,
  criado_por
) values (
  'RETORNO_FINANCEIRO',
  'Retorno do financeiro',
  340,                      -- logo depois de BAIXA_DEVOLVIDA (330), no grupo FINANCEIRO
  'FINANCEIRO',
  'NENHUM',
  null,
  'CONTATAR',
  true,
  true,                     -- SÓ GESTÃO: usuario_e_gestao() = Amanda, Fernanda, Amanda ADM
  false,
  false,                    -- não tira caso de cobrança
  false,                    -- não exige número de processo
  null,                     -- não devolve nem suspende parcela
  'migration 20261106120000'
)
-- DO NOTHING, NÃO `do update`. A linha é da gestão depois de criada:
-- `sistema = false` existe justamente para ela poder mudar rótulo e ordem pela
-- tela /tabulacoes, e um `do update` reaplicado desfaria essa edição. Pior:
-- `ativa = excluded.ativa` REATIVARIA a tabulação depois do rollback, que
-- desativa. Reaplicar esta migration não pode ressuscitar nada.
on conflict (codigo) do nothing;

-- VIGIA: a tabulação não pode nascer aberta ao operador. Se `somente_gestao`
-- não ficou true, a migration não entrega o que foi pedido -- aborta.
--
-- Com `do nothing`, este vigia também pega o caso "a linha já existe em outro
-- estado" -- por exemplo depois do rollback, que deixa `ativa = false`. Falhar
-- alto ali é o comportamento certo: reaplicar a migration não deve ressuscitar
-- em silêncio uma tabulação que alguém desativou de propósito.
do $$
declare
  v_ativa boolean;
  v_gestao boolean;
begin
  select ativa, somente_gestao into v_ativa, v_gestao
    from public.tabulacoes
   where codigo = 'RETORNO_FINANCEIRO';

  if not found then
    raise exception 'RETORNO_FINANCEIRO nao foi inserida';
  end if;

  if not v_gestao then
    raise exception
      'RETORNO_FINANCEIRO esta com somente_gestao = false: ficaria visivel ao operador';
  end if;

  if not v_ativa then
    raise exception
      'RETORNO_FINANCEIRO ja existe DESATIVADA (ativa = false). Reaplicar nao reativa: '
      'se a intencao e religar, faca um UPDATE explicito e registre o motivo.';
  end if;

  if not exists (
    select 1 from public.tabulacoes
     where codigo = 'RETORNO_FINANCEIRO'
       and grupo = 'FINANCEIRO'
       and retorno_modo = 'NENHUM'
       and retorno_dias_uteis is null
  ) then
    raise exception 'RETORNO_FINANCEIRO nao ficou em FINANCEIRO/NENHUM sem prazo';
  end if;
end
$$;

-- == FIM =======================================================================
COMMIT;
