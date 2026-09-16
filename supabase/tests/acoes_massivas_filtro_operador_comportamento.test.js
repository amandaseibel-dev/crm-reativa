// ACOES MASSIVAS: FILTRO "OPERADOR RESPONSAVEL" -- COMPORTAMENTO, nao estrutura.
//
// Roda num PostgreSQL real (PGlite) as definicoes VIVAS de producao em
// 16/09/2026 (fixtures com md5 conferido contra pg_get_functiondef), aplica a
// migration 20260916200000 por cima e observa o resultado. E o unico jeito de
// provar "sem operador nada muda": a previa de producao tem 13 parametros e
// nao existe na main como arquivo.
//
// O QUE ESTE TESTE PROVA
//   * sem operador (ausente, NULL, vazio): previa e registro devolvem EXATAMENTE
//     o que devolviam antes, numa matriz de filtros;
//   * operador A: zero alunos de B, zero livres; todas as travas seguem;
//   * operador + nunca acionados / bordero / unidade / curso;
//   * o valor vem do caso do proprio operador;
//   * previa e registro tem o mesmo recorte; quem troca de dono no meio e pulado;
//   * nada troca responsavel (aluno nem caso);
//   * gate de gestao, ACL, comentario, idempotencia, falha alta e rollback.
//
// Bancada (esquema, dubles, carteira inventada): fixtures/acoes_massivas_prod_20260916/bancada.js
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  md5, DEF_PREVIA, DEF_REGISTRAR, DEF_FILTROS, MIGRATION, ROLLBACK, MD5_PROD, COMENTARIO_REGISTRAR,
  OP_A, OP_B, IMP1, IMP2, ID, NOME_POR_ID, MATRIZ, comoGestao, comoSistema, previa, registrar,
  chaves, normal, defs, titularidade, novoBanco,
} from "./fixtures/acoes_massivas_prod_20260916/bancada.js";

// Cada teste sobe um PostgreSQL inteiro (alguns, dois). No runner do CI e com a
// suite toda em paralelo, 5 s nao bastam.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe("fixtures = producao em 16/09/2026", () => {
  it("o texto das tres funcoes bate com o md5 lido em producao", () => {
    expect(md5(DEF_PREVIA)).toBe(MD5_PROD.acoes_massivas_previa);
    expect(md5(DEF_REGISTRAR)).toBe(MD5_PROD.registrar_acao_massiva);
    expect(md5(DEF_FILTROS)).toBe(MD5_PROD.acoes_massivas_filtros);
  });

  it("o rollback carrega exatamente os mesmos trechos da migration", () => {
    const trechos = (sql) => [...sql.matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
    expect(trechos(MIGRATION).length).toBe(22);
    expect(trechos(ROLLBACK)).toEqual(trechos(MIGRATION));
  });
});

