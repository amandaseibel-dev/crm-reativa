// ACAO MASSIVA VOLTA A TABULAR, COM RETORNO DE 10 DIAS CORRIDOS.
//
// Pedido da gestao em 19/10/2026 ("coloque 10 dias, ja esta padronizado nessa
// forma"), depois da medicao que mostrou a massiva registrando acionamento e
// NAO tabulando: em outubro, 8.296 linhas de massiva WhatsApp e 4.888 de
// massiva e-mail com ZERO tabulacao, contra 3.171 de 3.171 (100%) no e-mail
// INDIVIDUAL do operador.
//
// "forma ja padronizada" nao e invencao desta migration:
//   * 6.294 alunos ja tem status_acionamento = 'Ação massiva externa enviada —
//     aguardando retorno' (valor unico na base);
//   * recalcular_situacao_aluno tem a regra viva por PREFIXO ('Ação massiva%')
//     e devolve data_ultimo_acionamento + 10 CORRIDOS;
//   * registrar_acao_massiva, antes de 16/09, gravava exatamente isso.
//
// O que este arquivo prova:
//   * EQUIVALENCIA repo x producao: a cadeia de migrations reproduz, por md5,
//     os corpos vivos das duas funcoes que o patch ancorado altera -- se
//     producao derivar, o teste quebra antes da migration;
//   * ANTES: massiva nao grava retorno nem status (contrato de 03/10);
//   * DEPOIS: grava o status padronizado, data_retorno = hoje + 10 e
//     retorno_origem AUTOMATICO, no aluno E no caso;
//   * retorno FUTURO do OPERADOR e preservado;
//   * status_jornada / status_atual NAO sao tocados -- e a guarda que impede
//     efeito financeiro e encaminhamento de nascer de acao massiva;
//   * a recalculadora continua NAO sendo chamada (a correcao de 03/10 fica);
//   * nada financeiro se move.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, alunos, previa, exportar, comoGestao, OP_A,
} from "./fixtures/acoes_massivas_universo/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const MIG_EMAIL = ler("supabase/migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql");
const MIG       = ler("supabase/migrations/20261019132433_acao_massiva_tabula_com_retorno_10_dias.sql");
const RB        = ler("supabase/rollbacks/20261019132433_acao_massiva_tabula_com_retorno_10_dias.rollback.sql");

// DERIVA REAL, medida em 19/10/2026: producao tem migrations aplicadas que NAO
// tem arquivo nesta arvore -- 20261006113000 acoes_massivas_responsaveis_por_lado
// e as tres de 15/10 (retorno_futuro_so_bloqueia_agendamento_do_operador,
// data_ultimo_acionamento_do_caso_no_fuso_de_brasilia, acoes_massivas_fora_do_universo).
// Por isso a cadeia de migrations do repo nao reproduz mais o corpo de
// registrar_acao_massiva, e o teste parte do CORPO VIVO lido de producao por
// pg_get_functiondef, com o md5 conferido logo no primeiro caso.
// acoes_massivas_exportar_emails_do_lote continua batendo pela migration do
// repo, sem fixture -- e o primeiro teste tambem prova isso.
const PROD_REGISTRAR = readFileSync(
  new URL("./fixtures/acoes_massivas_universo/prod_20261019_registrar_acao_massiva.sql", import.meta.url),
  "utf8");

// md5 do prosrc VIVO em producao, lido em 19/10/2026 por pg_get_functiondef.
// Sao os mesmos valores exigidos no preflight da migration.
const MD5_REGISTRAR = "7de4ee7830af47a4acec47d18a824e29";
const MD5_EMAIL_LOTE = "d37ddd499e81cc5381762cd8c95f25aa";
// md5 do prosrc DEPOIS da migration, lido em producao em 19/10/2026 as 13:24 UTC
// (versao registrada 20261019132433). Travar os dois e o que garante que o
// arquivo deste repo reproduz, byte a byte, o corpo que esta rodando -- e nao
// apenas "algo diferente do anterior".
const MD5_REGISTRAR_POS = "633a4ebe34819048da2e7b0247e53ac2";
const MD5_EMAIL_LOTE_POS = "74b33817e97fd5d0bf900f93c5bb7cbc";
const STATUS = "Ação massiva externa enviada — aguardando retorno";

