-- ONDA 1 · FECHA `onda1_simular` PARA QUEM NÃO FEZ LOGIN.
--
-- O QUE ACONTECEU
--
-- `onda1_simular(jsonb)` foi aplicada em 21/10/2026 (versão 20261021172255) e
-- nasceu com a ACL `=X/postgres|postgres=X/...`. Aquele `=X` inicial é PUBLIC
-- com EXECUTE -- a herança que TODA função nova recebe do Postgres. Não foi um
-- `grant` escrito por engano: é o padrão da linguagem, e é a mesma causa raiz da
-- P1 de hoje de manhã (20261020223151).
--
-- Conferido logo depois de aplicar, contra as três funções irmãs:
--
--   calibragem_simular              anon alcança? NÃO
--   calibragem_simular_nivelamento  anon alcança? NÃO
--   giro_2026_10_simular            anon alcança? NÃO
--   onda1_simular                   anon alcança? SIM   <- fora do padrão
--
-- O QUE NÃO ESTAVA EM RISCO, DITO COM PRECISÃO
--
-- O dado não vazava. A função tem portão interno (`calibragem_e_gestao()`) e
-- recusa com 42501 quem não é da gestão; uma chamada `anon` pelo PostgREST cai
-- nesse portão. O problema é de SUPERFÍCIE, não de vazamento: uma função
-- SECURITY DEFINER alcançável sem login é uma porta a mais para sondar, e o
-- padrão da casa é não deixá-la aberta.
--
-- PADRÃO DA CASA, repetido aqui porque já foi violado uma vez: restringir é
-- `revoke` de PUBLIC/anon ou portão interno, NUNCA `revoke` de `authenticated`
-- -- isso derrubaria a tela para a própria gestão. Há teste que proíbe
-- exatamente isso.
--
-- SÓ PRIVILÉGIO: 2 revoke e 2 grant. Zero DML, zero DDL de objeto. A lógica, os
-- parâmetros e o resultado da simulação ficam idênticos -- o corpo da função
-- não é tocado, e há teste que confere isso por md5(prosrc).
--
-- Reversível: supabase/rollbacks/20261021190000_*.rollback.sql

revoke all on function public.onda1_simular(jsonb) from public;
revoke all on function public.onda1_simular(jsonb) from anon;

grant execute on function public.onda1_simular(jsonb) to authenticated;
grant execute on function public.onda1_simular(jsonb) to service_role;
