-- PREPARA A ACL DA STAGE, ANTES DA 20260915140000.
--
-- POR QUE ESTA MIGRATION EXISTE. O schema `public` deste projeto tem DEFAULT
-- PRIVILEGES que concedem `arwdDxtm` -- tudo -- a `anon`, `authenticated` e
-- `service_role` em toda tabela nova. Medido em producao, 15/09/2026:
--
--   supabase_admin -> anon=arwdDxtm authenticated=arwdDxtm service_role=arwdDxtm
--   postgres       -> authenticated=arwdDxtm service_role=arwdDxtm
--
-- A 20260915140000 revoga `service_role` de `backfill_matricula_lotes` e de
-- `backfill_matricula_origem`, mas na STAGE ela revoga so `public, anon,
-- authenticated` e depois concede INSERT. Como o default ja deu tudo, o
-- `service_role` ficaria com SELECT, UPDATE e DELETE alem do INSERT -- e a
-- propria prova dela aborta, corretamente:
--
--   ERROR: P0001: service_role ganhou mais que INSERT na stage
--
-- Aplicada sozinha, portanto, a 20260915140000 NUNCA entra. E transacional:
-- nada fica, nem a tabela.
--
-- POR QUE NAO SE CORRIGE O ARQUIVO. Ele ja esta no `main` (1528a4cf), e a
-- governanca trata migration na base como IMUTAVEL. A catraca bloqueia alterar
-- (I1), apagar (I2) e renomear (I3).
--
-- ENTAO A CORRECAO E DE ORDEM, NAO DE CONTEUDO -- o mesmo remedio do PR #381,
-- que ja pos `20260915115959` antes de `20260915120000`. Esta migration ordena
-- ANTES (135959 < 140000), cria a stage e deixa a ACL zerada. Quando a
-- 20260915140000 rodar:
--
--   `create table if not exists`  -> no-op, a tabela ja existe
--   `enable row level security`   -> no-op, ja esta ligada
--   `revoke ... public/anon/auth` -> no-op, ja nao tinham nada
--   `grant insert ... service_role` -> concede EXATAMENTE um privilegio
--   `do $prova$`                  -> passa
--
-- O QUE ESTA MIGRATION NAO FAZ, DE PROPOSITO:
--   nao concede INSERT -- quem concede e a 20260915140000, que e quem prova;
--   nao mexe em DEFAULT PRIVILEGES do schema -- isso afetaria toda tabela
--     futura do projeto, e o problema e local a esta tabela;
--   nao cria funcao, auditoria, indice ou qualquer outra tabela;
--   nao toca em `pagamentos` nem em nada do #380.
--
-- O `CREATE TABLE` ABAIXO E COPIA EXATA da 20260915140000 -- coluna por coluna,
-- tipo por tipo, com os mesmos NOT NULL, o mesmo default e a mesma chave
-- primaria. Como la o comando e `IF NOT EXISTS`, qualquer diferenca aqui
-- viraria o schema definitivo sem ninguem perceber.

create table if not exists public.backfill_matricula_stage (
  lote                    text        not null,
  pagamento_id            uuid        not null,
  numero_parcela_completo text        not null,
  matricula               text        not null,
  arquivo_origem          text        not null,
  linha_no_arquivo        integer     not null,
  carregado_em            timestamptz not null default now(),
  primary key (lote, pagamento_id)
);

alter table public.backfill_matricula_stage enable row level security;

-- O PONTO DESTA MIGRATION: `service_role` entra na lista do revoke. A
-- 20260915140000 devolve a ele, em seguida, o unico privilegio que ele deve
-- ter -- e prova que e so aquele.
revoke all on table public.backfill_matricula_stage
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PROVA
-- ---------------------------------------------------------------------------

do $prova$
begin
  if to_regclass('public.backfill_matricula_stage') is null then
    raise exception 'a stage nao foi criada';
  end if;

  -- a tabela nasce SEM privilegio nenhum para os tres papeis, INSERT inclusive:
  -- conceder e tarefa da 20260915140000.
  if has_table_privilege('service_role', 'public.backfill_matricula_stage', 'INSERT')
  or has_table_privilege('service_role', 'public.backfill_matricula_stage', 'SELECT')
  or has_table_privilege('service_role', 'public.backfill_matricula_stage', 'UPDATE')
  or has_table_privilege('service_role', 'public.backfill_matricula_stage', 'DELETE') then
    raise exception 'a stage nasceu com privilegio para service_role';
  end if;
  if has_table_privilege('anon', 'public.backfill_matricula_stage', 'SELECT')
  or has_table_privilege('anon', 'public.backfill_matricula_stage', 'INSERT')
  or has_table_privilege('authenticated', 'public.backfill_matricula_stage', 'SELECT')
  or has_table_privilege('authenticated', 'public.backfill_matricula_stage', 'INSERT') then
    raise exception 'a stage nasceu acessivel por anon ou authenticated';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.backfill_matricula_stage'::regclass) then
    raise exception 'a stage ficou sem RLS';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'backfill_matricula_stage') then
    raise exception 'a stage ganhou policy -- nao devia ter nenhuma';
  end if;
end $prova$;
