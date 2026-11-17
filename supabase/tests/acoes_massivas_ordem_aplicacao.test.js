// Ordem de APLICACAO e REVERSAO das migrations pendentes, imposta por guardas no banco.
//  - 20261113100000 (confirmacao) recusa se a protecao de e-mail 20261113100100 nao estiver efetiva.
//  - 20261113100100 rollback recusa se acoes_massivas_concluir_envio existir (depende da protecao).
//  - rollbacks de 100000 e 100100 recusam se houver lote pendente (estado efetivo).
// Toda recusa e verificada com preservacao: md5 das funcoes, existencia, contagens.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, alunos, comoGestao } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const AGUARDANDO = "supabase/aguardando_aprovacao/";
const CONFIRMACAO = ler(AGUARDANDO + "20261113100000_acoes_massivas_confirmar_envio.sql.pendente");
const CONFIRMACAO_RB = ler(AGUARDANDO + "20261113100000_acoes_massivas_confirmar_envio.rollback.sql");
const PROTECAO = ler(AGUARDANDO + "20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente");
const PROTECAO_RB = ler(AGUARDANDO + "20261113100100_acoes_massivas_email_so_apos_tabulacao.rollback.sql");
const EXPORTAR_PUBLICADO = ler("supabase/tests/fixtures/acoes_massivas_confirmar_envio/prod_20261113_exportar.sql");
const REGISTRAR_PROD = ler("supabase/tests/fixtures/producao/registrar_acao_massiva_2026-11-15.sql");
const ESQUEMA_REPO = ler("supabase/migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql");
const EMAIL_PROD = ler("supabase/tests/fixtures/acoes_massivas_email_so_apos_tabulacao/prod_20261116_exportar_emails_do_lote.sql");
const FIDELIZACAO_PROD = ler("supabase/tests/fixtures/acoes_massivas_email_so_apos_tabulacao/prod_20261116_fidelizacao_protege.sql");
const COLUNAS = `
  alter table public.alunos add column if not exists status_acionamento text;
  alter table public.alunos add column if not exists data_retorno date;
  alter table public.alunos add column if not exists retorno_origem text;
  alter table public.casos  add column if not exists data_retorno date;`;
const GESTAO_EMAIL = "gestao.teste@reativa.local";

const MD5_EXPORTAR_PUBLICADO = "c9cc7498d16ca250e85c4727c8bb05bd";
const MD5_EXPORTAR_FINAL = "3861da11bfb0930fc698ce8e1ca05a35";
const MD5_EMAIL_PUBLICADO = "00d3370a7800bd334292808e1573a57d";
const MD5_EMAIL_FINAL = "1881bd1d0f362be586233264a396fcfd";

