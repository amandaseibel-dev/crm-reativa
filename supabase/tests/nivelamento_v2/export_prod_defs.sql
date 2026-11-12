-- EXPORT SOMENTE LEITURA das definicoes reais das 14 funcoes-dependencia da V2.
-- Nao altera nada. Nao contem dados de tabelas. Saida: um JSON por funcao com o
-- texto exato de pg_get_functiondef e o sha256 calculado no proprio banco.
--
-- USO (na sua maquina, com a URL de conexao de leitura em variavel de ambiente;
-- NAO cole a URL no chat nem no repositorio):
--   psql "$PROD_READONLY_URL" -At -v ON_ERROR_STOP=1 -f supabase/tests/nivelamento_v2/export_prod_defs.sql \
--        > supabase/tests/nivelamento_v2/prod_defs.json
-- Depois confira: shasum -a 256 supabase/tests/nivelamento_v2/prod_defs.json
\set QUIET on
set transaction read only;
begin read only;
with recursive roots as (
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('assumir_caso_livre','calibragem_teto_operador',
            'caso_protegido_redistribuicao','caso_encerrado_operacional','aluno_saldo_pendente_detalhe',
            'calibragem_e_gestao','saldo_titulos_aberto','caso_em_giro_fidelizacao',
            'caso_dentro_prazo_fidelizacao','nome_operador_por_email'))
      or (n.nspname = 'internal' and p.proname in ('matricula_em_fidelizacao',
            'operador_pode_receber_caso','carteira_geral_email'))
), clos as (
  select oid from roots
  union
  select d.refobjid from pg_depend d join clos c on d.objid = c.oid
   where d.classid = 'pg_proc'::regclass and d.refclassid = 'pg_proc'::regclass
)
select jsonb_agg(jsonb_build_object(
         'schema', n.nspname,
         'nome', p.proname,
         'args', pg_get_function_identity_arguments(p.oid),
         'sha256', encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex'),
         'def', pg_get_functiondef(p.oid))
       order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
from clos join pg_proc p on p.oid = clos.oid join pg_namespace n on n.oid = p.pronamespace;
commit;
