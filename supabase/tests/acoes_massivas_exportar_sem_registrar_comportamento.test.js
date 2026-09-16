// ACOES MASSIVAS: EXPORTAR A PLANILHA NAO E CONTATO REALIZADO -- COMPORTAMENTO.
//
// Roda num PostgreSQL real (PGlite), sobre as definicoes VIVAS de producao de
// 16/09/2026 mais as migrations 20260916200000 (operador) e 20260916210000
// (exportar x confirmar).
//
// O QUE ESTE TESTE PROVA
//   * exportar nao escreve em alunos, casos nem aluno_movimentacoes -- nem com
//     operador, nem repetido; grava so o lote de auditoria;
//   * a planilha sai com exatamente quem o registro gravaria (mesmo recorte);
//   * so a confirmacao grava tabulacao, retorno, acionamento e movimentacao;
//   * um lote confirma uma vez so; descartar nao escreve nada;
//   * a confirmacao revalida (confirmacao de pagamento, dono) e nao sobrescreve
//     quem foi acionado depois da exportacao;
//   * nada de contato no resultado guardado; gate, ACL, RLS, dependencia,
//     idempotencia e rollback.
//
// Bancada (esquema, dubles, carteira inventada): fixtures/acoes_massivas_prod_20260916/bancada.js
import { describe, it, expect } from "vitest";
import {
  MIGRATION_EXPORTAR, ROLLBACK_EXPORTAR, OP_A, OP_B, GESTAO, ID, NOME_POR_ID,
  comoGestao, comoOperador, previa, registrar, novoBanco,
} from "./fixtures/acoes_massivas_prod_20260916/bancada.js";

const STATUS_MASSIVA = "Ação massiva externa enviada — aguardando retorno";
const nomes = (ids) => ids.map((i) => NOME_POR_ID[i]).sort();

async function exportar(db, ids, { canal = "WHATSAPP", operador, arquivo = "planilha.xlsx" } = {}) {
  const r = await db.query(
    `select public.acoes_massivas_exportar(p_aluno_ids => $1::text[], p_canal => $2, p_arquivo => $3,
       p_operador_email => $4) r`,
    [`{${ids.join(",")}}`, canal, arquivo, operador ?? null]);
  return r.rows[0].r;
}
async function concluir(db, lote, acao) {
  return (await db.query(`select public.acoes_massivas_concluir_lote($1::uuid, $2) r`, [lote, acao])).rows[0].r;
}
async function pendentes(db) {
  return (await db.query(`select public.acoes_massivas_lotes_pendentes() r`)).rows[0].r;
}
// Foto de TUDO o que o registro toca, com as datas inteiras.
async function fotoOperacional(db) {
  const q = async (sql) => JSON.stringify((await db.query(sql)).rows);
  return [
    await q(`select * from public.alunos order by id`),
    await q(`select aluno_id, operador_email, total_em_aberto from public.casos order by aluno_id, total_em_aberto`),
    await q(`select * from public.aluno_movimentacoes order by aluno_id, registrado_em`),
  ].join("\n");
}
const contaMovs = async (db) =>
  Number((await db.query(`select count(*) n from public.aluno_movimentacoes`)).rows[0].n);
const lote = async (db, id) =>
  (await db.query(`select * from public.acoes_massivas_lotes where id = $1`, [id])).rows[0];

