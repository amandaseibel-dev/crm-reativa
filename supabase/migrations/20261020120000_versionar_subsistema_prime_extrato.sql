-- VERSIONAR O SUBSISTEMA prime_extrato -- BASELINE, NO-OP INTEGRAL EM PRODUCAO.
--
-- O QUE E ISTO: `docs/integracoes/prime-gaps.md` marcava como VERMELHO que
-- `prime_chave_api()`, `prime_extrato` e `prime_extrato_fila` existem em producao SEM
-- migration, e que a rotina que alimenta `prime_extrato_fila` "nao foi localizada em
-- src/ nem nas Edge Functions". Esta migration versiona o subsistema e fecha os dois --
-- a rotina E `prime_extrato_reenfileirar()`, chamada pelo cron
-- `prime_extrato_reenfileirar_semanal`; nao estava em src/ nem nas Edge Functions
-- porque e funcao SQL agendada no pg_cron, e tambem nao tinha migration.
--
-- ===========================================================================
-- CORRECAO DE 20/10/2026, PEDIDA PELA GESTAO
--
-- A primeira versao desta migration NAO era no-op integral, ao contrario do que o
-- cabecalho afirmava. Conferido objeto a objeto contra producao:
--
--   COMMENT ON TABLE  -> ALTERAVA. As duas tabelas estao SEM COMENTARIO em producao,
--                        e o comando teria adicionado um. E mudanca de catalogo em
--                        objeto existente. CORRIGIDO: so comenta a tabela que ESTA
--                        MIGRATION criou.
--   ENABLE RLS        -> ja ligada (`relrowsecurity = true`); efeito nulo, mas pega
--                        ACCESS EXCLUSIVE numa tabela de 412 mil linhas. CORRIGIDO:
--                        so executa para a tabela que esta migration criou.
--   GRANT/REVOKE      -> conferidos no ACL BRUTO (`relacl`/`proacl`), nao pelo
--                        information_schema, que esconde PUBLIC:
--                          relacl = postgres=arwdDxtm | service_role=arwdDxtm |
--                                   authenticated=r      -> sem anon, sem PUBLIC
--                          proacl = postgres=X | service_role=X
--                                   -> PUBLIC NAO tem EXECUTE (o default ja fora
--                                      revogado), logo o REVOKE seria no-op
--                        Eram no-op de fato, mas foram igualmente condicionados:
--                        objeto preexistente nao tem permissao tocada, nem para
--                        reafirmar o que ja vale.
--   CREATE POLICY     -> ja era condicional. Mantido.
--   CREATE TABLE/INDEX-> `if not exists`. Mantido.
--
-- E a verificacao de divergencia virou EXCECAO QUE ABORTA, e roda ANTES de tudo.
-- Na versao anterior era NOTICE, com o argumento de que abortar deixaria o
-- repositorio sem baseline. O argumento estava errado: um baseline que NAO
-- corresponde a producao e pior do que nenhum, porque passa a ser citado como se
-- correspondesse. Se divergir, nada e aplicado e a mensagem diz o que divergiu.
-- ===========================================================================
--
-- md5(pg_get_functiondef) capturados em producao em 20/10/2026:
--   prime_chave_api()                 86eae3185b21c18277ebf6a6174ca0b9   408 bytes
--   prime_extrato_falhou(text,text)   777f8cd526b0e29c343fdc31e527de1e   337 bytes
--   prime_extrato_mutirao()           6146ead7b9385fc757a764e92724c08b   932 bytes
--   prime_extrato_ok(text)            959e534c11cad2e98897f5d4aaf730e3   287 bytes
--   prime_extrato_reenfileirar()      6d098afc9cccaf2c19f1183c74b16ef2   845 bytes
--
-- O QUE ESTA MIGRATION NAO FAZ, POR DECISAO:
--   * NAO cria os crons. Os quatro jobs do fluxo ja existem e estao ativos em producao
--     (35 prime_extrato_mutirao `*/2 2-23 * * 6`; 40 prime_extrato_reenfileirar_semanal
--     `5 2 * * 6`; 59 prime_extrato_pendentes_vinculo_enfileirar `10 3 * * *`;
--     60 prime_extrato_pendentes_vinculo_drenar `15,35,55 3 * * *`). Agenda e estado
--     operacional, nao estrutura, e recria-los arriscaria duplicar job vivo.
--     Ficam REGISTRADOS aqui, nao executados.
--   * NAO toca em segredo do Vault. `prime_chave_api()` apenas LE
--     `vault.decrypted_secrets` pelo nome `prime_api_key`.
--   * NAO versiona os outros 28 objetos `prime*` sem migration (piloto academico,
--     portador 202, syncs de cadastro). Estao listados em `prime-gaps.md`; PR propria.
--   * NAO da baixa, nao move dinheiro, nao altera registro de aluno, nao mexe no lote
--     bloqueado de 109 confirmacoes.
--
-- ROLLBACK: nenhum necessario em producao -- la ela e no-op integral. Num banco novo,
-- dropar o que foi criado; ver `supabase/rollbacks/`.
begin;

