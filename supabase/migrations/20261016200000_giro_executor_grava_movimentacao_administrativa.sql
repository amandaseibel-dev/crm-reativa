-- GIRO: o executor passa a gravar o evento administrativo na ficha do aluno
--
-- NAO APLICADA. Depende de autorizacao expressa.
--
-- O PROBLEMA, medido em producao em 16/10/2026 depois do giro. O executor
-- `giro_2026_10_executar_lote_impl` grava a troca de dono em TRES lugares --
-- `casos`, `calibragem_auditoria` e, por gatilho de sincronia, `alunos` -- mas
-- nunca em `aluno_movimentacoes`, que e a tabela que a ficha do aluno le.
-- Resultado: a transferencia nao aparece como movimentacao administrativa. O
-- que o operador ve na ficha e a linha do gatilho de sincronia,
-- `REDISTRIBUICAO_SINCRONIZACAO`, com a descricao "Sincronizacao automatica em
-- tempo real (gatilho)" -- e em 2.644 das 3.792 linhas daquele dia ela nem traz
-- o operador anterior. Nao diz de quem o aluno veio, nem por que, nem que houve
-- um giro.
--
-- O QUE ESTA MIGRATION FAZ: um patch ancorado no executor, acrescentando um
-- INSERT em `aluno_movimentacoes` logo depois da auditoria de cada lote. Nada
-- mais. Nao toca na distribuicao, no universo, na fidelizacao, no teto nem em
-- qualquer regra do giro.
--
-- AS QUATRO GARANTIAS, e por que cada uma vale:
--
--   1. SO QUANDO O RESPONSAVEL MUDA DE VERDADE. A clausula
--      `e.de_email is distinct from e.para_email` deixa de fora quem ja era do
--      operador -- no giro de 16/10 seriam 143 alunos. Transferencia ficticia
--      nao entra no historico.
--   2. UM REGISTRO POR ALUNO. `distinct on (c.aluno_id)` dentro do lote, e o
--      indice unico parcial `ux_aluno_mov_lote_aluno (lote_id, aluno_id) where
--      lote_id is not null` entre lotes. Aluno com mais de uma ficha gera UMA
--      linha, nao uma por ficha.
--   3. IDEMPOTENCIA PELO IDENTIFICADOR DO GIRO. `lote_id = p_id` (o
--      simulacao_id) mais `on conflict ... do nothing`: reexecutar um lote, ou
--      o giro inteiro, nao duplica nada.
--   4. NAO E ACIONAMENTO. O tipo `ALTERACAO_OPERADOR` ja existe (1.122 linhas
--      em producao) e `public.eh_tipo_acionamento('ALTERACAO_OPERADOR')` e
--      FALSE -- conferido ao vivo --, entao o gatilho
--      `fn_atualizar_ultimo_acionamento` nao escreve `data_ultimo_acionamento`.
--      Nao mexe em ultimo contato, nao renova fidelizacao, nao cria retorno e
--      nao entra em produtividade: o tipo ja esta na lista do que fica FORA de
--      TIPOS_ACIONAMENTO_INDIVIDUAL (src/utils/carteiraAcionada.js, decisao da
--      gestao de 29/09/2026).
--
-- OS OUTROS DOIS GATILHOS da tabela foram conferidos e nao reagem a este tipo:
-- `sincronizar_elogio_da_movimentacao` so olha campos de elogio e
-- `_trg_desfazer_cartao_tabulacao` nao cita ALTERACAO_OPERADOR.
--
-- O BACKFILL do giro de 16/10 e outra migration, de proposito:
-- 20261016200500_giro_2026_10_backfill_movimentacao_administrativa.sql.

do $mig$
declare
  v_def text := pg_get_functiondef('public.giro_2026_10_executar_lote_impl(uuid,integer)'::regprocedure);
  v_ancora text := 'get diagnostics v_movidos = row_count;';
  v_novo text;
begin
  if position('aluno_movimentacoes' in v_def) > 0 then
    raise notice 'giro_2026_10_executar_lote_impl ja grava a movimentacao; nada a fazer.';
    return;
  end if;
  if position(v_ancora in v_def) = 0 then
    raise exception 'ancora nao encontrada em giro_2026_10_executar_lote_impl';
  end if;
  if (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 then
    raise exception 'ancora ambigua em giro_2026_10_executar_lote_impl';
  end if;

  v_novo := v_ancora || '

  -- Evento administrativo na ficha do aluno. So troca real de responsavel, um
  -- por aluno, idempotente pelo indice unico (lote_id, aluno_id). Nao e
  -- acionamento: ALTERACAO_OPERADOR esta fora de eh_tipo_acionamento.
  insert into public.aluno_movimentacoes(
      aluno_id, tipo, descricao,
      operador_anterior_nome, operador_anterior_email,
      operador_novo_nome, operador_novo_email,
      registrado_por_nome, registrado_por_email, registrado_em, lote_id)
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
  on conflict (lote_id, aluno_id) where lote_id is not null do nothing;';

  execute replace(v_def, v_ancora, v_novo);
end $mig$;

comment on function public.giro_2026_10_executar_lote_impl(uuid, int) is
  'Aplica em lotes uma simulação GIRO_2026_10 APROVADA. Além de casos e '
  'calibragem_auditoria, grava o evento administrativo ALTERACAO_OPERADOR em '
  'aluno_movimentacoes quando o responsável muda de verdade — um por aluno, '
  'idempotente por (lote_id, aluno_id), sem contar como acionamento.';
