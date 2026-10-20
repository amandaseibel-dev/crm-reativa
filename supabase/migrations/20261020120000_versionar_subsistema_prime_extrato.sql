-- VERSIONAR O SUBSISTEMA prime_extrato -- BASELINE, NAO ALTERA PRODUCAO.
--
-- O QUE E ISTO: `docs/integracoes/prime-gaps.md` marca como VERMELHO (drift, nao gap de
-- dado) que `prime_chave_api()`, `prime_extrato` e `prime_extrato_fila` existem em
-- producao SEM migration, e que a rotina que alimenta `prime_extrato_fila` "nao foi
-- localizada em src/ nem nas Edge Functions do repo". Esta migration versiona esse
-- subsistema e fecha o item -- a rotina E `prime_extrato_reenfileirar()`, chamada pelo
-- cron `prime_extrato_reenfileirar_semanal`; nao estava em src/ nem nas Edge Functions
-- porque e funcao SQL agendada no pg_cron, e tambem nao tinha migration.
--
-- A REGRA QUE GOVERNA CADA LINHA DAQUI: nao recriar, nao substituir e nao alterar objeto
-- de producao que ja funciona. Por isso:
--
--   * TABELAS e INDICES usam `if not exists` -- em producao viram no-op;
--   * POLICIES sao criadas so quando ausentes (checagem em pg_policies);
--   * GRANTS sao idempotentes por natureza (conceder o que ja existe nao muda nada);
--   * FUNCOES usam CREATE CONDICIONAL (`to_regprocedure(...) is null`), NUNCA
--     `create or replace` solto. Esta e a diferenca que importa: `create or replace`
--     SUBSTITUIRIA o corpo em producao, e um unico byte diferente no texto que eu
--     capturei mudaria comportamento. Com o create condicional, em producao nada e
--     tocado; num banco novo, o objeto nasce igual.
--
-- VERIFICACAO EM VEZ DE CONFIANCA: ao final, um bloco compara o md5 de
-- `pg_get_functiondef` de cada funcao existente com o md5 capturado de producao em
-- 20/10/2026 e emite NOTICE quando divergir. E NOTICE, nao EXCEPTION, de proposito:
-- divergencia e informacao para a proxima revisao, e abortar o apply por causa dela
-- deixaria o repositorio sem baseline -- que e exatamente o problema que estamos fechando.
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
--     `vault.decrypted_secrets` pelo nome `prime_api_key`; a migration nao cria, nao
--     altera e nao expoe segredo nenhum.
--   * NAO versiona os outros 28 objetos `prime*` sem migration (piloto academico,
--     portador 202, sync de cadastro). Sao drift real e estao listados em
--     `docs/integracoes/prime-gaps.md`, mas sao outro subsistema -- entram em PR propria.
--   * NAO da baixa, nao move dinheiro, nao altera registro de aluno, nao mexe no lote
--     bloqueado de 109 confirmacoes.
--
-- ROLLBACK: nenhum, por desenho. Em producao esta migration e no-op integral; nao ha o
-- que desfazer. Num banco novo, o rollback seria dropar o que ela criou, e isso esta em
-- `supabase/rollbacks/`.
begin;

-- ---------------------------------------------------------------- tabelas
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

comment on table public.prime_extrato is
  'Espelho do extrato financeiro da Prime, decomposto. Alimentado pela Edge Function prime-extrato a partir de GET /students/{registration}. valor_pago e paidAmount da Prime -- DIVIDA CORRIGIDA, nunca caixa recebido; liquidado_em e paymentDate -- NUNCA confirma pagamento sozinho (vem preenchido ate em titulo a vencer). Ver docs/integracoes/prime-mapa-fontes-verdade.md.';

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

comment on table public.prime_extrato_fila is
  'Fila de matriculas a coletar no espelho do extrato. Alimentada por prime_extrato_reenfileirar() (cron semanal) e drenada por prime_extrato_mutirao().';

