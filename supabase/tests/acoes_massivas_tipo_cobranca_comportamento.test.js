// ACOES MASSIVAS: FILTRO "TIPO DE COBRANCA" -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) com as definicoes de producao de 16/09/2026 mais as
// migrations 20260916200000 (operador), 210000 (exportar x confirmar) e 220000
// (tipo de cobranca).
//
// REGRA (gestao, 16/09):
//   MENSALIDADES            alunos elegiveis com mensalidade original em aberto;
//   ACORDOS_VENCIDOS        alunos elegiveis com acordo ATIVO com parcela VENCIDA;
//   MENSALIDADES_E_ACORDOS  uniao das duas, sem duplicar.
// Acordo em dia fora de todas. Demais travas (inclusive retorno agendado) iguais.
// Sem tipo: a tela anterior, identica a antes.
//
// Carteira de teste (bancada.js):
//   A1 A2 A11 L1 L2 B1 B2 B3 G1  mensalidade simples
//   A3   mensalidade NEGOCIADO ligada a acordo CANCELADO (continua mensalidade)
//   A12  mensalidade com saldo cobravel ajustado para zero (nao conta)
//   A6   acordo ATIVO sem parcela + mensalidade (acordo em dia: fora)
//   A15  acordo ATIVO so com parcela a vencer + mensalidade (em dia: fora)
//   A13  acordo vencido, titulo do tipo 'Acordo' (nao e mensalidade)
//   A16  acordo vencido, titulo vinculado ao acordo (nao e mensalidade)
//   A14 L4  acordo vencido + mensalidade (os dois tipos)
//   B4   acordo vencido, titulo pago;  A17 igual, em confirmacao;  A18 igual, quitado
//   A4 confirmacao, A5 quitado, A7 retorno agendado, A8 juridico, A9 liquidado no Prime
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  MATRIZ, MIGRATION_TIPO, ROLLBACK_TIPO, OP_A, OP_B, IMP1, ID, NOME_POR_ID, md5,
  comoGestao, previa, novoBanco, normal, chaves,
} from "./fixtures/acoes_massivas_prod_20260916/bancada.js";

