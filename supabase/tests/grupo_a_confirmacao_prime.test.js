// GRUPO A: SUSPENSAO POR TITULO (EM_CONFIRMACAO) + CONFERENCIA PRIME.
//
// Roda a migration REAL num PostgreSQL real (PGlite) em cima do pedaco de
// producao que ela toca: tabelas com as colunas de producao e 50 funcoes com o
// texto EXATO de pg_get_functiondef (fixtures/grupo_a_prod_20260918.sql), cada
// corpo conferido por md5 antes de usar. Nada de duble nas regras sob teste:
// recalculo, saldo, encerramentos, teto, nivelamento, vinculo -- tudo e o texto
// de producao, com as travas da migration por cima.
//
// Cada trava do item 10 aprovado pela gestao tem um cenario que ela segura e,
// no fim do arquivo, uma MUTACAO que tira so aquela trava e mostra o estrago
// acontecendo. Trava que passa com e sem ela nao prova nada.
//
// NENHUM DADO REAL: CPFs, nomes e valores sao inventados.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Cada teste abre uma copia do banco (~0,2 s) e roda funcoes de producao
// inteiras; com a suite toda em paralelo, 5 s e pouco.
vi.setConfig({ testTimeout: 60000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/grupo_a_prod_20260918.sql");
const MD5_PROD = JSON.parse(ler("supabase/tests/fixtures/grupo_a_prod_20260918.md5.json"));
const MIGRATION = ler("supabase/migrations/20260918150000_grupo_a_confirmacao_prime.sql");
const ROLLBACK = ler("supabase/rollbacks/20260918150000_grupo_a_confirmacao_prime.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const OP2 = "cobranca12@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// Datas do cenario padrao do grupo A: importado em jan, vencido em nov,
// liquidado na Prime em marco (depois do vencimento + 30 e da importacao).
const VENC = "2025-11-10";
const IMPORTADO = "2026-01-10";
const LIQ = "2026-03-05";

let ANTES; // producao sem a migration
let DEPOIS; // producao com a migration

async function abrir(dump) {
  return new PGlite({ loadDataDir: dump, extensions: { unaccent } });
}

async function montarAntes() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  // O que esta na fixture e producao: md5 de cada corpo contra o manifesto.
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
      ('Luana', '${OP1}', 'operador', true), ('Diego', '${OP2}', 'operador', true),
      ('Amanda', '${GESTAO}', 'gestao', true);
  `);
  return db;
}

beforeAll(async () => {
  const antes = await montarAntes();
  ANTES = await antes.dumpDataDir("none");
  await antes.exec(MIGRATION);
  DEPOIS = await antes.dumpDataDir("none");
  await antes.close();
}, 120000);

// ---------------------------------------------------------------- ajudantes
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

// Sessao de quem chama. As rotinas agendadas rodam em producao sem JWT; aqui
// rodam como gestao (email + sub), porque aluno_saldo_pendente_detalhe recusa
// sessao com claims VAZIO e o PGlite nao devolve o claims a nulo depois de usado.
const SUB = { [GESTAO]: U(900001), [OP1]: U(900002), [OP2]: U(900003) };
async function como(db, email) {
  const quem = email ?? GESTAO;
  const claims = JSON.stringify({ email: quem, sub: SUB[quem], role: "authenticated" });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
}

// Aluno + caso. O responsavel e antigo (fora dos 10 dias de fidelizacao).
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

async function extrato(db, al, doc, o = {}) {
  await db.query(
    `insert into public.prime_extrato (matricula, boleto, cpf, vencimento, liquidado_em, portador,
                                       valor_bruto, valor_pago, coletado_em)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [al.matricula, doc, o.cpfExtrato ?? al.cpf, o.venc ?? VENC, o.liq ?? LIQ, o.portador ?? 195,
     o.bruto ?? 1000, o.pago ?? 1000]
  );
}

async function pagamento(db, al, data = LIQ, valor = 1000) {
  await db.query(
    `insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago) values ($1, $2, $3, $4)`,
    [al.id, al.cpf, data, valor]
  );
}

async function acordo(db, al, o = {}) {
  const r = await q1(
    db,
    `insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em)
     values ($1, $2, $3, $4, $5, $6) returning id, numero_acordo`,
    [al.id, al.cpf, o.valor ?? 1000, o.parcelas ?? 2, o.status ?? "ATIVO", o.criado ?? "2026-03-06"]
  );
  const n = o.parcelas ?? 2;
  for (let i = 1; i <= n; i++) {
    await db.query(
      `insert into public.parcelas (acordo_id, numero, valor, vencimento, status) values ($1, $2, $3, $4, $5)`,
      [r.id, i, (o.valor ?? 1000) / n, `2027-0${i}-10`, o.statusParcela ?? "A_VENCER"]
    );
  }
  return r;
}

// Titulo do grupo A completo: liquidacao real, 195 no boleto, CPF coerente e
// pagamento ReATIVA no mesmo dia.
async function grupoA(db, al, doc, o = {}) {
  const id = await titulo(db, al, doc, o);
  await extrato(db, al, doc, o);
  if (o.semPagamento !== true) await pagamento(db, al, o.liq ?? LIQ, o.valor ?? 1000);
  return id;
}

async function detectar(db, aplicar = true) {
  await como(db, GESTAO);
  return (await q1(db, `select public.prime_conferencia_detectar_grupo_a($1) r`, [aplicar])).r;
}

const tit = (db, id) => q1(db, `select * from public.acordos_titulos where id = $1`, [id]);
const caso = (db, id) => q1(db, `select * from public.casos where id = $1`, [id]);
const aluno = (db, id) => q1(db, `select * from public.alunos where id = $1`, [id]);
const decisao = (db, id) => q1(db, `select * from public.prime_conferencia_decisao where titulo_id = $1`, [id]);
const saldo = async (db, alunoId) =>
  (await q1(db, `select public.aluno_saldo_pendente_detalhe($1) s`, [alunoId])).s;

// ------------------------------------------------------------ cenarios
// Cada cenario devolve o que a trava protege. O teste normal espera o valor
// certo; a mutacao, com a trava arrancada, espera o estrago.

// Suspende o unico titulo de um aluno com responsavel.
async function cenarioSoEmConfirmacao(db, n = 1, o = {}) {
  const al = await novoAluno(db, n, { operador: OP1, ...o });
  const t = await grupoA(db, al, `9${n}0001`);
  await detectar(db);
  return { al, t };
}

async function cenarioQuitacao(db) {
  const { al, t } = await cenarioSoEmConfirmacao(db);
  const a = await aluno(db, al.id);
  const c = await caso(db, al.caso);
  return { t, statusAluno: a.status_atual, quitadoEm: c.quitado_em, situacao: a.situacao_operacional };
}

async function cenarioBordero(db) {
  const { al, t } = await cenarioSoEmConfirmacao(db);
  // o upsert do borderô: mesma forma do Borderos.jsx (situacao ABERTO por documento)
  await como(db, OP1);
  await db.query(
    `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
                                         situacao, tipo_boleto)
     values ($1, $2, '910001', $3, 1100, 1100, 'ABERTO', 'Mensalidade')
     on conflict (documento) do update set situacao = excluded.situacao, valor_original = excluded.valor_original,
       saldo_corrigido = excluded.saldo_corrigido, vencimento = excluded.vencimento`,
    [al.id, al.cpf, VENC]
  );
  return tit(db, t);
}

async function cenarioReavaliar(db) {
  // aluno marcado como "pago aguardando baixa": a reavaliacao fecharia pelo status
  const { al } = await cenarioSoEmConfirmacao(db, 1, { status: "PAGO_AGUARDANDO_BAIXA" });
  await como(db, null);
  await db.query(`select public.casos_reavaliar_encerramento()`);
  return caso(db, al.caso);
}

async function cenarioZerados(db) {
  // caso da fila livre (sem responsavel): o encerramento de zerados fecharia
  const al = await novoAluno(db, 2);
  await grupoA(db, al, "920001");
  await detectar(db);
  await como(db, null);
  await db.query(`select public.casos_encerrar_zerados_sem_debito(null, 'teste')`);
  return { caso: await caso(db, al.caso), aluno: await aluno(db, al.id) };
}

async function cenarioRetirarZerados(db) {
  const { al } = await cenarioSoEmConfirmacao(db);
  await como(db, null);
  await db.query(`select * from public.retirar_zerados_reais_sem_saldo()`);
  const conf = await q1(db, `select count(*)::int n from public.solicitacoes_confirmacao_pagamento where aluno_id = $1`, [al.id]);
  return { caso: await caso(db, al.caso), confirmacoes: conf.n };
}

async function cenarioTeto(db) {
  await db.query(`insert into public.calibragem_parametros (chave, valor) values ('limite_por_operador', $1)`,
    [JSON.stringify({ [OP1]: 1 })]);
  const { al: s } = await cenarioSoEmConfirmacao(db, 1, { totalEmAberto: 0 });
  const n1 = await novoAluno(db, 2, { operador: OP1, totalEmAberto: 500 });
  await titulo(db, n1, "920001");
  const novo = await novoAluno(db, 3, { totalEmAberto: 3000 });
  await titulo(db, novo, "930001");
  await db.query(`update public.casos set operador_email = $1 where id = $2`, [OP1, novo.caso]);
  return { suspenso: await caso(db, s.caso), normal: await caso(db, n1.caso) };
}

async function cenarioNivelamento(db) {
  // OP1 bem abaixo da media: o nivelamento solta os casos de menor valor dele
  // e entrega o caso da fila livre mais perto da media.
  const { al: s } = await cenarioSoEmConfirmacao(db, 1, { totalEmAberto: 0 });
  const n = await novoAluno(db, 2, { operador: OP1, totalEmAberto: 100 });
  await titulo(db, n, "920001", { valor: 100 });
  for (let i = 0; i < 10; i++) {
    const x = await novoAluno(db, 10 + i, { operador: OP2, totalEmAberto: 1000 });
    await titulo(db, x, `9${10 + i}0001`);
  }
  // fila livre: um caso que so espera a conferencia (perto da media) e um normal
  const s2 = await novoAluno(db, 3, { totalEmAberto: 850 });
  await grupoA(db, s2, "930001", { valor: 850 });
  await detectar(db);
  const p = await novoAluno(db, 4, { totalEmAberto: 700 });
  await titulo(db, p, "940001", { valor: 700 });
  await db.query(`update public.casos set total_em_aberto = 850 where id = $1`, [s2.caso]);
  await db.query(`update public.casos set total_em_aberto = 0 where id = $1`, [s.caso]);
  await como(db, null);
  await db.query(`select public.nivelar_medias_progressivo()`);
  return {
    suspenso: await caso(db, s.caso),
    livreSuspenso: await caso(db, s2.caso),
    livreNormal: await caso(db, p.caso),
  };
}

// Operador com `normais` casos comuns e 1 que so espera a conferencia.
async function carteiraCheia(db, normais) {
  const { al: s } = await cenarioSoEmConfirmacao(db, 1);
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, responsavel_atual_email, responsavel_atual_em)
     select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'Carteira ' || g,
            (20000000000 + g)::text, 'C' || g, $1, now() - interval '30 days'
       from generate_series(1, $2::int) g`,
    [OP1, normais]
  );
  await db.query(
    `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email, status_atual, total_em_aberto)
     select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, (20000000000 + g)::text,
            (20000000000 + g)::text, 'Carteira ' || g, $1, 'Mensagem enviada', 1000
       from generate_series(1, $2::int) g`,
    [OP1, normais]
  );
  return s;
}

async function cenarioReforcoTeto(db) {
  await carteiraCheia(db, 500); // 501 no total, 500 que ocupam vaga
  await como(db, null);
  return (await q1(db, `select public.reforcar_teto_operadores() n`)).n;
}

async function cenarioAssumir(db) {
  await carteiraCheia(db, 499); // 500 no total, 499 que ocupam vaga
  const livre = await novoAluno(db, 5);
  await titulo(db, livre, "950001");
  await como(db, OP1);
  return q1(db, `select * from public.assumir_caso_livre($1)`, [livre.caso]);
}

async function cenarioA2(db) {
  const al = await novoAluno(db, 1, { operador: OP1 });
  const t = await grupoA(db, al, "910001");
  const ac = await acordo(db, al, { valor: 1000 });
  await detectar(db);
  return { al, t, ac };
}

async function cenarioRejeitarEReDetectar(db) {
  const { al, t } = await cenarioSoEmConfirmacao(db);
  await como(db, GESTAO);
  await db.query(`select public.prime_conferencia_rejeitar($1, 'Prime ainda cobra este boleto')`, [t]);
  const r = await detectar(db);
  return { al, t, r, titulo: await tit(db, t) };
}

async function cenarioEvidenciaMudou(db) {
  const { t } = await cenarioSoEmConfirmacao(db);
  // a 2a coleta mostra o boleto de volta na carteira 166: a liquidacao nao se sustenta
  await db.query(`update public.prime_extrato set portador = 166 where boleto = '910001'`);
  await como(db, GESTAO);
  let erro = null;
  try {
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);
  } catch (e) {
    erro = e.message;
  }
  return { erro, titulo: await tit(db, t) };
}

async function cenarioBaixaA2Cobre(db) {
  const { t } = await cenarioA2(db);
  await como(db, GESTAO);
  let erro = null;
  try {
    await db.query(`select public.prime_conferencia_baixar($1, null)`, [t]);
  } catch (e) {
    erro = e.message;
  }
  return { erro, titulo: await tit(db, t) };
}

async function cenarioRevisaoObrigatoria(db) {
  const al = await novoAluno(db, 1, { operador: OP1 });
  const t = await grupoA(db, al, "910001");
  await acordo(db, al, { status: "CANCELADO", criado: "2025-06-01" }); // fora da janela
  await detectar(db);
  await como(db, GESTAO);
  let erro = null;
  try {
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);
  } catch (e) {
    erro = e.message;
  }
  return { erro, titulo: await tit(db, t), decisao: await decisao(db, t) };
}

// ============================================================== TESTES
describe("porta de entrada: EM_CONFIRMACAO so pela Conferencia Prime", () => {
  it("a migration nao suspende nenhum titulo, mesmo com candidato do grupo A na base", async () => {
    const db = await abrir(ANTES);
    const al = await novoAluno(db, 1, { operador: OP1 });
    await grupoA(db, al, "910001");
    await db.exec(MIGRATION);
    const r = await q1(db, `select count(*)::int n from public.acordos_titulos where situacao = 'EM_CONFIRMACAO'`);
    expect(r.n).toBe(0);
    expect((await detectar(db, false)).titulos).toBe(1); // o candidato existe; so nao foi tocado
  });

  it("ninguem poe titulo em EM_CONFIRMACAO por fora: update e insert sao recusados", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await titulo(db, al, "910001");
    await expect(db.query(`update public.acordos_titulos set situacao = 'EM_CONFIRMACAO' where id = $1`, [t]))
      .rejects.toThrow(/EM_CONFIRMACAO_SO_PELA_CONFERENCIA_PRIME/);
    await expect(titulo(db, al, "910002", { situacao: "EM_CONFIRMACAO" }))
      .rejects.toThrow(/EM_CONFIRMACAO_SO_PELA_CONFERENCIA_PRIME/);
    expect((await tit(db, t)).situacao).toBe("ABERTO");
  });

  it("a medicao (p_aplicar = false) conta e nao escreve nada", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await grupoA(db, al, "910001");
    const r = await detectar(db, false);
    expect(r).toMatchObject({ aplicado: false, titulos: 1, A1: 1, alunos: 1 });
    expect((await tit(db, t)).situacao).toBe("ABERTO");
    expect(await decisao(db, t)).toBeUndefined();
  });

  it("so a regra fechada do grupo A suspende: cada condicao faltando deixa o titulo em cobranca", async () => {
    const db = await abrir(DEPOIS);
    const casos = {};
    const mk = async (n, doc, o = {}, extra) => {
      const al = await novoAluno(db, n, { operador: OP1 });
      casos[doc] = await grupoA(db, al, doc, o);
      if (extra) await extra(al);
    };
    await mk(1, "A_PAGAMENTO"); // pagamento ReATIVA no dia
    await mk(2, "A_ACIMA_DO_BRUTO", { semPagamento: true, pago: 1180 }); // valor pago > bruto
    await mk(3, "X_PORTADOR_166", { portador: 166 });
    await mk(4, "X_ATE_30_DIAS", { liq: "2025-12-05" });
    await mk(5, "X_ANTES_DA_IMPORTACAO", { liq: "2026-01-05", venc: "2025-10-01" });
    await mk(6, "X_NO_DIA_DA_IMPORTACAO", { liq: IMPORTADO, venc: "2025-10-01" });
    await mk(7, "X_CPF_DIFERENTE", { cpfExtrato: "99999999999" });
    await mk(8, "X_SEM_CORROBORACAO", { semPagamento: true });
    await mk(9, "X_SEGUNDA_COLETA_DIVERGE", {}, async () => {
      await db.query(`insert into public.prime_titulo_semestre (boleto, cpf, liquidado_em) values ('X_SEGUNDA_COLETA_DIVERGE', 'x', '2026-04-20')`);
    });
    await mk(10, "X_ACORDO_CANCELADO_NA_JANELA", {}, async (al) => {
      await acordo(db, al, { status: "CANCELADO", criado: "2026-03-01" });
    });
    await mk(11, "X_JA_VINCULADO", {}, async (al) => {
      const ac = await acordo(db, al, { criado: "2025-12-01" });
      await como(db, GESTAO);
      await db.query(`select public.vincular_titulos_acordo(array[$1]::uuid[], $2)`, [casos.X_JA_VINCULADO, ac.id]);
    });
    await detectar(db);
    const { rows } = await db.query(
      `select documento, situacao from public.acordos_titulos where documento like 'A_%' or documento like 'X_%' order by 1`
    );
    const suspensos = rows.filter((r) => r.situacao === "EM_CONFIRMACAO").map((r) => r.documento);
    expect(suspensos).toEqual(["A_ACIMA_DO_BRUTO", "A_PAGAMENTO"]);
    const d1 = await decisao(db, casos.A_PAGAMENTO);
    const d2 = await decisao(db, casos.A_ACIMA_DO_BRUTO);
    expect(d1.corroboracao).toBe("PAGAMENTO_REATIVA");
    expect(d2.corroboracao).toBe("VALOR_PAGO_ACIMA_DO_BRUTO");
  });

  it("suspender tira SO o titulo: nao paga, nao zera, nao mexe na outra mensalidade, nao usa nao_acionar", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t1 = await grupoA(db, al, "910001", { valor: 1000 });
    const t2 = await titulo(db, al, "910002", { valor: 400, venc: "2026-02-10" }); // nao liquidada
    const antes = await aluno(db, al.id);
    await detectar(db);

    const a = await tit(db, t1);
    expect(a).toMatchObject({ situacao: "EM_CONFIRMACAO", status: "em_confirmacao", acordo_id: null, origem_liquidacao: null });
    expect(Number(a.valor_original)).toBe(1000);
    expect(Number(a.saldo_corrigido)).toBe(1000);
    expect(await tit(db, t2)).toMatchObject({ situacao: "ABERTO", status: "em_aberto" });

    const s = await saldo(db, al.id);
    expect(Number(s.total)).toBe(400); // so a outra mensalidade e exigivel
    expect(s.titulos_em_confirmacao).toBe(1);

    const c = await caso(db, al.caso);
    expect(c).toMatchObject({ nao_acionar: false, operador_email: OP1, encerrado_operacional: false, quitado_em: null });
    const depois = await aluno(db, al.id);
    expect(depois.responsavel_atual_email).toBe(OP1);
    expect(depois.status_atual).toBe(antes.status_atual);
    expect(depois.situacao_operacional).toBe("COBRANCA_VENCIDA"); // segue cobrado pela outra

    const d = await decisao(db, t1);
    expect(d).toMatchObject({ decisao: "PENDENTE", motivo_entrada: "LIQUIDACAO_PRIME_CORROBORADA", subgrupo: "A1",
      situacao_anterior: "ABERTO", operador_no_momento: OP1, decidido_em: null });
    const mov = await q(db, `select tipo from public.aluno_movimentacoes where aluno_id = $1`, [al.id]);
    expect(mov.map((m) => m.tipo)).toContain("TITULO_EM_CONFIRMACAO_PRIME");
  });
});

describe("travas: o titulo em confirmacao nao quita, nao encerra, nao reabre, nao e cobrado", () => {
  it("nao dispara _talvez_quitar_aluno e o aluno nao vira QUITADO", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioQuitacao(db);
    expect(r.statusAluno).toBe("MENSAGEM_ENVIADA");
    expect(r.quitadoEm).toBeNull();
  });

  it("_talvez_quitar_aluno chamado por outro caminho (ultima parcela) tambem nao quita", async () => {
    const db = await abrir(DEPOIS);
    const { al } = await cenarioSoEmConfirmacao(db);
    await db.query(`select public._talvez_quitar_aluno($1)`, [al.id]);
    expect((await aluno(db, al.id)).status_atual).toBe("MENSAGEM_ENVIADA");
    expect((await caso(db, al.caso)).quitado_em).toBeNull();
  });

  it("o recalculo diz AGUARDANDO_CONFIRMACAO, nunca QUITADO, e tira o retorno do dia", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioQuitacao(db);
    expect(r.situacao).toBe("AGUARDANDO_CONFIRMACAO");
  });

  it("a reavaliacao horaria nao encerra o caso", async () => {
    const db = await abrir(DEPOIS);
    const c = await cenarioReavaliar(db);
    expect(c).toMatchObject({ encerrado_operacional: false, operador_email: OP1 });
  });

  it("o encerramento de zerados zera o 'em aberto' mas nao encerra nem troca o status", async () => {
    const db = await abrir(DEPOIS);
    const { caso: c, aluno: a } = await cenarioZerados(db);
    expect(c.encerrado_operacional).toBe(false);
    expect(Number(c.total_em_aberto)).toBe(0);
    expect(a.status_atual).toBe("MENSAGEM_ENVIADA");
    // controle: um aluno realmente zerado na mesma rodada e encerrado
    const al = await novoAluno(db, 3);
    await titulo(db, al, "930001", { situacao: "PAGO", statusTitulo: "quitada" });
    await db.query(`select public.casos_encerrar_zerados_sem_debito(null, 'teste')`);
    expect((await caso(db, al.caso)).encerrado_operacional).toBe(true);
  });

  it("a retirada de zerados nao tira o caso da fila nem abre confirmacao de pagamento", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioRetirarZerados(db);
    expect(r.caso.status_acionamento).toBeNull();
    expect(r.confirmacoes).toBe(0);
  });

  it("o bordero nao reabre: o valor atualiza, a situacao fica, e a tentativa fica registrada", async () => {
    const db = await abrir(DEPOIS);
    const t = await cenarioBordero(db);
    expect(t).toMatchObject({ situacao: "EM_CONFIRMACAO", status: "em_confirmacao" });
    expect(Number(t.valor_original)).toBe(1100);
    const aud = await q(db, `select acao from public.auditoria where registro_id = $1`, [t.id]);
    expect(aud.map((x) => x.acao)).toContain("TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA");
  });

  it("titulo_reavaliar e a edicao manual nao reabrem", async () => {
    const db = await abrir(DEPOIS);
    const { t } = await cenarioSoEmConfirmacao(db);
    await db.query(`select public.titulo_reavaliar($1)`, [t]);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    await db.query(`update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto' where id = $1`, [t]);
    expect(await tit(db, t)).toMatchObject({ situacao: "EM_CONFIRMACAO", status: "em_confirmacao" });
  });

  it("nao entra em acao massiva nem no saldo cobrado; o aluno com outra divida continua", async () => {
    const db = await abrir(DEPOIS);
    const { al: s } = await cenarioSoEmConfirmacao(db, 1);
    const o = await novoAluno(db, 2, { operador: OP1 });
    await grupoA(db, o, "920001");
    await titulo(db, o, "920002", { valor: 300 });
    await detectar(db);
    const pop = await q(db, `select * from public.acoes_massivas_tipo_cobranca_alunos($1::uuid[])`, [[s.id, o.id]]);
    expect(pop.map((x) => x.aluno_id)).toEqual([o.id]);
    expect(Number((await saldo(db, s.id)).total)).toBe(0);
    expect(Number((await q1(db, `select public.saldo_titulos_aberto($1) v`, [s.cpf])).v)).toBe(0);
    expect(Number((await saldo(db, o.id)).total)).toBe(300);
  });

  it("nao ocupa vaga quando e o unico saldo; ocupa quando o aluno deve outra coisa", async () => {
    const db = await abrir(DEPOIS);
    const { al: s } = await cenarioSoEmConfirmacao(db, 1);
    const o = await novoAluno(db, 2, { operador: OP1 });
    await grupoA(db, o, "920001");
    await titulo(db, o, "920002", { valor: 300 });
    const n = await novoAluno(db, 3, { operador: OP1 });
    await titulo(db, n, "930001");
    await detectar(db);
    expect((await q1(db, `select public.contar_carteira_ativa($1) n`, [OP1])).n).toBe(2);
    const prot = async (cpf) => (await q1(db, `select public.caso_protegido_redistribuicao($1, 'Mensagem enviada', false) p`, [cpf])).p;
    expect(await prot(s.cpf)).toBe(true);
    expect(await prot(o.cpf)).toBe(false);
    expect((await caso(db, s.caso)).operador_email).toBe(OP1);
  });

  it("teto: atribuir caso novo nao solta o caso em confirmacao (responsavel preservado)", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioTeto(db);
    expect(r.suspenso.operador_email).toBe(OP1);
    expect(r.normal.operador_email).toBeNull(); // o teto age sobre a carteira que ocupa vaga
  });

  it("nivelamento progressivo nao tira do operador nem entrega a ninguem caso que so espera a conferencia", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioNivelamento(db);
    expect(r.suspenso.operador_email).toBe(OP1);
    expect(r.livreSuspenso.operador_email).toBeNull();
    expect(r.livreNormal.operador_email).toBe(OP1);
  });

  it("reforco do teto de 500 nao conta o caso em confirmacao", async () => {
    const db = await abrir(DEPOIS);
    expect(await cenarioReforcoTeto(db)).toBe(0);
  });

  it("assumir caso livre com 499 que ocupam vaga + 1 em confirmacao nao troca ninguem", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioAssumir(db);
    expect(r.sucesso).toBe(true);
    expect(r.caso_liberado).toBeNull();
  });
});

