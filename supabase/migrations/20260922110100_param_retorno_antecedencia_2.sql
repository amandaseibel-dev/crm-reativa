-- PARAMETRO retorno_antecedencia_dias 3 -> 2 (DATA-ONLY, REVERSIVEL) -- SINALIZADO NO PR.
--
-- recalcular_situacao_aluno usa este parametro para o lembrete/retorno automatico do ACORDO_EM_DIA (dia_util_anterior_ou_igual(prox_venc - N)).
-- Valor em producao lido em 21/09/2026: {"dias": 3}. Mudar para 2 desloca o data_retorno de ~465 alunos em dia na proxima recalculacao
-- de cada um (nao reprocessa a base sozinha). Nao ha DDL nem funcao alterada. Rollback restaura {"dias": 3}.
begin;
update public.calibragem_parametros set valor = '{"dias": 2}'::jsonb, atualizado_em = now(), atualizado_por = 'migration_20260922110100'
 where chave = 'retorno_antecedencia_dias' and valor = '{"dias": 3}'::jsonb;
commit;
