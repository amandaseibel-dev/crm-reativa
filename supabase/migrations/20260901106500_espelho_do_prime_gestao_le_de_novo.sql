-- Correcao da 20260901106000: o `revoke all ... from authenticated` tirou o
-- SELECT da tabela, e sem privilegio de tabela a politica de RLS nao tem o que
-- liberar -- a gestao deixou de enxergar o espelho do Prime.
--
-- O desenho certo tem as DUAS camadas: a tabela concede SELECT a authenticated,
-- e a politica de RLS estreita esse SELECT para quem passa em usuario_e_gestao().
-- `anon` continua sem nada.

grant select on public.prime_extrato, public.prime_extrato_fila to authenticated;
revoke all on public.prime_extrato, public.prime_extrato_fila from anon;
