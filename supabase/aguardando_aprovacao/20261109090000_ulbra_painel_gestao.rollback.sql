-- ============================================================================
-- ROLLBACK de 20261109090000_ulbra_painel_gestao
--
-- Par do artefato de 09/11/2026. Como o SQL original NAO FOI APLICADO, este
-- arquivo tambem nunca rodou.
--
-- SEGURO PORQUE SO DESFAZE O QUE NASCEU ALI: uma funcao nova, que nao
-- substituiu nenhuma de mesmo nome e da qual nenhum objeto do banco depende
-- (nenhuma view, trigger, policy ou outra funcao a referencia). Quem a chama e
-- a tela `PainelMensageriaUlbra.jsx`, que ja trata a ausencia da funcao como
-- "painel nao disponivel" -- sem erro silencioso, sem numero inventado.
--
-- O QUE SE PERDE AO RODAR: nada de dado. A funcao e so leitura; nao ha tabela,
-- sequencia, policy ou grant em outro objeto a desfazer. Os grants vivem na
-- propria funcao e caem com ela.
--
-- `drop` SEM `cascade`, de proposito: se algum objeto tiver passado a depender
-- da funcao depois da aplicacao, o rollback FALHA e mostra.
-- ============================================================================

begin;

drop function if exists public.ulbra_painel_gestao();

commit;
