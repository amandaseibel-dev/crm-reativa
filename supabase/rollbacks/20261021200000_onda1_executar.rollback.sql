-- ROLLBACK de 20261021200000_onda1_executar.sql
--
-- O QUE REVERTER FAZ, E O QUE NÃO FAZ:
--
--   FAZ:     apaga as três funções (onda1_conferir, onda1_executar, onda1_reverter).
--   NÃO FAZ: não desmove nenhum aluno. Se a Onda 1 já tiver sido executada,
--            APAGAR A FUNÇÃO NÃO DESFAZ A EXECUÇÃO -- ela some e você perde o
--            reversor junto.
--
-- ORDEM OBRIGATÓRIA, EM LETRAS MAIÚSCULAS:
--
--   SE A SIMULAÇÃO ESTIVER 'EXECUTADA' E VOCÊ QUISER O ESTADO ANTERIOR,
--   RODE `select public.onda1_reverter('<id>')` PRIMEIRO E CONFIRME
--   status = 'REVERTIDA'. SÓ DEPOIS APLIQUE ESTE ROLLBACK.
--
-- Conferir antes:
--   select id, status, executado_em from public.calibragem_simulacoes
--    where resultado->>'metrica' = 'ONDA1_LOTE_A';
--
-- A TRILHA FICA. As linhas de public.calibragem_auditoria com
-- evento in ('MOVIMENTACAO_ONDA1','REVERSAO_ONDA1','PULADO_REVERSAO_ONDA1')
-- NÃO são apagadas, de propósito: a tabela é append-only por gatilho e apagar
-- destruiria o registro individual de uma decisão da gestão. Se as funções forem
-- recriadas depois, o reversor volta a encontrar a trilha e funciona.
--
-- ZERO DML sobre casos, acordos, alunos ou parcelas nos dois sentidos.

drop function if exists public.onda1_reverter(uuid);
drop function if exists public.onda1_executar(uuid);
drop function if exists public.onda1_conferir(uuid);
