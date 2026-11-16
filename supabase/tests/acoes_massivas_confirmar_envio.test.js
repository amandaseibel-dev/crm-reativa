// ACOES MASSIVAS: exportar cria lote PENDENTE_ENVIO; o envio e confirmado pela gestao.
//
// Bancada PGlite (Postgres real, dados inventados). Parte do corpo PUBLICADO de
// acoes_massivas_exportar (MD5 c9cc7498..., conferido abaixo) e aplica a migration
// pendente 20261113100000. Criterios da decisao da gestao de 13/11/2026:
//   1. exportar cria lote pendente, sem acionamento e sem fidelizacao;
//   2. confirmar registra so os enviados, com data, hora e responsavel;
//   3. total, parcial ou descarte;  4. parcial exige ids precisos;
//   5. sem dupla confirmacao nem movimentacao duplicada;  6. pendente visivel;
//   7. auditoria guardada no lote;  8. lote historico nao e convertido;
//   9. o registro segue a regra vigente (ultimo acionamento -> fidelizacao).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, alunos, previa, exportar, comoOperador, comoGestao, OP_A,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const EXPORTAR_PUBLICADO = ler("fixtures/acoes_massivas_confirmar_envio/prod_20261113_exportar.sql");
// Definicao VIGENTE em producao (lida em 15/11, reconferida em 16/11 por MD5).
// Substitui a fixture de 19/10, que tinha o mesmo comportamento mas outro hash.
const REGISTRAR_PROD = ler("fixtures/producao/registrar_acao_massiva_2026-11-15.sql");
const MD5_REGISTRAR_PROD = "6eb41bf1dd68fcfb4eb44b9022b43e44";
const MIG = ler("../aguardando_aprovacao/20261113100000_acoes_massivas_confirmar_envio.sql.pendente");
const ROLLBACK = ler("../aguardando_aprovacao/20261113100000_acoes_massivas_confirmar_envio.rollback.sql");
const MD5_PUBLICADO = "c9cc7498d16ca250e85c4727c8bb05bd";
const MD5_FINAL = "3861da11bfb0930fc698ce8e1ca05a35";
const GESTAO_RE = /@/;

let db;
beforeEach(async () => {
  db = await novoBanco({ registroAutomatico: true });
  await db.exec(EXPORTAR_PUBLICADO);
  // A definicao vigente TABULA (status + retorno em 10 dias, no aluno e no
  // caso). A bancada compartilhada nasceu antes disso: completa aqui, so para
  // este arquivo, as colunas que o corpo de producao escreve.
  await db.exec(`
    alter table public.alunos add column if not exists status_acionamento text;
    alter table public.alunos add column if not exists data_retorno date;
    alter table public.alunos add column if not exists retorno_origem text;
    alter table public.casos  add column if not exists data_retorno date;
  `);
  await db.exec(REGISTRAR_PROD);
  await comoGestao(db);
});