// Cada teste sobe um PostgreSQL inteiro (alguns, dois). No runner do CI e com a
// suite toda em paralelo, 5 s nao bastam.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const TIPOS = ["MENSALIDADES", "ACORDOS_VENCIDOS", "MENSALIDADES_E_ACORDOS"];
const nomes = (ids) => ids.map((i) => NOME_POR_ID[i]).sort();
const ord = (r) => chaves(r).sort();
const omitir = (obj, fora) => Object.fromEntries(Object.entries(obj).filter(([k]) => !fora.includes(k)));

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
  const caso = (tipo, extra = {}) => ({ p_tipo_cobranca: tipo, ...extra });

  it("operador A: mensalidades, acordos vencidos e a uniao sem duplicar", async () => {
    const o = { p_operador_email: OP_A };
    const m = await previa(db, caso("MENSALIDADES", o));
    const v = await previa(db, caso("ACORDOS_VENCIDOS", o));
    const u = await previa(db, caso("MENSALIDADES_E_ACORDOS", o));
    expect(ord(m)).toEqual(["A1", "A10", "A11", "A14", "A2", "A3"]);
    expect(ord(v)).toEqual(["A13", "A14", "A16"]);
    expect(ord(u)).toEqual(["A1", "A10", "A11", "A13", "A14", "A16", "A2", "A3"]);
    // A14 tem os dois tipos: aparece nas duas listas e UMA vez na uniao
    expect(chaves(u).filter((k) => k === "A14").length).toBe(1);
    const contagem = { mensalidades: 6, acordos_vencidos: 3, mensalidades_e_acordos_vencidos: 1, total_unico: 8 };
    for (const r of [m, v, u]) expect(r.contagem_tipo).toEqual(contagem);
    expect([m.total_elegivel_filtros, v.total_elegivel_filtros, u.total_elegivel_filtros]).toEqual([6, 3, 8]);
    expect(m.tipo_cobranca).toBe("MENSALIDADES");
  });

  it("operador B e sem operador", async () => {
    const B = { p_operador_email: OP_B };
    expect(ord(await previa(db, caso("MENSALIDADES", B)))).toEqual(["B1", "B2", "B3"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", B)))).toEqual(["B4"]);
    const ub = await previa(db, caso("MENSALIDADES_E_ACORDOS", B));
    expect(ord(ub)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(ub.contagem_tipo).toEqual({ mensalidades: 3, acordos_vencidos: 1, mensalidades_e_acordos_vencidos: 0, total_unico: 4 });
    expect(ord(await previa(db, caso("MENSALIDADES")))).toEqual(["L1", "L2", "L4"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS")))).toEqual(["L4"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS")))).toEqual(["L1", "L2", "L4"]);
  });

  it("sem operador, so nunca acionados (entra quem tem dono e nunca foi acionado)", async () => {
    const n = { p_apenas_nunca_acionado: true };
    expect(ord(await previa(db, caso("MENSALIDADES", n)))).toEqual(["A1", "A11", "A14", "B1", "G1", "L1", "L4"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", n)))).toEqual(["A14", "B4", "L4"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", n)))).toEqual(["A1", "A11", "A14", "B1", "B4", "G1", "L1", "L4"]);
  });

  it("acordo em dia fica fora de todas; as demais travas seguem, inclusive retorno agendado", async () => {
    for (const t of TIPOS) {
      for (const extra of [{}, { p_operador_email: OP_A }, { p_apenas_nunca_acionado: true }]) {
        const lista = chaves(await previa(db, caso(t, extra)));
        for (const fora of ["A4", "A5", "A6", "A7", "A8", "A9", "A12", "A15", "A17", "A18", "L3"]) {
          expect(lista).not.toContain(fora);
        }
      }
    }
    const r = await previa(db, caso("MENSALIDADES_E_ACORDOS", { p_operador_email: OP_A }));
    expect(r.excluidos_confirmacao).toEqual([
      { aluno: "A17 ***", motivo: "Aguardando confirmação financeira" },
      { aluno: "A4 ***", motivo: "Aguardando confirmação financeira" },
    ]);
    expect((await previa(db, caso("MENSALIDADES", { p_operador_email: OP_A }))).excluidos_confirmacao.map((x) => x.aluno)).toEqual(["A4 ***"]);
    expect((await previa(db, caso("ACORDOS_VENCIDOS", { p_operador_email: OP_A }))).excluidos_confirmacao.map((x) => x.aluno)).toEqual(["A17 ***"]);
  });

  it("combinado com prazo, acionamento, unidade, curso, bordero, canal e valor", async () => {
    const A = { p_operador_email: OP_A };
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { ...A, p_dias_minimo_sem_contato: 15 })))).toEqual(["A13", "A14", "A16"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { ...A, p_dias_minimo_sem_contato: 25 })))).toEqual(["A14", "A16"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { ...A, p_apenas_ja_acionado: true })))).toEqual(["A13", "A16"]);
    expect(ord(await previa(db, caso("MENSALIDADES_E_ACORDOS", { ...A, p_apenas_nunca_acionado: true })))).toEqual(["A1", "A11", "A14"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { ...A, p_unidade: "U1" })))).toEqual(["A14", "A16"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { ...A, p_curso: "EAD" })))).toEqual(["A13"]);
    expect(ord(await previa(db, caso("MENSALIDADES", { ...A, p_unidade: "U1" })))).toEqual(["A1", "A10", "A14", "A3"]);
    expect(ord(await previa(db, caso("MENSALIDADES", { ...A, p_importacao_ids: [IMP1] })))).toEqual(["A1"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { p_operador_email: OP_B, p_importacao_ids: [IMP1] })))).toEqual(["B4"]);
    expect(ord(await previa(db, caso("ACORDOS_VENCIDOS", { ...A, p_canal: "WHATSAPP", p_valor_min: 500 })))).toEqual(["A13", "A14"]);
    const u1 = await previa(db, caso("MENSALIDADES_E_ACORDOS", { p_unidade: "U1" }));
    expect(ord(u1)).toEqual(["L1", "L4"]);
    expect(u1.contagem_tipo).toEqual({ mensalidades: 2, acordos_vencidos: 1, mensalidades_e_acordos_vencidos: 1, total_unico: 2 });
  });

  it("valores aceitos e recusados: sem 'Todos', sem pedir a regra anterior", async () => {
    expect((await previa(db, caso("acordos_vencidos"))).tipo_cobranca).toBe("ACORDOS_VENCIDOS");
    for (const ruim of ["TODOS", "REGRA_ANTERIOR", "ACORDOS", "BOLETO"]) {
      await expect(previa(db, caso(ruim))).rejects.toThrow(/Tipo de cobranca invalido/);
    }
  });

  it("propriedades em toda a matriz x operador: uniao exata, sem duplicar, contagem coerente, dono", async () => {
    const dono = Object.fromEntries((await db.query(`select id::text, responsavel_atual_email d from public.alunos`)).rows.map((x) => [x.id, x.d]));
    for (const op of [null, OP_A, OP_B]) {
      for (const args of MATRIZ) {
        const base = op ? { ...args, p_operador_email: op } : args;
        const r = {};
        for (const t of TIPOS) r[t] = await previa(db, { ...base, p_tipo_cobranca: t });
        const lista = (t) => chaves(r[t]);
        for (const t of TIPOS) {
          expect(new Set(lista(t)).size).toBe(lista(t).length);                  // sem duplicar
          expect(r[t].contagem_tipo).toEqual(r.MENSALIDADES.contagem_tipo);       // contagem nao depende da opcao
          for (const k of lista(t)) expect(["A6", "A15"]).not.toContain(k);       // acordo em dia nunca
          if (op) for (const k of lista(t)) expect(dono[ID[k]]).toBe(op);
        }
        const c = r.MENSALIDADES.contagem_tipo;
        expect(r.MENSALIDADES.total_elegivel_filtros).toBe(c.mensalidades);
        expect(r.ACORDOS_VENCIDOS.total_elegivel_filtros).toBe(c.acordos_vencidos);
        expect(r.MENSALIDADES_E_ACORDOS.total_elegivel_filtros).toBe(c.total_unico);
        expect(c.total_unico).toBe(c.mensalidades + c.acordos_vencidos - c.mensalidades_e_acordos_vencidos);
        if (args.p_limite == null) {
          const uniao = new Set([...lista("MENSALIDADES"), ...lista("ACORDOS_VENCIDOS")]);
          expect([...uniao].sort()).toEqual([...lista("MENSALIDADES_E_ACORDOS")].sort());
          expect(lista("MENSALIDADES").filter((k) => lista("ACORDOS_VENCIDOS").includes(k)).length).toBe(c.mensalidades_e_acordos_vencidos);
        }
      }
    }
  }, 180000);
});

