// ACAO MASSIVA: a movimentacao carrega o status da tabulacao (status_novo).
//
// Parte das definicoes PUBLICADAS em producao em 12/11/2026 (fixture
// prod_20261112_registro_e_email_do_lote.sql -- registrar_acao_massiva
// 6eb41bf1..., acoes_massivas_exportar_emails_do_lote 00d3370a... e o helper de
// fidelizacao), reproduz o defeito, aplica a migration pendente 20261112235000
// e comprova que SO a movimentacao muda: a regra de 19/10 fica igual.
// Nenhum dado real.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, alunos, previa, exportar, comoGestao } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const MIG_EMAIL = ler("../migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql");
const PUBLICADO = ler("fixtures/acao_massiva_status_na_movimentacao/prod_20261112_registro_e_email_do_lote.sql");
const MIG = ler("../aguardando_aprovacao/20261112235000_acao_massiva_status_na_movimentacao.sql.pendente");
const ROLLBACK = ler("../aguardando_aprovacao/20261112235000_acao_massiva_status_na_movimentacao.rollback.sql");
const emTransacao = (sql) => "BEGIN;\n" + sql + "\nCOMMIT;";

const STATUS = "Ação massiva externa enviada — aguardando retorno";
const MD5 = {
  registrar: { antes: "6eb41bf1dd68fcfb4eb44b9022b43e44", depois: "a7309034dd1e07e27b4164b7c11d91b3" },
  email: { antes: "00d3370a7800bd334292808e1573a57d", depois: "a8ca35582ae84e7038417d622e54b693" },
};

let db;
beforeEach(async () => {
  db = await novoBanco({ registroAutomatico: true, semRetornoAutomatico: true });
  await db.exec(`alter table public.casos add column if not exists data_retorno date;`);
  // colunas que existem em producao e faltam neste duble
  await db.exec(`alter table public.aluno_movimentacoes add column if not exists status_anterior text;
                 alter table public.aluno_movimentacoes add column if not exists status_novo text;`);
  await db.exec(MIG_EMAIL);          // tabela/colunas do e-mail derivado do lote
  await db.exec(PUBLICADO);          // os corpos que rodam em producao hoje
  await comoGestao(db);
});

