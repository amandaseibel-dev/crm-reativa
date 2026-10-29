-- MOTOR GENERICO DE BACKFILL DA MATRICULA PRIME, EM DOIS TEMPOS.
--
-- O QUE ESTA MIGRATION CONTEM: uma tabela de estagio, a estrutura de auditoria,
-- a funcao de aplicacao com seus invariantes, e as ACLs. SO ISSO.
--
-- O QUE ELA NAO CONTEM, DE PROPOSITO: nenhum `pagamento_id`, nenhuma matricula,
-- nenhum boleto, nenhum CPF, nenhum nome, e nenhum hash de lote. O repositorio
-- e PUBLICO (amandaseibel-dev/crm-reativa, conferido em 15/09/2026).
--
-- POR QUE DOIS TEMPOS, E NAO UM `p_plano jsonb`.
--
-- Medido em 15/09/2026 neste projeto: `auto_explain.log_min_duration` = 10000 ms
-- e `auto_explain.log_parameter_max_length` = -1. Traduzindo: consulta que passe
-- de 10 segundos tem o plano de execucao logado COM OS PARAMETROS POR INTEIRO,
-- em `postgres_logs`. Foi encontrada uma entrada real de 40.864 bytes com a
-- secao `Query Parameters` preenchida.
--
-- E nao da para desligar: `auto_explain.*` tem contexto `superuser`, e o papel
-- `postgres` deste projeto NAO e superusuario (`rolsuper = false`) -- so
-- `supabase_admin` e. A mitigacao esta fora do nosso alcance.
--
-- Entao o desenho separa QUEM CARREGA O DADO de QUEM PODE DEMORAR:
--
--   TEMPO 1 (transporte). A Edge administrativa recebe o plano no CORPO da
--   requisicao -- nunca na URL, que e logada em `request.search` -- e insere em
--   `backfill_matricula_stage` em blocos pequenos. Cada INSERT e minusculo e
--   roda em milissegundos: nunca se aproxima dos 10 s, entao nunca e logado.
--
--   TEMPO 2 (aplicacao). Esta funcao recebe SO `lote`, `hash` e `esperado`, e
--   le o plano da stage. E a chamada que pode demorar -- e ela nao carrega
--   dado nenhum como parametro. Nada a vazar.
--
-- Consequencia pratica: a chamada do tempo 2 pode ir por `apply_migration` sem
-- problema. O historico vai guardar algo como `select ... ('LOTE', '<hash>',
-- 7401)` -- e so. Nenhuma matricula, nenhum boleto, nenhum UUID.
--
-- A SENHA DO BANCO NAO ENTRA NA EDGE. A Edge so INSERE na stage, via PostgREST,
-- com `service_role`. Aplicar o backfill ela NAO pode: a funcao e postgres-only.
--
-- O QUE ELA NAO FAZ: nao cria acordo, nao cria parcela, nao mexe em titulo, nao
-- altera data, nao chama conciliacao, nao religa `consulta_portador` e nao usa
-- nada da 20260915120000. Escreve UMA coluna: `pagamentos.matricula`.

-- ---------------------------------------------------------------------------
-- 1. ESTAGIO: onde o plano aterrissa, e de onde ele some depois do sucesso
-- ---------------------------------------------------------------------------

-- Chave (lote, pagamento_id): carga repetida do mesmo lote nao duplica linha,
-- e a Edge pode reenviar um bloco sem medo depois de uma queda de conexao.
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
revoke all on table public.backfill_matricula_stage from public, anon, authenticated;

-- A Edge administrativa so precisa DEPOSITAR. Ler, apagar e aplicar sao do
-- dono. `service_role` tem bypassrls, entao o que o segura aqui e o privilegio
-- da tabela -- e ele e exatamente um: INSERT.
grant insert on table public.backfill_matricula_stage to service_role;

comment on table public.backfill_matricula_stage is
  'Aterrissagem do plano de backfill. A Edge administrativa insere em blocos pequenos (service_role, so INSERT); o motor postgres-only le, aplica e limpa. Nenhuma tela do CRM alcanca esta tabela.';

