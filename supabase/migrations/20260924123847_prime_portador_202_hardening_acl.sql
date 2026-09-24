-- Menor privilegio na infraestrutura do portador 202 que JA ESTA EM PRODUCAO.
--
-- Migration SEPARADA de proposito. As migrations que criaram estes objetos ja
-- foram aplicadas; reescreve-las para "fingir que os REVOKEs sempre existiram"
-- deixaria o historico mentindo sobre o que rodou em producao. O hardening e
-- um fato datado e entra como tal.
--
-- DE ONDE VEM O EXCESSO. O schema `public` deste projeto tem default
-- privileges que concedem EXECUTE a `authenticated`, e a ACL padrao de uma
-- funcao nova ja inclui PUBLIC. Ou seja: ninguem decidiu abrir estas funcoes
-- -- elas nasceram abertas. Medido em 24/09/2026:
--
--   prime_portador_202_coletar      PUBLIC, anon, authenticated, service_role, postgres
--   prime_aluno_no_juridico         PUBLIC, anon, authenticated, service_role, postgres
--   prime_portador_snapshot_estado  PUBLIC, anon, authenticated, service_role, postgres
--   _prime_portador_202_auditar     authenticated, service_role, postgres
--
-- POR QUE REVOGAR NAO QUEBRA AS CHAMADAS INTERNAS. Levantamento de
-- dependencias feito NO BANCO (pg_proc, cron.job, views, triggers), nao por
-- busca textual:
--
--   _prime_portador_202_auditar    <- _disparar, _coletar, _conferir_ciclo, _rotina
--   _prime_portador_202_disparar   <- _coletar, _coletar_admin, _rotina
--   prime_portador_snapshot_estado <- _disparar, aluno_no_juridico, _coletar, _conferir_ciclo
--   prime_aluno_no_juridico        <- ninguem
--   prime_portador_202_coletar     <- ninguem
--
-- TODAS as chamadoras sao SECURITY DEFINER com owner `postgres`, e em
-- SECURITY DEFINER o EXECUTE da funcao interna e verificado contra o OWNER,
-- nao contra quem iniciou a chamada. Por isso `postgres` e mantido em todas e
-- nenhuma cadeia se rompe. A unica INVOKER do conjunto,
-- `prime_portador_202_coletar_admin`, so e executavel por postgres -- entao
-- tambem resolve o nucleo como postgres.
--
-- Frontend, Edge Functions e crons foram conferidos: nenhum consumidor.
--
-- `service_role` E MANTIDO nas quatro. E o papel das rotinas server-side e das
-- Edge Functions; manter custa nada e evita quebrar um caminho legitimo que
-- venha a existir sem passar por postgres. `authenticated` sai porque hoje nao
-- ha caso de uso -- quando houver tela, entra um GRANT explicito, decidido.

-- 1) O porteiro da aplicacao. Nenhum consumidor: nem front, nem Edge, nem
--    cron, nem outra funcao. O disparo real acontece por
--    `prime_portador_202_coletar_admin` (postgres) ou pela rotina do cron.
revoke all on function public.prime_portador_202_coletar(boolean) from public;
revoke all on function public.prime_portador_202_coletar(boolean) from anon;
revoke all on function public.prime_portador_202_coletar(boolean) from authenticated;
grant execute on function public.prime_portador_202_coletar(boolean) to postgres, service_role;

-- 2) Auxiliar de auditoria: so funcoes internas a chamam.
revoke all on function public._prime_portador_202_auditar(text, text, text, bigint, jsonb) from authenticated;
grant execute on function public._prime_portador_202_auditar(text, text, text, bigint, jsonb) to postgres, service_role;

-- 2b) O nucleo. Hoje `service_role` aparece na ACL dele por DEFAULT PRIVILEGE
--     do schema, nao por declaracao -- o que significa que uma mudanca no
--     default o removeria silenciosamente. Passa a ser explicito.
grant execute on function public._prime_portador_202_disparar(text, boolean) to postgres, service_role;

-- 3) A resposta sobre a condicao juridica. Sem consumidor hoje; quando a tela
--    existir, o GRANT sera explicito -- e ai tambem entra a trava de 24h, que
--    hoje NAO existe (ver prime-mapa-identificadores.md).
revoke all on function public.prime_aluno_no_juridico(text) from public;
revoke all on function public.prime_aluno_no_juridico(text) from anon;
revoke all on function public.prime_aluno_no_juridico(text) from authenticated;
grant execute on function public.prime_aluno_no_juridico(text) to postgres, service_role;

-- 4) Estado do snapshot: quatro chamadoras internas, nenhum consumidor externo.
revoke all on function public.prime_portador_snapshot_estado(integer, integer) from public;
revoke all on function public.prime_portador_snapshot_estado(integer, integer) from anon;
revoke all on function public.prime_portador_snapshot_estado(integer, integer) from authenticated;
grant execute on function public.prime_portador_snapshot_estado(integer, integer) to postgres, service_role;
