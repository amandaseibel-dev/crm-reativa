-- =====================================================================
-- SIMULACAO DE RETENCAO DAS IMPORTACOES -- acordos, projecao, bordero
-- CRM ReATIVA One  ·  07/11/2026
--
-- NATUREZA: SOMENTE LEITURA. Nenhum DROP, DELETE, TRUNCATE, UPDATE,
-- INSERT, ALTER ou CREATE. Se alguma linha deste arquivo alterar algo,
-- e defeito -- nao intencao.
--
-- NAO APLICADO. Documento de apoio ao diagnostico
-- docs/rascunhos/DIAGNOSTICO-RETENCAO-IMPORTACOES-2026-11-07.md
--
-- PITR NAO ESTA HABILITADO nesta producao. Qualquer exclusao derivada
-- deste estudo exige backup + SQL por id e autorizacao explicita da
-- gestao, com executor unico (sessao principal).
--
-- CUSTO: blocos 1 a 3 e 5 sao catalogo -- custo despreziivel.
--        BLOCO 4 conta linha em 548 relacoes. AVISAR ANTES DE RODAR.
--
-- EXECUTADO EM PRODUCAO EM 07/11/2026, com autorizacao da gestao.
-- Resultado completo em RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md.
-- Resumo do bloco 4: 548 tabelas -> 213 VAZIAS (1.704 kB) e 335 COM
-- CONTEUDO (11.645 linhas, 7.912 kB). Dependencias: nenhuma (0 FK, 0
-- indice, 0 trigger, 0 view, 0 leitor). ATENCAO: RLS habilitado nas 548
-- com 0 policies, mas `authenticated` tem TRUNCATE nas 548 -- e TRUNCATE
-- nao passa por RLS. Ver bloco 6, acrescentado depois dessa descoberta.
-- =====================================================================


