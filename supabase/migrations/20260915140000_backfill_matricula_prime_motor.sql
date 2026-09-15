-- MOTOR GENERICO DE BACKFILL DA MATRICULA PRIME.
--
-- O QUE ESTA MIGRATION CONTEM: estrutura de auditoria, uma funcao de aplicacao
-- com invariantes, e os revokes. SO ISSO.
--
-- O QUE ELA NAO CONTEM, DE PROPOSITO: nenhum `pagamento_id`, nenhuma matricula,
-- nenhum boleto, nenhum CPF, nenhum nome -- e tambem NENHUM hash de lote. O
-- repositorio e PUBLICO (amandaseibel-dev/crm-reativa, conferido em 15/09/2026).
-- Versionar o plano publicaria 7.401 identificadores de pessoas reais, e
-- versionar o hash publicaria a impressao digital daquele lote. Por isso o Git
-- guarda a REGRA; o plano e o hash chegam como argumento, na execucao.
--
-- COMO SE APLICA: chamada administrativa, fora da interface. O plano vai em
-- `p_plano`, o hash em `p_hash`, a contagem em `p_esperado` e o nome do lote em
-- `p_lote`. Nada disso trafega pelo frontend nem pelo PostgREST.
--
-- POR QUE `SECURITY INVOKER`: a aplicacao acontece em contexto administrativo,
-- que ja tem permissao de escrita em `pagamentos`. Nao ha motivo tecnico para
-- elevar privilegio, e `DEFINER` criaria uma funcao que escreve na tabela de
-- dinheiro com o privilegio do dono -- exatamente o que nao se quer ao lado de
-- um PostgREST publico. Fica INVOKER, mais o gate explicito e mais os revokes.
--
-- SOBRE O REVOKE DE `authenticated`: a regra da casa e que restringir a gestao
-- se faz por portao interno, nunca por revoke -- porque revogar derruba a tela
-- da propria gestao. Aqui e diferente e o revoke e correto: NENHUMA tela chama
-- esta funcao, e nenhuma deve chamar. Ela nao tem caminho pela interface.
--
-- O QUE ELA NAO FAZ: nao cria acordo, nao cria parcela, nao mexe em titulo, nao
-- altera data, nao chama conciliacao, nao religa `consulta_portador` e nao usa
-- nada da 20260915120000. Escreve UMA coluna: `pagamentos.matricula`.

-- ---------------------------------------------------------------------------
-- 1. AUDITORIA: o lote e a linha
-- ---------------------------------------------------------------------------

-- O lote existe para que uma reversao futura seja dirigida a UMA carga, sem
-- tocar nas outras. `artefato_hash` amarra a carga ao artefato revisado.
create table if not exists public.backfill_matricula_lotes (
  lote                 text primary key,
  artefato_hash        text        not null,
  quantidade_esperada  integer     not null check (quantidade_esperada > 0),
  quantidade_aplicada  integer,
  status               text        not null check (status in ('APLICADO')),
  aplicado_em          timestamptz not null default now()
);

-- A chave e (lote, pagamento_id): um mesmo pagamento pode aparecer em lotes
-- diferentes ao longo do tempo sem que o historico do lote anterior se perca.
create table if not exists public.backfill_matricula_origem (
  lote                    text        not null references public.backfill_matricula_lotes(lote),
  pagamento_id            uuid        not null references public.pagamentos(id),
  numero_parcela_completo text        not null,
  matricula               text        not null,
  arquivo_origem          text        not null,
  linha_no_arquivo        integer     not null,
  aplicado_em             timestamptz not null default now(),
  primary key (lote, pagamento_id)
);

create index if not exists backfill_matricula_origem_pagamento_idx
  on public.backfill_matricula_origem (pagamento_id);

-- Trilha interna: RLS ligada e SEM policy nenhuma = ninguem le pelo PostgREST.
alter table public.backfill_matricula_lotes  enable row level security;
alter table public.backfill_matricula_origem enable row level security;

revoke all on table public.backfill_matricula_lotes  from public, anon, authenticated;
revoke all on table public.backfill_matricula_origem from public, anon, authenticated;

comment on table public.backfill_matricula_lotes is
  'Um registro por carga de backfill de matricula Prime. artefato_hash amarra a carga ao artefato auditado no dry-run; a reversao e dirigida pelo lote.';
comment on table public.backfill_matricula_origem is
  'Procedencia por pagamento: de qual arquivo e de qual linha veio a matricula gravada. Chave (lote, pagamento_id) admite lotes futuros sem perder historico.';

-- ---------------------------------------------------------------------------
-- 2. O MOTOR
-- ---------------------------------------------------------------------------

create or replace function public.backfill_matricula_aplicar(
  p_plano    jsonb,
  p_hash     text,
  p_esperado integer,
  p_lote     text
)
 returns jsonb
 language plpgsql
 security invoker
 set search_path to 'public'
as $fn$
declare
  v_hash text;
  v_rows integer;
  v_n    integer;
  v_lote public.backfill_matricula_lotes%rowtype;
