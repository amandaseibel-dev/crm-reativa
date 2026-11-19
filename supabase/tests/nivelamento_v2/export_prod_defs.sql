-- EXPORT SOMENTE LEITURA — dependencias reais da V2.
-- Uma unica consulta SELECT (sem tabelas temporarias, sem DO), em transacao read only.
-- Saida: UM objeto JSON. As checagens vao DENTRO do JSON em "checagens":
--   dinamicas     : funcoes com EXECUTE/format no corpo (o importador recusa se nao vazio)
--   nao_resolvidas: funcoes public/internal citadas no corpo e fora do fechamento (idem)
-- USO: psql -X -q -At -v ON_ERROR_STOP=1 "$PROD_READONLY_URL" -f <este arquivo>
begin read only;
with recursive seed(nsp, nome) as (values
  ('public','assumir_caso_livre'),('public','calibragem_teto_operador'),
  ('public','caso_protegido_redistribuicao'),('public','caso_encerrado_operacional'),
  ('public','aluno_saldo_pendente_detalhe'),('public','calibragem_e_gestao'),
  ('public','saldo_titulos_aberto'),('public','caso_em_giro_fidelizacao'),
  ('public','caso_dentro_prazo_fidelizacao'),('public','nome_operador_por_email'),
  ('internal','matricula_em_fidelizacao'),('internal','operador_pode_receber_caso'),
  ('internal','carteira_geral_email')),
clos(oid) as (
  select p.oid from seed s join pg_namespace n on n.nspname = s.nsp
    join pg_proc p on p.pronamespace = n.oid and p.proname = s.nome
  union
  select p2.oid from clos c join pg_proc p1 on p1.oid = c.oid
    join pg_proc p2 on p2.oid <> p1.oid
    join pg_namespace n2 on n2.oid = p2.pronamespace and n2.nspname in ('public','internal')
   where pg_get_functiondef(p1.oid) ~ ('(^|[^a-z_])' || p2.proname || '[[:space:]]*\(')
),
defs as (
  select p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args,
         pg_get_functiondef(p.oid) def
    from clos c join pg_proc p on p.oid = c.oid join pg_namespace n on n.oid = p.pronamespace
),
dinamicas as (
  select coalesce(jsonb_agg(d.proname order by d.proname), '[]'::jsonb) j from defs d
   where d.def ~* '(^|[^a-z_])(execute|format)[[:space:]]*\('
),
nao_resolvidas as (
  select coalesce(jsonb_agg(x.nome order by x.nome), '[]'::jsonb) j from (
    select distinct p2.proname nome
      from defs d1
      join pg_namespace n2 on n2.nspname in ('public','internal')
      join pg_proc p2 on p2.pronamespace = n2.oid and p2.oid not in (select oid from clos)
     where d1.def ~ ('(^|[^a-z_])' || p2.proname || '[[:space:]]*\(')) x
),
tabnomes as (
  select distinct m[1] nome from defs, regexp_matches(defs.def, '([a-z_][a-z0-9_]*)', 'g') m
),
tab as (
  select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname in (select nome from tabnomes)
),
colunas as (
  select t.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) tipo,
         a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) dflt, a.atttypid
    from tab t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
),
enums as (
  select distinct ty.oid enum_oid, ty.typname, ns.nspname
    from colunas c join pg_type ty on ty.oid = c.atttypid join pg_namespace ns on ns.oid = ty.typnamespace
   where ty.typtype = 'e'
),
enum_ddl as (
  select e.nspname, e.typname,
         'create type ' || quote_ident(e.nspname) || '.' || quote_ident(e.typname) || ' as enum (' ||
         (select string_agg(quote_literal(l.enumlabel), ', ' order by l.enumsortorder)
            from pg_enum l where l.enumtypid = e.enum_oid) || ');' sql_ddl
    from enums e
),
con as (
  select cl.relname, k.contype, k.conname,
         (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
            from unnest(k.conkey) with ordinality u(attnum, ord)
            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) cols
    from pg_constraint k join pg_class cl on cl.oid = k.conrelid
   where k.contype in ('p','u') and cl.relname in (select relname from tab)
),
tab_ddl as (
  select rel.relname,
         'create table public.' || quote_ident(rel.relname) || ' (' || E'\n  ' ||
         (select string_agg(quote_ident(x.attname) || ' ' || x.tipo ||
                   case when x.dflt is not null then ' default ' || x.dflt else '' end ||
                   case when x.nn then ' not null' else '' end, E',\n  ' order by x.attnum)
            from colunas x where x.relname = rel.relname) ||
         coalesce((select E',\n  ' || string_agg(
                      case when k.contype = 'p' then 'primary key ' else 'unique ' end || '(' || k.cols || ')',
                      E',\n  ' order by k.conname)
                     from con k where k.relname = rel.relname), '') ||
         E'\n);' sql_ddl
    from (select distinct relname from colunas) rel
)
select jsonb_pretty(jsonb_build_object(
  'versao_export', 2,
  'checagens', jsonb_build_object('dinamicas', (select j from dinamicas),
                                  'nao_resolvidas', (select j from nao_resolvidas)),
  'tipos', (select coalesce(jsonb_agg(jsonb_build_object('nome', typname,
              'sha256', encode(sha256(convert_to(sql_ddl, 'UTF8')), 'hex'), 'ddl', sql_ddl)
              order by typname), '[]'::jsonb) from enum_ddl),
  'tabelas', (select coalesce(jsonb_agg(jsonb_build_object('nome', relname,
              'sha256', encode(sha256(convert_to(sql_ddl, 'UTF8')), 'hex'), 'ddl', sql_ddl)
              order by relname), '[]'::jsonb) from tab_ddl),
  'funcoes', (select coalesce(jsonb_agg(jsonb_build_object('schema', nspname, 'nome', proname,
              'args', args, 'sha256', encode(sha256(convert_to(def, 'UTF8')), 'hex'), 'def', def)
              order by nspname, proname, args), '[]'::jsonb) from defs)
));
commit;
