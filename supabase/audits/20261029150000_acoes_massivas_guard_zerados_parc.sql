-- VERIFICAÇÃO PÓS-APPLY — 20261029150000_acoes_massivas_guard_zerados_parc
-- Executar no SQL Editor do Supabase APÓS aplicar a migration.
-- Ambas as queries devem confirmar os números esperados antes de liberar
-- ACORDOS_VENCIDOS e MENSALIDADES_E_ACORDOS.

-- -------------------------------------------------------- query 1
-- Conta o universo novo e os excluídos pelo guard.
-- Esperado: universo_novo ≈ 13.718, so_parc_zerado_excluido ≈ 75
WITH pre AS (
  SELECT aluno_id, via_tit FROM (
    SELECT aluno_id, TRUE  AS via_tit FROM acordos_titulos
     WHERE upper(coalesce(situacao,'')) IN ('ABERTO','NEGOCIADO')
       AND coalesce(lower(status),'') <> 'quitada'
       AND coalesce(tipo_boleto,'') <> 'Acordo'
       AND coalesce(valor_cobranca_ajustado,saldo_corrigido,valor_em_aberto,valor_original,0) > 0
    UNION ALL
    SELECT a.aluno_id, FALSE AS via_tit
      FROM acordos a JOIN parcelas p ON p.acordo_id = a.id
     WHERE a.status = 'ATIVO' AND p.status = 'VENCIDA' AND p.vencimento IS NOT NULL
  ) x
)
SELECT
  count(DISTINCT aluno_id)                                       AS universo_novo,
  count(DISTINCT aluno_id) FILTER (WHERE NOT via_tit)            AS so_parc,
  count(DISTINCT aluno_id) FILTER (WHERE NOT via_tit
    AND coalesce((SELECT max(c.total_em_aberto) FROM casos c WHERE c.aluno_id = pre.aluno_id),0) = 0
  ) AS so_parc_zerado_excluido
FROM pre;

-- -------------------------------------------------------- query 2
-- Confirma que os 75 NÃO aparecem no universo após o guard.
-- Esperado: zerados_ainda_no_universo = 0
WITH zerados AS (
  SELECT DISTINCT a.aluno_id
  FROM acordos a JOIN parcelas p ON p.acordo_id = a.id
  JOIN casos c ON c.aluno_id = a.aluno_id
  WHERE a.status = 'ATIVO' AND p.status = 'VENCIDA'
    AND coalesce(c.total_em_aberto, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM acordos_titulos t
      WHERE t.aluno_id = a.aluno_id
        AND upper(coalesce(t.situacao,'')) IN ('ABERTO','NEGOCIADO')
        AND coalesce(lower(t.status),'') <> 'quitada'
        AND coalesce(t.tipo_boleto,'') <> 'Acordo'
        AND coalesce(valor_cobranca_ajustado,saldo_corrigido,valor_em_aberto,valor_original,0) > 0
    )
)
SELECT count(*) AS zerados_ainda_no_universo
FROM zerados z
WHERE EXISTS (
  SELECT 1 FROM acoes_massivas_universo('{}') u WHERE u.aluno_id = z.aluno_id
);