begin
  -- GATE EXPLICITO: SO O DONO. Mesmo com INVOKER e com os revokes, a funcao
  -- declara de quem ela e.
  --
  -- `service_role` NAO aparece aqui, de proposito. Ele nao tem EXECUTE -- o
  -- revoke de PUBLIC tirou a unica via que teria -- entao citar `service_role`
  -- num gate que ele jamais alcanca seria letra morta, e pior: sugeriria ao
  -- leitor que existe um caminho pelo PostgREST. Nao existe. Esta funcao e
  -- postgres-only POR DESENHO, e e exatamente assim que `apply_migration` a
  -- executa: tudo que ele cria tem proowner = postgres.
  --
  -- Tambem nao se consulta `auth.role()`: a funcao nao depende do schema `auth`
  -- do Supabase para decidir quem pode chama-la.
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception 'backfill_matricula_aplicar e exclusiva do dono (postgres); current_user = %',
      current_user using errcode = '42501';
  end if;

  if p_lote is null or btrim(p_lote) = '' then
    raise exception 'lote obrigatorio';
  end if;
  if p_hash is null or btrim(p_hash) = '' then
    raise exception 'hash do artefato obrigatorio';
  end if;
  if coalesce(p_esperado, 0) <= 0 then
    raise exception 'quantidade esperada tem de ser positiva';
  end if;

  -- IDEMPOTENCIA, ANTES DE QUALQUER COISA.
  --   mesmo lote + mesmo hash  -> JA_APLICADO, zero mutacao, zero trilha nova;
  --   mesmo lote + hash outro  -> aborta. Um lote nomeia um artefato, so um.
  select * into v_lote from public.backfill_matricula_lotes where lote = p_lote;
  if found then
    if v_lote.artefato_hash <> p_hash then
      raise exception 'lote % ja existe com outro artefato (gravado %, recebido %)',
        p_lote, v_lote.artefato_hash, p_hash;
    end if;
    return jsonb_build_object(
      'resultado', 'JA_APLICADO', 'lote', p_lote,
      'quantidade_aplicada', v_lote.quantidade_aplicada,
      'aplicado_em', v_lote.aplicado_em, 'alteracoes', 0);
  end if;

  -- O plano vira tabela temporaria. `on commit drop`: nao sobrevive a transacao.
  create temp table _plano (
    pagamento_id            uuid,
    numero_parcela_completo text,
    matricula               text,
    arquivo_origem          text,
    linha_no_arquivo        integer
  ) on commit drop;

  insert into _plano
  select (x->>'pagamento_id')::uuid, x->>'numero_parcela_completo',
         x->>'matricula', x->>'arquivo_origem', (x->>'linha_no_arquivo')::integer
    from jsonb_array_elements(p_plano) x;

  -- ---- INVARIANTES DO PLANO (antes de olhar o banco) ----

  select count(*) into v_n from _plano;
  if v_n <> p_esperado then
    raise exception 'plano com % registros, esperado %', v_n, p_esperado;
  end if;

  if exists (select 1 from _plano
              where pagamento_id is null or numero_parcela_completo is null
                 or matricula is null or arquivo_origem is null
                 or linha_no_arquivo is null) then
    raise exception 'plano com campo obrigatorio nulo';
  end if;

  if (select count(distinct pagamento_id) from _plano) <> v_n then
    raise exception 'plano com pagamento_id repetido';
  end if;

  if (select count(distinct numero_parcela_completo) from _plano) <> v_n then
    raise exception 'plano com boleto repetido';
  end if;

  -- CANONICALIZACAO. Tem de ser identica a do dry-run, ou o hash nunca fecha:
  -- ordem por pagamento_id textual ascendente, separador '|', registro '\n',
  -- SEM newline final. `collate "C"` e obrigatorio: sem ele a ordenacao segue a
  -- collation do banco, que trata o hifen do uuid de outro jeito, e a ordem
  -- deixaria de ser a mesma que gerou o hash.
  select md5(string_agg(
           pagamento_id::text || '|' || numero_parcela_completo || '|' ||
           matricula || '|' || arquivo_origem || '|' || linha_no_arquivo::text,
           E'\n' order by pagamento_id::text collate "C"))
    into v_hash from _plano;
  if v_hash <> p_hash then
    raise exception 'plano nao confere com o artefato auditado (calculado %, esperado %)',
      v_hash, p_hash;
  end if;

  -- ---- INVARIANTES CONTRA O BANCO (ainda sem escrever) ----

  if exists (select 1 from _plano x
              left join public.pagamentos p on p.id = x.pagamento_id
             where p.id is null) then
    raise exception 'plano referencia pagamento inexistente';
  end if;

  -- O VINCULO FOI PROVADO PELO BOLETO. Se o pagamento nao tem mais exatamente
  -- o boleto auditado, a prova do dry-run nao vale mais para ele.
  if exists (select 1 from _plano x
              join public.pagamentos p on p.id = x.pagamento_id
             where coalesce(p.numero_parcela_completo, '') <> x.numero_parcela_completo) then
    raise exception 'boleto do pagamento mudou desde o dry-run';
  end if;

  if exists (select 1 from _plano x
              join public.pagamentos p on p.id = x.pagamento_id
             where p.matricula is not null) then
    raise exception 'alvo com matricula ja preenchida -- nunca sobrescrever';
  end if;

  if exists (select 1 from _plano x
              join public.pagamentos p on p.id = x.pagamento_id
             where coalesce(p.tipo_pagamento, '') <> 'SANTANDER') then
    raise exception 'alvo fora de tipo_pagamento SANTANDER';
  end if;

  -- O boleto tem de continuar unico NO BANCO. `numero_parcela_completo` nao e
  -- unico na tabela -- foi medido: 37 boletos com 2+ pagamentos. Um alvo que
  -- virou multiplo desde o dry-run sai fora.
  if exists (select 1 from _plano x
              join public.pagamentos p on p.numero_parcela_completo = x.numero_parcela_completo
             group by x.pagamento_id having count(p.id) > 1) then
    raise exception 'alvo com boleto multiplo no banco';
  end if;

  -- ---- ESCRITA ----

  insert into public.backfill_matricula_lotes
         (lote, artefato_hash, quantidade_esperada, status)
  values (p_lote, p_hash, p_esperado, 'APLICADO');

  insert into public.backfill_matricula_origem
         (lote, pagamento_id, numero_parcela_completo, matricula, arquivo_origem, linha_no_arquivo)
  select p_lote, x.pagamento_id, x.numero_parcela_completo, x.matricula,
         x.arquivo_origem, x.linha_no_arquivo
    from _plano x;

  -- UMA coluna, por id, com a guarda de nulo. Nada mais do pagamento e tocado.
  update public.pagamentos p
     set matricula = x.matricula
    from _plano x
   where p.id = x.pagamento_id
     and p.matricula is null;
  get diagnostics v_rows = row_count;

  if v_rows <> p_esperado then
    raise exception 'gravou % linhas, previsto % -- rollback total', v_rows, p_esperado;
  end if;

  update public.backfill_matricula_lotes
     set quantidade_aplicada = v_rows
   where lote = p_lote;

  return jsonb_build_object(
    'resultado', 'APLICADO', 'lote', p_lote,
    'alteracoes', v_rows, 'artefato_hash', p_hash);
