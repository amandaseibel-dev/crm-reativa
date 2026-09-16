// ACOES MASSIVAS: FILTRO "TIPO DE COBRANCA" -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) com as definicoes de producao de 16/09/2026 mais as
// migrations 20260916200000 (operador), 210000 (exportar x confirmar) e 220000
// (tipo de cobranca).
//
// REGRA (decidida pela gestao em 16/09):
//   TODOS                   regra atual, sem filtrar pelo tipo;
//   MENSALIDADES            mensalidade em aberto e sem acordo ativo;
//   ACORDOS                 acordo ATIVO com parcela VENCIDA e sem mensalidade;
//   MENSALIDADES_E_ACORDOS  os dois ao mesmo tempo.
// Opcoes exclusivas. Acordo em dia fica fora de todas.
//
// Carteira de teste (bancada.js):
//   A1 A2 A11 L1 L2 B1 B2 B3 G1  mensalidade simples
//   A3   mensalidade NEGOCIADO ligada a acordo CANCELADO (continua mensalidade)
//   A12  mensalidade com saldo cobravel ajustado para zero (nao conta)
//   A6   acordo ATIVO sem parcela;  A15 acordo ATIVO em dia (+ mensalidade)
//   A13  acordo vencido, titulo do tipo 'Acordo' (nao e mensalidade)
//   A16  acordo vencido, titulo vinculado ao acordo (nao e mensalidade)
//   A14 L4  acordo vencido + mensalidade
//   B4   acordo vencido, titulo pago;  A17 igual, em confirmacao;  A18 igual, quitado
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  MATRIZ, MIGRATION_TIPO, ROLLBACK_TIPO, OP_A, OP_B, IMP1, ID, NOME_POR_ID, md5,
  comoGestao, previa, novoBanco, normal, chaves,
} from "./fixtures/acoes_massivas_prod_20260916/bancada.js";

// Cada teste sobe um PostgreSQL inteiro (alguns, dois). No runner do CI e com a
// suite toda em paralelo, 5 s nao bastam.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const TIPOS = ["TODOS", "MENSALIDADES", "ACORDOS", "MENSALIDADES_E_ACORDOS"];
const nomes = (ids) => ids.map((i) => NOME_POR_ID[i]).sort();
const ord = (r) => chaves(r).sort();

// Sem `tipo`, a chamada nem cita p_tipo_cobranca: funciona tambem no banco de
// antes da migration do tipo.
async function exportar(db, ids, { operador, tipo, canal = "WHATSAPP" } = {}) {
  const comTipo = tipo !== undefined;
  const r = await db.query(
    `select public.acoes_massivas_exportar(p_aluno_ids => $1::text[], p_canal => $2, p_arquivo => 'x.xlsx',
       p_operador_email => $3${comTipo ? ", p_tipo_cobranca => $4" : ""}) r`,
    [`{${ids.join(",")}}`, canal, operador ?? null, ...(comTipo ? [tipo] : [])]);
  return r.rows[0].r;
}
const omitir = (obj, chavesFora) => Object.fromEntries(Object.entries(obj).filter(([k]) => !chavesFora.includes(k)));
async function concluir(db, lote) {
  return (await db.query(`select public.acoes_massivas_concluir_lote($1::uuid, 'CONFIRMAR') r`, [lote])).rows[0].r;
}
const idsPrevia = async (db, args) => (await previa(db, args)).elegiveis.map((e) => e.id);

// Tudo o que o filtro NAO pode alterar: titulos, acordos, parcelas, vinculos,
// valores e responsaveis.
async function fotoIntocavel(db) {
  const q = async (sql) => JSON.stringify((await db.query(sql)).rows);
  return [
    await q(`select * from public.acordos_titulos order by id`),
    await q(`select * from public.acordos order by id`),
    await q(`select * from public.parcelas order by id`),
    await q(`select * from public.acordo_titulo_vinculo order by titulo_id`),
    await q(`select * from public.casos order by aluno_id, total_em_aberto`),
    await q(`select id, responsavel_atual_email from public.alunos order by id`),
  ].join("\n");
}

