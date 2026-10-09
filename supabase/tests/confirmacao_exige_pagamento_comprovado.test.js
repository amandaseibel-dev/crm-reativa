// CONFIRMACAO DE PAGAMENTO EXIGE PAGAMENTO COMPROVADO (migration 20261009180000).
//
// Banco real (PGlite) sobre a fixture de producao do grupo A: 50 funcoes com o
// texto exato de `pg_get_functiondef`, cada corpo conferido por md5. Aqui a
// regra de 18/09 e aplicada primeiro e a migration de 09/10 em cima dela, para
// medir a DIFERENCA de comportamento.
//
// O QUE ESTE TESTE PROVA, regra por regra do pedido de 09/10/2026:
//   1. importacao de titulo / `valor_pago` alto / `liquidado_em` sem
//      comprovacao -> o titulo CONTINUA ABERTO e cobravel, nenhuma decisao
//      nasce, e a classificacao fica registrada (a trilha nao se perde);
//   2. pagamento comprovado continua protegido: a Rota A segue suspendendo;
//   3. Rota B (acordo ATIVO comprovado pela composicao) preservada;
//   5. `liquidado_em` depois da coleta, ou no futuro, deixa de ser
//      "liquidacao real" e deixa de tornar o titulo elegivel; a evidencia
//      passa a declarar `liquidado_depois_da_coleta` e
//      `valor_pago_e_divida_corrigida`.
// Mais: a Fila Confirmacao de Pagamento nao e tocada, nada de dinheiro nasce,
// a migration e so DDL e o rollback devolve o comportamento de 18/09.
//
// NENHUM DADO REAL: CPFs, nomes e valores sao inventados.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/grupo_a_prod_20260918.sql");
const MD5_PROD = JSON.parse(ler("supabase/tests/fixtures/grupo_a_prod_20260918.md5.json"));
const GRUPO_A = ler("supabase/migrations/20260918150000_grupo_a_confirmacao_prime.sql");
const REGRA = ler("supabase/migrations/20260918230000_prime_liquidacao_regra_entrada.sql");
const MIGRATION = ler("supabase/migrations/20261009180000_confirmacao_exige_pagamento_comprovado.sql");
const ROLLBACK = ler("supabase/rollbacks/20261009180000_confirmacao_exige_pagamento_comprovado.rollback.sql");

// Os md5 que a migration exige encontrar antes de sobrescrever: o texto de
// producao de 09/10/2026, identico ao da migration de 18/09 no repositorio.
const MD5_CN = "b614689e6947d73f0d884a3bb0c28c61"; // prime_liquidacao_classificar_novas
const MD5_EV = "4840e523762f189f03c0173f14233493"; // prime_liquidacao_evidencias
const MD5_SUSPENDER = "76d69229e2dd521aacc070011160f256";
const MD5_REAVALIAR = "0e82b5fd2be5c4b03fd0b51ec748efd8";

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const VENC = "2025-11-10";
const IMPORTADO = "2026-01-10";
const LIQ = "2026-03-05";

let ANTES; // producao + grupo A + regra de 18/09
let DEPOIS; // o anterior + a migration de 09/10

async function montar(aplicarMigration) {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  const { rows } = await db.query(
    `select n.nspname || '.' || p.proname as nome, md5(p.prosrc) as md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`
  );
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5_PROD)) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }
  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo) values
      ('Luana', '${OP1}', 'operador', true), ('Amanda', '${GESTAO}', 'gestao', true);
  `);
  await db.exec(GRUPO_A);
  await db.exec(REGRA);
  if (aplicarMigration) await db.exec(MIGRATION);
  return db;
}

beforeAll(async () => {
  const a = await montar(false);
  ANTES = await a.dumpDataDir("none");
  await a.close();
  const d = await montar(true);
  DEPOIS = await d.dumpDataDir("none");
  await d.close();
}, 180000);

const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: { unaccent } });
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

const SUB = { [GESTAO]: U(900001), [OP1]: U(900002) };
async function como(db, email) {
  const quem = email ?? GESTAO;
  const claims = JSON.stringify({ email: quem, sub: SUB[quem], role: "authenticated" });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
}

async function novoAluno(db, n, o = {}) {
  const id = U(n);
  const caso = U(100000 + n);
  const cpf = String(10000000000 + n);
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, status_atual, status_jornada, status_acionamento,
                                responsavel_atual_email, responsavel_atual_em)
     values ($1, $2, $3, $4, $5, $5, $6, $7, now() - interval '30 days')`,
    [id, `Aluno ${n}`, cpf, `M${n}`, o.status ?? "MENSAGEM_ENVIADA", o.acionamento ?? null, o.operador ?? null]
  );
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, matricula, operador_email, operador_nome,
                               status_atual, status_acionamento, total_em_aberto)
     values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [caso, id, cpf, `Aluno ${n}`, `M${n}`, o.operador ?? null, o.operador ? "OP" : null,
     o.statusCaso ?? "Mensagem enviada", o.acionamento ?? null, o.totalEmAberto ?? 1000]
  );
  return { id, caso, cpf, matricula: `M${n}` };
}