-- ---------------------------------------------------------------------
-- BLOCO 1 -- Panorama: quanto o banco tem e quantos objetos
-- Custo: catalogo. Despreziivel.
-- ---------------------------------------------------------------------
select
  pg_size_pretty(pg_database_size(current_database()))              as banco_total,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p'))          as tabelas_public,
  (select pg_size_pretty(sum(pg_total_relation_size(c.oid)))
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p'))          as tamanho_public;


-- ---------------------------------------------------------------------
-- BLOCO 2 -- Candidatos por categoria: quantidade e tamanho somado
-- Custo: catalogo. Despreziivel.
-- Nenhuma destas categorias e aprovada para exclusao. E inventario.
-- ---------------------------------------------------------------------
with cat as (
  select c.relname, c.oid, pg_total_relation_size(c.oid) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p')
)
select categoria, objetos, pg_size_pretty(bytes) as tamanho, bytes
from (
  select 'A1 _backup_pos_import_* (cron desligado, sem leitor)' as categoria,
         count(*) as objetos, sum(bytes) as bytes
    from cat where relname like '\_backup\_pos\_import\_%'

  union all
  select 'A2 _backup_* de reparo de reimportacao -- NAO MEXER',
         count(*), sum(bytes)
    from cat where relname ~ '(dup_reimport|bordero723|acordo_erro_import)'

  union all
  select 'A3 outras _backup_/_excecao_ -- caso a caso',
         count(*), sum(bytes)
    from cat
   where (relname like '\_backup%' or relname like '\_excecao%')
     and relname not like '\_backup\_pos\_import\_%'
     and relname !~ '(dup_reimport|bordero723|acordo_erro_import)'

  union all
  select 'A4 *_bkp_YYYYMMDD / *backup_YYYYMMDD',
         count(*), sum(bytes)
    from cat
   where relname ~ '(_bkp_[0-9]{8}|_backup_[0-9]{8}|backup_[0-9]{8})$'

  union all
  select 'B1 TRILHA -- fica para sempre',
         count(*), sum(bytes)
    from cat where relname in ('importacoes','importacoes_acordos',
                               'academico_importacoes','importacao_acordo_critica')

  union all
  select 'B2 STAGING vazio -- conferir uso antes de qualquer coisa',
         count(*), sum(bytes)
    from cat where relname in ('borderos','base_importacoes','baixas_importadas')

  union all
  select 'B3 LASTRO de conferencia -- fica',
         count(*), sum(bytes)
    from cat where relname in ('extracao_escopo','titulo_presenca_importacao',
                               'projecao_snapshot_pagamentos')
) s
order by bytes desc nulls last;


-- ---------------------------------------------------------------------
-- BLOCO 3 -- Idade e cadencia das _backup_pos_import_*
-- O timestamp esta no proprio nome. Custo: catalogo.
-- ---------------------------------------------------------------------
select
  substring(relname from '([0-9]{8})')                      as dia,
  count(*)                                                  as tabelas_no_dia,
  pg_size_pretty(sum(pg_total_relation_size(oid)))           as tamanho_no_dia
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r','p')
  and c.relname like '\_backup\_pos\_import\_%'
group by 1
order by 1;


-- ---------------------------------------------------------------------
-- BLOCO 3b -- Prova de que ninguem le essas tabelas
-- Se vier vazio, nenhuma funcao/view do schema as referencia.
-- Custo: catalogo (pg_proc.prosrc). Despreziivel.
-- ---------------------------------------------------------------------
select p.proname, 'funcao' as objeto
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosrc like '%_backup_pos_import%'
union all
select c.relname, 'view'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v','m')
   and pg_get_viewdef(c.oid) like '%_backup_pos_import%';
-- Esperado em 07/11/2026: so `acordos_pos_importacao` (a criadora).
-- Nenhum leitor.


-- ---------------------------------------------------------------------
-- BLOCO 3c -- Os crons que alimentavam o fluxo seguem desligados?
-- Custo: catalogo. Despreziivel.
-- ---------------------------------------------------------------------
select jobname, schedule, active
  from cron.job
 where jobname in ('fluxo_acordos_diario','fluxo_pagamentos_horario',
                   'acordo_vinculo_automatico','baixa_automatica_por_titulo')
 order by jobname;
-- Esperado em 07/11/2026: todos active = false.
-- Se algum voltou a true, a categoria A1 volta a crescer e a
-- simulacao esta desatualizada.


-- ---------------------------------------------------------------------
-- BLOCO 4 -- CONTAGEM EXATA das _backup_pos_import_*
--
-- *** AVISAR A GESTAO ANTES DE RODAR ***
-- Percorre 548 relacoes com count(*). Cada uma tem 1 ou 2 paginas,
-- portanto o custo real e baixo, mas sao 548 consultas dinamicas e
-- este banco ja saturou sob carga. Rodar fora de horario de operacao.
--
-- Serve para responder o que `reltuples` NAO responde: reltuples = -1
-- significa "nunca analisada", nao "vazia". Sem este bloco nao se pode
-- afirmar que uma tabela esta vazia.
--
-- SOMENTE LEITURA: query_to_xml roda um SELECT count(*), nada mais.
-- ---------------------------------------------------------------------
select
  case when linhas = 0 then 'VAZIA -- candidata da 1a leva'
       else 'COM CONTEUDO -- exige prova de reparo encerrado' end as leva,
  count(*)                                   as tabelas,
  sum(linhas)                                as linhas_somadas,
  pg_size_pretty(sum(bytes))                 as tamanho_somado
from (
  select c.relname,
         pg_total_relation_size(c.oid) as bytes,
         (xpath('/row/cnt/text()',
                query_to_xml(format('select count(*) as cnt from public.%I', c.relname),
                             false, true, '')))[1]::text::bigint as linhas
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r','p')
     and c.relname like '\_backup\_pos\_import\_%'
) s
group by 1
order by 1;


-- ---------------------------------------------------------------------
-- BLOCO 4b -- Detalhe nominal das VAZIAS (a lista que a gestao aprova)
-- Mesmo custo do bloco 4. Rodar junto, nao separado.
-- A saida e a lista de nomes -- insumo da decisao, nao comando.
-- ---------------------------------------------------------------------
select relname, pg_size_pretty(bytes) as tamanho
from (
  select c.relname,
         pg_total_relation_size(c.oid) as bytes,
         (xpath('/row/cnt/text()',
                query_to_xml(format('select count(*) as cnt from public.%I', c.relname),
                             false, true, '')))[1]::text::bigint as linhas
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r','p')
     and c.relname like '\_backup\_pos\_import\_%'
) s
where linhas = 0
order by relname;


-- ---------------------------------------------------------------------
-- BLOCO 5 -- Trilha e staging: conferir que a trilha e intocavel
-- Custo: tabelas de centenas de linhas. Despreziivel.
-- ---------------------------------------------------------------------
select 'importacoes'               as tabela, count(*)::text as linhas,
       min(created_at)::date::text as de, max(created_at)::date::text as ate
  from public.importacoes
union all
select 'importacoes_acordos', count(*)::text,
       min(importado_em)::date::text, max(importado_em)::date::text
  from public.importacoes_acordos
union all
select 'borderos (staging)', count(*)::text,
       min(created_at)::date::text, max(created_at)::date::text
  from public.borderos
union all
select 'base_importacoes (staging)', count(*)::text,
       min(criado_em)::date::text, max(criado_em)::date::text
  from public.base_importacoes
union all
select 'baixas_importadas (staging)', count(*)::text,
       min(criado_em)::date::text, max(criado_em)::date::text
  from public.baixas_importadas;
-- Esperado em 07/11/2026: importacoes = 897, importacoes_acordos = 237,
-- e os tres staging = 0. Staging vazio nao autoriza remover a estrutura:
-- `borderos` tem `importacao_id` e remover tabela ja derrubou tela
-- neste projeto.


-- ---------------------------------------------------------------------
-- BLOCO 5b -- Cobertura do arquivo original (a lacuna, nao o excesso)
-- Custo: bucket com 21 objetos + tabela de 237 linhas. Despreziivel.
-- ---------------------------------------------------------------------
select
  (select count(*) from public.importacoes_acordos)                     as importacoes_de_acordo,
  (select count(*) from public.importacoes_acordos
    where arquivo_path is not null)                                     as com_path_registrado,
  (select count(*) from storage.objects
    where bucket_id = 'importacoes-acordos')                            as objetos_no_bucket,
  (select pg_size_pretty(coalesce(sum((metadata->>'size')::bigint),0))
     from storage.objects where bucket_id = 'importacoes-acordos')       as tamanho_no_bucket,
  (select count(*) from public.importacoes
    where tipo = 'BORDERO')                                             as borderos_importados,
  0                                                                     as arquivos_de_bordero_guardados;
-- O ultimo campo e 0 por constatacao, nao por consulta: nenhum caminho
-- do codigo faz upload de arquivo de bordero. Ver
-- src/pages/Borderos.jsx -- calcula SHA-256, nunca sobe o arquivo.


-- ---------------------------------------------------------------------
-- BLOCO 5c -- Divergencia de grafia em status (achado colateral)
-- Custo: 897 linhas. Despreziivel.
-- ---------------------------------------------------------------------
select status, count(*) as qtd
  from public.importacoes
 group by status
 order by qtd desc;
-- Esperado: CONCLUIDO=499 e Concluida=157 convivendo. Filtro por
-- status concluido erra por 157 linhas hoje.


-- ---------------------------------------------------------------------
-- BLOCO 6 -- SEGURANCA das 548 tabelas de lastro
-- Acrescentado em 07/11/2026 depois do resultado do bloco 4.
-- Custo: catalogo. Despreziivel.
--
-- RLS habilitado sem policy bloqueia linha a linha -- mas TRUNCATE NAO
-- PASSA POR RLS. Quem tem o privilegio, trunca. Este bloco mede isso.
-- ---------------------------------------------------------------------
with alvo as (
  select c.oid, c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p')
     and c.relname like '\_backup\_pos\_import\_%'
)
select 'tabelas no recorte'            as medida, count(*)::text as valor from alvo
union all
select 'com RLS habilitado',  count(*)::text from alvo where relrowsecurity
union all
select 'policies RLS',        count(*)::text from pg_policies
 where schemaname = 'public' and tablename like '\_backup\_pos\_import\_%'
union all
select 'grants a anon',       count(*)::text from information_schema.role_table_grants
 where table_schema = 'public' and table_name like '\_backup\_pos\_import\_%' and grantee = 'anon'
union all
select 'grants a authenticated', count(*)::text from information_schema.role_table_grants
 where table_schema = 'public' and table_name like '\_backup\_pos\_import\_%' and grantee = 'authenticated'
union all
select 'privilegios de authenticated',
       coalesce(string_agg(distinct privilege_type, ', ' order by privilege_type),'-')
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name like '\_backup\_pos\_import\_%' and grantee = 'authenticated';
-- Medido em 07/11/2026: 548 / 548 com RLS / 0 policies / 0 anon /
-- 3815 grants a authenticated, incluindo TRUNCATE, DELETE e UPDATE.
--
-- CONSEQUENCIA: qualquer token authenticated apaga as 11.645 linhas de
-- lastro de desfazer de acao financeira. O `revoke` correspondente e
-- migration, passa pela skill `seguranca-rls` e NAO sai desta frente.


-- =====================================================================
-- FIM. Nada acima apaga nada. Nenhuma exclusao, nenhuma rotina
-- automatica e nenhuma migration sai desta frente sem autorizacao
-- explicita da gestao.
-- =====================================================================
