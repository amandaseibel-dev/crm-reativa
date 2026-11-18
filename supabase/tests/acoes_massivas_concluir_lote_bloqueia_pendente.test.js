// ACOES MASSIVAS: concluir_lote NAO confirma integralmente lote PENDENTE de envio (20261113100200).
//
// Bancada PGlite (Postgres real, dados inventados). Ordem: 100100 (protecao de e-mail),
// 100000 (confirmacao por destinatario) e so depois 100200 (esta protecao).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, alunos, previa, exportar, comoGestao,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const EXPORTAR_PUBLICADO = ler("fixtures/acoes_massivas_confirmar_envio/prod_20261113_exportar.sql");
const REGISTRAR_PROD = ler("fixtures/producao/registrar_acao_massiva_2026-11-15.sql");
// Definicao publicada de producao (17/11/2026); a bancada nasce com outra escrita.
const CONCLUIR_LOTE_PROD = ler("fixtures/producao/concluir_lote_2026-11-17.sql");
const EMAIL_PROD = ler("fixtures/acoes_massivas_email_so_apos_tabulacao/prod_20261116_exportar_emails_do_lote.sql");
const PROTECAO = ler("../aguardando_aprovacao/20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente");
const CONFIRMAR = ler("../aguardando_aprovacao/20261113100000_acoes_massivas_confirmar_envio.sql.pendente");
const NOVA = ler("../aguardando_aprovacao/20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.sql.pendente");
const ROLLBACK_NOVA = ler("../aguardando_aprovacao/20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.rollback.sql");
// Definicao VIGENTE publicada de acoes_massivas_concluir_lote (producao, leitura de 17/11/2026).
const MD5_CONCLUIR_LOTE_PUBLICADO = "3a94002240236f6ccd63296ccc4b6a42";

let db;
beforeEach(async () => {
  db = await novoBanco({ registroAutomatico: true });
  await db.exec(EXPORTAR_PUBLICADO);
  await db.exec(`
    alter table public.alunos add column if not exists status_acionamento text;
    alter table public.alunos add column if not exists data_retorno date;
    alter table public.alunos add column if not exists retorno_origem text;
    alter table public.casos  add column if not exists data_retorno date;
  `);
  await db.exec(REGISTRAR_PROD);
  await db.exec(CONCLUIR_LOTE_PROD);
  await comoGestao(db);
});

