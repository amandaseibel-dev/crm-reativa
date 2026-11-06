-- OS CASOS. Rodam DEPOIS da proposta ser aplicada por cima do 01_ambiente.
--
-- Cada caso falha o job inteiro (ON_ERROR_STOP + assert). Nenhum caso aceita
-- "passou funcionalmente": o que se mede aqui e ACL e RLS, nao comportamento
-- de tela.

\set ON_ERROR_STOP on

-- ============================================================================
-- A. RLS LIGADA nas duas tabelas (premissa §3.1).
--    Tabela operacional com RLS desligada = publicacao bloqueada.
-- ============================================================================
do $$
declare faltando text;
begin
  select string_agg(c.relname, ', ')
    into faltando
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
    and c.relrowsecurity is false;

  if faltando is not null then
    raise exception 'A. RLS DESLIGADA em: %', faltando;
  end if;
  raise notice 'A. ok — RLS ligada nas duas tabelas';
end $$;

-- ============================================================================
-- B. A ARMADILHA DO TRUNCATE. RLS nao cobre TRUNCATE, e tabela nova em public
--    nasce com ele para authenticated. Se este caso falhar, qualquer usuario
--    logado apaga o staging inteiro sem violar policy nenhuma.
-- ============================================================================
do $$
declare sobrando text;
begin
  select string_agg(format('%s:%s', table_name, privilege_type), ', ')
    into sobrando
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated', 'PUBLIC')
    and table_name in ('acordos_prime_staging', 'acordos_prime_staging_criticas', 'acordos_prime_staging_atual')
    and privilege_type in ('TRUNCATE', 'DELETE', 'REFERENCES', 'TRIGGER');

  if sobrando is not null then
    raise exception 'B. privilegio perigoso sobrando: %', sobrando;
  end if;
  raise notice 'B. ok — nenhum TRUNCATE/DELETE/REFERENCES/TRIGGER para anon, authenticated ou PUBLIC';
end $$;

-- ============================================================================
-- C. anon nao tem NADA (premissa §5).
-- ============================================================================
do $$
declare sobrando text;
begin
  select string_agg(format('%s:%s', table_name, privilege_type), ', ')
    into sobrando
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name in ('acordos_prime_staging', 'acordos_prime_staging_criticas', 'acordos_prime_staging_atual');

  if sobrando is not null then
    raise exception 'C. anon tem privilegio: %', sobrando;
  end if;
  raise notice 'C. ok — anon sem nenhum privilegio';
end $$;

-- ============================================================================
-- D. authenticated NAO escreve no staging. INSERT/UPDATE em
--    acordos_prime_staging seria escrita de navegador numa tabela append-only
--    alimentada por servico.
-- ============================================================================
do $$
declare sobrando text;
begin
  select string_agg(privilege_type, ', ')
    into sobrando
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'authenticated'
    and table_name = 'acordos_prime_staging'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

  if sobrando is not null then
    raise exception 'D. authenticated escreve em acordos_prime_staging: %', sobrando;
  end if;
  raise notice 'D. ok — authenticated so le o staging';
end $$;

-- ============================================================================
-- E. UPDATE das criticas e POR COLUNA. Sem isto a gestao poderia reescrever
--    `codigo` e `detalhes`, que sao a evidencia do que foi detectado.
-- ============================================================================
do $$
declare colunas text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into colunas
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = 'acordos_prime_staging_criticas'
    and grantee = 'authenticated'
    and privilege_type = 'UPDATE';

  if colunas is distinct from 'revisado_em, revisado_por_email, status' then
    raise exception 'E. UPDATE de authenticated nas colunas erradas: [%]', coalesce(colunas, '(nenhuma)');
  end if;
  raise notice 'E. ok — UPDATE restrito a status/revisado_por_email/revisado_em';
end $$;

-- ============================================================================
-- F. Nenhuma policy com USING (true) (premissa §3.4).
-- ============================================================================
do $$
declare frouxa text;
begin
  select string_agg(format('%s/%s', tablename, policyname), ', ')
    into frouxa
  from pg_policies
  where schemaname = 'public'
    and tablename in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
    and (
      replace(replace(coalesce(qual, ''), ' ', ''), '(', '') in ('true', 'true)')
      or replace(replace(coalesce(with_check, ''), ' ', ''), '(', '') in ('true', 'true)')
    );

  if frouxa is not null then
    raise exception 'F. policy com USING/WITH CHECK true: %', frouxa;
  end if;
  raise notice 'F. ok — nenhuma policy frouxa';
end $$;

-- ============================================================================
-- G. Toda policy passa por usuario_e_gestao(). Operador nao tem porta.
-- ============================================================================
do $$
declare sem_portao text;
begin
  select string_agg(format('%s/%s', tablename, policyname), ', ')
    into sem_portao
  from pg_policies
  where schemaname = 'public'
    and tablename in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
    and coalesce(qual, '') || coalesce(with_check, '') not like '%usuario_e_gestao%';

  if sem_portao is not null then
    raise exception 'G. policy sem portao de gestao: %', sem_portao;
  end if;
  raise notice 'G. ok — toda policy passa por usuario_e_gestao()';
end $$;

-- ============================================================================
-- H. A VIEW respeita a RLS de quem consulta (premissa §6). security_invoker
--    desligado faria dela porta lateral para o staging inteiro.
-- ============================================================================
do $$
declare opcoes text;
begin
  select array_to_string(c.reloptions, ',')
    into opcoes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'acordos_prime_staging_atual';

  if coalesce(opcoes, '') not like '%security_invoker=true%' then
    raise exception 'H. view sem security_invoker=true (reloptions: %)', coalesce(opcoes, '(vazio)');
  end if;
  raise notice 'H. ok — view com security_invoker=true';