describe("sem operador: nada muda", () => {
  let antes;
  let depois;
  let db;
  beforeAll(async () => {
    db = await novoBanco();
    antes = [];
    for (const args of MATRIZ) antes.push(await previa(db, args));
    antes.filtros = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    await db.exec(MIGRATION);
    await comoGestao(db);
    depois = [];
    for (const args of MATRIZ) depois.push(await previa(db, args));
  });

  it("a matriz de dados de teste nao e trivial (cada filtro recorta algo)", () => {
    // sem filtro: so os livres (L3 esta em confirmacao)
    expect(chaves(antes[0]).sort()).toEqual(["L1", "L2"]);
    // so nunca acionados: livres e quem tem dono mas nunca foi acionado
    expect(chaves(antes[1]).sort()).toEqual(["A1", "A11", "B1", "G1", "L1"]);
    expect(chaves(antes[3])).toContain("A2");   // fora do prazo com dono entra
    expect(chaves(antes[3])).toContain("B2");
    expect(new Set(antes.map((r) => JSON.stringify(chaves(r)))).size).toBeGreaterThan(8);
  });

  it("previa sem p_operador_email devolve o mesmo JSON de antes, filtro a filtro", () => {
    MATRIZ.forEach((_, i) => {
      const { operador_email, ...resto } = depois[i];
      expect(operador_email).toBeNull();
      expect(normal(resto)).toEqual(normal(antes[i]));
    });
  });

  it("p_operador_email NULL, vazio ou so espacos = base livre / regra atual", async () => {
    for (const vazio of [null, "", "   "]) {
      for (let i = 0; i < MATRIZ.length; i += 1) {
        const { operador_email, ...resto } = await previa(db, { ...MATRIZ[i], p_operador_email: vazio });
        expect(operador_email).toBeNull();
        expect(normal(resto)).toEqual(normal(antes[i]));
      }
    }
  });

  it("filtros: unidades, cursos e status academicos iguais aos de antes", async () => {
    const { operadores, ...resto } = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    expect(resto).toEqual(antes.filtros);
    expect(Array.isArray(operadores)).toBe(true);
  });

  it("registro sem operador: mesmo retorno e mesma escrita de antes", async () => {
    const velho = await novoBanco();
    const novo = await novoBanco({ migrar: true });
    const ids = [ID.L1, ID.L2, ID.A1, ID.A2, ID.B2, ID.L3, ID.A9, ID.X1];
    const rv = await registrar(velho, ids);
    const { excluidos_outro_operador, operador_email, ...rn } = await registrar(novo, ids);
    expect(excluidos_outro_operador).toBe(0);
    expect(operador_email).toBeNull();
    const ord = (r) => ({ ...r, contatos: [...r.contatos].sort((a, b) => a.aluno_id.localeCompare(b.aluno_id)) });
    expect(ord(rn)).toEqual(ord(rv));
    // hoje: so livre ou dono-nunca-acionado grava; o resto e pulado
    expect(rv.ids_registrados.map((i) => NOME_POR_ID[i]).sort()).toEqual(["A1", "L1", "L2"]);
    const foto = async (d) => JSON.stringify((await d.query(
      `select id, data_retorno, retorno_origem, status_acionamento, responsavel_atual_email,
              data_ultimo_acionamento is not null acionado from public.alunos order by id`)).rows);
    expect(await foto(novo)).toBe(await foto(velho));
    const movs = async (d) => JSON.stringify((await d.query(
      `select aluno_id, tipo, descricao from public.aluno_movimentacoes order by aluno_id`)).rows);
    expect(await movs(novo)).toBe(await movs(velho));
  });
});

