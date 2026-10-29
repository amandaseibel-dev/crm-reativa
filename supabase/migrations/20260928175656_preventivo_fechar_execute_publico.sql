-- =============================================================================
-- PREVENTIVO — fechar o EXECUTE de PUBLIC nas 8 funções utilitárias
-- =============================================================================
--
-- SÓ PRIVILÉGIO. Esta migration não cria, não altera e não apaga nenhum objeto,
-- nenhuma coluna e nenhuma regra. Só tira o `EXECUTE` de `PUBLIC` de oito
-- funções e confere, no fim, que quem precisa continua podendo.
--
-- POR QUE ELA EXISTE. As migrations de 28/09/2026 deram
-- `revoke all ... from public` em 21 das 29 funções `preventivo_*`, e
-- esqueceram destas 8. Conferido em produção logo após a aplicação: a ACL
-- delas ficou `=X/postgres postgres=X/postgres authenticated=X/postgres
-- service_role=X/postgres` — o `=X/postgres` é o EXECUTE de PUBLIC, que em
-- Postgres é o padrão de toda função nova quando ninguém o revoga.
--
-- O QUE ISSO EXPÕE HOJE. Nada de dado. As oito são calculadoras puras: não
-- leem tabela nenhuma (verificado no corpo de cada uma), não são SECURITY
-- DEFINER e não aparecem em nenhum `default` ou `check` de constraint (zero em
-- todas — o que importa, porque revogar EXECUTE de função usada em CHECK
-- quebraria INSERT). `preventivo_hoje()` devolve a data de hoje;
-- `preventivo_limite_dias()` devolve 31; as demais recebem um texto ou uma
-- data do próprio chamador e devolvem o mesmo dado normalizado.
--
-- O QUE ISSO CUSTA MESMO ASSIM. Toda função em `public` vira endpoint
-- `POST /rest/v1/rpc/<nome>` no PostgREST. Com EXECUTE de PUBLIC, qualquer um
-- com a chave publicável chama esses oito endpoints. É superfície sem
-- finalidade, e superfície sem finalidade é dívida.
--
-- POR QUE É SEGURO REMOVER:
--
--   1. `authenticated` e `service_role` JÁ TÊM grant explícito nas oito (está
--      na ACL acima). Revogar de PUBLIC não toca nesses dois.
--   2. As chamadas internas continuam funcionando: quem as chama
--      (`preventivo_lote_processar`, `preventivo_janela_aplicar`,
--      `preventivo_acao_preparar`, `preventivo_resultados`,
--      `preventivo_sinc_abrir`, `preventivo_titulos`) é SECURITY DEFINER com
--      owner `postgres`, então durante a execução o `current_user` é
--      `postgres`, que tem EXECUTE.
--   3. Nem o front nem a Edge Function `prev-sincronizar` chamam qualquer uma
--      das oito diretamente — só as RPCs de alto nível.
--   4. Quem perde acesso é `anon`, e o que ele perde é a resposta "hoje é dia
--      tal" e "o limite é 31".
--
-- Reversão em
-- `supabase/rollbacks/20260928175656_preventivo_fechar_execute_publico.rollback.sql`.
-- =============================================================================

do $$
declare
  f text;
  v_alvos text[] := array[
    'preventivo_hoje()',
    'preventivo_limite_dias()',
    'preventivo_dias_atraso(date)',
    'preventivo_na_janela(date)',
    'preventivo_normalizar_celular(text)',
    'preventivo_email_valido(text)',
    'preventivo_celulares(text)',
    'preventivo_emails(text)'
  ];
begin
  foreach f in array v_alvos loop
    -- `revoke ... from public` NUNCA vem sozinho: o grant explícito logo
    -- abaixo é o que impede o erro de 12/09/2026, quando revogar de
    -- `authenticated` derrubou a tela da própria gestão. Ver a memória
    -- `restringir-a-gestao-e-portao-interno-nunca-revoke-de-authenticated`.
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- CONFERÊNCIA NA PRÓPRIA MIGRATION. Se o resultado não for exatamente o
-- esperado, a transação inteira volta atrás — é melhor não aplicar do que
-- aplicar pela metade.
-- ---------------------------------------------------------------------------
do $$
declare
  v_com_public text[];
  v_sem_authenticated text[];
  v_sem_service text[];
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by p.proname), '{}')
    into v_com_public
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'preventivo\_%'
     and (p.proacl is null or exists (select 1 from unnest(p.proacl) a where a::text like '=X/%'));

  select coalesce(array_agg(p.oid::regprocedure::text order by p.proname), '{}')
    into v_sem_authenticated
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'preventivo\_%'
     and p.proname <> 'preventivo_lote_processar'   -- interna: só service_role
     and not exists (select 1 from unnest(p.proacl) a where a::text like 'authenticated=X/%');

  select coalesce(array_agg(p.oid::regprocedure::text order by p.proname), '{}')
    into v_sem_service
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'preventivo\_%'
     and not exists (select 1 from unnest(p.proacl) a where a::text like 'service_role=X/%');

  if array_length(v_com_public, 1) is not null then
    raise exception 'Ainda há função do Preventivo com EXECUTE para PUBLIC: %', v_com_public;
  end if;
  if array_length(v_sem_authenticated, 1) is not null then
    raise exception 'Função do Preventivo ficou sem EXECUTE para authenticated: %', v_sem_authenticated;
  end if;
  if array_length(v_sem_service, 1) is not null then
    raise exception 'Função do Preventivo ficou sem EXECUTE para service_role: %', v_sem_service;
  end if;

  raise notice 'Preventivo: nenhuma função com EXECUTE para PUBLIC; authenticated e service_role intactos.';
end
$$;