-- ------------------------------------------------------------------- RLS
alter table public.prime_extrato      enable row level security;
alter table public.prime_extrato_fila enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='prime_extrato'
                    and policyname='prime_extrato_gestao') then
    create policy prime_extrato_gestao on public.prime_extrato
      for select to authenticated using (public.usuario_e_gestao());
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='prime_extrato_fila'
                    and policyname='prime_fila_gestao') then
    create policy prime_fila_gestao on public.prime_extrato_fila
      for select to authenticated using (public.usuario_e_gestao());
  end if;
end $$;

-- ---------------------------------------------------------------- grants
-- Espelha o que ja vale em producao: authenticated so le (e a RLS acima exige gestao);
-- escrita e do service_role, que e quem a Edge Function usa. TRUNCATE NAO vai para
-- authenticated -- tabela nova herda privilegios do schema, e aqui isso e explicito.
revoke all on table public.prime_extrato      from anon;
revoke all on table public.prime_extrato_fila from anon;
grant select on table public.prime_extrato      to authenticated;
grant select on table public.prime_extrato_fila to authenticated;
grant select, insert, update, delete, truncate, references, trigger on table public.prime_extrato      to service_role;
grant select, insert, update, delete, truncate, references, trigger on table public.prime_extrato_fila to service_role;

-- --------------------------------------------------------------- funcoes
-- Create CONDICIONAL: em producao, nenhum destes blocos executa.
--
-- O texto de cada funcao e EXATAMENTE o que `pg_get_functiondef` emite em producao,
-- alinhado a esquerda. Indentar aqui mudaria o `prosrc` e, com ele, o md5 -- o teste
-- `em banco NOVO cria as cinco com o md5 EXATO de producao` existe para pegar isso.
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
  end if;

end $$;

-- Grants das funcoes: funcao nova herda EXECUTE para PUBLIC pelo default do Postgres.
-- Em producao estas cinco sao service_role/postgres apenas -- nenhuma e chamada pelo
-- front. Revogar e conceder aqui deixa o banco novo igual ao de producao.
revoke all on function public.prime_chave_api()                       from public, anon, authenticated;
revoke all on function public.prime_extrato_ok(text)                  from public, anon, authenticated;
revoke all on function public.prime_extrato_falhou(text,text)         from public, anon, authenticated;
revoke all on function public.prime_extrato_reenfileirar()            from public, anon, authenticated;
revoke all on function public.prime_extrato_mutirao()                 from public, anon, authenticated;
grant execute on function public.prime_chave_api()                    to service_role;
grant execute on function public.prime_extrato_ok(text)               to service_role;
grant execute on function public.prime_extrato_falhou(text,text)      to service_role;
grant execute on function public.prime_extrato_reenfileirar()         to service_role;
grant execute on function public.prime_extrato_mutirao()              to service_role;

-- ----------------------------------------------------- verificacao (NOTICE)
do $$
declare
  r record;
  esperado jsonb := jsonb_build_object(
    'public.prime_chave_api()',               '86eae3185b21c18277ebf6a6174ca0b9',
    'public.prime_extrato_falhou(text,text)', '777f8cd526b0e29c343fdc31e527de1e',
    'public.prime_extrato_mutirao()',         '6146ead7b9385fc757a764e92724c08b',
    'public.prime_extrato_ok(text)',          '959e534c11cad2e98897f5d4aaf730e3',
    'public.prime_extrato_reenfileirar()',    '6d098afc9cccaf2c19f1183c74b16ef2');
  chave text; atual text; divergentes int := 0;
begin
  for chave in select jsonb_object_keys(esperado) loop
    if to_regprocedure(chave) is not null then
      select md5(pg_get_functiondef(to_regprocedure(chave))) into atual;
      if atual is distinct from (esperado->>chave) then
        divergentes := divergentes + 1;
        raise notice 'DIVERGENCIA: % tem md5 % e o versionado espera %',
          chave, atual, (esperado->>chave);
      end if;
    end if;
  end loop;
  if divergentes = 0 then
    raise notice 'prime_extrato: as 5 funcoes conferem byte a byte com o versionado.';
  else
    raise notice 'prime_extrato: % funcao(oes) divergem do versionado -- revisar antes de confiar no baseline.', divergentes;
  end if;
end $$;

commit;