-- ---------------------------------------------------------------------------
-- 2. AUDITORIA: o lote e a linha
-- ---------------------------------------------------------------------------

create table if not exists public.backfill_matricula_lotes (
  lote                 text primary key,
  artefato_hash        text        not null,
  quantidade_esperada  integer     not null check (quantidade_esperada > 0),
  quantidade_aplicada  integer,
  status               text        not null check (status in ('APLICADO')),
  aplicado_em          timestamptz not null default now()
);

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

alter table public.backfill_matricula_lotes  enable row level security;
alter table public.backfill_matricula_origem enable row level security;

revoke all on table public.backfill_matricula_lotes  from public, anon, authenticated, service_role;
revoke all on table public.backfill_matricula_origem from public, anon, authenticated, service_role;

comment on table public.backfill_matricula_lotes is
  'Um registro por carga de backfill de matricula Prime. artefato_hash amarra a carga ao artefato auditado no dry-run; a reversao e dirigida pelo lote.';
comment on table public.backfill_matricula_origem is
  'Procedencia por pagamento: de qual arquivo e de qual linha veio a matricula gravada. Chave (lote, pagamento_id) admite lotes futuros sem perder historico.';

-- ---------------------------------------------------------------------------
-- 3. O MOTOR
-- ---------------------------------------------------------------------------