describe("sem tipo (tela anterior): identico a antes", () => {
  it("previa sem tipo / NULL / vazio = previa de antes da migration, com e sem operador", async () => {
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
      for (const tipo of [undefined, null, "", "   "]) {
        const args = tipo === undefined ? combos[i] : { ...combos[i], p_tipo_cobranca: tipo };
        const r = await previa(db, args);
        expect(r.tipo_cobranca).toBe("REGRA_ANTERIOR");
        expect(r.contagem_tipo).toBeNull();
        expect(normal(omitir(r, ["tipo_cobranca", "contagem_tipo"]))).toEqual(normal(antes[i]));
      }
    }
  }, 180000);

  it("exportar e confirmar sem tipo = fluxo de antes", async () => {
    const ids = [ID.L1, ID.L2, ID.A1, ID.A2, ID.B2, ID.L3, ID.A9, ID.X1, ID.A14, ID.L4];
    const antes = await novoBanco({ exportar: true });
    const depois = await novoBanco({ tipo: true });
    const e0 = await exportar(antes, ids);
    const e1 = await exportar(depois, ids);
    expect(e1.excluidos_tipo_cobranca).toBe(0);
    expect(e1.tipo_cobranca).toBe("REGRA_ANTERIOR");
    expect(omitir(e1, ["lote_id", "excluidos_tipo_cobranca", "tipo_cobranca"])).toEqual(omitir(e0, ["lote_id"]));
    const c0 = await concluir(antes, e0.lote_id);
    const c1 = await concluir(depois, e1.lote_id);
    expect(c1.tipo_cobranca).toBe("REGRA_ANTERIOR");
    expect(c1.excluidos_tipo_cobranca).toBe(0);
    const tira = (x) => omitir(x, ["lote_id", "tipo_cobranca", "excluidos_tipo_cobranca", "ids_fora_do_tipo_cobranca"]);
    expect(tira(c1)).toEqual(tira(c0));
  });
});