-- ===========================================================================
-- PASSO 1 -- VERIFICACAO QUE ABORTA, ANTES DE QUALQUER DDL
-- ===========================================================================
do $$
declare
  esperado jsonb := jsonb_build_object(
    'public.prime_chave_api()',               '86eae3185b21c18277ebf6a6174ca0b9',
    'public.prime_extrato_falhou(text,text)', '777f8cd526b0e29c343fdc31e527de1e',
    'public.prime_extrato_mutirao()',         '6146ead7b9385fc757a764e92724c08b',
    'public.prime_extrato_ok(text)',          '959e534c11cad2e98897f5d4aaf730e3',
    'public.prime_extrato_reenfileirar()',    '6d098afc9cccaf2c19f1183c74b16ef2');
  chave text; atual text; problemas text := '';
  cols int; idx int;
begin
  -- 1a. funcoes que ja existem precisam bater BYTE A BYTE com o baseline
  for chave in select jsonb_object_keys(esperado) loop
    if to_regprocedure(chave) is not null then
      select md5(pg_get_functiondef(to_regprocedure(chave))) into atual;
      if atual is distinct from (esperado->>chave) then
        problemas := problemas || format(E'\n  - %s: producao tem md5 %s, baseline espera %s',
                                         chave, atual, esperado->>chave);
      end if;
    end if;
  end loop;

  -- 1b. tabelas que ja existem precisam ter a forma do baseline
  if to_regclass('public.prime_extrato') is not null then
    select count(*) into cols from information_schema.columns
      where table_schema='public' and table_name='prime_extrato';
    if cols <> 16 then
      problemas := problemas || format(E'\n  - prime_extrato: producao tem %s colunas, baseline espera 16', cols);
    end if;
    select count(*) into idx from pg_indexes
      where schemaname='public' and tablename='prime_extrato'
        and indexname in ('ix_prime_extrato_boleto','ix_prime_extrato_boleto_ltrim',
                          'ix_prime_extrato_boleto_mat','ix_prime_extrato_negociacao',
                          'prime_extrato_pkey');
    if idx <> 5 then
      problemas := problemas || format(E'\n  - prime_extrato: %s dos 5 indices do baseline presentes', idx);
    end if;
  end if;

  if to_regclass('public.prime_extrato_fila') is not null then
    select count(*) into cols from information_schema.columns
      where table_schema='public' and table_name='prime_extrato_fila';
    if cols <> 7 then
      problemas := problemas || format(E'\n  - prime_extrato_fila: producao tem %s colunas, baseline espera 7', cols);
    end if;
  end if;

  if problemas <> '' then
    raise exception E'BASELINE INCOMPATIVEL COM PRODUCAO -- nada foi aplicado.%s\n\nCorrija o baseline no repositorio (nao a producao) antes de aplicar.', problemas
      using errcode = 'data_exception';
  end if;
end $$;