end $$;

-- ============================================================================
-- I. TESTE DE PERFIL DE VERDADE (premissa §9), com ROLLBACK.
--    Semeia como postgres, depois le como authenticated nos dois perfis.
-- ============================================================================
begin;

insert into public.acordos_prime_staging
  (chave_acordo, numero_acordo_mannesoft, identificador_aluno,
   situacao_mannesoft, composicao, composicao_hash, lote_captura_id)
values
  ('71903|111.222.333-44', '71903', '111.222.333-44',
   'Acordo', '{"titulos_negociados":[],"titulos_gerados":[]}'::jsonb, 'hash-de-teste', gen_random_uuid());

insert into public.acordos_prime_staging_criticas (chave_acordo, codigo)
values ('71903|111.222.333-44', 'VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO');

-- I.1 OPERADOR (nao gestao): nao ve nada, em nenhuma das tres relacoes.
set local role authenticated;
set local teste.e_gestao = 'false';

do $$
declare n_staging int; n_criticas int; n_view int;
begin
  select count(*) into n_staging  from public.acordos_prime_staging;
  select count(*) into n_criticas from public.acordos_prime_staging_criticas;
  select count(*) into n_view     from public.acordos_prime_staging_atual;

  if n_staging <> 0 or n_criticas <> 0 or n_view <> 0 then
    raise exception 'I.1 OPERADOR LEU O STAGING: staging=%, criticas=%, view=%', n_staging, n_criticas, n_view;
  end if;
  raise notice 'I.1 ok — operador nao le staging, criticas nem view';
end $$;

-- I.2 OPERADOR nao escreve, mesmo tentando.
do $$
begin
  begin
    insert into public.acordos_prime_staging
      (chave_acordo, numero_acordo_mannesoft, identificador_aluno,
       situacao_mannesoft, composicao, composicao_hash, lote_captura_id)
    values ('x', 'x', 'x', 'x', '{}'::jsonb, 'x', gen_random_uuid());
    raise exception 'I.2 OPERADOR CONSEGUIU INSERIR no staging';
  exception
    when insufficient_privilege then
      raise notice 'I.2 ok — insert de operador negado (privilegio)';
  end;
end $$;

-- I.3 GESTAO: le as duas tabelas e a view.
set local teste.e_gestao = 'true';

do $$
declare n_staging int; n_criticas int; n_view int;
begin
  select count(*) into n_staging  from public.acordos_prime_staging;
  select count(*) into n_criticas from public.acordos_prime_staging_criticas;
  select count(*) into n_view     from public.acordos_prime_staging_atual;

  if n_staging <> 1 or n_criticas <> 1 or n_view <> 1 then
    raise exception 'I.3 gestao NAO leu: staging=%, criticas=%, view=%', n_staging, n_criticas, n_view;
  end if;
  raise notice 'I.3 ok — gestao le staging, criticas e view';
end $$;

-- I.4 GESTAO revisa a critica (status), e NAO reescreve a evidencia (codigo).
do $$
begin
  update public.acordos_prime_staging_criticas
     set status = 'REVISADA', revisado_por_email = 'amanda.seibel@aelbra.com.br', revisado_em = now();
  raise notice 'I.4a ok — gestao revisou o status';

  begin
    update public.acordos_prime_staging_criticas set codigo = 'INVENTADO';
    raise exception 'I.4b GESTAO REESCREVEU O CODIGO da critica';
  exception
    when insufficient_privilege then
      raise notice 'I.4b ok — reescrever codigo negado (grant de coluna)';
  end;
end $$;

-- I.5 GESTAO nao faz UPDATE nem DELETE no staging append-only.
do $$
begin
  begin
    update public.acordos_prime_staging set situacao_mannesoft = 'alterado';
    raise exception 'I.5a GESTAO ALTEROU linha do staging append-only';
  exception
    when insufficient_privilege then
      raise notice 'I.5a ok — update no staging negado';
  end;

  begin
    delete from public.acordos_prime_staging;
    raise exception 'I.5b GESTAO APAGOU linha do staging append-only';
  exception
    when insufficient_privilege then
      raise notice 'I.5b ok — delete no staging negado';
  end;
end $$;

reset role;
rollback;

-- ============================================================================
-- J. ISOLAMENTO: a proposta nao toca nenhuma tabela financeira.
--    Garantia estrutural — se um dia alguem acrescentar uma FK para `acordos`,
--    `parcelas` ou `baixas_pagamento`, este caso cai.
-- ============================================================================
do $$
declare vinculo text;
begin
  select string_agg(format('%s -> %s', c.conname, cf.relname), ', ')
    into vinculo
  from pg_constraint c
  join pg_class ct on ct.oid = c.conrelid
  join pg_class cf on cf.oid = c.confrelid
  where ct.relname in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
    and c.contype = 'f'
    and cf.relname in ('acordos', 'acordos_titulos', 'parcelas', 'baixas_pagamento', 'pagamentos');

  if vinculo is not null then
    raise exception 'J. staging amarrado a tabela financeira: %', vinculo;
  end if;
  raise notice 'J. ok — nenhuma FK para tabela financeira';
end $$;

\echo 'TODOS OS CASOS PASSARAM — RLS, grants e isolamento do staging de acordos'