describe("decisoes da Conferencia Prime", () => {
  it("REJEITAR devolve o titulo para a cobranca, com motivo, e preserva o responsavel", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSoEmConfirmacao(db);
    await como(db, GESTAO);
    await expect(db.query(`select public.prime_conferencia_rejeitar($1, 'x')`, [t])).rejects.toThrow(/MOTIVO_OBRIGATORIO/);
    await como(db, OP1);
    await expect(db.query(`select public.prime_conferencia_rejeitar($1, 'Prime ainda cobra')`, [t])).rejects.toThrow(/gestao/);
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_rejeitar($1, 'Prime ainda cobra este boleto')`, [t]);

    expect(await tit(db, t)).toMatchObject({ situacao: "ABERTO", status: "em_aberto" });
    expect(Number((await saldo(db, al.id)).total)).toBe(1000);
    expect((await aluno(db, al.id)).situacao_operacional).toBe("COBRANCA_VENCIDA");
    expect((await q1(db, `select public.contar_carteira_ativa($1) n`, [OP1])).n).toBe(1);
    expect((await caso(db, al.caso)).operador_email).toBe(OP1);
    expect(await decisao(db, t)).toMatchObject({ decisao: "REJEITADO", motivo: "Prime ainda cobra este boleto", decidido_por: GESTAO });
    const aud = await q(db, `select acao from public.auditoria where registro_id = $1`, [t]);
    expect(aud.map((x) => x.acao)).toContain("CONFERENCIA_PRIME_REJEICAO");
  });

  it("a mesma evidencia nao recoloca o rejeitado em confirmacao; fato novo recoloca", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioRejeitarEReDetectar(db);
    expect(r.r.titulos).toBe(0);
    expect(r.titulo.situacao).toBe("ABERTO");
    await db.query(`update public.prime_extrato set valor_pago = 1150, coletado_em = now() where boleto = '910001'`);
    const r2 = await detectar(db);
    expect(r2.suspensos).toBe(1);
    expect((await tit(db, r.t)).situacao).toBe("EM_CONFIRMACAO");
    expect((await decisao(db, r.t)).decisao).toBe("PENDENTE");
  });

  it("CONFIRMAR A1 baixa pelo fluxo oficial: origem gravada, ficha recalculada, auditoria, e nao reabre mais", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSoEmConfirmacao(db);
    await como(db, OP1);
    await expect(db.query(`select public.prime_conferencia_confirmar($1, null)`, [t])).rejects.toThrow(/SEM_PERMISSAO/);
    await como(db, GESTAO);
    const r = (await q1(db, `select public.prime_conferencia_confirmar($1, null) r`, [t])).r;
    expect(r).toMatchObject({ ok: true, decisao: "CONFIRMADO", ja_processado: false });

    const x = await tit(db, t);
    expect(x).toMatchObject({ situacao: "PAGO", status: "quitada", origem_liquidacao: "PRIME_LIQUIDACAO_OFICIAL",
      origem_liquidacao_ref: `conferencia_prime:${t}`, acordo_id: null });
    expect(x.origem_liquidacao_em).not.toBeNull();
    expect(await decisao(db, t)).toMatchObject({ decisao: "CONFIRMADO", decidido_por: GESTAO });
    expect((await aluno(db, al.id)).situacao_operacional).toBe("QUITADO");
    const mov = await q(db, `select tipo from public.aluno_movimentacoes where aluno_id = $1`, [al.id]);
    expect(mov.map((m) => m.tipo)).toContain("BAIXA_CONFERENCIA_PRIME");
    const aud = await q(db, `select acao from public.auditoria where registro_id = $1`, [t]);
    expect(aud.map((a) => a.acao)).toContain("CONFERENCIA_PRIME_BAIXA");

    // reabrir o titulo baixado e coagido de volta e registrado -- nao da erro
    await db.query(`update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto' where id = $1`, [t]);
    expect(await tit(db, t)).toMatchObject({ situacao: "PAGO", status: "quitada" });
    const recusa = await q(db, `select 1 from public.auditoria where registro_id = $1 and acao = 'TITULO_LIQUIDADO_REABERTURA_RECUSADA'`, [t]);
    expect(recusa).toHaveLength(1);
  });

  it("CONFIRMAR reconfere a evidencia na hora: se nao se sustenta, nada muda", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioEvidenciaMudou(db);
    expect(r.erro).toMatch(/EVIDENCIA_NAO_CONFIRMA/);
    expect(r.titulo.situacao).toBe("EM_CONFIRMACAO");
  });

  it("CONFIRMAR A2 que o acordo cobre = vinculo ao acordo existente, sem baixa, sem acordo nem parcela nova", async () => {
    const db = await abrir(DEPOIS);
    const { al, t, ac } = await cenarioA2(db);
    expect(await decisao(db, t)).toMatchObject({ subgrupo: "A2_COBRE", acordo_id: ac.id });
    const antes = await q1(db, `select (select count(*) from public.acordos)::int a, (select count(*) from public.parcelas)::int p`);

    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);

    expect(await tit(db, t)).toMatchObject({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac.id, origem_liquidacao: null });
    const v = await q(db, `select acordo_id from public.acordo_titulo_vinculo where titulo_id = $1 and ativo`, [t]);
    expect(v.map((x) => x.acordo_id)).toEqual([ac.id]);
    expect(await q1(db, `select (select count(*) from public.acordos)::int a, (select count(*) from public.parcelas)::int p`)).toEqual(antes);
    expect((await decisao(db, t)).decisao).toBe("VINCULADO");
    // a divida fica so nas parcelas do acordo
    const s = await saldo(db, al.id);
    expect(Number(s.titulos_abertos)).toBe(0);
    expect(Number(s.parcelas_abertas_valor)).toBe(1000);
    expect(Number(s.total)).toBe(1000);
  });

  it("A2 que o acordo cobre nao aceita baixa direta", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioBaixaA2Cobre(db);
    expect(r.erro).toMatch(/USE_O_VINCULO/);
    expect(r.titulo.situacao).toBe("EM_CONFIRMACAO");
  });

  it("A2 inconclusivo continua esperando gente: sem motivo e sem acordo escolhido nada acontece", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await grupoA(db, al, "910001");
    const ac1 = await acordo(db, al, { criado: "2026-03-01" });
    await acordo(db, al, { criado: "2026-03-10" });
    await detectar(db);
    expect((await decisao(db, t)).subgrupo).toBe("A2_INCONCLUSIVO");
    await como(db, GESTAO);
    await expect(db.query(`select public.prime_conferencia_confirmar($1, null)`, [t])).rejects.toThrow(/MOTIVO_OBRIGATORIO/);
    await expect(db.query(`select public.prime_conferencia_vincular($1, null, 'acordo do mesmo dia')`, [t]))
      .rejects.toThrow(/ESCOLHA_O_ACORDO_E_O_MOTIVO/);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    await db.query(`select public.prime_conferencia_vincular($1, $2, 'acordo feito no dia da liquidacao')`, [t, ac1.id]);
    expect(await tit(db, t)).toMatchObject({ situacao: "NEGOCIADO", acordo_id: ac1.id });
  });

  it("A2 em que o acordo ja e de outro lote de liquidacao (nao cobre) fica para gente, com motivo", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    // o acordo ja esta composto por uma mensalidade liquidada em fevereiro
    const t0 = await titulo(db, al, "910000", { venc: "2025-09-10" });
    await extrato(db, al, "910000", { venc: "2025-09-10", liq: "2026-02-01" });
    const ac = await acordo(db, al, { criado: "2026-03-06" });
    await como(db, GESTAO);
    await db.query(`select public.vincular_titulos_acordo(array[$1]::uuid[], $2)`, [t0, ac.id]);
    const t = await grupoA(db, al, "910001");
    await detectar(db);
    expect((await decisao(db, t)).subgrupo).toBe("A2_NAO_COBRE");
    await expect(db.query(`select public.prime_conferencia_confirmar($1, null)`, [t])).rejects.toThrow(/MOTIVO_OBRIGATORIO/);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
  });

  it("acordo cancelado antigo nao bloqueia: o titulo entra, mas a decisao exige motivo escrito", async () => {
    const db = await abrir(DEPOIS);
    const r = await cenarioRevisaoObrigatoria(db);
    expect(r.decisao).toMatchObject({ revisao_obrigatoria: true, decisao: "PENDENTE" });
    expect(r.erro).toMatch(/MOTIVO_OBRIGATORIO/);
    expect(r.titulo.situacao).toBe("EM_CONFIRMACAO");
    await db.query(`select public.prime_conferencia_confirmar($1, 'acordo cancelado e de 2025, sem relacao')`, [r.titulo.id]);
    expect((await tit(db, r.titulo.id)).situacao).toBe("PAGO");
  });

  it("a fila mostra so o que espera decisao, A2 primeiro, e so para a gestao", async () => {
    const db = await abrir(DEPOIS);
    await cenarioSoEmConfirmacao(db, 1);
    const al = await novoAluno(db, 2, { operador: OP1 });
    await grupoA(db, al, "920001", { valor: 200 });
    await acordo(db, al, { valor: 200 });
    await detectar(db);
    const fila = await q(db, `select documento, subgrupo, outras_dividas from public.prime_conferencia_fila()`);
    expect(fila.map((f) => f.subgrupo)).toEqual(["A2_COBRE", "A1"]);
    await como(db, OP1);
    await expect(db.query(`select * from public.prime_conferencia_fila()`)).rejects.toThrow(/gestao/);
  });

  it("rejeitar em lote devolve todos pelo mesmo caminho do individual", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t1 = await grupoA(db, al, "910001");
    const t2 = await grupoA(db, al, "910002", { venc: "2025-10-10" });
    await detectar(db);
    await como(db, GESTAO);
    const r = (await q1(db, `select public.prime_conferencia_rejeitar_lote($1::uuid[], 'Prime ainda cobra') r`, [[t1, t2, t1]])).r;
    expect(r).toMatchObject({ ok: true, rejeitados: 2 });
    expect((await tit(db, t1)).situacao).toBe("ABERTO");
    expect((await tit(db, t2)).situacao).toBe("ABERTO");
  });
});

