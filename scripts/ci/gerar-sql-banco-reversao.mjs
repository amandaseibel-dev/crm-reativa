// Gera o SQL completo do banco DESCARTAVEL de teste da reversao (PostgreSQL real, CI).
// Inclui, nesta ordem: sqlBase (papeis e schema de teste) + migration 20261006160000 + colunas
// + corpos publicados de producao (fidelizacao, exportar_emails, exportar, registrar, concluir_lote)
// + tabela ambiente_descartavel com o token.
// NAO inclui 20261113100100, 20261113100000 nem 20261113100200: essas sao aplicadas pelo teste
// de reversao (scripts/ci/teste-reversao-concorrencia.sh), na ordem de aplicacao.
// Uso: node scripts/ci/gerar-sql-banco-reversao.mjs <token> > banco.sql
// Gera o estado ANTES da 20261113100100 (corpo publicado de e-mail, 00d3370a), com os papeis
// de sistema e os corpos publicados de concluir_lote. As migrations
// pendentes (100100, 100000, 100200) e os rollbacks sao aplicados pelo teste, que mede as
// permissoes efetivas antes, depois e apos cada rollback.
import { sqlBase } from "../../supabase/tests/fixtures/acoes_massivas_universo/bancada.js";
import { readFileSync } from "node:fs";
const r = (p) => readFileSync(p, "utf8");
const token = process.argv[2];
if (!token || !/^[a-f0-9]{32}$/.test(token)) { console.error("token invalido"); process.exit(2); }
const T = "supabase/tests/fixtures";
const A = "supabase/aguardando_aprovacao";
const pre = [
  ...sqlBase({ registroAutomatico: true }),
  // Papeis de sistema: sqlBase ja os cria; este bloco so completa os que faltarem (idempotente).
  `do $r$ begin
     if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
     if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
     if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
   end $r$;`,
  r("supabase/migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql"),
  `alter table public.alunos add column if not exists status_acionamento text;
   alter table public.alunos add column if not exists data_retorno date;
   alter table public.alunos add column if not exists retorno_origem text;
   alter table public.casos  add column if not exists data_retorno date;`,
  r(`${T}/acoes_massivas_email_so_apos_tabulacao/prod_20261116_fidelizacao_protege.sql`),
  r(`${T}/acoes_massivas_email_so_apos_tabulacao/prod_20261116_exportar_emails_do_lote.sql`),
  r(`${T}/acoes_massivas_confirmar_envio/prod_20261113_exportar.sql`),
  r(`${T}/producao/registrar_acao_massiva_2026-11-15.sql`),
  r(`${T}/producao/concluir_lote_2026-11-17.sql`),
  `create table public.ambiente_descartavel (token text primary key);
   insert into public.ambiente_descartavel values ('${token}');`,
];
const parts = pre;
process.stdout.write(parts.join("\n;\n") + "\n");
