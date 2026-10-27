-- BACKFILL: o evento administrativo do giro de 16/10/2026 na ficha do aluno
--
-- NAO APLICADA. Depende de autorizacao expressa.
--
-- Cria os registros de transferencia que faltaram na ficha do aluno para o giro
-- ja executado (simulacao 437f434b-e781-4357-a5ef-3fcd8e9d4770). O executor so
-- passa a gravar sozinho a partir da migration irma
-- 20261016200000_giro_executor_grava_movimentacao_administrativa.sql; esta aqui
-- cobre o que ja aconteceu.
--
-- SO INSERE. Nenhum update, nenhum delete, nenhuma linha existente alterada --
-- nem as de REDISTRIBUICAO_SINCRONIZACAO que o gatilho gravou, nem as de
-- historico_operadores_alunos, nem a auditoria. O giro em si fica intocado:
-- nao mexe em casos, responsaveis, saldos, titulos, acordos nem na fidelizacao.
--
-- FONTE UNICA: public.calibragem_auditoria daquela simulacao. Nada e inferido
-- do estado atual da base.
--
-- A REGRA DE SELECAO, e por que ela e inequivoca (medido em 16/10):
--
--   * so linhas `MOVIMENTACAO_NIVELAMENTO`. Os 3.665 alunos com troca real
--     estao TODOS cobertos por elas; nenhum aluno aparece so com
--     `PULADO_NIVELAMENTO` (medido: 0). As linhas PULADO sao de fichas irmas
--     que ja tinham recebido o responsavel pelo gatilho de sincronia -- a
--     transferencia daquele aluno ja esta representada pela linha movida.
--   * so `operador_anterior_email is distinct from operador_novo_email`. Isso
--     deixa de fora os 143 alunos que ja eram do mesmo operador: transferencia
--     ficticia nao entra.
--   * `distinct on (aluno_id)` ordenado por `registrado_em, caso_id`: UM
--     registro por aluno, com a data ORIGINAL da transferencia. Aluno com mais
--     de uma ficha (102 casos) gera uma linha so -- e as fichas do mesmo aluno
--     concordam na origem e no destino (medido: 0 alunos com dois operadores
--     anteriores diferentes, 0 com dois destinos diferentes), entao qualquer
--     uma serviria; a ordenacao existe para o resultado ser deterministico.
--   * `aluno_id is not null`: medido, nenhuma linha da auditoria tem aluno nulo.
--
-- IDEMPOTENCIA: `lote_id` recebe o proprio simulacao_id e o indice unico
-- parcial `ux_aluno_mov_lote_aluno (lote_id, aluno_id) where lote_id is not
-- null` garante um registro por aluno por giro. Rodar duas vezes nao duplica --
-- a segunda nao insere nada.
--
-- NAO E ACIONAMENTO: `ALTERACAO_OPERADOR` esta fora de eh_tipo_acionamento
-- (conferido ao vivo), entao o gatilho fn_atualizar_ultimo_acionamento nao
-- escreve data_ultimo_acionamento -- nao mexe em ultimo contato, nao renova a
-- fidelizacao ate 26/10, nao cria retorno e nao entra em produtividade.
--
-- ESPERADO: 3.665 linhas inseridas, uma por aluno distinto.

do $mig$
declare
  v_sim    uuid := '437f434b-e781-4357-a5ef-3fcd8e9d4770';
  v_antes  int;
  v_depois int;
  v_alunos int;
  v_esperado int;
begin
  select count(*) into v_antes
    from public.aluno_movimentacoes where lote_id = v_sim;

  -- Quantos alunos a auditoria manda registrar, pela mesma regra do insert.
  select count(distinct a.aluno_id) into v_esperado
    from public.calibragem_auditoria a
   where a.simulacao_id = v_sim
     and a.evento = 'MOVIMENTACAO_NIVELAMENTO'
     and a.operador_anterior_email is distinct from a.operador_novo_email
     and a.aluno_id is not null;

  insert into public.aluno_movimentacoes(
      aluno_id, tipo, descricao,
      operador_anterior_nome, operador_anterior_email,
      operador_novo_nome, operador_novo_email,
      registrado_por_nome, registrado_por_email, registrado_em, lote_id)
  select distinct on (a.aluno_id)
      a.aluno_id,
      'ALTERACAO_OPERADOR',
      'Responsavel do aluno -> ' || coalesce(a.operador_novo_nome, '(sem nome)')
        || '. Anterior: ' || coalesce(a.operador_anterior_nome, 'Carteira geral / sem responsável anterior')
        || '. Motivo: Giro de carteira 2026/1 e 2026/2. Origem: giro ' || v_sim::text || '.',
      a.operador_anterior_nome, a.operador_anterior_email,
      a.operador_novo_nome, a.operador_novo_email,
      'Sistema', 'sistema@reativaone',
      a.registrado_em,            -- a data ORIGINAL da transferencia
      v_sim
    from public.calibragem_auditoria a
   where a.simulacao_id = v_sim
     and a.evento = 'MOVIMENTACAO_NIVELAMENTO'
     and a.operador_anterior_email is distinct from a.operador_novo_email
     and a.aluno_id is not null
   order by a.aluno_id, a.registrado_em, a.caso_id
  on conflict (lote_id, aluno_id) where lote_id is not null do nothing;

  select count(*), count(distinct aluno_id) into v_depois, v_alunos
    from public.aluno_movimentacoes where lote_id = v_sim;

  raise notice 'Backfill do giro %: antes % linhas, depois % linhas, % alunos distintos (esperado %).',
    v_sim, v_antes, v_depois, v_alunos, v_esperado;

  -- Uma linha por aluno, sempre. O indice unico ja garante; esta checagem
  -- existe para a migration FALHAR alto se algum dia ele sumir.
  if v_depois <> v_alunos then
    raise exception 'Backfill do giro %: % linhas para % alunos -- ha duplicidade.',
      v_sim, v_depois, v_alunos;
  end if;

  -- O resultado tem de bater com o que a auditoria manda, nem mais nem menos.
  if v_depois <> v_esperado then
    raise exception 'Backfill do giro %: % linhas gravadas contra % esperadas pela auditoria.',
      v_sim, v_depois, v_esperado;
  end if;
end $mig$;