const md5 = async (nome) => (await db.query(
  `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0].m;
const movs = async (lote) => (await db.query(
  `select aluno_id, tipo, status_anterior, status_novo, lote_id from public.aluno_movimentacoes
    where lote_id = $1 order by aluno_id`, [lote])).rows;
const aluno = async (id) => (await db.query(
  `select status_acionamento, status_jornada, status_atual, data_retorno::text as data_retorno, retorno_origem
     from public.alunos where id = $1`, [id])).rows[0];
const emDias = async (n) => (await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0].d;
const meta = async () => (await db.query(
  `select p.proname, pg_get_userbyid(p.proowner) dono, p.prosecdef, p.provolatile, p.proconfig::text config,
          coalesce(p.proacl::text, '') acl, pg_get_function_identity_arguments(p.oid) args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('registrar_acao_massiva', 'acoes_massivas_exportar_emails_do_lote')
    order by 1`)).rows;

async function exportarWhats(limite, operador = "TODOS") {
  const p = await previa(db, { p_canal: "WHATSAPP", p_limite: limite, p_operador_email: operador });
  return exportar(db, p.elegiveis.map((e) => e.id), { canal: "WHATSAPP", operador, previa_id: p.previa_id });
}
const emailDoLote = async (lote) => (await db.query(
  `select public.acoes_massivas_exportar_emails_do_lote($1::uuid, 'email.xlsx') r`, [lote])).rows[0].r;

describe("publicado hoje (antes da migration)", () => {
  it("o fixture reproduz os MD5 de producao", async () => {
    expect(await md5("registrar_acao_massiva")).toBe(MD5.registrar.antes);
    expect(await md5("acoes_massivas_exportar_emails_do_lote")).toBe(MD5.email.antes);
  });

  it("DEFEITO: o aluno e tabulado, mas a movimentacao sai sem status_novo", async () => {
    const ids = await alunos(db, 3, { ini: 1 });
    const r = await exportarWhats(10);
    const m = await movs(r.lote_id);
    expect(m).toHaveLength(3);
    expect(m.every((x) => x.status_novo === null)).toBe(true);
    for (const id of ids) expect((await aluno(id)).status_acionamento).toBe(STATUS);
  });
});

describe("depois da migration 20261112235000", () => {
  beforeEach(async () => { await db.exec(emTransacao(MIG)); });

  it("MD5 finais sao os validados", async () => {
    expect(await md5("registrar_acao_massiva")).toBe(MD5.registrar.depois);
    expect(await md5("acoes_massivas_exportar_emails_do_lote")).toBe(MD5.email.depois);
  });

  it("WhatsApp: toda movimentacao do lote carrega o status da acao", async () => {
    await alunos(db, 4, { ini: 1 });
    const r = await exportarWhats(10);
    const m = await movs(r.lote_id);
    expect(m).toHaveLength(4);
    for (const x of m) {
      expect(x.tipo).toBe("ACAO_MASSIVA_EXTERNA");
      expect(x.status_novo).toBe(STATUS);
      expect(x.status_anterior).toBeNull();
    }
    expect(Number(r.registrados)).toBe(4);
  });

  it("regra de 19/10 preservada: status do aluno, retorno +10 no aluno e no caso, origem AUTOMATICO", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await exportarWhats(10);
    const a = await aluno(id);
    expect(a.status_acionamento).toBe(STATUS);
    expect(a.data_retorno).toBe(await emDias(10));
    expect(a.retorno_origem).toBe("AUTOMATICO");
    const c = (await db.query(`select data_retorno::text d from public.casos where aluno_id = $1`, [id])).rows[0];
    expect(c.d).toBe(await emDias(10));
  });

  it("status da jornada e status atual NAO sao tocados", async () => {
    const [id] = await alunos(db, 1, { ini: 1, statusJornada: "EM_NEGOCIACAO", statusAtual: "EM_NEGOCIACAO" });
    await exportarWhats(10);
    const a = await aluno(id);
    expect(a.status_jornada).toBe("EM_NEGOCIACAO");
    expect(a.status_atual).toBe("EM_NEGOCIACAO");
  });

  it("a recalculadora continua sem ser chamada", async () => {
    await alunos(db, 3, { ini: 1 });
    await exportarWhats(10);
    expect((await db.query(`select count(*)::int n from public._recalc_log`)).rows[0].n).toBe(0);
  });

  it("e-mail derivado do lote de WhatsApp: movimentacao com o mesmo status", async () => {
    await alunos(db, 3, { ini: 1 });                         // sem responsavel: fidelizacao nao se aplica
    const w = await exportarWhats(10);
    const e = await emailDoLote(w.lote_id);
    expect(e.lote_id).toBeTruthy();
    const m = await movs(e.lote_id);
    expect(m).toHaveLength(3);
    for (const x of m) {
      expect(x.tipo).toBe("ACAO_MASSIVA_EXTERNA_EMAIL");
      expect(x.status_novo).toBe(STATUS);
    }
  });

  it("nao reprocessa: lote registrado antes da migration segue sem status_novo", async () => {
    await db.exec(emTransacao(ROLLBACK));                    // volta ao publicado
    await alunos(db, 2, { ini: 1 });
    const antigo = await exportarWhats(10);
    await db.exec(emTransacao(MIG));                         // aplica de novo
    await alunos(db, 2, { ini: 11 });
    const novo = await exportarWhats(10);
    expect((await movs(antigo.lote_id)).every((x) => x.status_novo === null)).toBe(true);
    expect((await movs(novo.lote_id)).every((x) => x.status_novo === STATUS)).toBe(true);
  });

  it("uma movimentacao por aluno no lote: repetir o registro nao duplica", async () => {
    const ids = await alunos(db, 2, { ini: 1 });
    const r = await exportarWhats(10);
    await db.query(
      `select public.registrar_acao_massiva($1::text[], 'WHATSAPP', 'x.xlsx', null, null, 'todos', $2::uuid, null)`,
      [`{${ids.join(",")}}`, r.lote_id]);
    expect(await movs(r.lote_id)).toHaveLength(2);
  });

  it("seguranca: dono, security definer, search_path, timeout e grants identicos", async () => {
    await db.exec(emTransacao(ROLLBACK));
    await db.exec(`revoke all on function public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb) from public;
                   grant execute on function public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb) to authenticated;
                   revoke all on function public.acoes_massivas_exportar_emails_do_lote(uuid,text) from public;
                   grant execute on function public.acoes_massivas_exportar_emails_do_lote(uuid,text) to authenticated;`);
    const antes = await meta();
    expect(antes).toHaveLength(2);
    expect(antes.every((f) => f.prosecdef && f.config.includes("search_path=public"))).toBe(true);
    await db.exec(emTransacao(MIG));
    expect(await meta()).toEqual(antes);
    await db.exec(emTransacao(ROLLBACK));
    expect(await meta()).toEqual(antes);
  });

  it("rollback volta aos MD5 publicados e recusa rodar duas vezes", async () => {
    await db.exec(emTransacao(ROLLBACK));
    expect(await md5("registrar_acao_massiva")).toBe(MD5.registrar.antes);
    expect(await md5("acoes_massivas_exportar_emails_do_lote")).toBe(MD5.email.antes);
    await expect(db.exec(emTransacao(ROLLBACK))).rejects.toThrow(/Rollback abortado/);
    await db.exec("ROLLBACK;").catch(() => {});
  });
});

describe("guardas da migration", () => {
  it("aborta sem alterar nada se uma das funcoes publicadas for outra", async () => {
    await db.exec(`create or replace function public.acoes_massivas_exportar_emails_do_lote(p_lote_id uuid, p_arquivo text default null)
                   returns jsonb language plpgsql as $f$ begin return '{}'::jsonb; end $f$;`);
    const antes = await md5("registrar_acao_massiva");
    await expect(db.exec(emTransacao(MIG))).rejects.toThrow(/Nada aplicado/);
    await db.exec("ROLLBACK;").catch(() => {});
    expect(await md5("registrar_acao_massiva")).toBe(antes);
  });

  it("nao aplica duas vezes", async () => {
    await db.exec(emTransacao(MIG));
    await expect(db.exec(emTransacao(MIG))).rejects.toThrow(/Nada aplicado/);
    await db.exec("ROLLBACK;").catch(() => {});
    expect(await md5("registrar_acao_massiva")).toBe(MD5.registrar.depois);
  });
});