describe("exportar planilha: somente leitura operacional", () => {
  it("sem operador: nada muda em alunos/casos/movimentacoes; so o lote e gravado", async () => {
    const db = await novoBanco({ exportar: true });
    const ids = [ID.L1, ID.L2, ID.A1, ID.A2, ID.B2, ID.L3, ID.A9, ID.X1];
    const antes = await fotoOperacional(db);
    const r = await exportar(db, ids);
    expect(await fotoOperacional(db)).toBe(antes);
    expect(nomes(r.ids_exportados)).toEqual(["A1", "L1", "L2"]);
    expect(r.contatos.map((c) => NOME_POR_ID[c.aluno_id]).sort()).toEqual(["A1", "L1", "L2"]);
    expect(r.contatos[0]).toHaveProperty("telefone");
    const l = await lote(db, r.lote_id);
    expect(l).toMatchObject({ canal: "WHATSAPP", operador_email: null, total: 3, exportado_por_email: GESTAO,
      confirmado_em: null, descartado_em: null, resultado: null, arquivo: "planilha.xlsx" });
    expect(nomes(l.aluno_ids)).toEqual(["A1", "L1", "L2"]);
  });

  it("com operador: exporta a carteira toda, inclusive quem ja foi acionado, sem regravar nada", async () => {
    const db = await novoBanco({ exportar: true });
    const ids = (await previa(db, { p_operador_email: OP_A })).elegiveis.map((e) => e.id);
    const antes = await fotoOperacional(db);
    const r = await exportar(db, ids, { operador: OP_A });
    expect(await fotoOperacional(db)).toBe(antes);
    expect(nomes(r.ids_exportados)).toEqual(nomes(ids));
    expect(r.operador_email).toBe(OP_A);
    // A2 e A3 ja tinham acionamento: continuam exatamente como estavam
    const a2 = (await db.query(`select status_acionamento, data_retorno from public.alunos where id = $1`, [ID.A2])).rows[0];
    expect(a2).toEqual({ status_acionamento: null, data_retorno: null });
  });

  it("exportar de novo nao acumula efeito: dois lotes, zero escrita operacional", async () => {
    const db = await novoBanco({ exportar: true });
    const antes = await fotoOperacional(db);
    const r1 = await exportar(db, [ID.L1, ID.A1]);
    const r2 = await exportar(db, [ID.L1, ID.A1]);
    expect(r1.lote_id).not.toBe(r2.lote_id);
    expect(await fotoOperacional(db)).toBe(antes);
    expect((await pendentes(db)).length).toBe(2);
  });

  it("ninguem elegivel: nenhum lote e criado", async () => {
    const db = await novoBanco({ exportar: true });
    const r = await exportar(db, [ID.A9, ID.L3, ID.B2]);
    expect(r.lote_id).toBeNull();
    expect(r.exportados).toBe(0);
    expect(Number((await db.query(`select count(*) n from public.acoes_massivas_lotes`)).rows[0].n)).toBe(0);
  });

  it("a planilha tem exatamente quem o registro gravaria (mesmo recorte e mesmos motivos)", async () => {
    const cenarios = [
      { ids: ["L1", "L2", "A1", "A2", "B2", "L3", "A9", "X1", "G1"] },
      { ids: ["A1", "B1", "L1", "A4", "A9", "A2", "A12"], operador: OP_A },
      { ids: ["B1", "B2", "B3", "A1", "L2"], operador: OP_B },
      { ids: ["A11", "L1", "G1", "A3"] },
    ];
    for (const c of cenarios) {
      const ids = c.ids.map((k) => ID[k]);
      const dbExp = await novoBanco({ exportar: true });
      const dbReg = await novoBanco({ exportar: true });
      const e = await exportar(dbExp, ids, { operador: c.operador });
      const g = await registrar(dbReg, ids, c.operador ? { p_operador_email: c.operador } : {});
      expect(nomes(e.ids_exportados)).toEqual(nomes([...new Set(g.ids_registrados)]));
      expect(e.excluidos_confirmacao).toBe(g.excluidos_confirmacao);
      expect(e.excluidos_liquidados_prime).toBe(g.excluidos_liquidados_prime);
      expect(e.excluidos_outro_operador).toBe(g.excluidos_outro_operador);
      expect(e.ids_excluidos).toEqual(g.ids_excluidos);
    }
  }, 60000);

  it("gate de gestao e canal valido", async () => {
    const db = await novoBanco({ exportar: true });
    await expect(exportar(db, [ID.L1], { canal: "SMS" })).rejects.toThrow(/Canal invalido/);
    const { lote_id } = await exportar(db, [ID.L1]);
    await comoOperador(db, OP_A);
    await expect(exportar(db, [ID.A1], { operador: OP_A })).rejects.toThrow(/restrito a gestao/);
    await expect(concluir(db, lote_id, "CONFIRMAR")).rejects.toThrow(/restrito a gestao/);
    await expect(pendentes(db)).rejects.toThrow(/restritos a gestao/);
    await comoGestao(db);
    expect((await lote(db, lote_id)).confirmado_em).toBeNull();
  });
});

