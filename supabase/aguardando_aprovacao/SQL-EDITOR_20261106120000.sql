-- ============================================================================
-- SQL-EDITOR 20261106120000 — RUNBOOK §11 (execução humana, SQL Editor)
-- Gerado a partir de supabase/aguardando_aprovacao/20261106120000_tabulacao_retorno_financeiro.sql.pendente (PR #844, main).
-- Conteúdo a validar = arquivo SEM o LF final.
--   versao pretendida : 20261106120000
--   nome              : 20261106120000_tabulacao_retorno_financeiro
--   md5 (sem LF final): b9dae9d5a1f0d12df7e9375b6d293227
--   bytes             : 4894
--   sha256 do arquivo : ff8e9e8e9c092ccf9f60e1c57aceaadca9a8d858ec1d0254a9dca7784f5196fb
-- ============================================================================

BEGIN;

-- LOCK: impede execução concorrente da mesma versão (liberado no COMMIT/ROLLBACK)
SELECT pg_advisory_xact_lock(hashtext('migration_20261106120000'));

-- BLOCO A: guardas + registro. O INSERT usa v_conteudo, a MESMA variável verificada.
DO $blocoA$
DECLARE
  v_md5_aprovado  CONSTANT text := 'b9dae9d5a1f0d12df7e9375b6d293227';
  v_versao        CONSTANT text := '20261106120000';
  v_nome          CONSTANT text := '20261106120000_tabulacao_retorno_financeiro';
  v_conteudo      text;
BEGIN
  -- Guard 1: dupla aplicação
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_versao) THEN
    RAISE EXCEPTION 'GUARDA: versao % ja registrada em schema_migrations', v_versao;
  END IF;

  -- Conteúdo aprovado: colado UMA vez, entre delimitadores, sem LF final
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

begin;

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

commit;$reg$;

  -- Guard 2: identidade
  IF md5(v_conteudo) <> v_md5_aprovado THEN
    RAISE EXCEPTION 'GUARDA DE IDENTIDADE: md5(conteudo)=% md5(aprovado)=%',
      md5(v_conteudo), v_md5_aprovado;
  END IF;

  INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
  VALUES (v_versao, v_nome, ARRAY[v_conteudo]);
END $blocoA$;

-- BLOCO B: execução. Idêntico ao arquivo aprovado, EXCETO as linhas begin;/commit;
-- do próprio arquivo, que saem porque o transação é o template acima.
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


-- FIM: confirma o COMMIT
COMMIT;
