-- ROLLBACK de 20261007193000_efetividade_composicao_academica_e_pendencias.sql
--
-- A migration e SO DDL e SO LEITURA: cinco funcoes novas, nenhuma tabela,
-- nenhum gatilho, nenhum dado escrito. Nao ha dado a restaurar -- derrubar as
-- cinco devolve o banco ao estado anterior, byte a byte no que importa.
--
-- O QUE NAO FOI TOCADO, e portanto nao precisa de reversao:
--   carteira_safra_situacoes, carteira_2026_1_indicadores,
--   carteira_2026_1_classificar, carteira_saldo_historico_por_ano,
--   carteira_2026_2_*, carteira_academico_perfil*, casos_pendentes_contar.
--
-- EFEITO NA TELA depois do rollback: a Efetividade perde o bloco de composicao
-- academica do saldo e o de Pendencias de validacao (os componentes tratam erro
-- de RPC e mostram o aviso, sem derrubar a pagina), e a Fila Unica fica sem a
-- aba de pendencias por safra. As seis linhas, os indicadores da carteira e o
-- fluxo de EM_CONFIRMACAO seguem inteiros -- nenhum deles depende destas
-- funcoes.
--
-- A ordem importa: as tres funcoes de consulta chamam as duas do catalogo.

drop function if exists public.carteira_pendencias_itens(text, text, text, integer, integer);
drop function if exists public.carteira_pendencias_por_motivo(text, text);
drop function if exists public.carteira_em_aberto_por_status_academico(text, text);
drop function if exists public.carteira_pendencia_acao(text);
drop function if exists public.carteira_pendencia_rotulo(text);