describe("com operador escolhido", () => {
  let db;
  beforeAll(async () => { db = await novoBanco({ migrar: true }); });

  it("operador A: so a carteira atual de A, com todas as travas", async () => {
    const r = await previa(db, { p_operador_email: OP_A });
    expect(r.operador_email).toBe(OP_A);
    expect(chaves(r).sort()).toEqual(["A1", "A10", "A11", "A12", "A2", "A3"].sort());
    // A4 confirmacao, A5 quitado, A6 acordo ativo, A7 retorno futuro,
    // A8 encerrado, A9 liquidado no Prime: nenhum entra
    for (const k of ["A4", "A5", "A6", "A7", "A8", "A9"]) expect(chaves(r)).not.toContain(k);
    // confirmacao aparece so na lista mascarada de excluidos, e so a de A
    expect(r.excluidos_confirmacao).toEqual([{ aluno: "A4 ***", motivo: "Aguardando confirmação financeira" }]);
    expect(r.total_elegivel_filtros).toBe(6);
  });

  it("operador A: zero alunos de B, zero livres, zero da gestao, em toda a matriz", async () => {
    const donoDe = async () => Object.fromEntries((await db.query(
      "select id, responsavel_atual_email d from public.alunos")).rows.map((x) => [x.id, x.d]));
    const dono = await donoDe();
    for (const [op, outro] of [[OP_A, OP_B], [OP_B, OP_A]]) {
      for (const args of MATRIZ) {
        const r = await previa(db, { ...args, p_operador_email: op });
        for (const e of r.elegiveis) expect(dono[e.id]).toBe(op);
        expect(r.elegiveis.some((e) => dono[e.id] === outro)).toBe(false);
      }
    }
  });

  it("e-mail com caixa e espacos casa com o mesmo operador (chave normalizada)", async () => {
    const a = await previa(db, { p_operador_email: OP_A });
    const b = await previa(db, { p_operador_email: `  ${OP_A.toUpperCase()} ` });
    expect(normal(b)).toEqual(normal(a));
  });

  it("operador inexistente ou sem carteira: lista vazia, nunca a base livre", async () => {
    const r = await previa(db, { p_operador_email: "ninguem@teste.local" });
    expect(r.elegiveis).toEqual([]);
    expect(r.total_elegivel_filtros).toBe(0);
    expect(r.operador_email).toBe("ninguem@teste.local");
  });

  it("operador + so nunca acionados", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_apenas_nunca_acionado: true })).sort())
      .toEqual(["A1", "A11"]);
    expect(chaves(await previa(db, { p_operador_email: OP_B, p_apenas_nunca_acionado: true })))
      .toEqual(["B1"]);
  });

  it("operador + bordero", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_importacao_ids: [IMP1] }))).toEqual(["A1"]);
    expect(chaves(await previa(db, { p_operador_email: OP_B, p_importacao_ids: [IMP1] }))).toEqual(["B1"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_importacao_ids: [IMP2] }))).toEqual(["A11"]);
  });

  it("operador + unidade / curso", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_unidade: "U1" })).sort()).toEqual(["A1", "A10", "A3"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_unidade: "U2" }))).toEqual(["A2"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_curso: "EAD" })).sort()).toEqual(["A1", "A3"]);
    expect(chaves(await previa(db, { p_operador_email: OP_B, p_unidade: "U1", p_curso: "EAD" })).sort()).toEqual(["B1", "B2"]);
  });

  it("operador + prazo sem acionamento e canal/valor", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_dias_minimo_sem_contato: 15 })).sort())
      .toEqual(["A1", "A10", "A11", "A12", "A2"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_canal: "WHATSAPP", p_valor_min: 100 })).sort())
      .toEqual(["A1", "A10", "A2", "A3"]);
  });

  it("o valor vem do caso do proprio operador; sem operador segue o de sempre", async () => {
    const valorDe = (r, k) => Number(r.elegiveis.find((e) => e.id === ID[k]).valor);
    expect(valorDe(await previa(db, { p_operador_email: OP_A }), "A10")).toBe(250);
    expect(valorDe(await previa(db, { p_dias_minimo_sem_contato: 15 }), "A10")).toBe(9000);
    // nenhum aluno com dono vira valor zero
    const r = await previa(db, { p_operador_email: OP_A });
    for (const e of r.elegiveis) expect(Number(e.valor)).toBeGreaterThan(0);
  });

  it("previa com operador nao troca responsavel de aluno nem de caso", async () => {
    const antes = await titularidade(db);
    for (const op of [OP_A, OP_B, OP_A, "ninguem@teste.local"]) await previa(db, { p_operador_email: op });
    expect(await titularidade(db)).toBe(antes);
  });

  it("gate de gestao continua: operador comum recebe 42501, com ou sem filtro", async () => {
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: OP_A, role: "authenticated" })]);
    await expect(previa(db, { p_operador_email: OP_A })).rejects.toThrow(/restrita a gestao/);
    await expect(previa(db, {})).rejects.toThrow(/restrita a gestao/);
    await expect(registrar(db, [ID.A1], { p_operador_email: OP_A })).rejects.toThrow(/restrito a gestao/);
    await comoGestao(db);
  });

  it("executor tecnico (sem JWT) segue passando no gate, com o mesmo recorte", async () => {
    const comGestao = await previa(db, { p_operador_email: OP_B });
    await comoSistema(db);
    try {
      expect(normal(await previa(db, { p_operador_email: OP_B }))).toEqual(normal(comGestao));
      // a lista de operadores nao sai para quem nao e gestao, nem para o executor
      expect((await db.query("select public.acoes_massivas_filtros() r")).rows[0].r.operadores).toEqual([]);
    } finally {
      await comoGestao(db);
    }
  });

  it("mascaramento continua: nome, telefone e e-mail seguem mascarados", async () => {
    const r = await previa(db, { p_operador_email: OP_A });
    for (const e of r.elegiveis) {
      expect(e.nome).toMatch(/^\S+ \*\*\*$/);
      expect(e.telefone ?? null).toBeNull();
      if (e.telefone_mascarado) expect(e.telefone_mascarado).toMatch(/^••••\d{4}$/);
      if (e.email_mascarado) expect(e.email_mascarado).toMatch(/^.•••@/);
    }
  });
});