describe("mesma populacao na previa, na planilha e na confirmacao", () => {
  it("para cada tipo e operador, previa = exportacao = confirmacao; o lote guarda o tipo", async () => {
    for (const tipo of TIPOS) {
      for (const op of [null, OP_A, OP_B]) {
        const db = await novoBanco({ tipo: true });
        const args = { p_tipo_cobranca: tipo, p_apenas_nunca_acionado: op == null, ...(op ? { p_operador_email: op } : {}) };
        const p = await idsPrevia(db, args);
        expect(p.length).toBeGreaterThan(0);
        const e = await exportar(db, p, { operador: op, tipo });
        expect(nomes(e.ids_exportados)).toEqual(nomes(p));
        expect(e.tipo_cobranca).toBe(tipo);
        const lote = (await db.query(`select tipo_cobranca from public.acoes_massivas_lotes where id = $1`, [e.lote_id])).rows[0];
        expect(lote.tipo_cobranca).toBe(tipo);
        const pend = (await db.query(`select public.acoes_massivas_lotes_pendentes() r`)).rows[0].r;
        expect(pend[0].tipo_cobranca).toBe(tipo);
        const c = await concluir(db, e.lote_id);
        expect(nomes(c.ids_registrados)).toEqual(nomes(p));
        expect(c.tipo_cobranca).toBe(tipo);
        expect(new Set(c.ids_registrados).size).toBe(c.ids_registrados.length);
      }
    }
  }, 240000);

  it("a planilha recusa quem nao corresponde ao tipo (inclusive acordo em dia)", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A1, ID.A13, ID.A14, ID.A15], { operador: OP_A, tipo: "ACORDOS_VENCIDOS" });
    expect(nomes(e.ids_exportados)).toEqual(["A13", "A14"]);
    expect(e.excluidos_tipo_cobranca).toBe(2);
    expect(e.ids_excluidos.map((x) => x.motivo)).toEqual(Array(2).fill("Não corresponde ao tipo de cobrança selecionado"));
    const u = await exportar(db, [ID.A1, ID.A13, ID.A14, ID.A15, ID.A6], { operador: OP_A, tipo: "MENSALIDADES_E_ACORDOS" });
    expect(nomes(u.ids_exportados)).toEqual(["A1", "A13", "A14"]);
    await expect(exportar(db, [ID.A1], { tipo: "TODOS" })).rejects.toThrow(/Tipo de cobranca invalido/);
  });
});

describe("a confirmacao revalida o tipo no banco", () => {
  it("acordo que ficou em dia depois da exportacao sai de 'Somente acordos vencidos'", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A13, ID.A16], { operador: OP_A, tipo: "ACORDOS_VENCIDOS" });
    await db.query(`update public.parcelas set status = 'PAGO' where acordo_id in
      (select id from public.acordos where aluno_id = $1) and status = 'VENCIDA'`, [ID.A13]);
    const c = await concluir(db, e.lote_id);
    expect(c.ids_fora_do_tipo_cobranca).toEqual([ID.A13]);
    expect(c.excluidos_tipo_cobranca).toBe(1);
    expect(c.ids_registrados).toEqual([ID.A16]);
    const a13 = (await db.query(`select status_acionamento from public.alunos where id = $1`, [ID.A13])).rows[0];
    expect(a13.status_acionamento).toBeNull();
  });

  it("na uniao, sai so quem perdeu os DOIS tipos", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A13, ID.A14], { operador: OP_A, tipo: "MENSALIDADES_E_ACORDOS" });
    // A13 acerta o acordo (fica em dia, sem mensalidade): sai.
    await db.query(`update public.parcelas set status = 'PAGO' where acordo_id in
      (select id from public.acordos where aluno_id = $1) and status = 'VENCIDA'`, [ID.A13]);
    // A14 paga a mensalidade mas segue com acordo vencido: fica.
    await db.query(`update public.acordos_titulos set situacao = 'PAGO', status = 'quitada' where aluno_id = $1`, [ID.A14]);
    const c = await concluir(db, e.lote_id);
    expect(c.ids_fora_do_tipo_cobranca).toEqual([ID.A13]);
    expect(c.ids_registrados).toEqual([ID.A14]);
  });

  it("'Somente mensalidades': quem pagou a mensalidade ou ficou com acordo em dia sai", async () => {
    const db = await novoBanco({ tipo: true });
    const e = await exportar(db, [ID.A1, ID.A2, ID.A14], { operador: OP_A, tipo: "MENSALIDADES" });
    await db.query(`insert into public.acordos (aluno_id, status) values ($1, 'ATIVO')`, [ID.A2]);
    await db.query(`update public.acordos_titulos set situacao = 'PAGO', status = 'quitada' where aluno_id = $1`, [ID.A14]);
    const c = await concluir(db, e.lote_id);
    expect(nomes(c.ids_fora_do_tipo_cobranca)).toEqual(["A14", "A2"]);
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
  });
});

