-- O mutirão cadastral do Prime passa a rodar só aos domingos.
--
-- POR QUE. Ele estava em `*/2 * * * *` -- a cada dois minutos, o dia inteiro.
-- São 720 execuções por dia de 60 alunos, 43.200 consultas, numa base elegível
-- de 17.402 alunos: duas voltas e meia por dia, todo dia.
--
-- O que isso rendia, medido em 02/09/2026 (contatos novos por dia):
--
--     24/08  22.695   <- carga inicial
--     26/08   6.408
--     27/08     526
--     28/08     542
--     31/08   2.509
--     01/09       5
--     02/09       2
--
-- E contratos: 2 novos em 30 dias, de 60.406. Em regime são 43.200 chamadas
-- para achar de duas a cinco novidades -- uma a cada dez mil consultas.
-- Nome, telefone, e-mail e contrato mudam devagar; não precisam disso.
--
-- Domingo inteiro dá as mesmas 720 execuções, ou seja duas voltas e meia na
-- base num dia só. A cobertura semanal continua completa.
--
-- O QUE NÃO MUDA, DE PROPÓSITO: `prime_extrato_mutirao` (*/2) e
-- `prime_portador_mutirao` (*/3). Esses trazem pagamento e portador -- é
-- dinheiro, e é o que sustenta a confirmação de baixa. Ali a frescura importa.
--
-- GANHO DE TABELA. Os três mutirões dividem a mesma fila do `pg_net`, e cada
-- invocação do cadastral reserva 300s de timeout. Com ele fora do caminho seis
-- dias por semana, qualquer consulta avulsa ao Prime volta a responder em
-- segundos em vez de esperar de três a cinco minutos na fila.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'prime_cadastro_mutirao'),
  schedule => '*/2 * * * 0'
);