describe("previa: cada opcao, com e sem operador", () => {
  let db;
  beforeAll(async () => { db = await novoBanco({ tipo: true }); });
  const caso = (tipo, extra = {}) => ({ ...(tipo ? { p_tipo_cobranca: tipo } : {}), ...extra });

  it("sem operador", async () => {
    expect(ord(await previa(db, caso("TODOS")))).toEqual(["L1", "L2"]);
    expect(ord(await previa(db, caso("MENSALIDADES")))).toEqual(["L1", "L2"]);
    expect(ord(await previa(db, caso("ACORDOS")))).toEqual([]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS")))).toEqual(["L4"]);
  });

  it("sem operador, so nunca acionados (entra quem tem dono e nunca foi acionado)", async () => {
    const n = { p_apenas_nunca_acionado: true };
    expect(ord(await previa(db, caso("TODOS", n)))).toEqual(["A1", "A11", "B1", "G1", "L1"]);
    expect(ord(await previa(db, caso("MENSALIDADES", n)))).toEqual(["A1", "A11", "B1", "G1", "L1"]);
    expect(ord(await previa(db, caso("ACORDOS", n)))).toEqual(["B4"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", n)))).toEqual(["A14", "L4"]);
  });

  it("operador A", async () => {
    const o = { p_operador_email: OP_A };
    expect(ord(await previa(db, caso("TODOS", o)))).toEqual(["A1", "A10", "A11", "A12", "A2", "A3"]);
    expect(ord(await previa(db, caso("MENSALIDADES", o)))).toEqual(["A1", "A10", "A11", "A2", "A3"]);
    expect(ord(await previa(db, caso("ACORDOS", o)))).toEqual(["A13", "A16"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", o)))).toEqual(["A14"]);
  });

  it("operador B", async () => {
    const o = { p_operador_email: OP_B };
    expect(ord(await previa(db, caso("MENSALIDADES", o)))).toEqual(["B1", "B2", "B3"]);
    expect(ord(await previa(db, caso("ACORDOS", o)))).toEqual(["B4"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", o)))).toEqual([]);
  });

  it("travas seguem valendo nas opcoes de acordo: confirmacao, quitado, acordo em dia", async () => {
    const r = await previa(db, caso("ACORDOS", { p_operador_email: OP_A, p_apenas_nunca_acionado: true }));
    expect(chaves(r)).toEqual([]);
    expect(r.excluidos_confirmacao).toEqual([{ aluno: "A17 ***", motivo: "Aguardando confirmação financeira" }]);
    for (const t of TIPOS) {
      const todos = chaves(await previa(db, caso(t, { p_operador_email: OP_A })));
      for (const fora of ["A4", "A5", "A6", "A7", "A8", "A9", "A15", "A17", "A18"]) expect(todos).not.toContain(fora);
    }
  });

  it("combinado com prazo, acionamento, unidade, curso, bordero, canal e valor", async () => {
    const A = { p_operador_email: OP_A };
    expect(ord(await previa(db, caso("ACORDOS", { ...A, p_dias_minimo_sem_contato: 15 })))).toEqual(["A13", "A16"]);
    expect(ord(await previa(db, caso("ACORDOS", { ...A, p_dias_minimo_sem_contato: 25 })))).toEqual(["A16"]);
    expect(ord(await previa(db, caso("ACORDOS", { ...A, p_apenas_ja_acionado: true })))).toEqual(["A13", "A16"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", { ...A, p_apenas_nunca_acionado: true })))).toEqual(["A14"]);
    expect(ord(await previa(db, caso("ACORDOS", { ...A, p_unidade: "U1" })))).toEqual(["A16"]);
    expect(ord(await previa(db, caso("ACORDOS", { ...A, p_curso: "EAD" })))).toEqual(["A13"]);
    expect(ord(await previa(db, caso("MENSALIDADES", { ...A, p_unidade: "U1" })))).toEqual(["A1", "A10", "A3"]);
    expect(ord(await previa(db, caso("MENSALIDADES", { ...A, p_importacao_ids: [IMP1] })))).toEqual(["A1"]);
    expect(ord(await previa(db, caso("ACORDOS", { p_operador_email: OP_B, p_importacao_ids: [IMP1] })))).toEqual(["B4"]);
    expect(ord(await previa(db, caso("ACORDOS", { ...A, p_canal: "WHATSAPP", p_valor_min: 500 })))).toEqual(["A13"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", { p_unidade: "U1" })))).toEqual(["L4"]);
  });

  it("a previa devolve o tipo aplicado; valor invalido e recusado", async () => {
    expect((await previa(db, {})).tipo_cobranca).toBe("TODOS");
    expect((await previa(db, caso("acordos"))).tipo_cobranca).toBe("ACORDOS");
    await expect(previa(db, caso("BOLETO"))).rejects.toThrow(/Tipo de cobranca invalido/);
  });

  it("propriedades em toda a matriz x operador: exclusivas, dentro do dono, mensalidades dentro de Todos", async () => {
    const vencidos = new Set((await db.query(
      `select distinct a.aluno_id::text id from public.acordos a join public.parcelas p on p.acordo_id = a.id
        where a.status = 'ATIVO' and p.status = 'VENCIDA'`)).rows.map((x) => x.id));
    const dono = Object.fromEntries((await db.query(`select id::text, responsavel_atual_email d from public.alunos`)).rows.map((x) => [x.id, x.d]));
    for (const op of [null, OP_A, OP_B]) {
      for (const args of MATRIZ) {
        const base = op ? { ...args, p_operador_email: op } : args;
        const r = {};
        for (const t of TIPOS) r[t] = new Set(chaves(await previa(db, { ...base, p_tipo_cobranca: t })));
        const [m, a, ma, todos] = [r.MENSALIDADES, r.ACORDOS, r.MENSALIDADES_E_ACORDOS, r.TODOS];
        // com p_limite o corte pega alunos diferentes em cada lista: a inclusao
        // em Todos so vale sem limite
        const semLimite = args.p_limite == null;
        for (const k of m) { expect(a.has(k)).toBe(false); expect(ma.has(k)).toBe(false); if (semLimite) expect(todos.has(k)).toBe(true); }
        for (const k of a) expect(ma.has(k)).toBe(false);
        for (const k of [...a, ...ma]) expect(vencidos.has(ID[k])).toBe(true);
        if (op) for (const t of TIPOS) for (const k of r[t]) expect(dono[ID[k]]).toBe(op);
      }
    }
  }, 120000);
});

describe("Todos preserva exatamente o comportamento atual", () => {
  it("previa sem tipo / NULL / vazio / TODOS = previa de antes da migration, com e sem operador", async () => {
    const db = await novoBanco({ exportar: true });
    const combos = [];
    for (const op of [null, OP_A, OP_B]) {
      for (const args of MATRIZ) combos.push(op ? { ...args, p_operador_email: op } : args);
    }
    const antes = [];
    for (const c of combos) antes.push(await previa(db, c));
    await db.exec(MIGRATION_TIPO);
    await comoGestao(db);
    for (let i = 0; i < combos.length; i += 1) {
      for (const tipo of [undefined, null, "", "TODOS", "todos"]) {
        const args = tipo === undefined ? combos[i] : { ...combos[i], p_tipo_cobranca: tipo };
        const { tipo_cobranca, ...resto } = await previa(db, args);
        expect(tipo_cobranca).toBe("TODOS");
        expect(normal(resto)).toEqual(normal(antes[i]));
      }
    }
  }, 120000);

  it("exportar e confirmar sem tipo = com TODOS, e iguais ao fluxo de antes", async () => {
    const ids = [ID.L1, ID.L2, ID.A1, ID.A2, ID.B2, ID.L3, ID.A9, ID.X1, ID.A14, ID.L4];
    const antes = await novoBanco({ exportar: true });
    const depois = await novoBanco({ tipo: true });
    const e0 = await exportar(antes, ids);
    const e1 = await exportar(depois, ids);
    const e2 = await exportar(depois, ids, { tipo: "TODOS" });
    for (const e of [e1, e2]) {
      expect(e.excluidos_tipo_cobranca).toBe(0);
      expect(e.tipo_cobranca).toBe("TODOS");
      expect(e.lote_id).toBeTruthy();
      expect(omitir(e, ["lote_id", "excluidos_tipo_cobranca", "tipo_cobranca"])).toEqual(omitir(e0, ["lote_id"]));
    }
    const c0 = await concluir(antes, e0.lote_id);
    const c1 = await concluir(depois, e1.lote_id);
    const tira = (x) => omitir(x, ["lote_id", "tipo_cobranca", "excluidos_tipo_cobranca", "ids_fora_do_tipo_cobranca"]);
    expect(c1.tipo_cobranca).toBe("TODOS");
    expect(c1.excluidos_tipo_cobranca).toBe(0);
    expect(tira(c1)).toEqual(tira(c0));
  }, 60000);
});

describe("mesma populacao na previa, na planilha e na confirmacao", () => {
  it("para cada tipo e operador, previa = exportacao = confirmacao; o lote guarda o tipo", async () => {
    const combos = [];
    for (const tipo of TIPOS) {
      for (const op of [null, OP_A, OP_B]) combos.push({ tipo, op });
    }
    for (const { tipo, op } of combos) {
      const db = await novoBanco({ tipo: true });
      const args = { p_tipo_cobranca: tipo, p_apenas_nunca_acionado: op == null, ...(op ? { p_operador_email: op } : {}) };
      const p = await idsPrevia(db, args);
      const e = await exportar(db, p, { operador: op, tipo });
      expect(nomes(e.ids_exportados)).toEqual(nomes(p));
      expect(e.tipo_cobranca).toBe(tipo);
      if (p.length === 0) continue;
      const lote = (await db.query(`select tipo_cobranca from public.acoes_massivas_lotes where id = $1`, [e.lote_id])).rows[0];
      expect(lote.tipo_cobranca).toBe(tipo);
      const pend = (await db.query(`select public.acoes_massivas_lotes_pendentes() r`)).rows[0].r;
      expect(pend[0].tipo_cobranca).toBe(tipo);
      const c = await concluir(db, e.lote_id);
      expect(nomes(c.ids_registrados)).toEqual(nomes(p));
      expect(c.tipo_cobranca).toBe(tipo);
    }
  }, 180000);

  it("a planilha recusa quem nao corresponde ao tipo", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A1, ID.A13, ID.A14, ID.A15], { operador: OP_A, tipo: "ACORDOS" });
    expect(nomes(e.ids_exportados)).toEqual(["A13"]);
    expect(e.excluidos_tipo_cobranca).toBe(3);
    expect(e.ids_excluidos.map((x) => x.motivo)).toEqual(Array(3).fill("Não corresponde ao tipo de cobrança selecionado"));
    await expect(exportar(db, [ID.A1], { tipo: "XPTO" })).rejects.toThrow(/Tipo de cobranca invalido/);
  });
});

describe("a confirmacao revalida o tipo no banco", () => {
  it("acordo que ficou em dia depois da exportacao sai de 'Somente acordos'", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A13, ID.A16], { operador: OP_A, tipo: "ACORDOS" });
    await db.query(`update public.parcelas set status = 'PAGO' where acordo_id in
      (select id from public.acordos where aluno_id = $1) and status = 'VENCIDA'`, [ID.A13]);
    const c = await concluir(db, e.lote_id);
    expect(c.ids_fora_do_tipo_cobranca).toEqual([ID.A13]);
    expect(c.excluidos_tipo_cobranca).toBe(1);
    expect(c.ids_registrados).toEqual([ID.A16]);
    const a13 = (await db.query(`select status_acionamento from public.alunos where id = $1`, [ID.A13])).rows[0];
    expect(a13.status_acionamento).toBeNull();
  });

  it("mensalidade paga depois da exportacao sai de 'Mensalidades e acordos'", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A14], { operador: OP_A, tipo: "MENSALIDADES_E_ACORDOS" });
    await db.query(`update public.acordos_titulos set situacao = 'PAGO', status = 'quitada' where aluno_id = $1`, [ID.A14]);
    const c = await concluir(db, e.lote_id);
    expect(c.excluidos_tipo_cobranca).toBe(1);
    expect(c.registrados).toBe(0);
  });

  it("acordo fechado depois da exportacao tira o aluno de 'Somente mensalidades'", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A1, ID.A2], { operador: OP_A, tipo: "MENSALIDADES" });
    await db.query(`insert into public.acordos (aluno_id, status) values ($1, 'ATIVO')`, [ID.A2]);
    const c = await concluir(db, e.lote_id);
    expect(c.ids_fora_do_tipo_cobranca).toEqual([ID.A2]);
    expect(c.ids_registrados).toEqual([ID.A1]);
  });
});

