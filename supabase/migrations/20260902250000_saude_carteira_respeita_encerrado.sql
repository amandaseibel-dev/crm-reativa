-- A Saúde da Carteira passa a respeitar o encerramento que a fila já aplicou.
--
-- O PROBLEMA. `vw_saude_carteira` calculava `encerrado` SÓ pela regra de strings
-- de status (`caso_encerrado_operacional`), ignorando a coluna
-- `casos.encerrado_operacional` -- que é o flag que o cron
-- `casos_reavaliar_encerramento` (:30) grava e que a fila do operador respeita.
-- Duas verdades diferentes sobre a mesma coisa, e as telas discordavam.
--
-- MEDIDO EM 02/09/2026:
--   casos.encerrado_operacional = false  -> 12.575  (a fila)
--   mv_saude_carteira.encerrado = false  -> 13.241  (a Saúde da Carteira)
--   666 casos já fora da fila seguiam contando lá.
--
-- E NÃO ERA SÓ NÚMERO: a tela lista caso a caso. Desses 666, 540 apareciam no
-- recorte "sem acionamento", 173 em "críticos", 48 em "urgentes", 347 em "sem
-- responsável", espalhados por 10 operadores. Alguém clicando ia atrás de
-- trabalho que não existe.
--
-- O QUE SÃO: 472 dos 473 com dívida têm um caso GÊMEO ABERTO -- são a cópia
-- duplicada que a fusão aposentou, e a Saúde contava o mesmo aluno duas vezes,
-- inflando R$ 1.306.446,88. Mais 184 QUITADO de saldo zero e 9 de acordo. Sobra
-- 1 caso com dívida real e sem gêmeo aberto, para olhar individualmente.
--
-- A CORREÇÃO é conservadora: o que a fila fechou fica fechado, e a regra antiga
-- ainda pode fechar mais. Nada de dinheiro some -- some a contagem em dobro.
--
-- POR QUE A TROCA É FEITA POR `replace` E NÃO REESCREVENDO A VIEW: ela é longa,
-- e reescrever à mão arrisca alterar alguma outra expressão sem querer. O bloco
-- aborta se o texto procurado não existir mais.
do $$
declare
  v_def text;
  v_novo text;
  v_de  text := 'caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada) AS encerrado';
  v_para text := '(COALESCE(c.encerrado_operacional, false) OR caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)) AS encerrado';
begin
  v_def := pg_get_viewdef('public.vw_saude_carteira'::regclass, true);

  if position(v_de in v_def) = 0 then
    raise exception 'Texto da expressao `encerrado` nao encontrado em vw_saude_carteira. '
                    'A view mudou -- conferir antes de aplicar, para nao trocar nada errado.';
  end if;

  v_novo := replace(v_def, v_de, v_para);

  if v_novo = v_def then
    raise exception 'A substituicao nao alterou nada. Abortado.';
  end if;

  execute 'create or replace view public.vw_saude_carteira as ' || v_novo;
end $$;

-- A materialized view só enxerga a mudança depois de refazer.
refresh materialized view concurrently public.mv_saude_carteira;
update public.saude_carteira_mv_meta set atualizado_em = now() where id;
