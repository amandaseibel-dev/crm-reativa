-- =============================================================================
-- DELTA: correcao dos limiares de faixa (comissao sobre HONORARIO)
-- =============================================================================
-- Politica confirmada (a partir de julho/2026), 4 faixas, base = honorario do mes:
--   Faixa 1: ate  R$ 38.000,00           = 4%   (m1=0,01)
--   Faixa 2: 38.000,01 a 45.000,00       = 8%   (m2=38.000,01)
--   Faixa 3: 45.000,01 a 60.000,00       = 9%   (m3=45.000,01)  <- absorve 52-60k
--   Faixa 4: acima de 60.000,00          = 9,5% (m4=60.000,01)
--   Amanda ADM (cobranca07): 8% fixo sobre honorarios (regra propria na funcao).
--
-- Config atual (2026-07) estava DESLOCADA: m2=45.000,01, m3=52.000,01. Corrige
-- SOMENTE m2 e m3; preserva m1, m4 e os percentuais (4/8/9/9,5). Nao cria 5a faixa.
-- Aplica a julho/2026 em diante; meses anteriores preservados.
-- Meses futuros: projecao_definir_meta recebe os limiares por parametro (sem
-- default hardcoded no backend); o frontend deve pre-preencher 38.000,01/45.000,01.
-- =============================================================================
update public.metas_projecao
   set m2_valor = 38000.01,
       m3_valor = 45000.01,
       m2_percentual = 8,
       m3_percentual = 9,
       m1_percentual = 4,
       m4_percentual = 9.5,
       atualizado_em = now()
 where mes_referencia >= '2026-07'
   and (m2_valor is distinct from 38000.01 or m3_valor is distinct from 45000.01
        or m2_percentual is distinct from 8 or m3_percentual is distinct from 9);