describe("rollback", () => {
  it("devolve cada funcao ao texto de producao e o titulo suspenso para a cobranca", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSoEmConfirmacao(db);
    await como(db, null);
    await db.exec(ROLLBACK);

    expect(await tit(db, t)).toMatchObject({ situacao: "ABERTO", status: "em_aberto" });
    expect(await decisao(db, t)).toBeUndefined(); // pendente nao era decisao
    expect((await aluno(db, al.id)).situacao_operacional).toBe("COBRANCA_VENCIDA");
    const { rows } = await db.query(
      `select n.nspname || '.' || p.proname as nome, md5(p.prosrc) as md5
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','internal')`
    );
    const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
    for (const [nome, md5] of Object.entries(MD5_PROD)) expect([nome, noBanco[nome]]).toEqual([nome, md5]);
    for (const nova of ["public.prime_conferencia_vincular", "public.prime_conferencia_detectar_grupo_a",
      "public.prime_grupo_a_candidatos", "public._titulo_em_confirmacao_protegido",
      "public.caso_aguarda_confirmacao_financeira"]) {
      expect(noBanco[nova]).toBeUndefined();
    }
    const trg = await q(db, `select 1 from pg_trigger where tgname = 'trg_titulo_em_confirmacao_protegido'`);
    expect(trg).toHaveLength(0);
  });
});