const md5 = async (nome) => (await db.query(
  `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0]?.m ?? null;
const aplicarAteConfirmar = async () => { await db.exec(EMAIL_PROD); await db.exec(PROTECAO); await db.exec(CONFIRMAR); };
const aplicar = async () => { await aplicarAteConfirmar(); await db.exec(NOVA); };
const movs = async (lote) => (await db.query(
  `select aluno_id from public.aluno_movimentacoes where lote_id = $1`, [lote])).rows;
const lote = async (id) => (await db.query(
  `select confirmado_em, descartado_em, registro_automatico from public.acoes_massivas_lotes where id = $1`, [id])).rows[0];
const concluirLote = async (id, acao) => (await db.query(
  `select public.acoes_massivas_concluir_lote($1::uuid, $2) r`, [id, acao])).rows[0].r;
const concluirEnvio = async (id, acao, ids = null) => (await db.query(
  `select public.acoes_massivas_concluir_envio($1::uuid, $2, $3::text[]) r`,
  [id, acao, ids === null ? null : `{${ids.join(",")}}`])).rows[0].r;

async function exportarLote(n, ini = 1) {
  await alunos(db, n, { ini, valor: 300 });
  const p = await previa(db, { p_canal: "WHATSAPP", p_limite: n, p_operador_email: "TODOS" });
  const ids = p.elegiveis.map((e) => e.id);
  const ex = await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });
  return { ex, ids: ex.ids_exportados };
}

describe("antes da 100200 (publicado)", () => {
  it("concluir_lote carregado e a definicao publicada de producao (MD5)", async () => {
    expect(await md5("acoes_massivas_concluir_lote")).toBe(MD5_CONCLUIR_LOTE_PUBLICADO);
  });
});

describe("depois da 100200", () => {
  beforeEach(aplicar);

  it("CONFIRMAR de lote PENDENTE e recusado (55000) antes de qualquer gravacao", async () => {
    const { ex } = await exportarLote(5);
    expect(ex.pendente_envio).toBe(true);
    await expect(concluirLote(ex.lote_id, "CONFIRMAR")).rejects.toThrow(/pendente de envio/);
    expect((await movs(ex.lote_id)).length).toBe(0);
    const l = await lote(ex.lote_id);
    expect(l.confirmado_em).toBeNull();
    expect(l.registro_automatico).toBe(false);
  });

  it("DESCARTAR de lote PENDENTE continua permitido", async () => {
    const { ex } = await exportarLote(3, 100);
    const r = await concluirLote(ex.lote_id, "DESCARTAR");
    expect(r.descartado).toBe(true);
    expect((await lote(ex.lote_id)).descartado_em).not.toBeNull();
  });

  it("a confirmacao por destinatario continua funcionando (TOTAL)", async () => {
    const { ex, ids } = await exportarLote(4, 200);
    const r = await concluirEnvio(ex.lote_id, "TOTAL");
    expect(r.registrados).toBe(ids.length);
    expect((await lote(ex.lote_id)).confirmado_em).not.toBeNull();
    expect((await movs(ex.lote_id)).length).toBe(ids.length);
  });

  it("lote JA confirmado: CONFIRMAR devolve a resposta guardada, sem nova gravacao", async () => {
    const { ex } = await exportarLote(4, 300);
    await concluirEnvio(ex.lote_id, "TOTAL");
    const antes = (await movs(ex.lote_id)).length;
    const r = await concluirLote(ex.lote_id, "CONFIRMAR");
    expect(r.ja_registrado).toBe(true);
    expect(r.movimentacoes_criadas).toBe(0);
    expect((await movs(ex.lote_id)).length).toBe(antes);
  });

  it("CONFIRMAR de lote PENDENTE DE E-MAIL tambem e recusado (sem filtro de canal)", async () => {
    const r = await db.query(`insert into public.acoes_massivas_lotes
      (canal, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca, recencia_dias, registro_automatico)
      values ('EMAIL', 'email-pendente.xlsx', '{}'::text[], 0, 'teste@x', null, 10, false) returning id`);
    await expect(concluirLote(r.rows[0].id, "CONFIRMAR")).rejects.toThrow(/pendente de envio/);
    expect((await lote(r.rows[0].id)).confirmado_em).toBeNull();
  });

  it("ROLLBACK da 100200 recusa com lote de E-MAIL pendente (nada alterado)", async () => {
    await db.query(`insert into public.acoes_massivas_lotes
      (canal, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca, recencia_dias, registro_automatico)
      values ('EMAIL', 'email-pendente2.xlsx', '{}'::text[], 0, 'teste@x', null, 10, false)`);
    const m = await md5("acoes_massivas_concluir_lote");
    await expect(db.exec(ROLLBACK_NOVA)).rejects.toThrow(/pendente de envio/);
    await db.exec("ROLLBACK").catch(() => {});
    expect(await md5("acoes_massivas_concluir_lote")).toBe(m);
  });

  it("ROLLBACK da 100200 recusa com lote pendente (nada alterado)", async () => {
    const { ex } = await exportarLote(2, 400);
    const m = await md5("acoes_massivas_concluir_lote");
    await expect(db.exec(ROLLBACK_NOVA)).rejects.toThrow(/lote pendente de envio/);
    await db.exec("ROLLBACK").catch(() => {}); // transacao do arquivo ficou abortada
    expect(await md5("acoes_massivas_concluir_lote")).toBe(m);
    expect((await lote(ex.lote_id)).confirmado_em).toBeNull();
  });
});

describe("100200 aplicada e revertida", () => {
  it("aplicar altera o corpo; o rollback sem lote pendente devolve o MD5 publicado", async () => {
    await aplicarAteConfirmar();
    const antes = await md5("acoes_massivas_concluir_lote");
    expect(antes).toBe(MD5_CONCLUIR_LOTE_PUBLICADO);
    await db.exec(NOVA);
    expect(await md5("acoes_massivas_concluir_lote")).not.toBe(MD5_CONCLUIR_LOTE_PUBLICADO);
    await db.exec(ROLLBACK_NOVA);
    expect(await md5("acoes_massivas_concluir_lote")).toBe(MD5_CONCLUIR_LOTE_PUBLICADO);
  });
});
