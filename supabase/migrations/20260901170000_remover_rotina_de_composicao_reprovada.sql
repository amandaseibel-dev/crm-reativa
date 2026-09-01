-- A rotina `composicao_acordo_aplicar` vinculava TODAS as mensalidades abertas
-- ao unico acordo ativo do aluno. O criterio veio de uma medicao correta -- nos
-- 825 acordos de composicao conhecida, quem registrou pegou todas em 96,8% --
-- mas aplicado ao conjunto errado.
--
-- REPROVADA no teste de 100 alunos em 01/09. A distribuicao do que ela produziu
-- nao se parece com o que uma pessoa confirma:
--
--                          acordo >= mensalidades   acordo < 70%   acordo < metade
--   gabarito (humano)              38,0%               20,2%           5,3%
--   lote da rotina                 21,0%               58,0%          36,0%
--
-- O caso que explicou tudo foi a Manuela Agliardi Camargo: o acordo dela e das
-- mensalidades de set a dez/2025, que JA SAIRAM da base; as 4 que estavam
-- abertas vencem de marco a junho/2026 e sao divida NOVA, posterior ao acordo.
-- A rotina teria escondido R$ 77.471,78 de divida viva so nela, e R$ 642.247,77
-- no lote inteiro. Tudo foi revertido.
--
-- Regra que ficou, dita pela Amanda: "essas mensalidades soltas, se tiverem no
-- portador reativa, sao mensalidades devidas". As da Manuela estao no portador
-- 195 (ReATIVA Recuperacao de Credito) -- sao devidas mesmo.
--
-- `composicao_acordo_pendentes` continua: e so leitura, lista os casos e a
-- evidencia para conferencia humana. Nao escreve nada.

drop function if exists public.composicao_acordo_aplicar(boolean, int);
drop function if exists public.composicao_acordo_aplicar(boolean);