async function banco() {
  const db = await novoBanco({ registroAutomatico: true });
  await db.exec(ESQUEMA_REPO);
  await db.exec(COLUNAS);
  await db.exec(FIDELIZACAO_PROD);
  await db.exec(EMAIL_PROD);
  await db.exec(EXPORTAR_PUBLICADO);
  await db.exec(REGISTRAR_PROD);
  await comoGestao(db);
  return db;
}
const md5f = async (db, nome) => (await db.query(
  `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0]?.m ?? null;
const estado = async (db) => ({
  exportar: await md5f(db, "acoes_massivas_exportar"),
  email: await md5f(db, "acoes_massivas_exportar_emails_do_lote"),
  concluir: (await db.query(`select to_regprocedure('public.acoes_massivas_concluir_envio(uuid,text,text[])') r`)).rows[0].r,
  lotes: (await db.query(`select count(*)::int c from public.acoes_massivas_lotes`)).rows[0].c,
  pendentes: (await db.query(`select count(*)::int c from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null`)).rows[0].c,
  movs: (await db.query(`select count(*)::int c from public.aluno_movimentacoes`)).rows[0].c,
  status: (await db.query(`select count(*)::int c from public.alunos where status_acionamento is not null`)).rows[0].c,
});
// Recusa: a migration roda numa transacao; o erro a aborta e o banco real desfaria tudo.
async function recusada(db, sql, padrao) {
  await expect(db.exec(sql)).rejects.toThrow(padrao);
  await db.exec("ROLLBACK").catch(() => {});
}
async function lotePendente(db) {
  const ids = (await db.query(`select id::text id from public.alunos where id::text like '00000000-0000-4000-8000-%' order by id limit 2`)).rows.map((r) => r.id);
  await db.query(
    `insert into public.acoes_massivas_lotes (canal, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca, recencia_dias)
     values ('WHATSAPP', 'pendente.xlsx', $1::text[], 2, $2, 'MENSALIDADES', 10)`,
    [`{${ids.join(",")}}`, GESTAO_EMAIL]);
}
async function semAlunos(db) { await alunos(db, 2, { valor: 300 }); }

describe("ordem de aplicacao: 20261113100100 antes de 20261113100000", () => {
  it("PROIBIDA: aplicar a confirmacao sem a protecao de e-mail e recusada, e nada muda", async () => {
    const db = await banco();
    await semAlunos(db);
    const antes = await estado(db);
    expect(antes.email).toBe(MD5_EMAIL_PUBLICADO);
    await recusada(db, CONFIRMACAO, /Ordem: aplique 20261113100100/);
    expect(await estado(db)).toEqual(antes);
  });

  it("PERMITIDA: protecao primeiro, depois confirmacao", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    expect(await md5f(db, "acoes_massivas_exportar_emails_do_lote")).toBe(MD5_EMAIL_FINAL);
    await db.exec(CONFIRMACAO);
    const e = await estado(db);
    expect(e.exportar).toBe(MD5_EXPORTAR_FINAL);
    expect(e.concluir).not.toBeNull();
    expect(e.email).toBe(MD5_EMAIL_FINAL);
  });

  it("PROIBIDA: aplicar a protecao duas vezes e recusado (md5 ja mudou), sem alteracao", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    const antes = await estado(db);
    await recusada(db, PROTECAO, /mudou desde a validacao/);
    expect(await estado(db)).toEqual(antes);
  });
});

describe("ordem de reversao: confirmacao antes da protecao; zero pendentes", () => {
  it("NAO BLOQUEIA: lote descartado nem lote confirmado impedem a reversao (so o pendente)", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    await db.exec(CONFIRMACAO);
    const ids = (await db.query(`select id::text id from public.alunos where id::text like '00000000-0000-4000-8000-%' order by id limit 2`)).rows.map((r) => r.id);
    await db.query(
      `insert into public.acoes_massivas_lotes (canal, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca, recencia_dias, descartado_em, descartado_por_email)
       values ('WHATSAPP', 'descartado.xlsx', $1::text[], 2, $2, 'MENSALIDADES', 10, now(), $2)`, [`{${ids.join(",")}}`, GESTAO_EMAIL]);
    await db.exec(CONFIRMACAO_RB);
    expect((await estado(db)).pendentes).toBe(0);
    expect((await estado(db)).exportar).toBe(MD5_EXPORTAR_PUBLICADO);
  });

  it("PROIBIDA: reverter a protecao enquanto a confirmacao depende dela e recusado, e nada muda", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    await db.exec(CONFIRMACAO);
    const antes = await estado(db);
    await recusada(db, PROTECAO_RB, /Reverta 20261113100000 antes/);
    expect(await estado(db)).toEqual(antes);
  });

  it("PROIBIDA: reverter a confirmacao com lote pendente e recusado, e o lote continua pendente", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    await db.exec(CONFIRMACAO);
    await lotePendente(db);
    const antes = await estado(db);
    expect(antes.pendentes).toBe(1);
    await recusada(db, CONFIRMACAO_RB, /ha lotes de WhatsApp\/e-mail pendentes/);
    expect(await estado(db)).toEqual(antes);
  });

  it("PERMITIDA: confirmacao revertida sem pendentes, depois protecao revertida, volta a producao", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    await db.exec(CONFIRMACAO);
    await db.exec(CONFIRMACAO_RB);
    const e1 = await estado(db);
    expect(e1.exportar).toBe(MD5_EXPORTAR_PUBLICADO);
    expect(e1.concluir).toBeNull();
    await db.exec(PROTECAO_RB);
    const e2 = await estado(db);
    expect(e2.email).toBe(MD5_EMAIL_PUBLICADO);
  });

  it("PROIBIDA: reverter a protecao com lote pendente (depois da confirmacao revertida) e recusado", async () => {
    const db = await banco();
    await db.exec(PROTECAO);
    await db.exec(CONFIRMACAO);
    await db.exec(CONFIRMACAO_RB);
    await lotePendente(db);
    const antes = await estado(db);
    await recusada(db, PROTECAO_RB, /ha lotes de WhatsApp\/e-mail pendentes/);
    expect(await estado(db)).toEqual(antes);
  });
});
