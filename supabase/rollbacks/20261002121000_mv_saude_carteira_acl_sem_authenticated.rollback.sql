-- Rollback de supabase/migrations/20261002121000_mv_saude_carteira_acl_sem_authenticated.sql
--
-- ESTE ROLLBACK NAO DESFAZ O REVOKE, DE PROPOSITO.
--
-- Desfazer seria `grant all on public.mv_saude_carteira to authenticated`, que
-- e exatamente o buraco que a migration fechou: SELECT direto na matview
-- entrega a carteira INTEIRA, de todos os operadores, a qualquer usuario
-- autenticado, contornando o `saude_carteira_escopo` das RPCs SECURITY
-- DEFINER. Nao existe cenario em que reabrir isso seja o comportamento
-- desejado, e um rollback nao deve ser uma porta para reintroduzir uma falha
-- de autorizacao.
--
-- O estado seguro esperado e, portanto, o MESMO antes e depois deste arquivo:
-- `authenticated` sem privilegio direto na matview, `service_role` lendo (as
-- RPCs dependem disso). A asercao abaixo garante que rodar este rollback nunca
-- deixa o banco num estado inseguro -- se alguem tiver reconcedido o
-- privilegio por fora, o arquivo falha alto em vez de passar em silencio.
--
-- O que ESTE arquivo cobre e so a ACL. A migration 20261002120000 (cobertura de
-- 10 dias) tem rollback proprio; se aquele for rodado, ele recria a matview e o
-- default privilege de `public` reconcede tudo a `authenticated` -- nesse caso
-- reaplique a migration 20261002121000, nao este arquivo.

do $$
begin
  if has_table_privilege('authenticated', 'public.mv_saude_carteira', 'SELECT') then
    raise exception
      'mv_saude_carteira esta legivel por authenticated. O estado seguro exige o revoke: '
      'reaplique supabase/migrations/20261002121000_mv_saude_carteira_acl_sem_authenticated.sql';
  end if;
end $$;