describe("confirmar acao realizada: so aqui o aluno e registrado", () => {
  it("confirmar grava tabulacao, retorno +10, acionamento e movimentacao -- e fecha o lote", async () => {
    const db = await novoBanco({ exportar: true });
    const { lote_id, ids_exportados } = await exportar(db, [ID.L1, ID.L2, ID.A1], { arquivo: "campanha.xlsx" });
    expect(await contaMovs(db)).toBe(0);
    const r = await concluir(db, lote_id, "confirmar");
    expect(nomes(r.ids_registrados)).toEqual(nomes(ids_exportados));
    expect(r.registrados).toBe(3);
    expect(r).not.toHaveProperty("contatos");
    const alunos = (await db.query(
      `select status_acionamento, retorno_origem, data_retorno = current_date + 10 as retorno10,
              data_ultimo_acionamento is not null as acionado
         from public.alunos where id = any($1::uuid[])`, [`{${ids_exportados.join(",")}}`])).rows;
    for (const a of alunos) {
      expect(a).toEqual({ status_acionamento: STATUS_MASSIVA, retorno_origem: "AUTOMATICO", retorno10: true, acionado: true });
    }
    const movs = (await db.query(`select tipo, descricao from public.aluno_movimentacoes`)).rows;
    expect(movs.length).toBe(3);
    expect(movs.every((m) => m.tipo === "ACAO_MASSIVA_EXTERNA" && m.descricao.includes("campanha.xlsx"))).toBe(true);
    const l = await lote(db, lote_id);
    expect(l.confirmado_por_email).toBe(GESTAO);
    expect(l.confirmado_em).not.toBeNull();
    // nada de contato guardado no lote
    const guardado = JSON.stringify(l.resultado);
    expect(l.resultado).not.toHaveProperty("contatos");
    expect(guardado).not.toMatch(/telefone|@aluno\.local|\(51\)/);
    expect(await pendentes(db)).toEqual([]);
  });

  it("um lote confirma uma vez so", async () => {
    const db = await novoBanco({ exportar: true });
    const { lote_id } = await exportar(db, [ID.L1, ID.A1]);
    await concluir(db, lote_id, "CONFIRMAR");
    const movs = await contaMovs(db);
    await expect(concluir(db, lote_id, "CONFIRMAR")).rejects.toThrow(/ja foi confirmado/);
    await expect(concluir(db, lote_id, "DESCARTAR")).rejects.toThrow(/ja foi confirmado/);
    expect(await contaMovs(db)).toBe(movs);
  });

  it("descartar nao escreve nada e impede confirmar depois", async () => {
    const db = await novoBanco({ exportar: true });
    const { lote_id } = await exportar(db, [ID.L1, ID.A1]);
    const antes = await fotoOperacional(db);
    const r = await concluir(db, lote_id, "DESCARTAR");
    expect(r).toMatchObject({ descartado: true, registrados: 0 });
    expect(await fotoOperacional(db)).toBe(antes);
    await expect(concluir(db, lote_id, "CONFIRMAR")).rejects.toThrow(/foi descartado/);
    expect(await pendentes(db)).toEqual([]);
    await expect(concluir(db, lote_id, "APAGAR")).rejects.toThrow(/Acao invalida/);
    await expect(concluir(db, "00000000-0000-4000-8000-00000000abcd", "CONFIRMAR")).rejects.toThrow(/nao encontrado/);
  });

  it("quem foi acionado depois da exportacao nao e sobrescrito pela campanha", async () => {
    const db = await novoBanco({ exportar: true });
    const ids = (await previa(db, { p_operador_email: OP_A })).elegiveis.map((e) => e.id);
    const { lote_id } = await exportar(db, ids, { operador: OP_A });
    // o operador liga para A2 depois da exportacao e tabula
    await db.query(`update public.alunos set data_ultimo_acionamento = now(), status_acionamento = 'Promessa de pagamento',
                      data_retorno = current_date + 2 where id = $1`, [ID.A2]);
    const a2antes = (await db.query(`select * from public.alunos where id = $1`, [ID.A2])).rows[0];
    const r = await concluir(db, lote_id, "CONFIRMAR");
    expect(r.excluidos_acionados_apos_exportacao).toBe(1);
    expect(r.ids_acionados_apos_exportacao).toEqual([ID.A2]);
    expect(r.ids_registrados).not.toContain(ID.A2);
    expect(r.registrados).toBe(ids.length - 1);
    expect((await db.query(`select * from public.alunos where id = $1`, [ID.A2])).rows[0]).toEqual(a2antes);
  });

  it("a confirmacao revalida: confirmacao de pagamento e troca de dono depois da exportacao", async () => {
    const db = await novoBanco({ exportar: true });
    const ids = (await previa(db, { p_operador_email: OP_A })).elegiveis.map((e) => e.id);
    const { lote_id } = await exportar(db, ids, { operador: OP_A });
    const donosAntes = (await db.query(`select id, responsavel_atual_email from public.alunos order by id`)).rows;
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento values ($1, 'AGUARDANDO_CONFIRMACAO')`, [ID.A1]);
    await db.query(`update public.alunos set responsavel_atual_email = $1 where id = $2`, [OP_B, ID.A12]);
    const r = await concluir(db, lote_id, "CONFIRMAR");
    expect(r.excluidos_confirmacao).toBe(1);
    expect(r.excluidos_outro_operador).toBe(1);
    expect(r.ids_registrados).not.toContain(ID.A1);
    expect(r.ids_registrados).not.toContain(ID.A12);
    // titularidade: so a troca feita pelo proprio teste
    const donosDepois = (await db.query(`select id, responsavel_atual_email from public.alunos order by id`)).rows;
    expect(donosDepois).toEqual(donosAntes.map((d) => (d.id === ID.A12 ? { ...d, responsavel_atual_email: OP_B } : d)));
  });

  it("lotes pendentes: so os abertos, mais recente primeiro, sem dado pessoal de aluno", async () => {
    const db = await novoBanco({ exportar: true });
    const a = await exportar(db, [ID.L1], { arquivo: "a.xlsx" });
    const b = await exportar(db, [ID.A1, ID.A2], { operador: OP_A, arquivo: "b.xlsx", canal: "EMAIL" });
    const c = await exportar(db, [ID.L2], { arquivo: "c.xlsx" });
    await concluir(db, c.lote_id, "DESCARTAR");
    const p = await pendentes(db);
    expect(p.map((x) => x.id)).toEqual([b.lote_id, a.lote_id]);
    expect(Object.keys(p[0]).sort()).toEqual(
      ["arquivo", "canal", "exportado_em", "exportado_por_email", "id", "operador_email", "operador_nome", "total"]);
    expect(p[0]).toMatchObject({ canal: "EMAIL", operador_email: OP_A, operador_nome: "Ana Operadora", total: 2 });
  });
});

describe("instalacao: estrutura, ACL, RLS, dependencia, idempotencia e rollback", () => {
  const semComentarios = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const corpo = (nome) => {
    const ini = MIGRATION_EXPORTAR.indexOf(`create or replace function public.${nome}(`);
    const fim = MIGRATION_EXPORTAR.indexOf("$function$;", ini);
    expect(ini).toBeGreaterThan(-1);
    return semComentarios(MIGRATION_EXPORTAR.slice(ini, fim));
  };

  it("exportar so escreve no lote e nunca chama o registro", () => {
    const fn = corpo("acoes_massivas_exportar");
    const alvos = [...fn.matchAll(/\b(insert\s+into|update|delete\s+from)\s+public\.(\w+)/gi)].map((m) => m[2]);
    expect(new Set(alvos)).toEqual(new Set(["acoes_massivas_lotes"]));
    expect(fn).not.toMatch(/registrar_acao_massiva/);
    expect(fn).not.toMatch(/aluno_movimentacoes|public\.casos/);
  });

  it("tabela com RLS e sem acesso direto; funcoes sem anon/PUBLIC", async () => {
    const db = await novoBanco({ exportar: true });
    const rls = (await db.query(`select relrowsecurity from pg_class where oid = 'public.acoes_massivas_lotes'::regclass`)).rows[0];
    expect(rls.relrowsecurity).toBe(true);
    for (const papel of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const ok = (await db.query(`select has_table_privilege($1, 'public.acoes_massivas_lotes', $2) ok`, [papel, priv])).rows[0].ok;
        expect(ok).toBe(false);
      }
    }
    for (const fn of ["public.acoes_massivas_exportar(text[],text,text,text)",
                      "public.acoes_massivas_concluir_lote(uuid,text)",
                      "public.acoes_massivas_lotes_pendentes()"]) {
      const q = async (papel) => (await db.query(`select has_function_privilege($1, $2, 'EXECUTE') ok`, [papel, fn])).rows[0].ok;
      expect(await q("anon")).toBe(false);
      expect(await q("authenticated")).toBe(true);
      expect(await q("service_role")).toBe(true);
      const acl = (await db.query(`select array_to_string(proacl, ',') a from pg_proc where oid = $1::regprocedure`, [fn])).rows[0].a;
      expect(acl.split(",").some((e) => e.startsWith("="))).toBe(false);
    }
  });

  it("sem a migration do operador aplicada, falha alto e nao cria nada", async () => {
    const db = await novoBanco();
    await expect(db.exec(MIGRATION_EXPORTAR)).rejects.toThrow(/aplique antes a migration 20260916200000/);
    expect((await db.query(`select to_regclass('public.acoes_massivas_lotes') t`)).rows[0].t).toBeNull();
  });

  it("rodar de novo preserva os lotes; rollback guarda a tabela como backup e tira as funcoes", async () => {
    const db = await novoBanco({ exportar: true });
    const { lote_id } = await exportar(db, [ID.L1]);
    await db.exec(MIGRATION_EXPORTAR);
    expect((await lote(db, lote_id)).total).toBe(1);
    await db.exec(ROLLBACK_EXPORTAR);
    const fns = (await db.query(`select count(*) n from pg_proc where proname in
      ('acoes_massivas_exportar','acoes_massivas_concluir_lote','acoes_massivas_lotes_pendentes')`)).rows[0].n;
    expect(Number(fns)).toBe(0);
    const bk = (await db.query(`select relname, relrowsecurity from pg_class where relname like '_backup_acoes_massivas_lotes_%'`)).rows;
    expect(bk.length).toBe(1);
    expect(bk[0].relrowsecurity).toBe(true);
    expect(Number((await db.query(`select count(*) n from public.${bk[0].relname}`)).rows[0].n)).toBe(1);
    // o registro direto segue existindo (tela antiga continua funcionando)
    const reg = await registrar(db, [ID.L1]);
    expect(reg.registrados).toBe(1);
  });
});
