-- ROLLBACK de 20261027120001_mensalidades_ausentes_inserir.sql
-- 27/10/2026 · NAO EXECUTAR sem autorizacao expressa da Amanda.
--
-- A migration cria UMA funcao e nao escreve dado nenhum (so INSERT dentro do
-- corpo, que a migration nao executa). PITR nao esta habilitado: a reversa e
-- por objeto nomeado (memoria `pitr-nao-habilitado-rollback-nao-e-restore`).
--
-- NAO DESFAZ o que a RPC tiver inserido se ela JA foi executada com
-- `p_dry_run = false`. Nesse caso os titulos inseridos tem
-- `observacao = 'Mensalidade ausente incluida pelo lote <lote>'` e
-- `importacao_id` nulo -- e a reversa daquilo e backup + SQL por id, decidida
-- caso a caso, nunca este arquivo.

begin;

set local lock_timeout = '3s';

drop function if exists public.mensalidades_ausentes_inserir(jsonb, text, boolean);

do $prova$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'mensalidades_ausentes_inserir') then
    raise exception 'PROVA DA REVERSA: sobrou mensalidades_ausentes_inserir';
  end if;
  -- a protecao NAO e desta migration e tem de continuar de pe
  if not exists (select 1 from pg_class where relname = 'ux_acordos_titulos_documento_norm') then
    raise exception 'PROVA DA REVERSA: o indice unico da protecao desapareceu -- ele NAO e desta migration';
  end if;
end $prova$;

commit;