-- ===========================================================================
-- PASSO 2 -- registrar o que JA EXISTIA, antes de criar qualquer coisa.
-- E este registro que permite nao encostar em objeto preexistente mais adiante.
-- ===========================================================================
create temporary table _prime_pre_estado on commit drop as
select 'prime_extrato'::text  obj, to_regclass('public.prime_extrato')      is not null existia
union all
select 'prime_extrato_fila',       to_regclass('public.prime_extrato_fila') is not null;

-- ===========================================================================
-- PASSO 3 -- tabelas e indices (`if not exists`: no-op quando ja existem)
-- ===========================================================================
create table if not exists public.prime_extrato (
  matricula     text not null,
  boleto        text not null,
  cpf           text,
  vencimento    date,
  liquidado_em  date,
  valor_liquido numeric,
  valor_pago    numeric,
  honorario     numeric,
  de_acordo     boolean,
  portador      integer,
  portador_nome text,
  coletado_em   timestamptz not null default now(),
  valor_bruto   numeric,
  desconto      numeric,
  multa         numeric,
  juros         numeric,
  constraint prime_extrato_pkey primary key (matricula, boleto)
);

create index if not exists ix_prime_extrato_boleto       on public.prime_extrato using btree (boleto);
create index if not exists ix_prime_extrato_boleto_ltrim on public.prime_extrato using btree (ltrim(boleto, '0'::text));
create index if not exists ix_prime_extrato_boleto_mat   on public.prime_extrato using btree (boleto, matricula);
create index if not exists ix_prime_extrato_negociacao   on public.prime_extrato using btree (matricula, portador, liquidado_em)
  where ((portador = 195) and (liquidado_em is not null));

create table if not exists public.prime_extrato_fila (
  matricula   text not null,
  cpf         text,
  motivo      text,
  tentativas  integer not null default 0,
  ultimo_erro text,
  coletado_em timestamptz,
  criado_em   timestamptz not null default now(),
  constraint prime_extrato_fila_pkey primary key (matricula)
);

-- ===========================================================================
-- PASSO 4 -- comentario, RLS, policy e grants: SO para a tabela que ESTA
-- migration criou. Tabela preexistente nao tem catalogo nem permissao tocados.
-- ===========================================================================
do $$
declare t text; nasceu_aqui boolean;
begin
  foreach t in array array['prime_extrato','prime_extrato_fila'] loop
    select not existia into nasceu_aqui from _prime_pre_estado where obj = t;
    if not nasceu_aqui then
      raise notice 'prime_extrato: % ja existia -- comentario, RLS, policy e grants NAO foram tocados.', t;
      continue;
    end if;

    if t = 'prime_extrato' then
      execute $c$comment on table public.prime_extrato is
        'Espelho do extrato financeiro da Prime, decomposto. Alimentado pela Edge Function prime-extrato a partir de GET /students/{registration}. valor_pago e paidAmount da Prime -- DIVIDA CORRIGIDA, nunca caixa recebido; liquidado_em e paymentDate -- NUNCA confirma pagamento sozinho (vem preenchido ate em titulo a vencer). Ver docs/integracoes/prime-mapa-fontes-verdade.md.'$c$;
      execute 'alter table public.prime_extrato enable row level security';
      execute 'create policy prime_extrato_gestao on public.prime_extrato
                 for select to authenticated using (public.usuario_e_gestao())';
    else
      execute $c$comment on table public.prime_extrato_fila is
        'Fila de matriculas a coletar no espelho do extrato. Alimentada por prime_extrato_reenfileirar() (cron semanal) e drenada por prime_extrato_mutirao().'$c$;
      execute 'alter table public.prime_extrato_fila enable row level security';
      execute 'create policy prime_fila_gestao on public.prime_extrato_fila
                 for select to authenticated using (public.usuario_e_gestao())';
    end if;

    -- Espelha o ACL de producao: authenticated=r (so leitura, e a RLS exige gestao);
    -- service_role com escrita; anon e PUBLIC sem nada.
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete, truncate, references, trigger
                      on table public.%I to service_role', t);
  end loop;
