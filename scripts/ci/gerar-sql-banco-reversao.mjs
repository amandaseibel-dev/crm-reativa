// Gera o SQL completo do banco DESCARTAVEL de teste da reversao (PostgreSQL real, CI).
// Ordem = a mesma do teste de ordem (supabase/tests/acoes_massivas_ordem_aplicacao.test.js):
// base + repo + colunas + fidelizacao/exportar de producao + protecao (100100) + confirmacao (100000).
// Uso: node scripts/ci/gerar-sql-banco-reversao.mjs <token> > banco.sql
import { sqlBase } from "../../supabase/tests/fixtures/acoes_massivas_universo/bancada.js";
import { readFileSync } from "node:fs";
const r = (p) => readFileSync(p, "utf8");
const token = process.argv[2];
if (!token || !/^[a-f0-9]{32}$/.test(token)) { console.error("token invalido"); process.exit(2); }
const T = "supabase/tests/fixtures";
const A = "supabase/aguardando_aprovacao";
const parts = [
  ...sqlBase({ registroAutomatico: true }),
  r("supabase/migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql"),
  `alter table public.alunos add column if not exists status_acionamento text;
   alter table public.alunos add column if not exists data_retorno date;
   alter table public.alunos add column if not exists retorno_origem text;
   alter table public.casos  add column if not exists data_retorno date;`,
  r(`${T}/acoes_massivas_email_so_apos_tabulacao/prod_20261116_fidelizacao_protege.sql`),
  r(`${T}/acoes_massivas_email_so_apos_tabulacao/prod_20261116_exportar_emails_do_lote.sql`),
  r(`${T}/acoes_massivas_confirmar_envio/prod_20261113_exportar.sql`),
  r(`${T}/producao/registrar_acao_massiva_2026-11-15.sql`),
  r(`${A}/20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente`),
  r(`${A}/20261113100000_acoes_massivas_confirmar_envio.sql.pendente`),
  `create table public.ambiente_descartavel (token text primary key);
   insert into public.ambiente_descartavel values ('${token}');`,
];
process.stdout.write(parts.join("\n;\n") + "\n");