const md5 = async (nome = "acoes_massivas_exportar") => (await db.query(
  `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0]?.m ?? null;
const existe = async (nome) => (await db.query(
  `select count(*)::int c from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0].c > 0;
const aplicar = () => db.exec(MIG);
const movs = async (lote) => (await db.query(
  `select aluno_id, tipo, registrado_por_email, registrado_em from public.aluno_movimentacoes
    where lote_id = $1 order by aluno_id`, [lote])).rows;
const totalMovs = async () => (await db.query(
  `select count(*)::int c from public.aluno_movimentacoes where tipo like 'ACAO_MASSIVA%'`)).rows[0].c;
const lote = async (id) => (await db.query(
  `select total, registrados, registro_automatico, confirmado_em, confirmado_por_email,
          descartado_em, descartado_por_email, exportado_em, resultado
     from public.acoes_massivas_lotes where id = $1`, [id])).rows[0];
const ultimoAcionamento = async (ids) => (await db.query(
  `select id::text, data_ultimo_acionamento d from public.alunos where id = any($1::uuid[]) order by id`,
  [`{${ids.join(",")}}`])).rows;
const tabulacao = async (ids) => (await db.query(
  `select a.id::text, a.status_acionamento s, (a.data_retorno - current_date) dias, a.retorno_origem o,
          (select bool_and(c.data_retorno = a.data_retorno) from public.casos c where c.aluno_id = a.id) caso_igual
     from public.alunos a where a.id = any($1::uuid[]) order by a.id`,
  [`{${ids.join(",")}}`])).rows;
const STATUS_MASSIVA = "Ação massiva externa enviada — aguardando retorno";
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

describe("publicado hoje (antes da migration)", () => {
  it("registrar_acao_massiva da bancada e a definicao vigente de producao (MD5)", async () => {
    expect(await md5("registrar_acao_massiva")).toBe(MD5_REGISTRAR_PROD);
    await aplicar();
    expect(await md5("registrar_acao_massiva")).toBe(MD5_REGISTRAR_PROD);
  });
  it("MD5 de origem confere com producao", async () => {
    expect(await md5()).toBe(MD5_PUBLICADO);
  });
  it("DEFEITO: exportar ja registra a acao no aluno, sem confirmacao de envio", async () => {
    const { ex } = await exportarLote(5);
    expect(ex.registro_automatico).toBe(true);
    expect((await movs(ex.lote_id)).length).toBe(5);
    expect((await lote(ex.lote_id)).confirmado_em).not.toBeNull();
  });
});

describe("depois da migration", () => {
  beforeEach(aplicar);

  it("MD5 final confere", async () => {
    expect(await md5()).toBe(MD5_FINAL);
  });

  it("1. exportar cria lote PENDENTE_ENVIO: nenhuma movimentacao, acionamento ou fidelizacao", async () => {
    await alunos(db, 6, { valor: 300 });
    const antes = await ultimoAcionamento((await db.query("select id::text from public.alunos")).rows.map((r) => r.id));
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 6, p_operador_email: "TODOS" });
    const ex = await exportar(db, p.elegiveis.map((e) => e.id), { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });
    expect(ex.pendente_envio).toBe(true);
    expect(ex.registro_automatico).toBe(false);
    expect(ex.registrados).toBe(0);
    expect(ex.selecionados).toBe(6);
    expect(ex.contatos).toHaveLength(6);           // a planilha continua saindo
    expect(await movs(ex.lote_id)).toHaveLength(0);
    const l = await lote(ex.lote_id);
    expect(l.confirmado_em).toBeNull();
    expect(l.descartado_em).toBeNull();
    expect(l.registro_automatico).toBe(false);
    expect(l.total).toBe(6);
    expect(await ultimoAcionamento(antes.map((r) => r.id))).toEqual(antes);
  });

  it("2. TOTAL registra todos, com data/hora da confirmacao e o e-mail de quem confirmou", async () => {
    const { ex, ids } = await exportarLote(5);
    const r = await concluirEnvio(ex.lote_id, "TOTAL");
    expect(r.confirmacao).toBe("TOTAL");
    expect(r.registrados).toBe(5);
    expect(r.nao_enviados).toBe(0);
    const m = await movs(ex.lote_id);
    expect(m).toHaveLength(5);
    expect(m.every((x) => x.tipo === "ACAO_MASSIVA_EXTERNA")).toBe(true);
    expect(m.every((x) => GESTAO_RE.test(x.registrado_por_email))).toBe(true);
    const l = await lote(ex.lote_id);
    expect(m.every((x) => new Date(x.registrado_em) >= new Date(l.exportado_em))).toBe(true);
    expect(l.confirmado_por_email).toBe(m[0].registrado_por_email);
    expect(l.registrados).toBe(5);
    // 9. regra vigente: a acao confirmada vira o ultimo acionamento (base da fidelizacao)
    const ua = await ultimoAcionamento(ids);
    expect(ua.every((x) => x.d !== null)).toBe(true);
  });

  it("3/4. PARCIAL registra so os ids informados e guarda quem nao foi enviado", async () => {
    const { ex, ids } = await exportarLote(10);
    const enviados = ids.slice(0, 3);
    const r = await concluirEnvio(ex.lote_id, "PARCIAL", enviados);
    expect(r.confirmacao).toBe("PARCIAL");
    expect(r.registrados).toBe(3);
    expect(r.enviados_informados).toBe(3);
    expect(r.nao_enviados).toBe(7);
    expect((await movs(ex.lote_id)).map((x) => x.aluno_id).sort()).toEqual([...enviados].sort());
    const l = await lote(ex.lote_id);
    expect(l.resultado.ids_nao_enviados).toHaveLength(7);
    expect(l.resultado.ids_enviados_informados.sort()).toEqual([...enviados].sort());
    const naoEnviados = await ultimoAcionamento(ids.slice(3));
    expect(naoEnviados.every((x) => x.d === null)).toBe(true);
  });

  it("4. PARCIAL recusa lista vazia, id fora do lote, lista com todos e TOTAL com ids", async () => {
    const { ex, ids } = await exportarLote(4);
    await expect(concluirEnvio(ex.lote_id, "PARCIAL", [])).rejects.toThrow(/exige a lista/);
    await expect(concluirEnvio(ex.lote_id, "PARCIAL", null)).rejects.toThrow(/exige a lista/);
    await expect(concluirEnvio(ex.lote_id, "PARCIAL", [ids[0], "00000000-0000-4000-8000-000000009999"]))
      .rejects.toThrow(/fora deste lote/);
    await expect(concluirEnvio(ex.lote_id, "PARCIAL", ids)).rejects.toThrow(/use TOTAL/);
    await expect(concluirEnvio(ex.lote_id, "TOTAL", [ids[0]])).rejects.toThrow(/use PARCIAL/);
    await expect(concluirEnvio(ex.lote_id, "OUTRA")).rejects.toThrow(/Acao invalida/);
    expect(await movs(ex.lote_id)).toHaveLength(0);
    expect((await lote(ex.lote_id)).confirmado_em).toBeNull();
  });

  it("tabulacao vigente: exportar nao tabula; confirmar grava status e retorno em 10 dias; repetir nao muda nada", async () => {
    const { ex, ids } = await exportarLote(4);
    for (const t of await tabulacao(ids)) {
      expect(t.s).toBeNull();
      expect(t.dias).toBeNull();
    }
    const r = await concluirEnvio(ex.lote_id, "PARCIAL", ids.slice(0, 3));
    expect(r.tabulados).toBe(3);
    const depois = await tabulacao(ids);
    const enviados = depois.filter((t) => ids.slice(0, 3).includes(t.id));
    const fora = depois.filter((t) => !ids.slice(0, 3).includes(t.id));
    expect(enviados.length).toBe(3);
    for (const t of enviados) {
      expect(t.s).toBe(STATUS_MASSIVA);
      expect(t.dias).toBe(10);
      expect(t.o).toBe("AUTOMATICO");
      expect(t.caso_igual).not.toBe(false);
    }
    // quem nao recebeu nao e tabulado
    expect(fora.length).toBe(1);
    expect(fora[0].s).toBeNull();
    expect(fora[0].dias).toBeNull();
    // repeticao: resultado guardado, nenhuma tabulacao nova (nem para o nao enviado)
    const r2 = await concluirEnvio(ex.lote_id, "TOTAL");
    expect(r2.ja_registrado).toBe(true);
    expect(await tabulacao(ids)).toEqual(depois);
  });

  it("5. dupla confirmacao devolve o resultado guardado e nao grava de novo", async () => {
    const { ex, ids } = await exportarLote(5);
    await concluirEnvio(ex.lote_id, "PARCIAL", ids.slice(0, 2));
    const antes = await movs(ex.lote_id);
    const total = await totalMovs();
    const r2 = await concluirEnvio(ex.lote_id, "TOTAL");
    const r3 = await concluirEnvio(ex.lote_id, "PARCIAL", ids.slice(2, 4));
    expect(r2.ja_registrado).toBe(true);
    expect(r2.movimentacoes_criadas).toBe(0);
    expect(r3.ja_registrado).toBe(true);
    expect(await movs(ex.lote_id)).toEqual(antes);
    expect(await totalMovs()).toBe(total);
    await expect(concluirEnvio(ex.lote_id, "DESCARTAR")).rejects.toThrow(/nao pode ser descartado/);
  });

  it("3. DESCARTAR nao registra nada e trava confirmacao posterior", async () => {
    const { ex } = await exportarLote(4);
    const r = await concluirEnvio(ex.lote_id, "DESCARTAR");
    expect(r.descartado).toBe(true);
    expect(await movs(ex.lote_id)).toHaveLength(0);
    const l = await lote(ex.lote_id);
    expect(l.descartado_em).not.toBeNull();
    expect(l.descartado_por_email).toMatch(GESTAO_RE);
    await expect(concluirEnvio(ex.lote_id, "TOTAL")).rejects.toThrow(/descartado/);
  });

  it("aluno acionado depois da exportacao nao recebe registro retroativo do lote", async () => {
    const { ex, ids } = await exportarLote(3);
    await db.query(`update public.alunos set data_ultimo_acionamento = now() + interval '1 minute' where id = $1`, [ids[0]]);
    const r = await concluirEnvio(ex.lote_id, "TOTAL");
    expect(r.excluidos_acionados_apos_exportacao).toBe(1);
    expect((await movs(ex.lote_id)).map((x) => x.aluno_id)).not.toContain(ids[0]);
  });

  it("dois lotes com o mesmo aluno: o segundo nao duplica o registro do primeiro", async () => {
    const a = await exportarLote(3);
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 3, p_operador_email: "TODOS" });
    const b = await exportar(db, p.elegiveis.map((e) => e.id), { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });
    await concluirEnvio(a.ex.lote_id, "TOTAL");
    const r = await concluirEnvio(b.lote_id, "TOTAL");
    expect(r.registrados).toBe(0);
    expect(await totalMovs()).toBe(3);
  });

  it("operador nao confirma envio", async () => {
    const { ex } = await exportarLote(2);
    await comoOperador(db, OP_A);
    await expect(concluirEnvio(ex.lote_id, "TOTAL")).rejects.toThrow(/Acesso negado/);
    await comoGestao(db);
    expect(await movs(ex.lote_id)).toHaveLength(0);
  });

  it("lote inexistente e recusado", async () => {
    await expect(concluirEnvio("00000000-0000-4000-8000-0000000000aa", "TOTAL")).rejects.toThrow(/nao encontrado/);
  });

  it("grants: sem execucao para PUBLIC nas duas funcoes novas", async () => {
    for (const nome of ["acoes_massivas_concluir_envio", "acoes_massivas_lote_destinatarios"]) {
      const acl = (await db.query(
        `select coalesce(p.proacl::text, '') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0].a;
      expect(acl).not.toBe("");                         // ACL explicita, nao o padrao (PUBLIC executa)
      expect(acl.replace(/[{}]/g, "").split(",").some((e) => e.startsWith("="))).toBe(false);
    }
  });

  it("destinatarios do lote: gestao le na ordem da planilha; operador nao le", async () => {
    const { ex, ids } = await exportarLote(4);
    const r = (await db.query(`select public.acoes_massivas_lote_destinatarios($1::uuid) r`, [ex.lote_id])).rows[0].r;
    expect(r.pendente).toBe(true);
    expect(r.destinatarios.map((d) => d.aluno_id)).toEqual(ids);
    expect(r.destinatarios[0].nome).toBeTruthy();
    // minimo necessario: lote de WhatsApp nao devolve e-mail
    expect(r.destinatarios.every((d) => d.email === null)).toBe(true);
    // telefone NUNCA integral: so a mascara (ultimos 4 digitos), como na tela de ficha
    expect(r.destinatarios.every((d) => d.telefone === undefined && /^••••\d{4}$/.test(d.telefone_mascarado))).toBe(true);
    // lote ja concluido nao entrega a lista de novo
    await concluirEnvio(ex.lote_id, "TOTAL");
    await expect(db.query(`select public.acoes_massivas_lote_destinatarios($1::uuid)`, [ex.lote_id]))
      .rejects.toThrow(/Lote ja concluido/);
    await comoOperador(db, OP_A);
    await expect(db.query(`select public.acoes_massivas_lote_destinatarios($1::uuid)`, [ex.lote_id]))
      .rejects.toThrow(/Acesso negado/);
    await comoGestao(db);
  });
});

describe("lotes existentes nao sao convertidos (criterio 8)", () => {
  it("lote antigo pendente continua pendente e confirmado continua como estava", async () => {
    const { ex: antigo } = await exportarLote(3);              // registrado pelo fluxo de hoje
    await db.query(`insert into public.acoes_massivas_lotes (id, canal, aluno_ids, total, exportado_por_email)
                    values ('00000000-0000-4000-8000-0000000000bb', 'WHATSAPP', '{x}', 1, 'g@x')`);
    const foto = async () => (await db.query(
      `select id, confirmado_em, descartado_em, registrados, resultado::text r
         from public.acoes_massivas_lotes order by id`)).rows;
    const antes = await foto();
    const movsAntes = await totalMovs();
    await aplicar();
    expect(await foto()).toEqual(antes);
    expect(await totalMovs()).toBe(movsAntes);
    expect((await lote(antigo.lote_id)).confirmado_em).not.toBeNull();
  });
});

describe("guardas e rollback", () => {
  it("aborta sem alterar nada se a exportacao publicada for outra", async () => {
    await db.exec(EXPORTAR_PUBLICADO.replace("  v_contatos jsonb;", "  v_contatos jsonb; -- alterado"));
    const antes = await md5();
    await expect(db.exec(MIG)).rejects.toThrow(/Nada aplicado/);
    await db.exec("ROLLBACK;").catch(() => {});
    expect(await md5()).toBe(antes);
    expect(await existe("acoes_massivas_concluir_envio")).toBe(false);
  });

  it("nao aplica duas vezes", async () => {
    await aplicar();
    await expect(db.exec(MIG)).rejects.toThrow(/Nada aplicado/);
    await db.exec("ROLLBACK;").catch(() => {});
    expect(await md5()).toBe(MD5_FINAL);
  });

  it("rollback volta ao publicado, remove a funcao nova e preserva os lotes", async () => {
    await aplicar();
    const { ex } = await exportarLote(3);
    await db.exec(ROLLBACK);
    expect(await md5()).toBe(MD5_PUBLICADO);
    expect(await existe("acoes_massivas_concluir_envio")).toBe(false);
    expect(await existe("acoes_massivas_lote_destinatarios")).toBe(false);
    expect((await lote(ex.lote_id)).confirmado_em).toBeNull();    // pendente continua pendente
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/Rollback abortado/);
    await db.exec("ROLLBACK;").catch(() => {});
  });
});