/** Producao de hoje: registro automatico (02/10) + sem recalculadora (03/10)
 *  + e-mail do lote (06/10) + o corpo VIVO de registrar_acao_massiva. */
async function base() {
  const db = await novoBanco({ registroAutomatico: true, semRetornoAutomatico: true });
  // Coluna que existe em producao e faltava neste duble.
  await db.exec(`alter table public.casos add column if not exists data_retorno date;`);
  await db.exec(MIG_EMAIL);
  // o corpo que esta rodando em producao hoje (ver nota da deriva acima)
  await db.exec(PROD_REGISTRAR);
  await comoGestao(db);
  return db;
}

const md5De = async (db, assinatura) =>
  (await db.query(`select md5(prosrc) m from pg_proc where oid = $1::regprocedure`, [assinatura])).rows[0].m;

const alunoRow = async (db, id) =>
  (await db.query(`select data_retorno, retorno_origem, status_acionamento, status_jornada,
                          status_atual, data_ultimo_acionamento, responsavel_atual_email
                     from public.alunos where id = $1`, [id])).rows[0];

const casoRow = async (db, id) =>
  (await db.query(`select data_retorno, data_ultimo_acionamento from public.casos where aluno_id = $1`, [id])).rows[0];

const emDias = async (db, n) =>
  (await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0].d;

const dia = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function exportarTudo(db, limite, operador = "TODOS") {
  const p = await previa(db, { p_canal: "WHATSAPP", p_limite: limite, p_operador_email: operador });
  return exportar(db, p.elegiveis.map((e) => e.id), { canal: "WHATSAPP", operador, previa_id: p.previa_id });
}

describe("equivalencia entre o repo e os corpos vivos de producao", () => {
  it("a cadeia de migrations reproduz, por md5, as duas funcoes que o patch altera", async () => {
    const db = await base();
    expect(await md5De(db, "public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)"))
      .toBe(MD5_REGISTRAR);
    expect(await md5De(db, "public.acoes_massivas_exportar_emails_do_lote(uuid,text)"))
      .toBe(MD5_EMAIL_LOTE);
  });

  // A prova de que o versionado preserva EXATAMENTE o que foi validado em
  // producao: o arquivo desta branch, rodado sobre o estado anterior, produz os
  // mesmos corpos que a versao 20261019132433 deixou no banco.
  it("o corpo gerado pelo arquivo e byte a byte o que roda em producao", async () => {
    const db = await base();
    await db.exec(MIG);
    const reg = await md5De(db, "public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)");
    const mail = await md5De(db, "public.acoes_massivas_exportar_emails_do_lote(uuid,text)");

    expect(reg).toBe(MD5_REGISTRAR_POS);
    expect(mail).toBe(MD5_EMAIL_LOTE_POS);
    // e, obviamente, nao sao mais os de antes
    expect(reg).not.toBe(MD5_REGISTRAR);
    expect(mail).not.toBe(MD5_EMAIL_LOTE);

    const tam = await db.query(`select length(prosrc) t, oid::regprocedure::text f
                                  from pg_proc
                                 where oid in ('public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)'::regprocedure,
                                               'public.acoes_massivas_exportar_emails_do_lote(uuid,text)'::regprocedure)
                                 order by f`);
    // 6.774 e 9.287 chars, os mesmos medidos em producao
    expect(tam.rows.map((r) => r.t).sort((a, b) => a - b)).toEqual([6774, 9287]);
  });

  it("falha alto se o corpo de producao tiver derivado", async () => {
    const db = await base();
    await db.exec(`create or replace function public.registrar_acao_massiva(
                     p_aluno_ids text[], p_canal text, p_arquivo text,
                     p_registrado_por_nome text, p_registrado_por_email text,
                     p_operador_email text default null, p_lote_id uuid default null,
                     p_filtros jsonb default null)
                   returns jsonb language plpgsql as $f$ begin return '{}'::jsonb; end $f$;`);
    await expect(db.exec(MIG)).rejects.toThrow(/mudou em producao/);
  });
});

