// Regra no BANCO: exportacao de e-mails de um lote de WhatsApp PENDENTE de envio
// e recusada, para qualquer chamador (gestao, sistema ou chamada direta a RPC).
//
// Base: definicao VIGENTE de producao de acoes_massivas_exportar_emails_do_lote
// (fixture; md5 00d3370a..., conferido no proprio teste). A migration de
// repositorio 20261006160000 NAO reproduz essa definicao (md5 3477115d...): esta
// deriva e a mesma registrada na #964 para a exportacao, e por isso o patch e
// ancorado no md5 de producao.
//
// Migration: supabase/aguardando_aprovacao/20261113100100_..._apos_tabulacao.sql.pendente
// Rollback : supabase/aguardando_aprovacao/20261113100100_..._apos_tabulacao.rollback.sql
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, alunos, comoOperador, comoGestao, OP_A } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
// Funcao de fidelizacao: so existe em producao (sem migration no repositorio).
// Mesmo tipo de deriva. O md5 de producao e cfab30b8... e e conferido no teste.
const FIDELIZACAO_PROD = ler("supabase/tests/fixtures/acoes_massivas_email_so_apos_tabulacao/prod_20261116_fidelizacao_protege.sql");
const ESQUEMA_REPO = ler("supabase/migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql");
const PROD = ler("supabase/tests/fixtures/acoes_massivas_email_so_apos_tabulacao/prod_20261116_exportar_emails_do_lote.sql");
const MIGRACAO = ler("supabase/aguardando_aprovacao/20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente");
const ROLLBACK = ler("supabase/aguardando_aprovacao/20261113100100_acoes_massivas_email_so_apos_tabulacao.rollback.sql");
const MD5_PROD = "00d3370a7800bd334292808e1573a57d";
const MD5_FINAL = "eb960a2445b786514ad8bcd0d07c102b";
const COLUNAS_TABULACAO = `
  alter table public.alunos add column if not exists status_acionamento text;
  alter table public.alunos add column if not exists data_retorno date;
  alter table public.alunos add column if not exists retorno_origem text;
  alter table public.casos  add column if not exists data_retorno date;`;
const GESTAO_EMAIL = "gestao.teste@reativa.local";

async function banco() {
  const db = await novoBanco({ registroAutomatico: true });
  // schema (colunas lote_origem_id etc.) da migration do repositorio; o corpo
  // vigente de producao da funcao vem da fixture e sobrepoe a versao do repo.
  await db.exec(ESQUEMA_REPO);
  // colunas de tabulacao que o corpo de producao escreve (a bancada nao as tem)
  await db.exec(COLUNAS_TABULACAO);
  await db.exec(FIDELIZACAO_PROD);
  await db.exec(PROD);
  return db;
}
const md5 = async (db) => (await db.query(
  `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acoes_massivas_exportar_emails_do_lote'`)).rows[0].m;
const acl = async (db) => (await db.query(
  `select coalesce(p.proacl::text, '') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acoes_massivas_exportar_emails_do_lote'`)).rows[0].a;
const deriva = (db, lote) => db.query(
  `select public.acoes_massivas_exportar_emails_do_lote($1::uuid, 'email.xlsx') r`, [lote]);
const contagens = async (db) => (await db.query(`select
  (select count(*)::int from public.acoes_massivas_lotes) lotes,
  (select count(*)::int from public.acoes_massivas_lotes where canal = 'EMAIL') lotes_email,
  (select count(*)::int from public.aluno_movimentacoes where tipo like 'ACAO_MASSIVA%') movs,
  (select count(*)::int from public.alunos where status_acionamento is not null) com_status`)).rows[0];
async function idsAlunos(db, n, ini = 1) {
  await alunos(db, n, { ini, valor: 300 });
  return (await db.query(
    `select id::text id from public.alunos where id::text like '00000000-0000-4000-8000-%'
      order by id limit $1`, [n])).rows.map((r) => r.id);
}
async function loteWhats(db, ids, { pendente = false, descartado = false, arquivo = "whats.xlsx" } = {}) {
  const r = await db.query(
    `insert into public.acoes_massivas_lotes
       (canal, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca,
        confirmado_em, confirmado_por_email, descartado_em, descartado_por_email, recencia_dias)
     values ('WHATSAPP', $1, $2::text[], $3, $4, 'MENSALIDADES', $5, $6, $7, $8, 10) returning id`,
    [arquivo, `{${ids.join(",")}}`, ids.length, GESTAO_EMAIL,
     pendente || descartado ? null : new Date().toISOString(), pendente || descartado ? null : GESTAO_EMAIL,
     descartado ? new Date().toISOString() : null, descartado ? GESTAO_EMAIL : null]);
  return r.rows[0].id;
}