async function titulo(db, al, doc, o = {}) {
  const r = await q1(
    db,
    `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
                                         situacao, status, tipo_boleto, created_at)
     values ($1, $2, $3, $4, $5, $5, $6, $7, 'Mensalidade', $8) returning id`,
    [al.id, o.cpf ?? al.cpf, doc, o.venc ?? VENC, o.valor ?? 1000, o.situacao ?? "ABERTO",
     o.statusTitulo ?? "em_aberto", o.importado ?? IMPORTADO]
  );
  return r.id;
}

// O extrato da Prime. `valor_pago` MAIOR que o bruto e a forma real do
// relatorio (divida corrigida) -- foi o que apareceu nos 22 de 08-09/10.
// `coletado_em` e explicito porque a guarda de data compara com ele.
async function extrato(db, al, doc, o = {}) {
  await db.query(
    `insert into public.prime_extrato (matricula, boleto, cpf, vencimento, liquidado_em, portador,
                                       valor_bruto, valor_pago, coletado_em)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [al.matricula, doc, o.cpfExtrato ?? al.cpf, o.venc ?? VENC, o.liq ?? LIQ, o.portador ?? 195,
     o.bruto ?? 1000, o.pago ?? 3200, o.coletado ?? "2026-03-10 12:00:00+00"]
  );
}

async function pagamento(db, al, o = {}) {
  const r = await q1(
    db,
    `insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao, numero_parcela_completo)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [al.id, al.cpf, o.data ?? LIQ, o.valor ?? 1080, o.status ?? null, o.boleto ?? null]
  );
  return r.id;
}

