-- =============================================================================
-- RETORNO PRIORITÁRIO — a marca que o operador faz na tabulação
-- -----------------------------------------------------------------------------
-- Pedido da gestão em 15/10/2026, junto com o aviso na hora do retorno: ao
-- tabular, o operador pode marcar aquele retorno como PRIORITÁRIO, e o caso
-- passa a vir primeiro na fila de acionamento e no bloco "Meu dia".
--
-- POR QUE UMA COLUNA NOVA E NÃO UM CAMPO QUE JÁ EXISTE. `nivel_criticidade` é
-- calculada pelo backend a partir da dívida (recalcular_situacao_aluno), e
-- sobrescrever aquilo pela mão do operador apagaria o critério financeiro no
-- primeiro recálculo. `data_retorno`/`hora_retorno` dizem QUANDO, não QUÃO
-- importante: um retorno das 17h pode ser o mais importante do dia. São duas
-- perguntas diferentes e por isso são dois campos.
--
-- O QUE ESTA MIGRATION FAZ, E SÓ ISSO:
--   * acrescenta `alunos.retorno_prioritario boolean not null default false`;
--   * NENHUM índice: a tela lê a marca junto com o resto da carteira (um
--     `select` por responsável) e ordena em memória -- nenhuma consulta filtra
--     por `retorno_prioritario`. Índice sem consulta que o use é só custo de
--     escrita. Quando existir uma consulta que busque "os prioritários de
--     fulano", o índice entra com ela, medido;
--   * nenhuma linha existente muda de comportamento: todo mundo nasce false,
--     que é exatamente a fila de hoje;
--   * nenhuma função, gatilho, view ou policy é tocada. A escrita usa o mesmo
--     caminho (update em `public.alunos`) e as mesmas policies de RLS que a
--     tela já usa para gravar tabulação.
--
-- ADD COLUMN com DEFAULT não reescreve a tabela no PostgreSQL 11+: o default é
-- guardado no catálogo e aplicado na leitura. Em ~18 mil linhas é instantâneo e
-- não trava a fila enquanto roda.
--
-- ORDEM DE APLICAÇÃO (importante): esta migration vai ANTES do deploy do
-- frontend. A tela passa a pedir `retorno_prioritario` no select da carteira, e
-- pedir coluna que não existe faz o PostgREST recusar a consulta INTEIRA — a
-- fila abriria vazia, não "sem a marca".
-- =============================================================================

alter table public.alunos
  add column if not exists retorno_prioritario boolean not null default false;

comment on column public.alunos.retorno_prioritario is
  'Marcado pelo operador na tabulação: este retorno vem primeiro na fila e no bloco "Meu dia". Não é criticidade financeira (nivel_criticidade) nem prazo (data_retorno) -- é a escolha humana de prioridade. Limpo quando o retorno é tratado.';