create or replace function public.backfill_matricula_aplicar(
  p_lote     text,
  p_hash     text,
  p_esperado integer
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
  -- `service_role` NAO aparece aqui, de proposito. Ele carrega a stage e nada
  -- mais: nao tem EXECUTE nesta funcao, entao cita-lo num gate que ele jamais
  -- alcanca seria letra morta, e sugeriria um caminho pelo PostgREST que nao
  -- existe. Esta funcao e postgres-only POR DESENHO, e e assim que
  -- `apply_migration` a executa: tudo que ele cria tem proowner = postgres.
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

  -- 1) LOCK DO LOTE, antes de ler qualquer coisa. Duas aplicacoes concorrentes
  -- do mesmo lote serializam aqui; a segunda so prossegue depois que a primeira
  -- commitou, e ai encontra o lote gravado e devolve JA_APLICADO. Lock de
  -- transacao: solta sozinho no commit ou no rollback, sem `unlock` explicito.
  perform pg_advisory_xact_lock(hashtext('backfill_matricula:' || p_lote));

  -- IDEMPOTENCIA, logo depois do lock.
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

  -- ---- 2 a 6: INVARIANTES DA STAGE (antes de olhar `pagamentos`) ----

  select count(*) into v_n
    from public.backfill_matricula_stage s where s.lote = p_lote;
  if v_n <> p_esperado then
    raise exception 'stage do lote % tem % linhas, esperado %', p_lote, v_n, p_esperado;
  end if;

  if exists (select 1 from public.backfill_matricula_stage s
              where s.lote = p_lote
                and (btrim(s.numero_parcela_completo) = '' or btrim(s.matricula) = ''
                     or btrim(s.arquivo_origem) = '')) then
    raise exception 'stage com campo obrigatorio vazio';
  end if;

  -- pagamento_id unico: garantido pela chave primaria, e conferido assim mesmo
  if (select count(distinct s.pagamento_id) from public.backfill_matricula_stage s
       where s.lote = p_lote) <> v_n then
    raise exception 'stage com pagamento_id repetido';
  end if;

  -- boleto unico dentro do lote
  if (select count(distinct s.numero_parcela_completo) from public.backfill_matricula_stage s
       where s.lote = p_lote) <> v_n then
    raise exception 'stage com boleto repetido';
  end if;

  -- uma unica matricula por pagamento
  if exists (select 1 from public.backfill_matricula_stage s
              where s.lote = p_lote
              group by s.pagamento_id having count(distinct s.matricula) > 1) then
    raise exception 'stage com mais de uma matricula para o mesmo pagamento';
  end if;

  -- CANONICALIZACAO. Identica a do dry-run, ou o hash nunca fecha: ordem por
  -- pagamento_id textual ascendente, separador '|', registro '\n', SEM newline
  -- final. `collate "C"` e obrigatorio: sem ele a ordenacao segue a collation
  -- do banco, que trata o hifen do uuid de outro jeito, e a ordem deixaria de
  -- ser a mesma que gerou o hash.
  select md5(string_agg(
           s.pagamento_id::text || '|' || s.numero_parcela_completo || '|' ||
           s.matricula || '|' || s.arquivo_origem || '|' || s.linha_no_arquivo::text,
           E'\n' order by s.pagamento_id::text collate "C"))
    into v_hash
    from public.backfill_matricula_stage s where s.lote = p_lote;
  if v_hash is distinct from p_hash then
    raise exception 'stage nao confere com o artefato auditado (calculado %, esperado %)',
      coalesce(v_hash, '(vazia)'), p_hash;
  end if;

  -- ---- 7: INVARIANTES CONTRA `pagamentos` (ainda sem escrever) ----

  if exists (select 1 from public.backfill_matricula_stage s
              left join public.pagamentos p on p.id = s.pagamento_id
             where s.lote = p_lote and p.id is null) then
    raise exception 'stage referencia pagamento inexistente';
  end if;

  -- O VINCULO FOI PROVADO PELO BOLETO. Se o pagamento nao tem mais exatamente
  -- o boleto auditado, a prova do dry-run nao vale mais para ele.
  if exists (select 1 from public.backfill_matricula_stage s
              join public.pagamentos p on p.id = s.pagamento_id
             where s.lote = p_lote
               and coalesce(p.numero_parcela_completo, '') <> s.numero_parcela_completo) then
    raise exception 'boleto do pagamento mudou desde o dry-run';
  end if;

  if exists (select 1 from public.backfill_matricula_stage s
              join public.pagamentos p on p.id = s.pagamento_id
             where s.lote = p_lote and p.matricula is not null) then
    raise exception 'alvo com matricula ja preenchida -- nunca sobrescrever';
  end if;

  if exists (select 1 from public.backfill_matricula_stage s
              join public.pagamentos p on p.id = s.pagamento_id
             where s.lote = p_lote and coalesce(p.tipo_pagamento, '') <> 'SANTANDER') then
    raise exception 'alvo fora de tipo_pagamento SANTANDER';
  end if;

  -- O boleto tem de continuar unico NO BANCO. `numero_parcela_completo` nao e
  -- unico na tabela -- foi medido: 37 boletos com 2+ pagamentos.
  if exists (select 1 from public.backfill_matricula_stage s
              join public.pagamentos p on p.numero_parcela_completo = s.numero_parcela_completo
             where s.lote = p_lote
             group by s.pagamento_id having count(p.id) > 1) then
    raise exception 'alvo com boleto multiplo no banco';
  end if;

  -- ---- 8 a 12: ESCRITA, tudo na mesma transacao ----

  insert into public.backfill_matricula_lotes
         (lote, artefato_hash, quantidade_esperada, status)
  values (p_lote, p_hash, p_esperado, 'APLICADO');

  insert into public.backfill_matricula_origem
         (lote, pagamento_id, numero_parcela_completo, matricula, arquivo_origem, linha_no_arquivo)
  select s.lote, s.pagamento_id, s.numero_parcela_completo, s.matricula,
         s.arquivo_origem, s.linha_no_arquivo
    from public.backfill_matricula_stage s where s.lote = p_lote;

  -- UMA coluna, por id, com a guarda de nulo. Nada mais do pagamento e tocado.
  update public.pagamentos p
     set matricula = s.matricula
    from public.backfill_matricula_stage s
   where p.id = s.pagamento_id
     and s.lote = p_lote
     and p.matricula is null;
  get diagnostics v_rows = row_count;

  if v_rows <> p_esperado then
    raise exception 'gravou % linhas, previsto % -- rollback total', v_rows, p_esperado;
  end if;

  update public.backfill_matricula_lotes
     set quantidade_aplicada = v_rows
   where lote = p_lote;

  -- A STAGE SO E LIMPA DEPOIS DO SUCESSO. Como tudo esta na mesma transacao,
  -- qualquer falha acima desfaz tambem este delete -- e as linhas ficam la,
  -- para diagnostico e reexecucao.
  delete from public.backfill_matricula_stage s where s.lote = p_lote;

  return jsonb_build_object(
    'resultado', 'APLICADO', 'lote', p_lote,
    'alteracoes', v_rows, 'artefato_hash', p_hash);