end $$;

-- ===========================================================================
-- PASSO 5 -- funcoes: create CONDICIONAL, e grants so para a que nasceu aqui.
--
-- O texto de cada funcao e EXATAMENTE o que `pg_get_functiondef` emite em producao,
-- alinhado a esquerda. Indentar aqui mudaria o `prosrc` e, com ele, o md5 -- o teste
-- "em banco NOVO cria as cinco com o md5 EXATO de producao" existe para pegar isso.
-- ===========================================================================
do $$
begin

  if to_regprocedure('public.prime_chave_api()') is null then
    execute $f$
CREATE OR REPLACE FUNCTION public.prime_chave_api()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado.' using errcode='42501';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name='prime_api_key';
  return v;
end;
$function$
$f$;
    execute 'revoke all on function public.prime_chave_api() from public, anon, authenticated';
    execute 'grant execute on function public.prime_chave_api() to service_role';
  end if;

  if to_regprocedure('public.prime_extrato_ok(text)') is null then
    execute $f$
CREATE OR REPLACE FUNCTION public.prime_extrato_ok(p_matricula text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.prime_extrato_fila
     set coletado_em = now(), ultimo_erro = null
   where matricula = p_matricula;
$function$
$f$;
    execute 'revoke all on function public.prime_extrato_ok(text) from public, anon, authenticated';
    execute 'grant execute on function public.prime_extrato_ok(text) to service_role';
  end if;

  if to_regprocedure('public.prime_extrato_falhou(text,text)') is null then
    execute $f$
CREATE OR REPLACE FUNCTION public.prime_extrato_falhou(p_matricula text, p_erro text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.prime_extrato_fila
     set tentativas = tentativas + 1, ultimo_erro = left(coalesce(p_erro,''),200)
   where matricula = p_matricula;
$function$
$f$;
    execute 'revoke all on function public.prime_extrato_falhou(text,text) from public, anon, authenticated';
    execute 'grant execute on function public.prime_extrato_falhou(text,text) to service_role';
  end if;

  -- A ROTINA QUE ALIMENTA A FILA -- o item que estava VERMELHO em prime-gaps.md.
  if to_regprocedure('public.prime_extrato_reenfileirar()') is null then
    execute $f$
CREATE OR REPLACE FUNCTION public.prime_extrato_reenfileirar()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_n integer;
begin
  insert into public.prime_extrato_fila (matricula, cpf, motivo, tentativas, criado_em)
  select c.registration, c.cpf, 'atualizacao semanal', 0, now()
    from (
      select distinct on (cpf) cpf, registration
        from public.prime_contratos
       order by cpf, valid_from desc
    ) c
   where exists (
     select 1 from public.alunos a
      where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = c.cpf)
  on conflict (matricula) do update
     set coletado_em = null,
         tentativas  = 0,
         ultimo_erro = null,
         motivo      = excluded.motivo;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$
$f$;
    execute 'revoke all on function public.prime_extrato_reenfileirar() from public, anon, authenticated';
    execute 'grant execute on function public.prime_extrato_reenfileirar() to service_role';
  end if;

  if to_regprocedure('public.prime_extrato_mutirao()') is null then
    execute $f$
CREATE OR REPLACE FUNCTION public.prime_extrato_mutirao()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_url text; v_req bigint; v_carga jsonb; v_faltam int;
begin
  select count(*) into v_faltam from public.prime_extrato_fila
   where coletado_em is null and tentativas < 3;
  if coalesce(v_faltam,0) = 0 then return null; end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then return null; end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name='projeto_url';
  if v_url is null then return null; end if;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-extrato',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('lote', 400),
    timeout_milliseconds := 170000) into v_req;
  return v_req;
end;
$function$
$f$;
    execute 'revoke all on function public.prime_extrato_mutirao() from public, anon, authenticated';
    execute 'grant execute on function public.prime_extrato_mutirao() to service_role';
  end if;

end $$;

commit;