async function acordo(db, al, o = {}) {
  const r = await q1(
    db,
    `insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em, forma_pagamento)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, numero_acordo`,
    [al.id, al.cpf, o.valor ?? 1000, o.parcelas ?? 1, o.status ?? "ATIVO", o.criado ?? "2026-03-06",
     (o.parcelas ?? 1) > 1 ? "PARCELADO" : "AVISTA"]
  );
  const n = o.parcelas ?? 1;
  for (let i = 1; i <= n; i++) {
    await db.query(
      `insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, titulos_origem)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [r.id, i, (o.valor ?? 1000) / n, `2027-0${i}-10`,
       o.pagas != null && i <= o.pagas ? "PAGO" : (o.statusParcela ?? "A_VENCER"),
       `5${String(r.numero_acordo).padStart(6, "0")}${String(i).padStart(4, "0")}`, o.origem ?? null]
    );
  }
  return r;
}

const classificar = async (db, aplicar = true) => {
  await como(db, GESTAO);
  return (await q1(db, `select public.prime_liquidacao_classificar_novas(500, $1) r`, [aplicar])).r;
};
const tit = (db, id) => q1(db, `select * from public.acordos_titulos where id = $1`, [id]);
const aluno = (db, id) => q1(db, `select * from public.alunos where id = $1`, [id]);
const decisao = (db, id) => q1(db, `select * from public.prime_conferencia_decisao where titulo_id = $1`, [id]);
const evidencias = async (db, id) => (await q1(db, `select public.prime_liquidacao_evidencias($1) e`, [id])).e;
const registros = (db, id) =>
  q(db, `select classificacao, nivel_evidencia, origem_decisao, resultado_titulo, motivo
           from public.prime_liquidacao_classificacao where titulo_id = $1 order by id`, [id]);
const saldo = async (db, alunoId) => (await q1(db, `select public.aluno_saldo_pendente_detalhe($1) s`, [alunoId])).s;
const contarDinheiro = (db) =>
  q1(db, `select (select count(*) from public.acordos)::int a, (select count(*) from public.parcelas)::int p,
                 (select count(*) from public.pagamentos)::int g,
                 (select count(*) from public.acordo_titulo_vinculo)::int v,
                 (select count(*) from public.baixas_pagamento)::int b,
                 (select count(*) from public.solicitacoes_confirmacao_pagamento)::int s,
                 (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO')::int pagos`);

// Liquidacao nova sem nada por tras: o cenario dos 22 de 08-09/10.
async function cenarioSemProva(db, n = 1, o = {}) {
  const al = await novoAluno(db, n, { operador: OP1, ...o });
  const t = await titulo(db, al, `9${n}0001`, o);
  await extrato(db, al, `9${n}0001`, o);
  return { al, t };
}

// ============================================================ a migration
describe("a migration", () => {
  it("exige as duas definicoes de producao e muda so elas", async () => {
    const db = await abrir(ANTES);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_classificar_novas'`)).m).toBe(MD5_CN);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_evidencias'`)).m).toBe(MD5_EV);
    const dinheiroAntes = await contarDinheiro(db);

    await db.exec(MIGRATION);

    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_classificar_novas'`)).m).not.toBe(MD5_CN);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_evidencias'`)).m).not.toBe(MD5_EV);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_suspender'`)).m).toBe(MD5_SUSPENDER);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_reavaliar_pendentes'`)).m).toBe(MD5_REAVALIAR);
    expect(await contarDinheiro(db)).toEqual(dinheiroAntes);
  });

  it("recusa aplicar sobre uma definicao que nao e a de producao", async () => {
    const db = await abrir(ANTES);
    await db.exec(`create or replace function public.prime_liquidacao_classificar_novas(p_limite int default 500, p_aplicar boolean default true)
                   returns jsonb language plpgsql security definer set search_path to 'public'
                   as $f$ begin return '{}'::jsonb; end $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/classificar_novas nao esta na definicao esperada/);
  });
});

// ============================================================ regra 1
describe("regra 1: importacao, saldo atualizado e liquidado_em nao geram confirmacao", () => {
  it("o titulo continua ABERTO e cobravel, nenhuma decisao nasce, a classificacao fica registrada", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const dinheiroAntes = await contarDinheiro(db);

    const r = await classificar(db);
    expect(r).toMatchObject({ aplicado: true, novas: 1, PRIME_ORIGEM_NAO_COMPROVADA: 1 });
    expect(Number(r.valor_em_confirmacao)).toBe(0);
    expect(Number(r.valor_so_registro_sem_prova)).toBe(1000);

    expect(await tit(db, t)).toMatchObject({
      situacao: "ABERTO", status: "em_aberto", origem_liquidacao: null, acordo_id: null,
    });
    expect(await decisao(db, t)).toBeUndefined();
    expect(await registros(db, t)).toEqual([
      expect.objectContaining({
        classificacao: "PRIME_ORIGEM_NAO_COMPROVADA", nivel_evidencia: "NENHUMA",
        origem_decisao: "ROTINA", resultado_titulo: "ABERTO",
      }),
    ]);
    const mov = await q(db, `select tipo from public.aluno_movimentacoes where aluno_id = $1`, [al.id]);
    expect(mov.map((m) => m.tipo)).not.toContain("TITULO_EM_CONFIRMACAO_PRIME");
    expect(await contarDinheiro(db)).toEqual(dinheiroAntes);
  });

  it("`valor_pago` da Prime tres vezes maior que o titulo nao cria prova nenhuma", async () => {
    const db = await abrir(DEPOIS);
    const { t } = await cenarioSemProva(db, 1, { pago: 9999 });
    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("ABERTO");
    expect(await decisao(db, t)).toBeUndefined();
    const e = await evidencias(db, t);
    expect(e.prime.valor_pago_e_divida_corrigida).toBe(true);
    expect(e.aviso).toMatch(/divida corrigida, nao caixa/);
  });

  it("o saldo cobravel e o aluno nao mudam: a parcela em aberto fica em aberto", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const antes = await saldo(db, al.id);
    const alunoAntes = await aluno(db, al.id);
    await classificar(db);
    const depois = await saldo(db, al.id);
    // `titulos_abertos` e VALOR, nao contagem
    expect(Number(depois.titulos_abertos)).toBe(Number(antes.titulos_abertos));
    expect(Number(depois.titulos_abertos)).toBe(1000);
    expect(Number(depois.total)).toBe(Number(antes.total));
    // sem suspensao nao ha `recalcular_situacao_aluno`: o aluno fica como estava
    expect((await aluno(db, al.id)).situacao_operacional).toBe(alunoAntes.situacao_operacional);
    expect((await tit(db, t)).situacao).toBe("ABERTO");
  });

  it("acordo QUITADO sem pagamento real tambem fica so no registro", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db, 2);
    await acordo(db, al, { status: "QUITADO", parcelas: 1, pagas: 1, valor: 1000, origem: "920001" });
    await classificar(db);
    expect(await decisao(db, t)).toBeUndefined();
    expect((await tit(db, t)).situacao).toBe("ABERTO");
    expect((await registros(db, t))[0].motivo).toMatch(/ACORDO_QUITADO_SEM_PAGAMENTO_REAL/);
  });

  it("a mesma liquidacao em duas rodadas nao duplica registro nem cria decisao", async () => {
    const db = await abrir(DEPOIS);
    const { t } = await cenarioSemProva(db);
    await classificar(db);
    expect(await classificar(db)).toMatchObject({ novas: 0 });
    expect(await registros(db, t)).toHaveLength(1);
    expect(await decisao(db, t)).toBeUndefined();
  });
});

// ============================================================ regras 2 e 3
describe("regras 2 e 3: pagamento comprovado protegido, Rota B preservada", () => {
  it("A: pagamento baixado que cobre o acordo quitado -> EM_CONFIRMACAO / PENDENTE, como antes", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const ac = await acordo(db, al, { status: "QUITADO", parcelas: 1, pagas: 1, valor: 1000, origem: "910001" });
    await pagamento(db, al, { valor: 1080, status: "BAIXADO", boleto: `5${String(ac.numero_acordo).padStart(6, "0")}0001` });
    const r = await classificar(db);
    expect(r).toMatchObject({ novas: 1, PAGAMENTO_COMPROVADO: 1 });
    expect(await decisao(db, t)).toMatchObject({ decisao: "PENDENTE", subgrupo: "A_PAGAMENTO_COMPROVADO" });
    // protegido da cobranca: continua fora de ABERTO
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    expect(Number((await saldo(db, al.id)).titulos_abertos)).toBe(0);
  });

  it("B: acordo ATIVO comprovado pela composicao -> EM_CONFIRMACAO / PENDENTE, como antes", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const ac = await acordo(db, al, { status: "ATIVO", parcelas: 2, valor: 1000, origem: "910001, 910009" });
    await classificar(db);
    expect(await decisao(db, t)).toMatchObject({ decisao: "PENDENTE", subgrupo: "B_ACORDO_COMPROVADO", acordo_id: ac.id });
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
  });

  it("titulo ja NEGOCIADO no CRM continua so registrado, sem decisao e sem mudar de situacao", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 3, { operador: OP1 });
    const t = await titulo(db, al, "930001", { situacao: "NEGOCIADO", statusTitulo: "vinculada" });
    await extrato(db, al, "930001");
    await classificar(db);
    expect(await decisao(db, t)).toBeUndefined();
    expect(await tit(db, t)).toMatchObject({ situacao: "NEGOCIADO", status: "vinculada" });
    expect((await registros(db, t))[0]).toMatchObject({ classificacao: "ACORDO_COMPROVADO" });
  });
});

// ============================================================ regra 5
describe("regra 5: a guarda de data da Prime", () => {
  it("liquidado_em DEPOIS da coleta nao e liquidacao real, nao torna o titulo elegivel e e declarado", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 4, { operador: OP1 });
    const t = await titulo(db, al, "940001");
    // coletado em 10/03, mas o relatorio traz paymentDate de 20/03: e parcela
    // que ainda vai vencer, nao pagamento ocorrido.
    await extrato(db, al, "940001", { liq: "2026-03-20", coletado: "2026-03-10 12:00:00+00" });

    const e = await evidencias(db, t);
    expect(e.prime.liquidacao_real).toBe(false);
    expect(e.prime.liquidado_depois_da_coleta).toBe(true);

    const r = await classificar(db);
    expect(r).toMatchObject({ novas: 0 });
    expect(await decisao(db, t)).toBeUndefined();
    expect(await registros(db, t)).toHaveLength(0);
    expect((await tit(db, t)).situacao).toBe("ABERTO");
  });

  it("liquidado_em no FUTURO tambem nao entra, mesmo com a coleta ainda mais no futuro", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 5, { operador: OP1 });
    const t = await titulo(db, al, "950001");
    await db.query(
      `insert into public.prime_extrato (matricula, boleto, cpf, vencimento, liquidado_em, portador,
                                         valor_bruto, valor_pago, coletado_em)
       values ($1, '950001', $2, $3, current_date + 60, 195, 1000, 3200, now() + interval '90 days')`,
      [al.matricula, al.cpf, VENC]
    );
    expect((await evidencias(db, t)).prime.liquidacao_real).toBe(false);
    expect(await classificar(db)).toMatchObject({ novas: 0 });
    expect((await tit(db, t)).situacao).toBe("ABERTO");
  });

  it("a mesma liquidacao, mas ANTES da coleta, continua sendo liquidacao real (a guarda nao barra o legitimo)", async () => {
    const db = await abrir(DEPOIS);
    const { t } = await cenarioSemProva(db, 6);
    expect((await evidencias(db, t)).prime.liquidacao_real).toBe(true);
    expect((await evidencias(db, t)).prime.liquidado_depois_da_coleta).toBe(false);
    expect(await classificar(db)).toMatchObject({ novas: 1 });
  });

  it("antes da migration, a mesma data posterior a coleta ERA tratada como liquidacao real", async () => {
    const db = await abrir(ANTES);
    const al = await novoAluno(db, 4, { operador: OP1 });
    const t = await titulo(db, al, "940001");
    await extrato(db, al, "940001", { liq: "2026-03-20", coletado: "2026-03-10 12:00:00+00" });
    expect((await evidencias(db, t)).prime.liquidacao_real).toBe(true);
    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
  });
});

// ============================================================ a outra fila
describe("Fila Confirmacao de Pagamento", () => {
  it("a rotina nao escreve em solicitacoes_confirmacao_pagamento, nem antes nem depois da migration", async () => {
    for (const dump of [ANTES, DEPOIS]) {
      const db = await abrir(dump);
      const { al } = await cenarioSemProva(db);
      const antes = Number((await q1(db, `select count(*)::int n from public.solicitacoes_confirmacao_pagamento`)).n);
      await classificar(db);
      expect(Number((await q1(db, `select count(*)::int n from public.solicitacoes_confirmacao_pagamento`)).n)).toBe(antes);
      expect(Number((await q1(db,
        `select count(*)::int n from public.solicitacoes_confirmacao_pagamento where aluno_id = $1`, [al.id])).n)).toBe(0);
      await db.close();
    }
  });
});

// ============================================================ antes x depois
describe("antes x depois: a diferenca medida no mesmo cenario", () => {
  it("o MESMO titulo em aberto sai da cobranca na regra de 18/09 e NAO sai depois de 09/10", async () => {
    const velho = await abrir(ANTES);
    const c1 = await cenarioSemProva(velho);
    await classificar(velho);
    expect((await tit(velho, c1.t)).situacao).toBe("EM_CONFIRMACAO");
    expect((await decisao(velho, c1.t)).decisao).toBe("PENDENTE");
    await velho.close();

    const novo = await abrir(DEPOIS);
    const c2 = await cenarioSemProva(novo);
    await classificar(novo);
    expect((await tit(novo, c2.t)).situacao).toBe("ABERTO");
    expect(await decisao(novo, c2.t)).toBeUndefined();
    await novo.close();
  });
});

// ============================================================ rollback
describe("rollback", () => {
  it("devolve as duas definicoes de producao e, com elas, o comportamento de 18/09", async () => {
    const db = await abrir(DEPOIS);
    await db.exec(ROLLBACK);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_classificar_novas'`)).m).toBe(MD5_CN);
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname='prime_liquidacao_evidencias'`)).m).toBe(MD5_EV);

    const { t } = await cenarioSemProva(db);
    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    expect((await decisao(db, t)).subgrupo).toBe("C_SEM_PROVA");
  });

  it("migration -> rollback -> migration, sem residuo", async () => {
    const db = await abrir(ANTES);
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    await db.exec(MIGRATION);
    const { t } = await cenarioSemProva(db);
    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("ABERTO");
    expect(await decisao(db, t)).toBeUndefined();
  });
});