end;
$fn$;

comment on function public.backfill_matricula_aplicar(jsonb, text, integer, text) is
  'Motor generico de backfill da matricula Prime. Recebe o plano, o hash do artefato, a contagem esperada e o lote -- nada disso vive no repositorio. Confere doze invariantes antes de escrever, grava so pagamentos.matricula e exige ROW_COUNT igual ao previsto, senao levanta excecao e desfaz tudo. Chamada administrativa postgres-only: nao tem caminho pela interface, e nem service_role executa.';

revoke all on function public.backfill_matricula_aplicar(jsonb, text, integer, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. PROVA
-- ---------------------------------------------------------------------------

do $prova$
declare v_src text; v_codigo text;
begin
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'backfill_matricula_aplicar';
  if v_src is null then
    raise exception 'a funcao nao foi criada';
  end if;

  -- INVOKER, nunca DEFINER
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.proname='backfill_matricula_aplicar'
                and p.prosecdef) then
    raise exception 'a funcao ficou SECURITY DEFINER';
  end if;

  -- a guarda de nulo tem de estar no UPDATE
  if v_codigo not like '%and p.matricula is null%' then
    raise exception 'o update perdeu a guarda de matricula nula';
  end if;

  -- a conferencia de ROW_COUNT tem de existir
  if v_codigo not like '%get diagnostics v_rows = row_count%' then
    raise exception 'o motor nao mede row_count';
  end if;

  -- nada de anon/authenticated
  if has_function_privilege('anon',
       'public.backfill_matricula_aplicar(jsonb, text, integer, text)', 'EXECUTE')
  or has_function_privilege('authenticated',
       'public.backfill_matricula_aplicar(jsonb, text, integer, text)', 'EXECUTE') then
    raise exception 'a funcao ficou executavel por anon ou authenticated';
  end if;

  -- O CODIGO, NAO O COMENTARIO. O comentario do gate explica POR QUE
  -- service_role nao esta la -- e compararia contra si mesmo.
  v_codigo := regexp_replace(v_src, '--[^\n]*', '', 'g');

  -- o gate e do dono, e nao pode citar service_role (que nao tem EXECUTE)
  if v_codigo like '%service_role%' then
    raise exception 'o gate voltou a citar service_role, que nao executa a funcao';
  end if;
  if v_codigo not like '%exclusiva do dono (postgres)%' then
    raise exception 'o gate deixou de ser postgres-only';
  end if;

  -- a trilha nao pode ser legivel pelo PostgREST
  if has_table_privilege('anon', 'public.backfill_matricula_origem', 'SELECT')
  or has_table_privilege('authenticated', 'public.backfill_matricula_origem', 'SELECT') then
    raise exception 'a trilha ficou legivel por anon ou authenticated';
  end if;
end $prova$;
