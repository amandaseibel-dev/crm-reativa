-- DESFAZ a versao 20260928180725 (conferencia "em aberto" na Efetividade 2026/2).
--
-- O QUE ELE FAZ: devolve carteira_2026_2_classificar() e
-- carteira_2026_2_competencia_detalhe() a forma de producao de 28/09/2026,
-- ANTES desta versao. Com isso o classificador volta a ignorar a conferencia e
-- os titulos conferidos voltam para "Em conferencia".
--
-- O QUE ELE NAO FAZ, DE PROPOSITO: nao derruba
-- public.titulo_conferido_em_aberto nem apaga uma linha dela. Aquilo e decisao
-- registrada da gestao, com autor, data e evidencia -- historico, nao lixo.
-- Sem PITR neste projeto, apagar seria irreversivel. A tabela parada nao
-- estorva ninguem: quem nao le, nao ve.
--
-- Tambem nao remove carteira_conferir_em_aberto nem
-- carteira_titulo_conferido_valido. Sem o classificador lendo, elas ficam
-- inertes; remover exigiria conferir dependencias por um ganho nenhum.
--
-- DEPOIS DE RODAR: o botao "Conferir em aberto" continua na tela, mas passa a
-- gravar sem efeito visivel na faixa. Se o rollback for definitivo, o PR que
-- publicou a tela tem de ser revertido junto -- senao a tela promete uma coisa
-- que o banco nao faz mais.
--
-- Para reconstruir o corpo anterior, o texto integral esta no ledger da versao
-- 20260927221825 (classificador e detalhe como estavam antes desta mudanca).

\echo 'Este rollback exige o corpo anterior das duas funcoes.'
\echo 'Copie de supabase/ledger/2026-09/, versao 20260927221825, e rode dentro de uma transacao:'
\echo '  begin;'
\echo '    create or replace function public.carteira_2026_2_classificar() ... (forma de 28/09)'
\echo '    create or replace function public.carteira_2026_2_competencia_detalhe(...) ... (forma de 28/09)'
\echo '    -- conferir a ACL ANTES do commit: classificador sem PUBLIC/anon/authenticated,'
\echo '    -- detalhe com authenticated e sem PUBLIC/anon'
\echo '  commit;'
\echo 'NAO derrube public.titulo_conferido_em_aberto: ela e historico da gestao.'