describe("e-mail do lote de WhatsApp: a regra e do banco", () => {
  it("base: as funcoes de producao tem o md5 esperado e a migration chega ao md5 final", async () => {
    const db = await banco();
    const fid = (await db.query(`select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_fidelizacao_protege'`)).rows[0].m;
    expect(fid).toBe("cfab30b8673b09965a1f7098cd25e31b");
    expect(await md5(db)).toBe(MD5_PROD);
    await db.exec(MIGRACAO);
    expect(await md5(db)).toBe(MD5_FINAL);
  });

  it("a migration nao muda ACL nem dado: contagens iguais antes e depois", async () => {
    const db = await banco();
    const ids = await idsAlunos(db, 3);
    await loteWhats(db, ids, { pendente: true });
    const aclAntes = await acl(db);
    const antes = await contagens(db);
    await db.exec(MIGRACAO);
    expect(await acl(db)).toBe(aclAntes);
    expect(await contagens(db)).toEqual(antes);
  });

  it("chamada direta com lote PENDENTE (gestao) e recusada, sem gravar nada", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 3);
    const lote = await loteWhats(db, ids, { pendente: true });
    await comoGestao(db);
    const antes = await contagens(db);
    await expect(deriva(db, lote)).rejects.toThrow(/ainda esta pendente de envio/);
    expect(await contagens(db)).toEqual(antes);
  });

  it("sistema (service_role, sem usuario de gestao) e recusado para lote pendente, com SQLSTATE 55000", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 2);
    const lote = await loteWhats(db, ids, { pendente: true });
    // sessao de servico: role service_role, sem e-mail de gestao
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: "service_role" })]);
    const erro = await deriva(db, lote).then(() => null, (e) => e);
    expect(erro).not.toBeNull();
    expect(String(erro.message)).toMatch(/ainda esta pendente de envio/);
    expect(erro.code).toBe("55000");
    expect((await contagens(db)).lotes_email).toBe(0);
  });

  it("chamada sem sessao de usuario (sistema) tambem e recusada para lote pendente", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 2);
    const lote = await loteWhats(db, ids, { pendente: true });
    await expect(deriva(db, lote)).rejects.toThrow(/ainda esta pendente de envio/);
    expect((await contagens(db)).lotes_email).toBe(0);
  });

  it("operador nao exporta e-mail nem de lote confirmado (permissao antes da regra)", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 2);
    const confirmado = await loteWhats(db, ids);
    await comoOperador(db, OP_A);
    await expect(deriva(db, confirmado)).rejects.toThrow(/Acesso negado|42501/);
  });

  it("lote CONFIRMADO deriva como antes, e o lote de WhatsApp de origem nao e tocado", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 3);
    const lote = await loteWhats(db, ids);
    const origemAntes = (await db.query(`select confirmado_em, confirmado_por_email, total from public.acoes_massivas_lotes where id = $1`, [lote])).rows[0];
    await comoGestao(db);
    const r = (await deriva(db, lote)).rows[0].r;
    expect(r.lote_id).toBeTruthy();
    expect(r.registrados).toBe(3);
    expect((await db.query(`select confirmado_em, confirmado_por_email, total from public.acoes_massivas_lotes where id = $1`, [lote])).rows[0]).toEqual(origemAntes);
  });

  it("lote que a gestao confirma depois (tabulacao do envio) passa a derivar", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 2);
    const lote = await loteWhats(db, ids, { pendente: true });
    await comoGestao(db);
    await expect(deriva(db, lote)).rejects.toThrow(/pendente/);
    await db.query(`update public.acoes_massivas_lotes set confirmado_em = now(), confirmado_por_email = $2 where id = $1`, [lote, GESTAO_EMAIL]);
    const r = (await deriva(db, lote)).rows[0].r;
    expect(r.registrados).toBe(2);
  });

  it("lote DESCARTADO continua recusado, pela mensagem de descarte", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 2);
    const lote = await loteWhats(db, ids, { descartado: true });
    await comoGestao(db);
    await expect(deriva(db, lote)).rejects.toThrow(/foi descartado/);
  });

  it("nao depende de lista: com 60 lotes pendentes na base, o veredito do lote alvo e o mesmo", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 3);
    for (let i = 0; i < 60; i++) await loteWhats(db, [ids[0]], { pendente: true, arquivo: `outro-${i}.xlsx` });
    const confirmado = await loteWhats(db, ids);
    const pendente = await loteWhats(db, ids.slice(0, 1), { pendente: true });
    await comoGestao(db);
    expect((await deriva(db, confirmado)).rows[0].r.registrados).toBe(3);
    await expect(deriva(db, pendente)).rejects.toThrow(/pendente/);
  });

  it("a migration recusa aplicar sobre outra versao da funcao (guarda de md5) e nada e alterado", async () => {
    const db = await novoBanco({ registroAutomatico: true });
    await db.exec(ESQUEMA_REPO);
    await db.exec(COLUNAS_TABULACAO);
    await db.exec(FIDELIZACAO_PROD);
    const alterada = PROD.replace("v_reg int := 0;", "v_reg int := 1;");
    expect(alterada).not.toBe(PROD);
    await db.exec(alterada);
    const antes = await md5(db);
    await expect(db.exec(MIGRACAO)).rejects.toThrow(/mudou desde a validacao/);
    // a migration roda numa transacao: o erro a aborta; o banco real desfaria tudo
    await db.exec("ROLLBACK").catch(() => {});
    expect(await md5(db)).toBe(antes);
  });

  it("rollback volta ao corpo de producao: recusado com lote pendente; com o lote confirmado, a regra some", async () => {
    const db = await banco();
    await db.exec(MIGRACAO);
    const ids = await idsAlunos(db, 2);
    const lote = await loteWhats(db, ids, { pendente: true });
    await comoGestao(db);
    await expect(deriva(db, lote)).rejects.toThrow(/pendente/);
    // reversao recusada enquanto ha lote pendente (zero pendentes e condicao de reversao)
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/ha lotes de WhatsApp\/e-mail pendentes/);
    await db.exec("ROLLBACK").catch(() => {});
    expect(await md5(db)).toBe(MD5_FINAL);
    // o lote e tabulado (confirmado); so entao a reversao e permitida
    await db.query(`update public.acoes_massivas_lotes set confirmado_em = now(), confirmado_por_email = $2 where id = $1`, [lote, GESTAO_EMAIL]);
    await db.exec(ROLLBACK);
    expect(await md5(db)).toBe(MD5_PROD);
    expect((await deriva(db, lote)).rows[0].r.registrados).toBe(2);
  });
});