end;
$fn$;

comment on function public.backfill_matricula_aplicar(text, text, integer) is
  'Motor de backfill da matricula Prime, tempo 2. Recebe SO lote, hash e contagem -- nenhum dado pessoal como parametro, de proposito: auto_explain loga parametros por inteiro acima de 10s e nao pode ser desligado por nao-superusuario. Le o plano de backfill_matricula_stage, confere os invariantes, grava so pagamentos.matricula, exige ROW_COUNT igual ao previsto e limpa a stage apenas no sucesso. Chamada administrativa postgres-only: nem service_role executa.';

revoke all on function public.backfill_matricula_aplicar(text, text, integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. PROVA
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

  -- O CODIGO, NAO O COMENTARIO. O comentario do gate explica POR QUE
  -- service_role nao esta la -- e compararia contra si mesmo.
  v_codigo := regexp_replace(v_src, '--[^\n]*', '', 'g');

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.proname='backfill_matricula_aplicar'
                and p.prosecdef) then
    raise exception 'a funcao ficou SECURITY DEFINER';
  end if;

  -- a assinatura NAO pode voltar a receber o plano
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.proname='backfill_matricula_aplicar'
                and pg_get_function_identity_arguments(p.oid) like '%jsonb%') then
    raise exception 'a funcao voltou a receber o plano como parametro';
  end if;

  if v_codigo not like '%pg_advisory_xact_lock%' then
    raise exception 'o motor nao adquire lock do lote';
  end if;
  if v_codigo not like '%and p.matricula is null%' then
    raise exception 'o update perdeu a guarda de matricula nula';
  end if;
  if v_codigo not like '%get diagnostics v_rows = row_count%' then
    raise exception 'o motor nao mede row_count';
  end if;
  if v_codigo like '%service_role%' then
    raise exception 'o gate voltou a citar service_role, que nao executa a funcao';
  end if;
  if v_codigo not like '%exclusiva do dono (postgres)%' then
    raise exception 'o gate deixou de ser postgres-only';
  end if;

  -- ACL da funcao
  if has_function_privilege('anon',
       'public.backfill_matricula_aplicar(text, text, integer)', 'EXECUTE')
  or has_function_privilege('authenticated',
       'public.backfill_matricula_aplicar(text, text, integer)', 'EXECUTE')
  or has_function_privilege('service_role',
       'public.backfill_matricula_aplicar(text, text, integer)', 'EXECUTE') then
    raise exception 'a funcao ficou executavel por anon, authenticated ou service_role';
  end if;

  -- ACL da stage: service_role INSERE e so
  if not has_table_privilege('service_role', 'public.backfill_matricula_stage', 'INSERT') then
    raise exception 'service_role perdeu o INSERT na stage -- a Edge nao carrega';
  end if;
  if has_table_privilege('service_role', 'public.backfill_matricula_stage', 'SELECT')
  or has_table_privilege('service_role', 'public.backfill_matricula_stage', 'DELETE')
  or has_table_privilege('service_role', 'public.backfill_matricula_stage', 'UPDATE') then
    raise exception 'service_role ganhou mais que INSERT na stage';
  end if;
  if has_table_privilege('anon', 'public.backfill_matricula_stage', 'SELECT')
  or has_table_privilege('authenticated', 'public.backfill_matricula_stage', 'SELECT') then
    raise exception 'a stage ficou legivel por anon ou authenticated';
  end if;

  -- a trilha nao pode ser legivel pelo PostgREST
  if has_table_privilege('anon', 'public.backfill_matricula_origem', 'SELECT')
  or has_table_privilege('authenticated', 'public.backfill_matricula_origem', 'SELECT')
  or has_table_privilege('service_role', 'public.backfill_matricula_origem', 'SELECT') then
    raise exception 'a trilha ficou legivel fora do dono';
  end if;
end $prova$;
