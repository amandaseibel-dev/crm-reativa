-- GIRO: coluna propria para o evento administrativo, e o executor usando ela
--
-- NAO APLICADA. Depende de autorizacao expressa.
--
-- CORRIGE 20261016200000, QUE NAO PODE SER APLICADA. Aquela migration usava
-- `aluno_movimentacoes.lote_id` como identificador do giro. Nao da: `lote_id`
-- tem chave estrangeira para `acoes_massivas_lotes`, a tabela de lotes de ACAO
-- MASSIVA. Tentar aplicar o backfill com ela quebrou em producao em 16/10/2026,
-- e quebrou corretamente:
--
--   violates foreign key constraint "aluno_movimentacoes_lote_id_fkey"
--   Key (lote_id)=(437f434b-...) is not present in table "acoes_massivas_lotes"
--
-- A migration inteira reverteu, nada foi gravado, nada foi registrado. O erro
-- de origem foi inferir a semantica do campo pelo indice unico
-- `ux_aluno_mov_lote_aluno (lote_id, aluno_id)` sem conferir as constraints da
-- tabela. A saida errada seria criar uma linha em `acoes_massivas_lotes` para o
-- giro -- o giro passaria a contar como acao massiva nos relatorios de
-- penetracao e cobertura.
--
-- A SAIDA, decidida pela gestao em 16/10: coluna propria.
--   * `giro_simulacao_id uuid`, nula, aditiva -- metadata-only, instantanea
--     mesmo nas 237 mil linhas da tabela;
--   * indice unico PARCIAL `(giro_simulacao_id, aluno_id) where
--     giro_simulacao_id is not null` -- a idempotencia continua sendo garantia
--     do banco, nao convencao, e o indice so cobre as linhas de giro;
--   * `lote_id` fica como esta, significando o que sempre significou.
--
-- As migrations 20261016200000 e 20261016200500 ficam no repositorio porque a
-- catraca nao deixa alterar nem apagar migration que ja esta na base -- ver
-- 20261016200000_LEIA-ME-NAO-APLICAR.md ao lado delas. NENHUMA DAS DUAS FOI
-- APLICADA em producao.

-- ---------------------------------------------------------------------------
-- 1. A coluna e o indice
-- ---------------------------------------------------------------------------
alter table public.aluno_movimentacoes
  add column if not exists giro_simulacao_id uuid;

comment on column public.aluno_movimentacoes.giro_simulacao_id is
  'Identificador do giro de carteira (calibragem_simulacoes.id) que gerou este '
  'evento administrativo. Nulo em tudo que nao vem de giro. Nao confundir com '
  'lote_id, que e lote de ACAO MASSIVA e tem FK para acoes_massivas_lotes.';

create unique index if not exists ux_aluno_mov_giro_aluno
  on public.aluno_movimentacoes (giro_simulacao_id, aluno_id)
  where giro_simulacao_id is not null;

-- ---------------------------------------------------------------------------
-- 2. O executor grava o evento administrativo
-- ---------------------------------------------------------------------------
-- Patch ancorado. Trata os DOIS estados possiveis da funcao em producao:
--   a) ainda sem insert nenhum (o estado real hoje) -- acrescenta depois da
--      auditoria do lote;
--   b) ja com a versao errada, por lote_id (se um dia 20261016200000 for
--      aplicada por engano) -- troca o bloco inteiro pelo certo, em vez de
--      pular achando que ja esta feito.
do $mig$
declare
  v_def  text := pg_get_functiondef('public.giro_2026_10_executar_lote_impl(uuid,integer)'::regprocedure);
  v_anc  text := 'get diagnostics v_movidos = row_count;';
  v_ins  text;
  v_ini  int;
  v_fim  int;
begin
  if position('giro_simulacao_id' in v_def) > 0 then
    raise notice 'giro_2026_10_executar_lote_impl ja grava a movimentacao pela coluna propria; nada a fazer.';
    return;
  end if;

  -- O INSERT, igual nos dois caminhos.
  v_ins := '
  -- Evento administrativo na ficha do aluno. So troca real de responsavel, um
  -- por aluno, idempotente pelo indice unico (giro_simulacao_id, aluno_id).
  -- Nao e acionamento: ALTERACAO_OPERADOR esta fora de eh_tipo_acionamento.
  insert into public.aluno_movimentacoes(
      aluno_id, tipo, descricao,
      operador_anterior_nome, operador_anterior_email,
      operador_novo_nome, operador_novo_email,
      registrado_por_nome, registrado_por_email, registrado_em, giro_simulacao_id)
  select distinct on (c.aluno_id)
      c.aluno_id,
      ''ALTERACAO_OPERADOR'',
      ''Responsavel do aluno -> '' || coalesce(e.para_nome, ''(sem nome)'')
        || ''. Anterior: '' || coalesce(e.de_nome, ''Carteira geral / sem responsável anterior'')
        || ''. Motivo: Giro de carteira 2026/1 e 2026/2. Origem: giro '' || p_id::text || ''.'',
      e.de_nome, e.de_email, e.para_nome, e.para_email,
      ''Sistema'', ''sistema@reativaone'', now(), p_id
    from _slice e
    join public.casos c on c.id = e.caso_id
   where e.valido
     and e.para_email is not null
     and e.de_email is distinct from e.para_email
     and c.aluno_id is not null
   order by c.aluno_id, e.caso_id
  on conflict (giro_simulacao_id, aluno_id) where giro_simulacao_id is not null do nothing;';

  if position('aluno_movimentacoes' in v_def) > 0 then
    -- (b) tem a versao por lote_id: recorta o insert antigo e poe o novo.
    v_ini := position('  insert into public.aluno_movimentacoes(' in v_def);
    if v_ini = 0 then
      raise exception 'versao antiga do insert nao localizada em giro_2026_10_executar_lote_impl';
    end if;
    v_fim := position('do nothing;' in substr(v_def, v_ini));
    if v_fim = 0 then
      raise exception 'fim do insert antigo nao localizado em giro_2026_10_executar_lote_impl';
    end if;
    v_def := substr(v_def, 1, v_ini - 1)
          || ltrim(v_ins, E'\n')
          || substr(v_def, v_ini + v_fim + length('do nothing;') - 1);
    execute v_def;
    raise notice 'giro_2026_10_executar_lote_impl: insert por lote_id trocado pelo da coluna propria.';
    return;
  end if;

  -- (a) ainda nao grava nada: entra depois da auditoria do lote.
  if position(v_anc in v_def) = 0 then
    raise exception 'ancora nao encontrada em giro_2026_10_executar_lote_impl';
  end if;
  if (length(v_def) - length(replace(v_def, v_anc, ''))) / length(v_anc) <> 1 then
    raise exception 'ancora ambigua em giro_2026_10_executar_lote_impl';
  end if;
  execute replace(v_def, v_anc, v_anc || E'\n' || v_ins);
end $mig$;

comment on function public.giro_2026_10_executar_lote_impl(uuid, int) is
  'Aplica em lotes uma simulação GIRO_2026_10 APROVADA. Além de casos e '
  'calibragem_auditoria, grava o evento administrativo ALTERACAO_OPERADOR em '
  'aluno_movimentacoes quando o responsável muda de verdade — um por aluno, '
  'idempotente por (giro_simulacao_id, aluno_id), sem contar como acionamento.';
