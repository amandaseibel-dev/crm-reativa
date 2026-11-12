-- EXPORT SOMENTE LEITURA — dependencias reais da V2.
-- Transacao read only. Nao altera nada. Nao exporta dados de tabelas.
-- Saida: UM objeto JSON (stdout). Falha explicitamente (sem JSON) se houver
-- referencia dinamica (EXECUTE/format em corpo) ou dependencia nao resolvida.
\set QUIET on
\set ON_ERROR_STOP on
begin read only;

create temporary table _seed(nsp text, nome text) on commit drop;
insert into _seed values
  ('public','assumir_caso_livre'),('public','calibragem_teto_operador'),
  ('public','caso_protegido_redistribuicao'),('public','caso_encerrado_operacional'),
  ('public','aluno_saldo_pendente_detalhe'),('public','calibragem_e_gestao'),
  ('public','saldo_titulos_aberto'),('public','caso_em_giro_fidelizacao'),
  ('public','caso_dentro_prazo_fidelizacao'),('public','nome_operador_por_email'),
  ('internal','matricula_em_fidelizacao'),('internal','operador_pode_receber_caso'),
  ('internal','carteira_geral_email');

-- Fechamento por ponto fixo: entra toda funcao public/internal cujo nome aparece
-- como chamada `nome(` no corpo de uma funcao ja incluida.
create temporary table _clos(oid oid primary key) on commit drop;
insert into _clos
with recursive c(oid) as (
  select p.oid from _seed s join pg_namespace n on n.nspname = s.nsp
    join pg_proc p on p.pronamespace = n.oid and p.proname = s.nome
  union
  select p2.oid from c join pg_proc p1 on p1.oid = c.oid
    join pg_proc p2 on p2.oid <> p1.oid
    join pg_namespace n2 on n2.oid = p2.pronamespace and n2.nspname in ('public','internal')
   where pg_get_functiondef(p1.oid) ~ ('(^|[^a-z_])' || p2.proname || '[[:space:]]*\(')
)
select oid from c;

-- Texto das definicoes materializado uma vez; as checagens operam sobre o texto.
create temporary table _defs on commit drop as
select c.oid, p.proname, pg_get_functiondef(p.oid) def
  from _clos c join pg_proc p on p.oid = c.oid;

do $$
declare v_dinamico text; v_nao_resolvido text;
begin
  select string_agg(d.proname, ', ') into v_dinamico
    from _defs d
   where d.def ~* '(^|[^a-z_])(execute|format)[[:space:]]*\('
      or d.def ~* '[[:space:]]execute[[:space:]]';
  if v_dinamico is not null then
    raise exception 'EXPORT RECUSADO: referencia dinamica (EXECUTE/format) em: %', v_dinamico;
  end if;

  create temporary table _nr on commit drop as
  select distinct p2.proname nome
    from _defs d1
    join pg_namespace n2 on n2.nspname in ('public','internal')
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.oid not in (select oid from _clos)
   where d1.def ~ ('(^|[^a-z_])' || p2.proname || '[[:space:]]*\(');
  select string_agg(nome, ', ') into v_nao_resolvido from _nr;
  if v_nao_resolvido is not null then
    raise exception 'EXPORT RECUSADO: dependencias nao resolvidas: %', v_nao_resolvido;
  end if;
end $$;

create temporary table _fn on commit drop as
select n.nspname, d.proname, pg_get_function_identity_arguments(d.oid) args, d.def
  from _defs d join pg_proc p on p.oid = d.oid join pg_namespace n on n.oid = p.pronamespace;

create temporary table _tabnome on commit drop as
select distinct m[1] nome
  from _fn, regexp_matches(_fn.def, '([a-z_][a-z0-9_]*)', 'g') m;

create temporary table _tab on commit drop as
select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relname in (select nome from _tabnome);

create temporary table _col on commit drop as
select t.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) tipo,
       a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) dflt, a.atttypid
  from _tab t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum;

create temporary table _enum on commit drop as
select distinct ty.typname, ns.nspname, ty.oid enum_oid
  from _col c join pg_type ty on ty.oid = c.atttypid join pg_namespace ns on ns.oid = ty.typnamespace
 where ty.typtype = 'e';

create temporary table _enum_ddl on commit drop as
select e.nspname, e.typname,
       'create type ' || quote_ident(e.nspname) || '.' || quote_ident(e.typname) || ' as enum (' ||
       (select string_agg(quote_literal(l.enumlabel), ', ' order by l.enumsortorder)
          from pg_enum l where l.enumtypid = e.enum_oid) || ');' sql_ddl
  from _enum e;

create temporary table _con on commit drop as
select cl.relname, k.contype, k.conname,
       (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
          from unnest(k.conkey) with ordinality u(attnum, ord)
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) cols
  from pg_constraint k join pg_class cl on cl.oid = k.conrelid
 where k.contype in ('p','u') and cl.relname in (select relname from _tab);

create temporary table _tab_ddl on commit drop as
select c.relname,
       'create table public.' || quote_ident(c.relname) || ' (' || E'\n  ' ||
       (select string_agg(quote_ident(x.attname) || ' ' || x.tipo ||
                 case when x.dflt is not null then ' default ' || x.dflt else '' end ||
                 case when x.nn then ' not null' else '' end, E',\n  ' order by x.attnum)
          from _col x where x.relname = c.relname) ||
       coalesce((select E',\n  ' || string_agg(
                    case when k.contype = 'p' then 'primary key ' else 'unique ' end || '(' || k.cols || ')',
                    E',\n  ' order by k.conname)
                   from _con k where k.relname = c.relname), '') ||
       E'\n);' sql_ddl
  from (select distinct relname from _col) c;

select jsonb_pretty(jsonb_build_object(
  'versao_export', 2,
  'tipos', (select coalesce(jsonb_agg(jsonb_build_object(
               'nome', typname,
               'sha256', encode(sha256(convert_to(sql_ddl, 'UTF8')), 'hex'),
               'ddl', sql_ddl) order by typname), '[]'::jsonb) from _enum_ddl),
  'tabelas', (select coalesce(jsonb_agg(jsonb_build_object(
               'nome', relname,
               'sha256', encode(sha256(convert_to(sql_ddl, 'UTF8')), 'hex'),
               'ddl', sql_ddl) order by relname), '[]'::jsonb) from _tab_ddl),
  'funcoes', (select coalesce(jsonb_agg(jsonb_build_object(
               'schema', nspname, 'nome', proname, 'args', args,
               'sha256', encode(sha256(convert_to(def, 'UTF8')), 'hex'),
               'def', def) order by nspname, proname, args), '[]'::jsonb) from _fn)
));
commit;