// ============================================================ MUTACOES
// Cada mutacao arranca UMA trava do texto da migration e roda o cenario que
// ela protege. O estrago tem de aparecer; se nao aparecer, a trava nao esta
// sendo provada pelo teste.
function mutar(velho, novo = "", vezes = 1) {
  const n = MIGRATION.split(velho).length - 1;
  if (n !== vezes) throw new Error(`ancora da mutacao achada ${n} vez(es): ${velho.slice(0, 80)}`);
  return MIGRATION.split(velho).join(novo);
}

async function bancoMutado(texto) {
  const db = await abrir(ANTES);
  await db.exec(texto);
  return db;
}

const MUTACOES = [
  {
    nome: "sem o gatilho de guarda, o bordero reabre o titulo",
    texto: () => mutar(`create trigger trg_titulo_em_confirmacao_protegido
  before insert or update on public.acordos_titulos
  for each row execute function public._titulo_em_confirmacao_protegido();`),
    estrago: async (db) => expect((await cenarioBordero(db)).situacao).toBe("ABERTO"),
  },
  {
    nome: "sem as travas de quitacao (gatilho + _talvez_quitar_aluno), o aluno vira QUITADO",
    texto: () => {
      let t = mutar(`in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')`,
      `in ('ABERTO','NEGOCIADO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO')`);
      const bloco = `  if exists (select 1 from public.acordos_titulos
              where aluno_id = v_aluno and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') then
    return;
  end if;
`;
      if (t.split(bloco).length !== 2) throw new Error("ancora _talvez_quitar_aluno");
      return t.split(bloco).join("");
    },
    estrago: async (db) => expect((await cenarioQuitacao(db)).statusAluno).toBe("QUITADO"),
  },
  {
    nome: "sem a trava do recalculo, a ficha vira QUITADO",
    texto: () => mutar("if v_saldo_total <= 0.005 and v_conf_pend = 0 and v_tit_conf > 0 then", "if false then"),
    estrago: async (db) => expect((await cenarioQuitacao(db)).situacao).toBe("QUITADO"),
  },
  {
    nome: "sem a trava da reavaliacao horaria, o caso e encerrado",
    texto: () => mutar(`       -- titulo aguardando a Conferencia Prime: o caso espera a decisao aberto
       and not exists (select 1 from public.acordos_titulos tc
                        where tc.aluno_id = c.aluno_id
                          and upper(coalesce(tc.situacao,'')) = 'EM_CONFIRMACAO')
`),
    estrago: async (db) => expect((await cenarioReavaliar(db)).encerrado_operacional).toBe(true),
  },
  {
    nome: "sem a trava do encerramento de zerados, o caso da fila livre e encerrado",
    texto: () => mutar(`     and not exists (select 1 from public.acordos_titulos tc
                      where tc.aluno_id = z.aluno_id
                        and upper(coalesce(tc.situacao,'')) = 'EM_CONFIRMACAO')
`),
    estrago: async (db) => expect((await cenarioZerados(db)).caso.encerrado_operacional).toBe(true),
  },
  {
    nome: "sem a pendencia no saldo, a retirada de zerados tira o caso e abre confirmacao",
    texto: () => mutar("(v_total > 0.005 or v_conf_pendentes > 0 or v_tit_conf > 0)", "(v_total > 0.005 or v_conf_pendentes > 0)"),
    estrago: async (db) => {
      const r = await cenarioRetirarZerados(db);
      expect(r.caso.status_acionamento).toBe("SEM_SALDO_EM_ABERTO");
      expect(r.confirmacoes).toBe(1);
    },
  },
  {
    nome: "sem a trava do protegido, o teto solta o caso em confirmacao",
    texto: () => mutar(`          and public.caso_aguarda_confirmacao_financeira(al.id)) then
    return true;`, `          and false) then
    return true;`),
    estrago: async (db) => expect((await cenarioTeto(db)).suspenso.operador_email).toBeNull(),
  },
  {
    nome: "sem a trava da contagem, o caso em confirmacao ocupa vaga",
    texto: () => mutar(`     AND NOT public.caso_aguarda_confirmacao_financeira(c.aluno_id);`, `;`),
    estrago: async (db) => {
      await cenarioSoEmConfirmacao(db);
      expect((await q1(db, `select public.contar_carteira_ativa($1) n`, [OP1])).n).toBe(1);
    },
  },
  {
    nome: "sem a trava do nivelamento (saida), o operador perde o caso em confirmacao",
    texto: () => mutar("AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id)",
      "AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento)", 2),
    estrago: async (db) => expect((await cenarioNivelamento(db)).suspenso.operador_email).toBeNull(),
  },
  {
    nome: "sem a trava do nivelamento (entrada), o caso em confirmacao e entregue a um operador",
    texto: () => mutar("WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id)",
      "WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL", 2),
    estrago: async (db) => expect((await cenarioNivelamento(db)).livreSuspenso.operador_email).toBe(OP1),
  },
  {
    nome: "sem a trava do reforco de teto, um caso comum perde o responsavel",
    texto: () => mutar(`      -- caso que so espera a Conferencia Prime nao ocupa vaga
      AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id)
`),
    estrago: async (db) => expect(await cenarioReforcoTeto(db)).toBe(1),
  },
  {
    nome: "sem a trava do assumir, a carteira parece cheia e um caso e trocado",
    texto: () => mutar(`
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id))`, ")", 2),
    estrago: async (db) => expect((await cenarioAssumir(db)).caso_liberado).not.toBeNull(),
  },
  {
    nome: "sem a reconferencia da evidencia, a baixa passa com prova que caiu",
    texto: () => mutar(`  if not found then
    raise exception 'EVIDENCIA_NAO_CONFIRMA`, `  if false then
    raise exception 'EVIDENCIA_NAO_CONFIRMA`),
    estrago: async (db) => {
      const r = await cenarioEvidenciaMudou(db);
      expect(r.erro).toBeNull();
      expect(r.titulo.situacao).toBe("PAGO");
    },
  },
  {
    nome: "sem o bloqueio do A2 coberto, a baixa direta passa (divida contada fora do acordo)",
    texto: () => mutar(`  if v_dec.subgrupo = 'A2_COBRE' then
    raise exception 'USE_O_VINCULO`, `  if false then
    raise exception 'USE_O_VINCULO`),
    estrago: async (db) => expect((await cenarioBaixaA2Cobre(db)).titulo.situacao).toBe("PAGO"),
  },
  {
    nome: "sem o filtro de evidencia rejeitada, o titulo volta sozinho para confirmacao",
    texto: () => mutar(`
                             or (d.decisao = 'REJEITADO'
                                 and (d.evidencia_chave is null or d.evidencia_chave = c.evidencia_chave))`),
    estrago: async (db) => expect((await cenarioRejeitarEReDetectar(db)).titulo.situacao).toBe("EM_CONFIRMACAO"),
  },
  {
    nome: "sem a correcao do gatilho terminal, reabrir o titulo baixado da ERRO em vez de ser recusado",
    texto: () => mutar("'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,",
      "'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id::text,"),
    estrago: async (db) => {
      const { t } = await cenarioSoEmConfirmacao(db);
      await como(db, GESTAO);
      await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);
      await expect(db.query(`update public.acordos_titulos set situacao = 'ABERTO' where id = $1`, [t]))
        .rejects.toThrow(/registro_id/);
    },
  },
  {
    nome: "sem a revisao obrigatoria, o aluno com acordo cancelado e baixado sem motivo",
    texto: () => mutar("if (v_dec.revisao_obrigatoria or v_dec.subgrupo in ('A2_NAO_COBRE','A2_INCONCLUSIVO'))",
      "if (false or v_dec.subgrupo in ('A2_NAO_COBRE','A2_INCONCLUSIVO'))"),
    estrago: async (db) => expect((await cenarioRevisaoObrigatoria(db)).titulo.situacao).toBe("PAGO"),
  },
];

describe("mutacoes: cada trava critica, arrancada, deixa o estrago acontecer", () => {
  for (const m of MUTACOES) {
    it(m.nome, async () => {
      const db = await bancoMutado(m.texto());
      await m.estrago(db);
    }, 30000);
  }
});
