-- ROLLBACK de 20260922110100_param_retorno_antecedencia_2: devolve retorno_antecedencia_dias a {"dias": 3} (valor de producao em 21/09/2026).
begin;
update public.calibragem_parametros set valor = '{"dias": 3}'::jsonb, atualizado_em = now(), atualizado_por = 'rollback_20260922110100'
 where chave = 'retorno_antecedencia_dias' and valor = '{"dias": 2}'::jsonb;
commit;