describe("instalacao: ACL, dependencia, falha alta, idempotencia e rollback", () => {
  const fnDefs = async (db) => (await db.query(`
    select p.proname, md5(pg_get_functiondef(p.oid)) h, pg_get_function_identity_arguments(p.oid) args,
           array_to_string(p.proacl, ',') acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in
       ('acoes_massivas_previa','acoes_massivas_exportar','acoes_massivas_concluir_lote','acoes_massivas_lotes_pendentes',
        'acoes_massivas_tipo_cobranca_alunos','acoes_massivas_tipo_cobranca_corresponde')
     order by p.proname, p.oid`)).rows;
  const colunas = async (db) => (await db.query(
    `select column_name from information_schema.columns where table_name = 'acoes_massivas_lotes' order by column_name`)).rows.map((x) => x.column_name);

  it("o rollback carrega exatamente os mesmos trechos da migration", () => {
    const trechos = (sql) => [...sql.matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
    expect(trechos(MIGRATION_TIPO).length).toBe(40);
    expect(trechos(ROLLBACK_TIPO)).toEqual(trechos(MIGRATION_TIPO));
  });

  it("uma sobrecarga por funcao; regra so para service_role; funcoes da tela sem anon/PUBLIC", async () => {
    const db = await novoBanco({ tipo: true });
    const d = await fnDefs(db);
    expect(d.map((x) => x.proname)).toEqual(["acoes_massivas_concluir_lote", "acoes_massivas_exportar",
      "acoes_massivas_lotes_pendentes", "acoes_massivas_previa", "acoes_massivas_tipo_cobranca_alunos",
      "acoes_massivas_tipo_cobranca_corresponde"]);
    const priv = async (papel, fn) => (await db.query(`select has_function_privilege($1, $2, 'EXECUTE') ok`, [papel, fn])).rows[0].ok;
    for (const regra of ["public.acoes_massivas_tipo_cobranca_alunos(uuid[])",
                         "public.acoes_massivas_tipo_cobranca_corresponde(text,boolean,boolean)"]) {
      expect(await priv("anon", regra)).toBe(false);
      expect(await priv("authenticated", regra)).toBe(false);
      expect(await priv("service_role", regra)).toBe(true);
    }
    for (const fn of ["public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text,text)",
                      "public.acoes_massivas_exportar(text[],text,text,text,text)"]) {
      expect(await priv("anon", fn)).toBe(false);
      expect(await priv("authenticated", fn)).toBe(true);
      expect(await priv("service_role", fn)).toBe(true);
    }
    for (const x of d) expect((x.acl || "").split(",").some((e) => e.startsWith("="))).toBe(false);
    for (const ruim of ["TODOS", "ACORDOS"]) {
      await expect(db.query(`insert into public.acoes_massivas_lotes (canal, aluno_ids, total, exportado_por_email, tipo_cobranca)
        values ('WHATSAPP', '{}', 0, 'x', $1)`, [ruim])).rejects.toThrow(/tipo_cobranca_valido/);
    }
  });

  it("sem a migration de exportar aplicada, falha alto e nao cria nada", async () => {
    const db = await novoBanco({ migrar: true });
    await expect(db.exec(MIGRATION_TIPO)).rejects.toThrow(/aplique antes a migration 20260916210000/);
    expect((await db.query(`select to_regprocedure('public.acoes_massivas_tipo_cobranca_alunos(uuid[])') f`)).rows[0].f).toBeNull();
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