describe("nada de titulos, acordos, parcelas, valores ou responsaveis muda", () => {
  it("previa, exportacao e confirmacao em todos os tipos", async () => {
    const db = await novoBanco({ tipo: true });
    const antes = await fotoIntocavel(db);
    for (const tipo of TIPOS) {
      for (const op of [null, OP_A, OP_B]) {
        const args = { p_tipo_cobranca: tipo, p_apenas_nunca_acionado: true, ...(op ? { p_operador_email: op } : {}) };
        const p = await idsPrevia(db, args);
        if (p.length === 0) continue;
        const e = await exportar(db, p, { operador: op, tipo });
        if (e.lote_id) await concluir(db, e.lote_id);
      }
    }
    expect(await fotoIntocavel(db)).toBe(antes);
  }, 60000);
});

describe("instalacao: ACL, dependencia, falha alta, idempotencia e rollback", () => {
  const fnDefs = async (db) => (await db.query(`
    select p.proname, md5(pg_get_functiondef(p.oid)) h, pg_get_function_identity_arguments(p.oid) args,
           array_to_string(p.proacl, ',') acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in
       ('acoes_massivas_previa','acoes_massivas_exportar','acoes_massivas_concluir_lote','acoes_massivas_lotes_pendentes',
        'acoes_massivas_tipo_cobranca_confere')
     order by p.proname, p.oid`)).rows;
  const colunas = async (db) => (await db.query(
    `select column_name from information_schema.columns where table_name = 'acoes_massivas_lotes' order by column_name`)).rows.map((x) => x.column_name);

  it("o rollback carrega exatamente os mesmos trechos da migration", () => {
    const trechos = (sql) => [...sql.matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
    expect(trechos(MIGRATION_TIPO).length).toBe(32);
    expect(trechos(ROLLBACK_TIPO)).toEqual(trechos(MIGRATION_TIPO));
  });

  it("uma sobrecarga por funcao; regra so para service_role; funcoes da tela sem anon/PUBLIC", async () => {
    const db = await novoBanco({ tipo: true });
    const d = await fnDefs(db);
    expect(d.map((x) => x.proname)).toEqual(["acoes_massivas_concluir_lote", "acoes_massivas_exportar",
      "acoes_massivas_lotes_pendentes", "acoes_massivas_previa", "acoes_massivas_tipo_cobranca_confere"]);
    const priv = async (papel, fn) => (await db.query(`select has_function_privilege($1, $2, 'EXECUTE') ok`, [papel, fn])).rows[0].ok;
    const regra = "public.acoes_massivas_tipo_cobranca_confere(text,uuid[])";
    expect(await priv("anon", regra)).toBe(false);
    expect(await priv("authenticated", regra)).toBe(false);
    expect(await priv("service_role", regra)).toBe(true);
    for (const fn of ["public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text,text)",
                      "public.acoes_massivas_exportar(text[],text,text,text,text)"]) {
      expect(await priv("anon", fn)).toBe(false);
      expect(await priv("authenticated", fn)).toBe(true);
      expect(await priv("service_role", fn)).toBe(true);
    }
    for (const x of d) expect((x.acl || "").split(",").some((e) => e.startsWith("="))).toBe(false);
    await expect(db.query(`insert into public.acoes_massivas_lotes (canal, aluno_ids, total, exportado_por_email, tipo_cobranca)
      values ('WHATSAPP', '{}', 0, 'x', 'XPTO')`)).rejects.toThrow(/tipo_cobranca_valido/);
  });

  it("sem a migration de exportar aplicada, falha alto e nao cria nada", async () => {
    const db = await novoBanco({ migrar: true });
    await expect(db.exec(MIGRATION_TIPO)).rejects.toThrow(/aplique antes a migration 20260916210000/);
    expect((await db.query(`select to_regprocedure('public.acoes_massivas_tipo_cobranca_confere(text,uuid[])') f`)).rows[0].f).toBeNull();
  });

  it("ancora ausente: falha alto e nao instala nada -- nem a coluna do lote", async () => {
    const db = await novoBanco({ exportar: true });
    const def = (await db.query(`select pg_get_functiondef('public.acoes_massivas_lotes_pendentes()'::regprocedure) d`)).rows[0].d;
    await db.exec(def.replace("'operador_email', l.operador_email,", "'operador', l.operador_email,"));
    const antes = await fnDefs(db);
    await expect(db.exec(MIGRATION_TIPO)).rejects.toThrow(/acoes_massivas_lotes_pendentes: ancora nao encontrada/);
    expect(await fnDefs(db)).toEqual(antes);
    expect(await colunas(db)).not.toContain("tipo_cobranca");
  });

  it("rodar de novo nao muda nada; rollback devolve as funcoes de antes e tira coluna e regra", async () => {
    const db = await novoBanco({ exportar: true });
    const antes = await fnDefs(db);
    const colAntes = await colunas(db);
    await db.exec(MIGRATION_TIPO);
    const uma = await fnDefs(db);
    await db.exec(MIGRATION_TIPO);
    expect(await fnDefs(db)).toEqual(uma);
    expect(md5(JSON.stringify(uma))).not.toBe(md5(JSON.stringify(antes)));
    await db.exec(ROLLBACK_TIPO);
    expect(await fnDefs(db)).toEqual(antes);
    expect(await colunas(db)).toEqual(colAntes);
    await db.exec(ROLLBACK_TIPO);
    expect(await fnDefs(db)).toEqual(antes);
  });
});
