-- RASTREABILIDADE DA IMPORTACAO DE ACORDOS — P1, P2 e P3.
--
-- Por que existe. Em 23/10/2026 a gestao perguntou "tivemos alguma critica no
-- relatorio de importacao de parcelas? como vamos saber?" e a resposta medida
-- foi: nao vamos. `importacoes_acordos` guarda SO contadores; 136 importacoes
-- de ACORDOS estao 100% "Concluída" e nenhuma tem observacao; o arquivo e lido
-- no navegador e nunca sai dele; e `ImportacaoAcordos.jsx` descarta linha com
-- `continue` sem contador nenhum. Uma importacao que derrubasse 40 linhas
-- sairia com a mesma cara de uma perfeita.
--
-- O que esta migration faz, e so isto:
--   P1  preserva o ARQUIVO original em bucket privado e grava a identificacao
--       da importacao (path, md5, bytes, linhas);
--   P2  registra CRITICA POR LINHA, classificada em tres naturezas distintas
--       -- REJEICAO, DUPLICIDADE e IGNORADA_POR_REGRA -- porque tratar as tres
--       como "erro" e o que faria a operacao parar de olhar;
--   P3  expoe as criticas por RPC para a tela de Importacoes consultar e
--       exportar.
--
-- O QUE ELA NAO FAZ. Nao altera acordo, titulo, parcela, status financeiro,
-- baixa nem saldo. Nao mexe em `importacoes.status`: mudar o valor gravado ali
-- (hoje sempre 'Concluída') mexeria com quem le aquela coluna, e a exigencia de
-- "nao considerar sucesso uma importacao parcial" e atendida onde ela importa
-- -- `importar_acordos` passa a DEVOLVER o resumo das criticas, e a tela nao
-- consegue mais pintar sucesso sem elas.
--
-- Nao reconstroi critica historica. As 136 importacoes anteriores nao deixaram
-- evidencia por linha, e inventar critica retroativa seria produzir fato sem
-- prova. A trilha comeca na proxima importacao -- igual a trilha de presenca
-- (J3/I1) comecou na dela.
--
-- COMPATIBILIDADE. `registrar_importacao_acordo` NAO e tocada: trocar a
-- assinatura dela criaria sobrecarga ambigua no PostgREST e quebraria o
-- frontend ja publicado. O dado do arquivo entra por uma funcao nova e
-- separada. Os acrescimos em `importar_acordos` vao por
-- `internal.patch_funcao_ancorada`, que exige a ancora no numero exato de
-- ocorrencias e falha fechado se producao tiver mudado.
--
-- Corpo de producao ancorado aqui: md5 d858a3b13b204dcfe29ab41fa192e7c5
-- (8.057 caracteres), colhido em 23/10/2026.
--
-- Idempotente. Rollback:
--   supabase/rollbacks/20261023190000_importacao_acordos_rastreabilidade.rollback.sql

begin;

------------------------------------------------------------------------------
-- P1.1  Identificacao do arquivo na importacao.
--       Colunas novas, todas opcionais: importacao antiga segue valida com
--       tudo nulo, e nenhuma consulta existente muda de resultado.
--       `criticas_total` NAO existe de proposito -- e derivavel, e estado
--       derivado guardado e estado que vai divergir.
------------------------------------------------------------------------------
alter table public.importacoes_acordos
  add column if not exists arquivo_path          text,
  add column if not exists arquivo_sha256           text,
  add column if not exists arquivo_bytes         bigint,
  add column if not exists linhas_arquivo        integer,
  add column if not exists linhas_fora_do_escopo integer;

comment on column public.importacoes_acordos.arquivo_path is
  'Caminho do arquivo original no bucket privado importacoes-acordos. NULL = arquivo nao preservado (importacao anterior a 23/10/2026, ou falha de upload declarada na tela).';