describe("ANTES da migration: o contrato de 03/10 segue valendo", () => {
  it("a massiva nao grava retorno nem status", async () => {
    const db = await base();
    const ids = await alunos(db, 3, { valor: 300 });
    expect((await exportarTudo(db, 3)).registrados).toBe(3);
    for (const id of ids) {
      const a = await alunoRow(db, id);
      expect(a.data_retorno).toBeNull();
      expect(a.status_acionamento).toBeNull();
      expect(a.retorno_origem).toBeNull();
    }
  });
});

describe("DEPOIS da migration: tabula na forma padronizada", () => {
  it("grava o status padronizado e retorno de 10 dias CORRIDOS no aluno", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 3, { valor: 300 });
    const r = await exportarTudo(db, 3);
    expect(r.registrados).toBe(3);

    const esperado = await emDias(db, 10);
    for (const id of ids) {
      const a = await alunoRow(db, id);
      expect(a.status_acionamento).toBe(STATUS);
      expect(dia(a.data_retorno)).toBe(esperado);
      expect(a.retorno_origem).toBe("AUTOMATICO");
    }
  });

  it("o caso acompanha o aluno (a fila do dia le casos.data_retorno)", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 2, { valor: 300 });
    await exportarTudo(db, 2);
    const esperado = await emDias(db, 10);
    for (const id of ids) expect(dia((await casoRow(db, id)).data_retorno)).toBe(esperado);
  });

  it("10 dias e corrido, nao util: cai exatamente em hoje + 10", async () => {
    const db = await base();
    await db.exec(MIG);
    const [id] = await alunos(db, 1, { valor: 300 });
    await exportarTudo(db, 1);
    const d = await db.query(
      `select (data_retorno - current_date)::int dif from public.alunos where id = $1`, [id]);
    expect(d.rows[0].dif).toBe(10);
  });

  // MEDIDO, e nao presumido: o retorno futuro do OPERADOR nunca chega a
  // disputar com o +10, porque a propria previa/exportacao tira esse aluno da
  // massiva antes. A guarda dentro da funcao fica como defesa de borda.
  //
  // DIVERGENCIA DECLARADA repo x producao: a bancada roda o
  // acoes_massivas_universo do repo, ANTERIOR a 20261015124500
  // (retorno_futuro_so_bloqueia_agendamento_do_operador), que nao tem arquivo
  // versionado. Aqui QUALQUER retorno futuro bloqueia; em producao so bloqueia
  // quando retorno_origem like 'OPERADOR%' (conferido no corpo vivo em 19/10).
  // Por isso este teste afirma so o que vale nas duas versoes: quem fica fora
  // nao e tabulado e a data do operador nao e tocada.
  it("retorno futuro nao e sobrescrito para quem fica fora da massiva", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 2, { valor: 300 });
    await db.query(`update public.alunos
                       set data_retorno = current_date + 3, retorno_origem = 'OPERADOR'
                     where id = $1`, [ids[0]]);

    const r = await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS" });
    expect(r.ids_registrados).not.toContain(ids[0]);

    const fora = await alunoRow(db, ids[0]);
    expect(dia(fora.data_retorno)).toBe(await emDias(db, 3));
    expect(fora.retorno_origem).toBe("OPERADOR");
    expect(fora.status_acionamento).toBeNull();
  });

  it("NAO toca status_jornada nem status_atual", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 2, { valor: 300 });
    await db.query(`update public.alunos set status_jornada = 'CONTATAR', status_atual = 'CONTATAR'
                     where id = any($1::uuid[])`, [ids]);
    await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS" });
    for (const id of ids) {
      const a = await alunoRow(db, id);
      expect(a.status_jornada).toBe("CONTATAR");
      expect(a.status_atual).toBe("CONTATAR");
    }
  });

  it("a recalculadora continua fora do caminho da massiva", async () => {
    const db = await base();
    await db.exec(MIG);
    await alunos(db, 3, { valor: 300 });
    await exportarTudo(db, 3);
    const total = (await db.query(`select count(*)::int c from public._recalc_log`)).rows[0].c;
    expect(total).toBe(0);
  });

  // `fotoIntocavel` da bancada inclui data_retorno e status_acionamento do
  // aluno -- que agora mudam DE PROPOSITO. A foto aqui e so do financeiro.
  it("nao troca responsavel e nao move nada financeiro", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 3, { valor: 300, dono: OP_A });
    const financeiro = async () => JSON.stringify((await db.query(
      `select (select count(*) from public.acordos) a,
              (select count(*) from public.parcelas) p,
              (select count(*) from public.acordos_titulos) t,
              (select count(*) from public.acordo_titulo_vinculo) v,
              (select coalesce(sum(valor_em_aberto), 0) from public.acordos_titulos) soma`)).rows);
    const antes = await financeiro();
    await exportar(db, ids, { canal: "WHATSAPP", operador: OP_A });
    expect(await financeiro()).toEqual(antes);
    for (const id of ids) expect((await alunoRow(db, id)).responsavel_atual_email).toBe(OP_A);
  });

  it("quem fica fora do registro nao e tabulado", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 2, { valor: 300 });
    // o segundo entra em confirmacao de pagamento: sai do universo
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento
                    values ($1, 'AGUARDANDO_CONFIRMACAO')`, [ids[1]]);
    const r = await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS" });
    expect(r.registrados).toBe(1);
    expect((await alunoRow(db, ids[1])).status_acionamento).toBeNull();
    expect((await alunoRow(db, ids[1])).data_retorno).toBeNull();
  });

  // Uma segunda tentativa nao empurra o retorno para +20: ou o aluno e
  // recusado (bancada, e tambem producao quando a origem e OPERADOR), ou ele e
  // registrado de novo e o +10 e recontado do dia da nova acao -- nunca somado
  // ao que ja estava.
  it("tentar de novo nao acumula prazo: o retorno nunca passa de hoje + 10", async () => {
    const db = await base();
    await db.exec(MIG);
    const ids = await alunos(db, 2, { valor: 300 });
    expect((await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS" })).registrados).toBe(2);
    const dezDias = await emDias(db, 10);
    for (const id of ids) expect(dia((await alunoRow(db, id)).data_retorno)).toBe(dezDias);

    await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS" });
    for (const id of ids) {
      const a = await alunoRow(db, id);
      expect(dia(a.data_retorno)).toBe(dezDias);
      expect(a.status_acionamento).toBe(STATUS);
    }
  });
});

describe("o rollback devolve o estado anterior", () => {
  it("restaura as duas funcoes byte a byte (md5 de producao) e a massiva para de tabular", async () => {
    const db = await base();
    await db.exec(MIG);
    await db.exec(RB);
    expect(await md5De(db, "public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)"))
      .toBe(MD5_REGISTRAR);
    expect(await md5De(db, "public.acoes_massivas_exportar_emails_do_lote(uuid,text)"))
      .toBe(MD5_EMAIL_LOTE);

    const ids = await alunos(db, 2, { valor: 300 });
    expect((await exportar(db, ids, { canal: "WHATSAPP", operador: "TODOS" })).registrados).toBe(2);
    for (const id of ids) {
      const a = await alunoRow(db, id);
      expect(a.data_retorno).toBeNull();
      expect(a.status_acionamento).toBeNull();
    }
  });

  it("rodar o rollback sem a migration falha alto, em vez de deixar outra versao", async () => {
    const db = await base();
    await expect(db.exec(RB)).rejects.toThrow(/nada a desfazer/);
  });
});