describe("registro com operador: mesmo recorte da previa", () => {
  it("todo aluno da previa do operador e registrado -- inclusive os ja acionados", async () => {
    const db = await novoBanco({ migrar: true });
    const antes = await titularidade(db);
    const p = await previa(db, { p_operador_email: OP_A });
    const ids = p.elegiveis.map((e) => e.id);
    const r = await registrar(db, ids, { p_operador_email: OP_A });
    expect([...r.ids_registrados].sort()).toEqual([...ids].sort());
    expect(r.registrados).toBe(ids.length);
    expect(r.excluidos_outro_operador).toBe(0);
    expect(r.operador_email).toBe(OP_A);
    expect(r.contatos.map((c) => NOME_POR_ID[c.aluno_id]).sort()).toEqual(chaves(p).sort());
    // sem o parametro, o registro de hoje descartaria os ja acionados
    const semParam = await novoBanco({ migrar: true });
    const r0 = await registrar(semParam, ids);
    expect(r0.ids_registrados.map((i) => NOME_POR_ID[i]).sort()).toEqual(["A1", "A11"]);
    // titularidade intacta; so os campos de acionamento mudam
    expect(await titularidade(db)).toBe(antes);
    const movs = await db.query(`select count(*)::int n from public.aluno_movimentacoes`);
    expect(movs.rows[0].n).toBe(ids.length);
  });

  it("aluno de outro operador nunca e gravado com o filtro de A", async () => {
    const db = await novoBanco({ migrar: true });
    const antesB1 = (await db.query(`select * from public.alunos where id = $1`, [ID.B1])).rows[0];
    const r = await registrar(db, [ID.A1, ID.B1, ID.L1], { p_operador_email: OP_A });
    expect(r.ids_registrados).toEqual([ID.A1]);
    expect(r.excluidos_outro_operador).toBe(2);
    expect(r.ids_excluidos.map((x) => x.motivo)).toEqual([
      "Não está mais na carteira do operador selecionado, ou inexistente",
      "Não está mais na carteira do operador selecionado, ou inexistente",
    ]);
    expect((await db.query(`select * from public.alunos where id = $1`, [ID.B1])).rows[0]).toEqual(antesB1);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where aluno_id <> $1`, [ID.A1])).rows[0].n).toBe(0);
  });

  it("quem mudou de dono entre a previa e o registro e pulado e contado", async () => {
    const db = await novoBanco({ migrar: true });
    const ids = (await previa(db, { p_operador_email: OP_A })).elegiveis.map((e) => e.id);
    await db.query(`update public.alunos set responsavel_atual_email = $1 where id = $2`, [OP_B, ID.A2]);
    const r = await registrar(db, ids, { p_operador_email: OP_A });
    expect(r.ids_registrados).not.toContain(ID.A2);
    expect(r.excluidos_outro_operador).toBe(1);
    expect(r.registrados).toBe(ids.length - 1);
    const a2 = (await db.query(`select status_acionamento, responsavel_atual_email from public.alunos where id = $1`, [ID.A2])).rows[0];
    expect(a2).toEqual({ status_acionamento: null, responsavel_atual_email: OP_B });
  });

  it("confirmacao e liquidado no Prime seguem barrados no registro com operador", async () => {
    const db = await novoBanco({ migrar: true });
    const r = await registrar(db, [ID.A4, ID.A9, ID.A1], { p_operador_email: OP_A });
    expect(r.ids_registrados).toEqual([ID.A1]);
    expect(r.excluidos_confirmacao).toBe(1);
    expect(r.excluidos_liquidados_prime).toBe(1);
    expect(r.excluidos_outro_operador).toBe(0);
  });
});

describe("filtros: lista de operadores", () => {
  it("gestao recebe os operadores ativos do cadastro, com e-mail e nome, em ordem", async () => {
    const db = await novoBanco({ migrar: true });
    const { operadores } = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    expect(operadores).toEqual([
      { email: OP_A, nome: "Ana Operadora" },
      { email: OP_B, nome: "Bruno Operador" },
    ]);
  });

  it("quem nao e gestao recebe a lista vazia", async () => {
    const db = await novoBanco({ migrar: true });
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: OP_A, role: "authenticated" })]);
    const { operadores } = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    expect(operadores).toEqual([]);
  });
});

describe("instalacao: ACL, comentario, idempotencia, falha alta e rollback", () => {
  const PREVIA_NOVA = "public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text)";
  const REG_NOVO = "public.registrar_acao_massiva(text[],text,text,text,text,text)";

  it("uma sobrecarga so por funcao, sem anon/PUBLIC, comentario preservado", async () => {
    const db = await novoBanco({ migrar: true });
    const d = await defs(db);
    expect(d.map((x) => x.proname)).toEqual(["acoes_massivas_filtros", "acoes_massivas_previa", "registrar_acao_massiva"]);
    for (const fn of [PREVIA_NOVA, REG_NOVO, "public.acoes_massivas_filtros()"]) {
      const q = async (papel) => (await db.query(
        `select has_function_privilege($1, $2, 'EXECUTE') ok`, [papel, fn])).rows[0].ok;
      expect(await q("anon")).toBe(false);
      expect(await q("authenticated")).toBe(true);
      expect(await q("service_role")).toBe(true);
      const acl = (await db.query(`select array_to_string(proacl, ',') a from pg_proc where oid = $1::regprocedure`, [fn])).rows[0].a;
      expect(acl.split(",").some((e) => e.startsWith("="))).toBe(false); // PUBLIC
    }
    expect(d.find((x) => x.proname === "registrar_acao_massiva").comentario).toBe(COMENTARIO_REGISTRAR);
    // nada alem do parametro novo mudou nas propriedades da funcao
    const prev = d.find((x) => x.proname === "acoes_massivas_previa").def;
    expect(prev).toMatch(/STABLE SECURITY DEFINER/);
    expect(prev).toMatch(/SET statement_timeout TO '60s'/);
    expect(d.find((x) => x.proname === "registrar_acao_massiva").def).toMatch(/SET statement_timeout TO '60s'/);
  });

  it("rodar a migration de novo nao muda nada", async () => {
    const db = await novoBanco({ migrar: true });
    const uma = await defs(db);
    await db.exec(MIGRATION);
    expect(await defs(db)).toEqual(uma);
  });

  it("ancora ausente: falha alto e nao instala nenhuma das tres", async () => {
    const db = await novoBanco();
    // simula producao ter mudado o registro: a ancora do gate some
    const alterado = DEF_REGISTRAR.replace(
      "AND (responsavel_atual_email IS NULL OR data_ultimo_acionamento IS NULL);",
      "AND (responsavel_atual_email IS NULL);");
    expect(alterado).not.toBe(DEF_REGISTRAR);
    await db.exec(alterado);
    const antes = await defs(db);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/registrar_acao_massiva: ancora nao encontrada/);
    expect(await defs(db)).toEqual(antes);
  });

  it("migration + rollback devolvem as tres funcoes identicas as de producao", async () => {
    const db = await novoBanco();
    const antes = await defs(db);
    const acl = async () => (await db.query(
      `select proname, array_to_string(proacl, ',') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname in ('acoes_massivas_previa','registrar_acao_massiva','acoes_massivas_filtros')
        order by proname`)).rows;
    const aclAntes = await acl();
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    const depois = await defs(db);
    expect(depois.map(({ def, args, comentario, proname }) => ({ def: md5(def), args, comentario, proname })))
      .toEqual(antes.map(({ def, args, comentario, proname }) => ({ def: md5(def), args, comentario, proname })));
    expect(await acl()).toEqual(aclAntes);
    // e o md5 bate com o de producao
    expect(md5(depois.find((x) => x.proname === "acoes_massivas_previa").def)).toBe(MD5_PROD.acoes_massivas_previa);
    // rollback repetido e inocuo
    await db.exec(ROLLBACK);
    expect(await defs(db)).toEqual(depois);
  });
});