comment on column public.importacoes_acordos.arquivo_sha256 is
  'SHA-256 do arquivo como chegou ao navegador (o mesmo que hashArquivo calcula, 64 hex). E o que liga a critica ao arquivo exato que a produziu. `extracao_escopo.arquivo_hash` guarda o MESMO hash, mas so quando a captura de presenca rodou -- 48 escopos para 136 importacoes de ACORDOS. Esta coluna e o registro incondicional.';
comment on column public.importacoes_acordos.linhas_arquivo is
  'Total de linhas da planilha, antes de qualquer filtro do importador.';
comment on column public.importacoes_acordos.linhas_fora_do_escopo is
  'Linhas de tipo diferente de Acordo. NAO viram critica por linha: a trilha de presenca (J3/I1) ja guarda cada uma, e duplicar daria milhares de linhas por importacao.';

------------------------------------------------------------------------------
-- P1.2  Bucket privado do arquivo.
--       Padrao dos buckets financeiros do projeto: privado, com limite de
--       tamanho e MIME alinhados ao que a tela realmente envia (.xlsx/.xls/.csv).
------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('importacoes-acordos', 'importacoes-acordos', false, 52428800, array[
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'text/csv'])
on conflict (id) do update
   set public             = false,
       file_size_limit    = 52428800,
       allowed_mime_types = excluded.allowed_mime_types;

-- Quem importa escreve; so a gestao le. Sem UPDATE e sem DELETE: o arquivo
-- preservado e para conferir depois, nao para ser corrigido depois.
drop policy if exists importacao_acordo_arquivo_gravar on storage.objects;
create policy importacao_acordo_arquivo_gravar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'importacoes-acordos'
              and public.app_pode_borderos_importacoes());

drop policy if exists importacao_acordo_arquivo_ler on storage.objects;
create policy importacao_acordo_arquivo_ler on storage.objects
  for select to authenticated
  using (bucket_id = 'importacoes-acordos'
         and public.usuario_e_gestao());

