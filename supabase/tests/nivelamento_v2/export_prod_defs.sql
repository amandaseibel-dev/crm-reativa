-- EXPORT SOMENTE LEITURA — dependencias reais da V2 (funcoes + DDL minimo de tabelas).
-- Nao altera nada (transacao read only). Nao contem dados de tabelas.
-- Saida: UM objeto JSON com:
--   funcoes: fechamento de dependencias por nome (profundidade 3), texto exato
--            (pg_get_functiondef) e sha256 calculado no banco;
--   tabelas: DDL minimo (colunas, tipo, NOT NULL, default, chave primaria) das
--            tabelas citadas pelas funcoes;
--   sha256_do_bloco: sha256 do texto canonico do bloco, para o CI conferir.
--
-- USO (na sua maquina; PROD_READONLY_URL deve existir no seu ambiente e nao ser colada aqui):
--   psql -X -q -At -v ON_ERROR_STOP=1 "$PROD_READONLY_URL" -f supabase/tests/nivelamento_v2/export_prod_defs.sql \
--        > supabase/tests/nivelamento_v2/prod_defs.json
\set QUIET on
begin read only;
with recursive seed(nsp, nome) as (values
  ('public','assumir_caso_livre'),('public','calibragem_teto_operador'),
  ('public','caso_protegido_redistribuicao'),('public','caso_encerrado_operacional'),
  ('public','aluno_saldo_pendente_detalhe'),('public','calibragem_e_gestao'),
  ('public','saldo_titulos_aberto'),('public','caso_em_giro_fidelizacao'),
  ('public','caso_dentro_prazo_fidelizacao'),('public','nome_operador_por_email'),
  ('internal','matricula_em_fidelizacao'),('internal','operador_pode_receber_caso'),
  ('internal','carteira_geral_email')),
clos as (
  select p.oid, 0 nivel
    from seed s join pg_namespace n on n.nspname = s.nsp
    join pg_proc p on p.pronamespace = n.oid and p.proname = s.nome
  union
  select p2.oid, c.nivel + 1
    from clos c join pg_proc p1 on p1.oid = c.oid
    join pg_proc p2 on p2.oid <> p1.oid
    join pg_namespace n2 on n2.oid = p2.pronamespace and n2.nspname in ('public','internal')
   where c.nivel < 3
     and pg_get_functiondef(p1.oid) ~ ('(^|[^a-z_])' || p2.proname || '[[:space:]]*\(')
),
fn as (
  select distinct on (c.oid) n.nspname, p.proname,
         pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def
    from clos c join pg_proc p on p.oid = c.oid join pg_namespace n on n.oid = p.pronamespace
),
tabnomes as (
  select distinct m[1] nome
    from fn, regexp_matches(fn.def, '(?:public\.)?([a-z_][a-z0-9_]*)', 'g') m
),
tab as (
  select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in (select nome from tabnomes)
),
colunas as (
  select t.relname, a.attnum, a.attname,
         format_type(a.atttypid, a.atttypmod) tipo,
         a.attnotnull nn,
         pg_get_expr(d.adbin, d.adrelid) dflt
    from tab t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
),
ddl as (
  select relname,
         'create table public.' || quote_ident(relname) || ' (' || E'\n  ' ||
         string_agg(quote_ident(attname) || ' ' || tipo ||
                    case when dflt is not null then ' default ' || dflt else '' end ||
                    case when nn then ' not null' else '' end,
                    E',\n  ' order by attnum) || E'\n);' sql_ddl
    from colunas group by relname
)
select jsonb_pretty(jsonb_build_object(
  'versao_export', 1,
  'funcoes', (select coalesce(jsonb_agg(jsonb_build_object(
                 'schema', nspname, 'nome', proname, 'args', args,
                 'sha256', encode(sha256(convert_to(def, 'UTF8')), 'hex'),
                 'def', def) order by nspname, proname, args), '[]'::jsonb) from fn),
  'tabelas', (select coalesce(jsonb_agg(jsonb_build_object(
                 'nome', relname,
                 'sha256', encode(sha256(convert_to(sql_ddl, 'UTF8')), 'hex'),
                 'ddl', sql_ddl) order by relname), '[]'::jsonb) from ddl)
));
commit;
