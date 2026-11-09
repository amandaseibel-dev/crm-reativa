-- ============================================================================
-- ROLLBACK de 20261109150000_ulbra_central_operador
--
-- Par do artefato de 09/11/2026. Como o SQL original NAO FOI APLICADO, este
-- arquivo tambem nunca rodou.
--
-- SEGURO PORQUE SO DESFAZ O QUE NASCEU ALI: uma funcao nova, que nao substituiu
-- nenhuma de mesmo nome e da qual nenhum objeto do banco depende. Quem a chama
-- e a tela `CentralUlbra.jsx`, que trata a ausencia da funcao como "Central
-- ainda nao disponivel" -- sem lista vazia fingindo ser fila zerada.
--
-- O QUE SE PERDE AO RODAR: nada de dado. A funcao e so leitura. Os grants vivem
-- nela e caem com ela. A RPC gerencial `ulbra_painel_gestao()` NAO e tocada.
--
-- `drop` SEM `cascade`, de proposito: se algo passou a depender da funcao, o
-- rollback FALHA e mostra.
-- ============================================================================

begin;

drop function if exists public.ulbra_central_operador(text, integer, integer);

commit;