------------------------------------------------------------------------------
-- P1.3  Gravar a identificacao do arquivo.
--       Portao = `app_pode_borderos_importacoes()`, o MESMO de
--       `importar_acordos`. De proposito: se este portao fosse o da gestao,
--       quem importa sem ser gestao gravaria a importacao e perderia o
--       registro do arquivo em silencio.
--       A linha pode nao existir ainda -- a tela chama isto logo apos o upload,
--       ANTES de importar, para que o arquivo fique registrado mesmo se a
--       importacao falhar depois.
------------------------------------------------------------------------------
create or replace function public.registrar_importacao_acordo_arquivo(
  p_importacao_id        uuid,
  p_arquivo_path         text,
  p_arquivo_sha256          text,
  p_arquivo_bytes        bigint,
  p_linhas_arquivo       integer,
  p_arquivo_nome         text    default null,
  p_linhas_fora_do_escopo integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'SEM_PERMISSAO_IMPORTACAO_BORDERO';
  end if;
  if p_importacao_id is null then
    raise exception 'importacao_id e obrigatorio';
  end if;

  insert into public.importacoes_acordos as i
    (importacao_id, arquivo_nome, importado_por, importado_em,
     arquivo_path, arquivo_sha256, arquivo_bytes, linhas_arquivo, linhas_fora_do_escopo)
  values
    (p_importacao_id, p_arquivo_nome, auth.jwt() ->> 'email', now(),
     p_arquivo_path, p_arquivo_sha256, p_arquivo_bytes, p_linhas_arquivo, p_linhas_fora_do_escopo)
  on conflict (importacao_id) do update set
    arquivo_nome          = coalesce(i.arquivo_nome, excluded.arquivo_nome),
    arquivo_path          = coalesce(excluded.arquivo_path, i.arquivo_path),
    arquivo_sha256           = coalesce(excluded.arquivo_sha256, i.arquivo_sha256),
    arquivo_bytes         = coalesce(excluded.arquivo_bytes, i.arquivo_bytes),
    linhas_arquivo        = coalesce(excluded.linhas_arquivo, i.linhas_arquivo),
    linhas_fora_do_escopo = coalesce(excluded.linhas_fora_do_escopo, i.linhas_fora_do_escopo);
end;
$fn$;

revoke all on function public.registrar_importacao_acordo_arquivo(uuid,text,text,bigint,integer,text,integer)
  from public, anon;
grant execute on function public.registrar_importacao_acordo_arquivo(uuid,text,text,bigint,integer,text,integer)
  to authenticated;

------------------------------------------------------------------------------
-- P2.1  A critica por linha.
--
-- TRES NATUREZAS, nunca "erro" para tudo:
--   REJEICAO           a linha nao pode ser lida (documento sem digito). E
--                      defeito do arquivo, e alguem precisa olhar.
--   DUPLICIDADE        a linha ja esta representada por um registro igual
--                      (mesmo documento ja e titulo; acordo sinalizado como
--                      duplicado). Nao e defeito do arquivo nem do CRM.
--   IGNORADA_POR_REGRA a linha foi deixada de fora por uma decisao de negocio
--                      que ja existia (CPF quitado nos ultimos 7 dias; divida
--                      ja representada por parcela ou acordo). E comportamento
--                      correto -- so precisava ser visivel.
--
-- DADO PESSOAL: guarda o minimo que identifica a linha -- CPF, documento,
-- vencimento e valor. NAO guarda nome, unidade nem situacao do aluno: o nome e
-- resolvido na LEITURA, por join, e o CPF sai mascarado. Guardar o nome aqui
-- seria uma segunda copia de dado pessoal sem nenhum ganho de conferencia.
------------------------------------------------------------------------------
create table if not exists public.importacao_acordo_critica (
  id            bigserial primary key,
  importacao_id uuid        not null,
  classe        text        not null,
  motivo_codigo text        not null,
  origem        text        not null,
  linha_numero  integer,
  documento     text,
  acordo_ulbra  text,
  cpf           text,
  vencimento    date,
  valor         numeric,
  detectado_em  timestamptz not null default now(),

  constraint importacao_acordo_critica_classe_ck
    check (classe in ('REJEICAO', 'DUPLICIDADE', 'IGNORADA_POR_REGRA')),
  constraint importacao_acordo_critica_origem_ck
    check (origem in ('ARQUIVO', 'SERVIDOR')),
  -- classe e motivo nao sao independentes: o par e fixo, e o banco e que
  -- garante. Sem isto, a mesma causa apareceria em classes diferentes
  -- dependendo de quem escreveu, e o resumo por classe perderia sentido.
  constraint importacao_acordo_critica_par_ck check (
       (motivo_codigo = 'documento_invalido'          and classe = 'REJEICAO')
    or (motivo_codigo = 'titulo_ja_existe'            and classe = 'DUPLICIDADE')
    or (motivo_codigo = 'acordo_duplicado_sinalizado' and classe = 'DUPLICIDADE')
    or (motivo_codigo = 'cpf_quitado_recente'         and classe = 'IGNORADA_POR_REGRA')
    or (motivo_codigo = 'divida_ja_representada'      and classe = 'IGNORADA_POR_REGRA'))
);

create index if not exists ix_importacao_acordo_critica_lote
  on public.importacao_acordo_critica (importacao_id, classe, motivo_codigo);

-- INTEGRIDADE DO LOTE. A importacao vai em pedacos de 1.200 linhas, todos sob
-- o mesmo importacao_id e o mesmo advisory lock. Esta unicidade e o que impede
-- que reenviar um pedaco conte a mesma critica duas vezes.
create unique index if not exists ux_importacao_acordo_critica_identidade
  on public.importacao_acordo_critica (
       importacao_id, motivo_codigo,
       coalesce(documento, ''), coalesce(acordo_ulbra, ''),
       coalesce(cpf, ''), coalesce(linha_numero, -1));

alter table public.importacao_acordo_critica enable row level security;

drop policy if exists importacao_acordo_critica_ler on public.importacao_acordo_critica;
create policy importacao_acordo_critica_ler on public.importacao_acordo_critica
  for select to authenticated
  using (public.usuario_e_gestao());

-- Tabela nova HERDA do schema public o grant de arwdDxtm para authenticated --
-- TRUNCATE incluido, e RLS nao cobre TRUNCATE. Endurecer e o padrao do
-- projeto: tira tudo e devolve so SELECT. Escrita so pelas funcoes
-- SECURITY DEFINER abaixo.
revoke all on table public.importacao_acordo_critica from public, anon, authenticated;
grant select on table public.importacao_acordo_critica to authenticated;
revoke all on sequence public.importacao_acordo_critica_id_seq from public, anon, authenticated;

comment on table public.importacao_acordo_critica is
  'Uma linha por linha recusada, duplicada ou ignorada numa importacao de acordos. Comeca em 23/10/2026: nao ha critica historica, e nenhuma foi reconstruida.';

------------------------------------------------------------------------------
-- P2.2  Critica vinda do ARQUIVO (a tela).
--       A tela e a unica que conhece o NUMERO DA LINHA, porque e ela que le a
--       planilha -- e por isso e ela que reporta `documento_invalido`.
--       Aceita SO esse motivo: se aceitasse qualquer um, um cliente poderia
--       fabricar duplicidade que o banco nunca viu.
------------------------------------------------------------------------------
create or replace function public.importacao_acordo_critica_registrar(
  p_importacao_id uuid,
  p_criticas      jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_n integer := 0;
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'SEM_PERMISSAO_IMPORTACAO_BORDERO';
  end if;
  if p_importacao_id is null then
    raise exception 'importacao_id e obrigatorio';
  end if;
  if p_criticas is null or jsonb_typeof(p_criticas) <> 'array' then
    return 0;
  end if;

  insert into public.importacao_acordo_critica
    (importacao_id, classe, motivo_codigo, origem, linha_numero, documento, cpf, vencimento, valor)
  select p_importacao_id, 'REJEICAO', 'documento_invalido', 'ARQUIVO',
         nullif(c->>'linha', '')::integer,
         -- CRU, nao normalizado: o valor desta critica e justamente mostrar o
         -- que estava na celula. Normalizado para digito, "TOTAL" e "458342O"
         -- (com a letra O) virariam os dois nulo, e a conferencia nao teria
         -- como distinguir linha de total de documento digitado errado.
         -- Limitado a 40 caracteres para nao carregar texto livre de planilha.
         nullif(left(trim(coalesce(c->>'documento', '')), 40), ''),
         nullif(regexp_replace(coalesce(c->>'cpf', ''), '\D', '', 'g'), ''),
         nullif(c->>'venc', '')::date,
         nullif(c->>'valor', '')::numeric
    from jsonb_array_elements(p_criticas) c
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

revoke all on function public.importacao_acordo_critica_registrar(uuid,jsonb) from public, anon;
grant execute on function public.importacao_acordo_critica_registrar(uuid,jsonb) to authenticated;

------------------------------------------------------------------------------
-- P3.1  Consulta das criticas, para a tela e para a exportacao.
--       CPF sai MASCARADO; o nome vem por join lateral com limit 1 (o mesmo
--       CPF tem ficha duplicada na base, e sem o limit a consulta multiplicaria
--       a critica por ficha).
------------------------------------------------------------------------------
create or replace function public.importacao_acordo_critica_listar(p_importacao_id uuid)
returns table (
  id            bigint,
  classe        text,
  motivo_codigo text,
  origem        text,
  linha_numero  integer,
  documento     text,
  acordo_ulbra  text,
  cpf_mascarado text,
  nome          text,
  vencimento    date,
  valor         numeric,
  detectado_em  timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select c.id, c.classe, c.motivo_codigo, c.origem, c.linha_numero,
         c.documento, c.acordo_ulbra,
         case when c.cpf is null or length(c.cpf) < 5 then null
              else left(c.cpf, 3) || '.***.***-' || right(c.cpf, 2) end,
         al.nome, c.vencimento, c.valor, c.detectado_em
    from public.importacao_acordo_critica c
    left join lateral (
      select a.nome from public.alunos a
       where regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g') = c.cpf
       order by a.id limit 1) al on true
   where public.usuario_e_gestao()
     and c.importacao_id = p_importacao_id
   order by c.classe, c.motivo_codigo, c.linha_numero nulls last, c.id;
$fn$;

revoke all on function public.importacao_acordo_critica_listar(uuid) from public, anon;
grant execute on function public.importacao_acordo_critica_listar(uuid) to authenticated;

------------------------------------------------------------------------------
-- P3.2  Resumo por classe e motivo. E o que a tela usa para dizer, na lista
--       de importacoes, que aquela importacao TEM critica -- sem precisar
--       carregar as linhas.
------------------------------------------------------------------------------
create or replace function public.importacao_acordo_critica_resumo(p_importacao_id uuid default null)
returns table (
  importacao_id uuid,
  classe        text,
  motivo_codigo text,
  total         bigint)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select c.importacao_id, c.classe, c.motivo_codigo, count(*)
    from public.importacao_acordo_critica c
   where public.usuario_e_gestao()
     and (p_importacao_id is null or c.importacao_id = p_importacao_id)
   group by 1, 2, 3
   order by 1, 2, 3;
$fn$;

revoke all on function public.importacao_acordo_critica_resumo(uuid) from public, anon;
grant execute on function public.importacao_acordo_critica_resumo(uuid) to authenticated;

------------------------------------------------------------------------------
-- P2.3  Os acrescimos em `importar_acordos`.
--
-- Cinco patches ANCORADOS. Cada um exige a ancora UMA vez; se producao tiver
-- mudado naquele trecho, `patch_funcao_ancorada` falha e esta migration nao
-- aplica nada. Nenhum patch remove, altera ordem ou muda condicao existente --
-- todos ACRESCENTAM um insert na tabela de critica, e nada mais.
------------------------------------------------------------------------------

-- (1) REJEICAO: documento sem digito nenhum. Rede de seguranca do servidor.
select internal.patch_funcao_ancorada(
  'public', 'importar_acordos',
  $anc$  create index on _imp(cpf);$anc$,
  $novo$  create index on _imp(cpf);

  -- P2: linha cujo documento nao tem digito nenhum nao entra em _imp (o filtro
  -- `documento <> ''` logo acima) e, ate 23/10/2026, desaparecia sem contador.
  -- Rede de seguranca para um chamador que nao seja a tela: a tela ja barra
  -- documento com menos de 6 digitos e reporta cada linha COM o numero dela.
  insert into public.importacao_acordo_critica
    (importacao_id, classe, motivo_codigo, origem, cpf, vencimento, valor)
  select p_importacao_id, 'REJEICAO', 'documento_invalido', 'SERVIDOR',
         nullif(regexp_replace(coalesce(l->>'cpf',''),'\D','','g'),''),
         nullif(l->>'venc','')::date, nullif(l->>'valor','')::numeric
    from jsonb_array_elements(p_linhas) l
   where regexp_replace(coalesce(l->>'documento',''),'\D','','g') = ''
  on conflict do nothing;$novo$,
  1);

-- (2) IGNORADA_POR_REGRA: CPF quitado nos ultimos 7 dias, com acordo.
--     Entra ANTES do delete que aplica a regra -- depois dele a linha nao
--     existe mais em _imp e nao haveria o que registrar.
select internal.patch_funcao_ancorada(
  'public', 'importar_acordos',
  $anc$  delete from _imp i using _pular p where p.cpf_n = i.cpf;$anc$,
  $novo$  -- P2: regra de negocio que ja existia (quitado ha 7 dias e com acordo),
  -- agora visivel linha por linha. Nao e erro: e a protecao funcionando.
  insert into public.importacao_acordo_critica
    (importacao_id, classe, motivo_codigo, origem, documento, cpf, vencimento, valor)
  select p_importacao_id, 'IGNORADA_POR_REGRA', 'cpf_quitado_recente', 'SERVIDOR',
         i.documento, nullif(i.cpf,''), i.venc, i.valor
    from _imp i join _pular p on p.cpf_n = i.cpf
  on conflict do nothing;

  delete from _imp i using _pular p where p.cpf_n = i.cpf;$novo$,
  1);

-- (3) DUPLICIDADE (titulo ja existe) e IGNORADA_POR_REGRA (divida ja
--     representada). Medidos ANTES do insert em acordos_titulos: depois dele,
--     os titulos recem-criados tambem casariam e a critica acusaria uma
--     duplicidade que nao existia.
select internal.patch_funcao_ancorada(
  'public', 'importar_acordos',
  $anc$  select count(*) into v_ja_representados from _imp i$anc$,
  $novo$  -- P2: mesmo documento JA e titulo no CRM. Duplicidade, nao erro.
  insert into public.importacao_acordo_critica
    (importacao_id, classe, motivo_codigo, origem, documento, cpf, vencimento, valor)
  select p_importacao_id, 'DUPLICIDADE', 'titulo_ja_existe', 'SERVIDOR',
         i.documento, nullif(i.cpf,''), i.venc, i.valor
    from _imp i
   where exists (select 1 from public.acordos_titulos t where t.documento = i.documento)
  on conflict do nothing;

  -- P2: a divida ja esta representada por parcela ou por acordo vivo -- a
  -- MESMA condicao que alimenta v_ja_representados, agora com identidade.
  insert into public.importacao_acordo_critica
    (importacao_id, classe, motivo_codigo, origem, documento, cpf, vencimento, valor)
  select p_importacao_id, 'IGNORADA_POR_REGRA', 'divida_ja_representada', 'SERVIDOR',
         i.documento, nullif(i.cpf,''), i.venc, i.valor
    from _imp i
   where exists (select 1 from public.parcelas p where p.boleto = ltrim(i.documento,'0'))
      or (i.documento ~ '^\d{12}$'
          and exists (select 1 from public.acordos a
                       where a.numero_ulbra = substr(i.documento,4,5)
                         and upper(coalesce(a.status,'')) <> 'CANCELADO'))
  on conflict do nothing;

  select count(*) into v_ja_representados from _imp i$novo$,
  1);

-- (4) DUPLICIDADE: acordo que o gatilho sinalizou como duplicado neste lote.
select internal.patch_funcao_ancorada(
  'public', 'importar_acordos',
  $anc$  select count(*) into v_dup from public.acordos a
   where a.duplicado_de is not null and a.observacao like '%'||p_importacao_id::text;$anc$,
  $novo$  select count(*) into v_dup from public.acordos a
   where a.duplicado_de is not null and a.observacao like '%'||p_importacao_id::text;

  -- P2: o acordo duplicado ja era SINALIZADO (decisao de 27/08/2026: sinalizar
  -- em vez de barrar) e contado em v_dup. Passa a ter identidade.
  insert into public.importacao_acordo_critica
    (importacao_id, classe, motivo_codigo, origem, acordo_ulbra, cpf)
  select p_importacao_id, 'DUPLICIDADE', 'acordo_duplicado_sinalizado', 'SERVIDOR',
         a.numero_ulbra, nullif(regexp_replace(coalesce(a.cpf,''),'\D','','g'),'')
    from public.acordos a
   where a.duplicado_de is not null and a.observacao like '%'||p_importacao_id::text
  on conflict do nothing;$novo$,
  1);

-- (5) O retorno passa a CARREGAR o resumo das criticas.
--     E isto que impede a tela de pintar sucesso sem elas: a resposta da
--     propria importacao traz o total e a quebra por classe, no mesmo objeto
--     onde a tela ja le os contadores.
select internal.patch_funcao_ancorada(
  'public', 'importar_acordos',
  $anc$                           'importacao_id',p_importacao_id);$anc$,
  $novo$                           'criticas_total',(select count(*) from public.importacao_acordo_critica
                                                      where importacao_id = p_importacao_id),
                           'criticas_por_classe',(select coalesce(jsonb_object_agg(k.classe, k.n), '{}'::jsonb)
                                                    from (select classe, count(*) as n
                                                            from public.importacao_acordo_critica
                                                           where importacao_id = p_importacao_id
                                                           group by classe) k),
                           'importacao_id',p_importacao_id);$novo$,
  1);

------------------------------------------------------------------------------
-- GUARDA. Falha a migration inteira se qualquer peca nao ficou de pe.
------------------------------------------------------------------------------
do $guarda$
declare v_corpo text; v_falta text;
begin
  -- 1) colunas de P1
  select string_agg(c, ', ') into v_falta from (
    select c from unnest(array['arquivo_path','arquivo_sha256','arquivo_bytes',
                               'linhas_arquivo','linhas_fora_do_escopo']) c
     where not exists (select 1 from information_schema.columns
                        where table_schema='public' and table_name='importacoes_acordos'
                          and column_name = c)) q;
  if v_falta is not null then
    raise exception 'P1: faltam colunas em importacoes_acordos: %', v_falta;
  end if;

  -- 2) as tres restricoes de classificacao de P2
  select string_agg(c, ', ') into v_falta from (
    select c from unnest(array['importacao_acordo_critica_classe_ck',
                               'importacao_acordo_critica_origem_ck',
                               'importacao_acordo_critica_par_ck']) c
     where not exists (select 1 from pg_constraint
                        where conrelid = 'public.importacao_acordo_critica'::regclass
                          and conname = c)) q;
  if v_falta is not null then
    raise exception 'P2: faltam restricoes na tabela de critica: %', v_falta;
  end if;

  -- 3) a unicidade que garante a integridade do lote
  if not exists (select 1 from pg_class where relname = 'ux_importacao_acordo_critica_identidade') then
    raise exception 'P2: sem a unicidade por identidade, reenviar um pedaco contaria a critica duas vezes';
  end if;

  -- 4) os cinco acrescimos entraram no corpo de importar_acordos
  select pg_get_functiondef('public.importar_acordos(jsonb,uuid)'::regprocedure) into v_corpo;
  select string_agg(c, ', ') into v_falta from (
    select c from unnest(array['documento_invalido','cpf_quitado_recente','titulo_ja_existe',
                               'divida_ja_representada','acordo_duplicado_sinalizado',
                               'criticas_total']) c
     where position(c in v_corpo) = 0) q;
  if v_falta is not null then
    raise exception 'P2: importar_acordos nao registra: %', v_falta;
  end if;

  -- 5) o portao de escrita e o MESMO da importacao, nao o da gestao
  if position('app_pode_borderos_importacoes' in
              pg_get_functiondef('public.importacao_acordo_critica_registrar(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'P2: a gravacao de critica tem de usar o portao da importacao';
  end if;

  -- 6) leitura so para a gestao, nas duas funcoes de consulta
  if position('usuario_e_gestao' in
              pg_get_functiondef('public.importacao_acordo_critica_listar(uuid)'::regprocedure)) = 0
     or position('usuario_e_gestao' in
              pg_get_functiondef('public.importacao_acordo_critica_resumo(uuid)'::regprocedure)) = 0 then
    raise exception 'P3: consulta de critica sem portao de gestao';
  end if;

  -- 7) authenticated nao pode ter mais que SELECT na tabela de critica
  if exists (select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='importacao_acordo_critica'
                and grantee='authenticated' and privilege_type <> 'SELECT') then
    raise exception 'P2: authenticated ficou com privilegio alem de SELECT na tabela de critica';
  end if;

  -- 8) anon nao executa nenhuma das funcoes novas
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema='public' and grantee='anon'
                and routine_name in ('registrar_importacao_acordo_arquivo',
                                     'importacao_acordo_critica_registrar',
                                     'importacao_acordo_critica_listar',
                                     'importacao_acordo_critica_resumo')) then
    raise exception 'anon ficou com execute em funcao nova';
  end if;

  -- 9) o bucket do arquivo e privado
  if exists (select 1 from storage.buckets where id = 'importacoes-acordos' and public is true) then
    raise exception 'P1: o bucket do arquivo importado ficou publico';
  end if;
end;
$guarda$;

commit;
