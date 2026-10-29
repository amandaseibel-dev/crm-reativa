-- O portador volta, uma volta completa por semana, no sábado de madrugada.
--
-- Substitui a pausa da 20260902210000 no que toca ao portador. O extrato
-- continua pausado.
--
-- POR QUE O PORTADOR VOLTA. É a única fonte de
-- `relatorio_mensalidades_2026_1_sem_negociacao` além de `acordos_titulos`, e
-- é ele que tira do relatório quem negociou direto com a Ulbra sem passar pelo
-- CRM (balde 166). Sem ele o relatório mostra como "sem negociação" quem já
-- negociou. Com a lista congelada não quebra -- envelhece calado, que é pior.
--
-- POR QUE O EXTRATO NÃO VOLTA. Conferido no corpo das funções: o relatório usa
-- `prime_portador_membro` e `acordos_titulos`, e NÃO toca em `prime_extrato`.
-- Somado a `prime_extrato_fila` com 0 pendentes desde 01/09, não tem consumidor
-- nem trabalho.
--
-- POR QUE UMA JANELA, E NÃO UM HORÁRIO. Erro que quase entrou aqui: agendar
-- `0 1 * * 6`, um disparo só. Não funciona. A lista tem 67.048 itens (40.509 no
-- 195 e 26.539 no 166) e a Edge Function morre aos 150s -- não cabe. A varredura
-- lê o que dá em ~110s, grava onde parou em `prime_sync_cursor` e devolve; o
-- modo de uso é chamar de novo até `concluido: true`.
--
-- E meia varredura não é lista velha, é lista ERRADA: a limpeza de quem SAIU do
-- portador (quitou, não está em balde nenhum) só roda no FIM do ciclo,
-- comparando o carimbo de tempo. Ciclo interrompido nunca remove ninguém, e o
-- relatório passa a cobrar quem já pagou.
--
-- Medido em 02/09/2026: um ciclo completo leva de 13 a 25 minutos nessa cadência
-- (ciclo 108 do carrier 166 levou 12:48; o 73 do 195, 25:06), ou seja de 5 a 9
-- disparos. A janela `*/3 0-1` dá 40. Folga de sobra, e termina às 02:00 -- 50
-- minutos antes do snapshot das 02:50.
--
-- POR QUE SÁBADO, E NÃO DOMINGO. O mutirão cadastral roda `*/2 * * * 0`, ou
-- seja TODAS as horas de domingo, inclusive 00:00-01:59. Os dois dividem a mesma
-- fila do `pg_net` e cada invocação do cadastral reserva 300s de timeout: no
-- mesmo dia, o cadastro atropelaria a janela do portador e deixaria o ciclo pela
-- metade -- exatamente o caso "lista errada" acima. Um em cada dia do fim de
-- semana, sem cruzar.
--
-- O CORTE. De ~480 disparos/dia (*/3 o dia inteiro, ~13 voltas completas,
-- ~4.400 requisições à API) para 40 disparos e 1 volta por semana.
select cron.alter_job(
  (select jobid from cron.job where jobname='prime_portador_mutirao'),
  schedule => '*/3 0-1 * * 6',
  active   => true
);
