// FIDELIZAÇÃO DO GIRO SEGUE OS 10 DIAS — regressão de comportamento.
//
// Roda a MIGRATION REAL e o ROLLBACK REAL (supabase/aguardando_aprovacao/
// 20261112210000_*) num PostgreSQL real (PGlite), sobre os corpos EXATOS de
// produção de 12/11/2026, cada um conferido por md5(prosrc).
//
// Bancada: base `fidelizacao_por_dono_prod_20260930` + complementos que já
// existiam (M3, assumir, executor da onda 1) + `fidelizacao_giro_prod_20261112`,
// que traz o `liberar_fidelizacao_caso` de hoje.
//
// NENHUM DADO REAL: CPF, nome e operador são sintéticos. Datas são RELATIVAS a
// current_date -- nada aqui vence com o calendário.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que
// a executa, num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const FX = "supabase/tests/fixtures/";

const CADEIA = [
  ler(`${FX}fidelizacao_por_dono_prod_20260930.sql`),
  ler(`${FX}nivelamento_m3_prod_20261021.sql`),
  ler(`${FX}assumir_caso_livre_prod_20261020.sql`),
  ler("supabase/migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql"),
  ler(`${FX}onda1_executor_prod_20261021.sql`),
  ler(`${FX}fidelizacao_giro_prod_20261112.sql`),
  // cadeia de gatilhos de alunos + congelamento, como em producao: e ela que faz
  // soltar um caso soltar todos os casos do mesmo aluno.
  ler(`${FX}fidelizacao_giro_lotes_prod_20261112.sql`),
];
const MD5_PROD = JSON.parse(ler(`${FX}fidelizacao_giro_prod_20261112.md5.json`));
const PASTA = "supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias";
const MIGRATION = ler(`${PASTA}.sql.pendente`);
const ROLLBACK = ler(`${PASTA}.rollback.sql`);

const ALVOS = ["liberar_fidelizacao_caso", "trg_impor_teto_operador", "assumir_caso_livre", "casos_risco_perder"];

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const OP2 = "cobranca06@aelbra.com.br";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(40000000000 + n);

// Quem chama. `null` = cron: sem claims, auth.jwt() devolve NULL como no Supabase.
const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [email ? JSON.stringify({ email }) : ""]);

const md5s = async (db) =>
  Object.fromEntries((await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`)).map((r) => [r.nome, r.md5]));

const retrato = async (db) =>
  qn(db,
    `select p.proname, p.proacl::text acl, p.proconfig::text cfg, p.prosecdef def, p.proowner::text dono,
            pg_get_function_identity_arguments(p.oid) args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname = any($1) order by 1`, [ALVOS]);

async function construir(comMigration) {
  const db = new PGlite({ extensions: ext });
  for (const sql of CADEIA) await db.exec(sql);

  // PORTAO DE FIDELIDADE: os corpos que a migration altera (e os que ela chama)
  // são os de produção em 12/11/2026. Divergiu, para aqui.
  const noBanco = await md5s(db);
  for (const [nome, md5] of Object.entries(MD5_PROD)) {
    if (noBanco[nome] !== md5) throw new Error(`bancada diverge de producao: ${nome} = ${noBanco[nome]}`);
  }

  await db.exec(`
    -- auth.jwt() fiel ao Supabase: sem claims devolve NULL (é assim que o cron
    -- passa pelo portão de gestão). O dublê da base devolvia '{}'.
    create or replace function auth.jwt() returns jsonb language sql stable as $stub$
      select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    $stub$;
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ('OP UM',   '${OP1}', 'operador', true, 'OP UM',   true),
      ('OP DOIS', '${OP2}', 'operador', true, 'OP DOIS', true),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null, false);
    insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '3'::jsonb)
      on conflict (chave) do update set valor = excluded.valor;
  `);
  await como(db, GESTAO);
  if (comMigration) await db.exec(MIGRATION);
  return db;
}

// aluno + título ABERTO com saldo + caso. Por padrão: caso de giro com a marca
// VENCIDA há 17 dias, parado há 15 dias, do OP1, sem proteção nenhuma.
async function cenario(db, n, o = {}) {
  const {
    dono = OP1, dua = 15, giro = -17, statusAcion = null, naoAcionar = false,
    acordoAtivo = false, valor = 500, retorno = null, retornoOrigem = null,
  } = o;
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em,
        data_retorno, retorno_origem)
     values ($1,$2,$3,$4,$5,'DONO', now() - interval '30 days',
        case when $6::int is null then null else current_date + $6::int end, $7)`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, dono, retorno, retornoOrigem]);
  await db.query(
    `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status)
     values ($1,$2,$3, current_date - 90, $4,$4,'ABERTO','em_aberto')`,
    [U(n), cpf, `DOC${n}`, valor]);
  if (acordoAtivo) {
    await db.query(
      `insert into public.acordos (aluno_id, cpf, status, numero_acordo, valor_total) values ($1,$2,'ATIVO',$3,100)`,
      [U(n), cpf, 70000 + n]);
  }
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
        status_acionamento, nao_acionar, data_ultimo_acionamento, giro_fidelizacao_ate,
        ultima_tabulacao_em, total_em_aberto, caso_codigo, caso_atualizado_em)
     values ($1,$1,$2,$2,$3,$2,$4,'DONO',$5,$6,
        case when $7::int is null then null else current_date - $7::int end,
        case when $8::int is null then null else current_date + $8::int end,
        now() - interval '20 days', $9, $10, now() - interval '30 days')`,
    [U(n), cpf, `Aluno Sintetico ${n}`, dono, statusAcion, naoAcionar, dua, giro, valor, n]);
  return U(n);
}

const caso = (db, n) =>
  q1(db, `select operador_email dono, giro_fidelizacao_ate marca, data_ultimo_acionamento dua from public.casos where id=$1`, [U(n)]);
const rodarCron = async (db) => {
  await como(db, null);
  const r = await q1(db, "select public.liberar_casos_fidelizacao_vencida() n");
  await como(db, GESTAO);
  return Number(r.n);
};
const assumir = async (db, email, n) => {
  await como(db, email);
  const r = await q1(db, "select * from public.assumir_caso_livre($1)", [U(n)]);
  await como(db, GESTAO);
  return r;
};

let SEM, COM;
beforeAll(async () => {
  const a = await construir(false);
  SEM = await a.dumpDataDir();
  await a.close();
  const b = await construir(true);
  COM = await b.dumpDataDir();
  await b.close();
});
// Sessao no fuso de Sao Paulo, como as funcoes que comparam datas de negocio.
// Sem isso, depois das 21h BRT o current_date (UTC) fica um dia a frente e a
// suite quebra (mesma causa do N3 na suite dos lotes).
const abrir = async (dump) => {
  const db = new PGlite({ loadDataDir: dump, extensions: ext });
  await db.exec("set timezone to 'America/Sao_Paulo'");
  await como(db, GESTAO);
  return db;
};
const hoje = () => abrir(SEM);
const novo = () => abrir(COM);

// ===========================================================================
describe("a bancada reproduz produção de 12/11/2026", () => {
  it("os corpos alvo batem por md5", async () => {
    const db = await hoje();
    const m = await md5s(db);
    for (const [nome, md5] of Object.entries(MD5_PROD)) expect(m[nome]).toBe(md5);
    await db.close();
  });

  it("DEFEITO: caso de giro com a data vencida e 15 dias parado nunca é solto", async () => {
    const db = await hoje();
    await cenario(db, 1);
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("DEFEITO OPOSTO: outro operador assume caso de giro acionado há 3 dias", async () => {
    const db = await hoje();
    await cenario(db, 2, { dua: 3 });
    const r = await assumir(db, OP2, 2);
    expect(r.sucesso).toBe(true);
    expect((await caso(db, 2)).dono).toBe(OP2);
    await db.close();
  });
});

// ===========================================================================
describe("regra 1 e 2 — o giro segue os 10 dias", () => {
  it("11º dia em diante: perde a exclusividade, fica LIVRE e ninguém recebe", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 11 });
    expect(await rodarCron(db)).toBe(1);
    const c = await caso(db, 1);
    expect(c.dono).toBeNull();
    const al = await q1(db, "select responsavel_atual_email r from public.alunos where id=$1", [U(1)]);
    expect(al.r).toBeNull();
    const h = await qn(db, "select acao, operador_anterior_email de, operador_email para from public.historico_operadores_alunos where cpf_referencia=$1", [CPF(1)]);
    expect(h.map((x) => x.acao)).toEqual(["FIDELIZACAO_EXPIRADA"]);
    expect(h[0].de).toBe(OP1);
    expect(h[0].para).toBeNull();
    await db.close();
  });

  it("o último acionamento é preservado na liberação", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 15 });
    const antes = (await caso(db, 1)).dua;
    await rodarCron(db);
    expect((await caso(db, 1)).dua).toEqual(antes);
    await db.close();
  });

  it.each([[0], [1], [9], [10]])("acionado há %i dia(s): continua com o operador", async (dias) => {
    const db = await novo();
    await cenario(db, 1, { dua: dias });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("marca do giro ainda VIVA segura o caso mesmo parado há 15 dias", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: 0 });   // vence hoje: ainda vale
    await cenario(db, 2, { giro: 5 });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("caso de giro nunca acionado, com a data vencida, é solto (a fidelização só nasce no acionamento)", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: null });
    expect(await rodarCron(db)).toBe(1);
    await db.close();
  });

  it("caso SEM marca de giro não muda de comportamento", async () => {
    for (const abre of [hoje, novo]) {
      const db = await abre();
      await cenario(db, 1, { giro: null, dua: 15 });
      await cenario(db, 2, { giro: null, dua: 5 });
      expect(await rodarCron(db)).toBe(1);
      expect((await caso(db, 1)).dono).toBeNull();
      expect((await caso(db, 2)).dono).toBe(OP1);
      await db.close();
    }
  });
});

// ===========================================================================
describe("regra 5 — proteções legítimas continuam valendo", () => {
  it.each([
    ["acordo ativo", { acordoAtivo: true }],
    ["retorno agendado", { statusAcion: "RETORNO AGENDADO" }],
    ["em negociação", { statusAcion: "EM NEGOCIACAO" }],
    ["aguardando pagamento", { statusAcion: "AGUARDANDO PAGAMENTO" }],
    ["jurídico", { statusAcion: "JURIDICO" }],
    ["não acionar", { naoAcionar: true }],
  ])("%s: caso de giro parado há 15 dias NÃO é solto", async (_nome, extra) => {
    const db = await novo();
    await cenario(db, 1, extra);
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it.each([[0], [3]])("retorno marcado pelo OPERADOR para daqui a %i dia(s): caso preservado", async (d) => {
    const db = await novo();
    await cenario(db, 1, { retorno: d, retornoOrigem: "OPERADOR" });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("retorno OPERADOR_EM_CONFIRMACAO (prefixo, como em retornoOrigem.js) também preserva", async () => {
    const db = await novo();
    await cenario(db, 1, { retorno: 2, retornoOrigem: "OPERADOR_EM_CONFIRMACAO" });
    await cenario(db, 2, { retorno: 2, retornoOrigem: "operador" });  // caixa baixa: upper() normaliza
    expect(await rodarCron(db)).toBe(0);
    await db.close();
  });

  it("retorno do operador JÁ VENCIDO (ontem) não protege mais", async () => {
    const db = await novo();
    await cenario(db, 1, { retorno: -1, retornoOrigem: "OPERADOR" });
    expect(await rodarCron(db)).toBe(1);
    await db.close();
  });

  it("retorno AUTOMÁTICO (ações massivas) futuro NÃO é compromisso e não protege", async () => {
    const db = await novo();
    await cenario(db, 1, { retorno: 5, retornoOrigem: "AUTOMATICO" });
    await cenario(db, 2, { retorno: 5, retornoOrigem: null });
    expect(await rodarCron(db)).toBe(2);
    await db.close();
  });

  it("no mesmo lote, solta só quem está fora do prazo e sem proteção", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 20 });
    await cenario(db, 2, { dua: 20, acordoAtivo: true });
    await cenario(db, 3, { dua: 4 });
    await cenario(db, 4, { dua: 12, dono: OP2 });
    expect(await rodarCron(db)).toBe(2);
    expect((await caso(db, 1)).dono).toBeNull();
    expect((await caso(db, 2)).dono).toBe(OP1);
    expect((await caso(db, 3)).dono).toBe(OP1);
    expect((await caso(db, 4)).dono).toBeNull();
    await db.close();
  });
});

// ===========================================================================
describe("regra 5 — soltar um caso solta todos os casos do aluno: o irmão que não pode sair segura", () => {
  // Segundo caso (ficha antiga) do mesmo aluno. So o INSERT e feito com os
  // gatilhos desligados, para montar o legado; o resto roda com eles ligados.
  const irmao = async (db, n, alunoN, o = {}) => {
    const { dua = 15, giro = null, statusAtual = null } = o;
    await db.exec("alter table public.casos disable trigger user");
    await db.query(
      `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
          status_atual, data_ultimo_acionamento, giro_fidelizacao_ate, ultima_tabulacao_em, total_em_aberto,
          caso_codigo, caso_atualizado_em, nao_acionar, encerrado_operacional)
       values ($1,$2,$3,$3,$4,$3,$5,'DONO',$6,
          case when $7::int is null then null else current_date - $7::int end,
          case when $8::int is null then null else current_date + $8::int end,
          now() - interval '20 days', 100, $9, now() - interval '30 days', false, true)`,
      [U(n), U(alunoN), CPF(alunoN), `Aluno Sintetico ${alunoN}`, OP1, statusAtual, dua, giro, n]);
    await db.exec("alter table public.casos enable trigger user");
  };

  it("HOJE (já existia, sem giro): o cron solta por cascata o caso acionado há 2 dias", async () => {
    const db = await hoje();
    await cenario(db, 1, { giro: null });
    await irmao(db, 2, 1, { dua: 2 });
    await rodarCron(db);
    expect((await caso(db, 1)).dono).toBeNull();
    expect((await caso(db, 2)).dono).toBeNull();   // dentro dos 10 dias e solto mesmo assim
    await db.close();
  });

  it("DEPOIS: irmão acionado há 2 dias segura o aluno inteiro", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null });
    await irmao(db, 2, 1, { dua: 2 });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("DEPOIS: irmão CONGELADO (regra de 26/10) segura o aluno inteiro", async () => {
    const db = await novo();
    await cenario(db, 1);
    await irmao(db, 2, 1, { statusAtual: "SEM SALDO EM ABERTO" });
    await db.query("insert into public.caso_encerramento_sem_saldo (caso_id) values ($1)", [U(2)]);
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("DEPOIS: irmão sob giro ainda VIGENTE segura o aluno inteiro", async () => {
    const db = await novo();
    await cenario(db, 1);
    await irmao(db, 2, 1, { giro: 4 });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("DEPOIS: irmão encerrado, fora dos 10 dias e sem proteção NÃO segura — sai junto", async () => {
    const db = await novo();
    await cenario(db, 1);
    await irmao(db, 2, 1, { statusAtual: "SEM SALDO EM ABERTO" });
    await rodarCron(db);
    expect((await caso(db, 1)).dono).toBeNull();
    expect((await caso(db, 2)).dono).toBeNull();
    await db.close();
  });
});

// ===========================================================================
describe("regra de irmãos — REGRESSÃO com e sem giro (decisão da gestão, N1)", () => {
  // Mesma montagem do describe da regra 5: segundo caso do aluno, ficha antiga.
  const irmaoSemGiro = async (db, n, alunoN, o = {}) => {
    const { dua = 2, statusAtual = null, giro = null, congelado = false } = o;
    await db.exec("alter table public.casos disable trigger user");
    await db.query(
      `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
          status_atual, data_ultimo_acionamento, giro_fidelizacao_ate, ultima_tabulacao_em, total_em_aberto,
          caso_codigo, caso_atualizado_em, nao_acionar, encerrado_operacional)
       values ($1,$2,$3,$3,$4,$3,$5,'DONO',$6,
          case when $7::int is null then null else current_date - $7::int end,
          case when $8::int is null then null else current_date + $8::int end,
          now() - interval '20 days', 100, $9, now() - interval '30 days', false, $10)`,
      [U(n), U(alunoN), CPF(alunoN), `Aluno Sintetico ${alunoN}`, OP1, statusAtual, dua, giro, n, statusAtual === "SEM SALDO EM ABERTO"]);
    if (congelado) await db.query("insert into public.caso_encerramento_sem_saldo (caso_id) values ($1)", [U(n)]);
    await db.exec("alter table public.casos enable trigger user");
  };

  it("SEM GIRO: caso parado há 15 dias, irmão acionado há 2 dias → liberar recusa", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoSemGiro(db, 2, 1, { dua: 2 });
    expect(await q1(db, "select public.liberar_fidelizacao_caso($1) ok", [U(1)])).toEqual({ ok: false });
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("SEM GIRO: a CASCATA de 2 dias não acontece pelo cron (HOJE acontecia)", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoSemGiro(db, 2, 1, { dua: 2 });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("SEM GIRO: irmão encerrado, fora dos 10 dias e sem proteção → caso sai (sem bloqueio indevido)", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoSemGiro(db, 2, 1, { dua: 30, statusAtual: "SEM SALDO EM ABERTO" });
    expect(await rodarCron(db)).toBe(1);
    expect((await caso(db, 1)).dono).toBeNull();
    await db.close();
  });

  it("SEM GIRO: irmão CONGELADO segura o aluno inteiro", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoSemGiro(db, 2, 1, { dua: 30, statusAtual: "SEM SALDO EM ABERTO", congelado: true });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("COM GIRO: caso de giro vencido, irmão sob giro VIGENTE → caso fica", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: -17, dua: 15 });
    await irmaoSemGiro(db, 2, 1, { dua: 30, statusAtual: "SEM SALDO EM ABERTO", giro: 5 });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("COM GIRO: caso de giro vencido, irmão acionado há 2 dias → fica (a mesma regra)", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: -17, dua: 15 });
    await irmaoSemGiro(db, 2, 1, { dua: 2 });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("a regra não solta caso protegido, em nenhum dos dois casos (giro e sem giro)", async () => {
    for (const giro of [null, -17]) {
      const db = await novo();
      await cenario(db, 1, { giro, dua: 15, acordoAtivo: true });
      expect(await rodarCron(db)).toBe(0);
      expect((await caso(db, 1)).dono).toBe(OP1);
      await db.close();
    }
  });
});

// ===========================================================================
describe("teto (N2) — o UPDATE direto do teto respeita a mesma regra de irmãos", () => {
  // Teto = 3. OP1 tem 3 casos e entra o 4º (caso livre atribuido). Candidato a
  // ser solto pelo teto: caso de giro vencido, parado ha 15 dias.
  const montarTeto = async (db, irmao) => {
    await cenario(db, 1, { dua: 15, valor: 10 });                 // candidato
    await cenario(db, 2, { giro: null, dua: 2 });
    await cenario(db, 3, { giro: null, dua: 2 });
    if (irmao) {
      await db.exec("alter table public.casos disable trigger user");
      await db.query(
        `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
            status_atual, data_ultimo_acionamento, ultima_tabulacao_em, total_em_aberto, caso_codigo, caso_atualizado_em,
            nao_acionar, encerrado_operacional)
         values ($1,$2,$3,$3,'Irmao',$3,$4,'DONO','SEM SALDO EM ABERTO', current_date - 40, now(), 100, 99, now() - interval '30 days', false, true)`,
        [U(60), U(1), CPF(1), OP1]);
      await db.query("insert into public.caso_encerramento_sem_saldo (caso_id) values ($1)", [U(60)]);
      await db.exec("alter table public.casos enable trigger user");
    }
    await cenario(db, 4, { giro: null, dua: 2, dono: null });
    await db.query("update public.casos set operador_email=$1, operador_nome='DONO' where id=$2", [OP1, U(4)]);
  };

  it("SEM irmão: o teto continua soltando o caso de giro vencido (comportamento mantido)", async () => {
    const db = await novo();
    await montarTeto(db, false);
    expect((await caso(db, 1)).dono).toBeNull();
    await db.close();
  });

  it("COM irmão congelado: o teto NÃO solta o caso de giro (N2 corrigido)", async () => {
    const db = await novo();
    await montarTeto(db, true);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await caso(db, 60)).dono).toBe(OP1);
    await db.close();
  });
});

// ===========================================================================
describe("achados da 3ª auditoria — A1 (assumir_caso_livre) e A2 (Carteira Geral)", () => {
  // A verificacao de carteira cheia e da carteira de QUEM RECEBE o caso (OP2).
  // OP2 precisa estar cheio, com um caso candidato a ser trocado.
  it("A1: ao trocar caso de carteira cheia, o caso cujo irmão está dentro dos 10 dias NÃO é escolhido", async () => {
    const db = await novo();
    await db.query("update public.calibragem_parametros set valor = '1'::jsonb where chave = 'limite_carteira'");
    await cenario(db, 1, { dono: OP2, giro: null, dua: 15 });     // candidato a troca de OP2
    await db.query("update public.casos set ultima_tabulacao_em = null where id = $1", [U(1)]);
    // irmao do MESMO aluno, de OP2, acionado ha 2 dias: protege o aluno inteiro
    await db.exec("alter table public.casos disable trigger user");
    await db.query(
      `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
          status_atual, data_ultimo_acionamento, ultima_tabulacao_em, total_em_aberto, caso_codigo, caso_atualizado_em, nao_acionar)
       values ($1,$2,$3,$3,'Irmao',$3,$4,'DONO', null, current_date - 2, now(), 100, 97, now() - interval '30 days', false)`,
      [U(2), U(1), CPF(1), OP2]);
    await db.exec("alter table public.casos enable trigger user");
    await cenario(db, 3, { dono: null });                          // caso livre que OP2 quer assumir
    const r = await assumir(db, OP2, 3);
    expect(r.sucesso).toBe(false);                                // nada a trocar: o candidato protege irmao
    expect((await caso(db, 1)).dono).toBe(OP2);
    expect((await caso(db, 2)).dono).toBe(OP2);
    expect((await caso(db, 3)).dono).toBeNull();
    await db.close();
  });

  it("A1: sem irmão protegido, a troca continua funcionando (comportamento mantido)", async () => {
    const db = await novo();
    await db.query("update public.calibragem_parametros set valor = '1'::jsonb where chave = 'limite_carteira'");
    await cenario(db, 1, { dono: OP2, giro: null, dua: 15 });
    await db.query("update public.casos set ultima_tabulacao_em = null where id = $1", [U(1)]);
    await cenario(db, 2, { dono: OP2, giro: null, dua: 15 });     // outro aluno, sem protecao
    await cenario(db, 3, { dono: null });
    const r = await assumir(db, OP2, 3);
    expect(r.sucesso).toBe(true);
    expect((await caso(db, 1)).dono).toBeNull();                  // trocado, como antes
    expect((await caso(db, 3)).dono).toBe(OP2);
    await db.close();
  });

  // F1: trocar a MAO de um caso de giro vencido (dono OP1 -> OP2) muda o dono de
  // todos os casos do aluno. So pode se nenhum irmao puder mudar junto.
  const irmaoDe = async (db, n, alunoN, dono, o) => {
    const { dua, statusAtual, congelado } = o;
    await db.exec("alter table public.casos disable trigger user");
    await db.query(
      `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
          status_atual, data_ultimo_acionamento, ultima_tabulacao_em, total_em_aberto, caso_codigo, caso_atualizado_em, nao_acionar, encerrado_operacional)
       values ($1,$2,$3,$3,'Irmao',$3,$4,'DONO',$5, case when $6::int is null then null else current_date - $6::int end,
          now(), 100, $7, now() - interval '30 days', false, $8)`,
      [U(n), U(alunoN), CPF(alunoN), dono, statusAtual ?? null, dua ?? null, n, statusAtual === "SEM SALDO EM ABERTO"]);
    if (congelado) await db.query("insert into public.caso_encerramento_sem_saldo (caso_id) values ($1)", [U(n)]);
    await db.exec("alter table public.casos enable trigger user");
  };

  it("F1 / Q1b: troca de mão com irmão ENCERRADO dentro dos 10 dias → recusada, irmão fica", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    await irmaoDe(db, 2, 1, OP1, { dua: 2, statusAtual: "SEM SALDO EM ABERTO" });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(false);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("F1 / Q2: troca de mão com irmão CONGELADO → recusada, irmão fica", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    await irmaoDe(db, 2, 1, OP1, { dua: 30, statusAtual: "SEM SALDO EM ABERTO", congelado: true });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(false);
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("F1 / Q3: troca de mão com irmão na CARTEIRA GERAL → recusada, a gestão não perde o caso", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    await irmaoDe(db, 2, 1, "carteira.geral@reativa.local", { dua: 40, statusAtual: "SEM SALDO EM ABERTO" });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(false);
    expect((await caso(db, 2)).dono).toBe("carteira.geral@reativa.local");
    await db.close();
  });

  it("F1: troca de mão SEM irmão protegido continua valendo (giro vencido é transferido)", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(true);
    expect((await caso(db, 1)).dono).toBe(OP2);
    await db.close();
  });

  it("F1: irmão encerrado, fora dos 10 dias e sem proteção → troca permitida (sai junto, fica registrado)", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    await irmaoDe(db, 2, 1, OP1, { dua: 30, statusAtual: "SEM SALDO EM ABERTO" });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(true);
    expect((await caso(db, 2)).dono).toBe(OP2);
    await db.close();
  });

  it("A2: irmão na CARTEIRA GERAL segura o aluno inteiro no cron", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await db.exec("alter table public.casos disable trigger user");
    await db.query(
      `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
          status_atual, data_ultimo_acionamento, ultima_tabulacao_em, total_em_aberto, caso_codigo, caso_atualizado_em,
          nao_acionar, encerrado_operacional)
       values ($1,$2,$3,$3,'Irmao',$3,'carteira.geral@reativa.local','GERAL','SEM SALDO EM ABERTO', current_date - 40,
          now(), 100, 98, now() - interval '30 days', false, true)`,
      [U(41), U(1), CPF(1)]);
    await db.exec("alter table public.casos enable trigger user");
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [U(41)])).e).toBe("carteira.geral@reativa.local");
    await db.close();
  });
});

// ===========================================================================
describe("regra 4 — nenhuma redistribuição automática", () => {
  it("a liberação não entrega o caso a ninguém nem cria caso em outra carteira", async () => {
    const db = await novo();
    for (let n = 1; n <= 4; n++) await cenario(db, n, { dua: 12 + n });
    const antes = await q1(db, "select count(*) filter (where operador_email=$1) op2 from public.casos", [OP2]);
    expect(await rodarCron(db)).toBe(4);
    const depois = await q1(db,
      `select count(*) filter (where operador_email is null) livres,
              count(*) filter (where operador_email=$1) op2, count(*) total from public.casos`, [OP2]);
    expect(Number(depois.livres)).toBe(4);
    expect(Number(depois.op2)).toBe(Number(antes.op2));
    expect(Number(depois.total)).toBe(4);
    await db.close();
  });
});

// ===========================================================================
describe("regra 3 — receptivo: assumir caso de giro", () => {
  it("dentro dos 10 dias, outro operador NÃO assume", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 3 });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(false);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("no 10º dia ainda é do operador; no 11º outro operador assume", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 10 });
    await cenario(db, 2, { dua: 11 });
    expect((await assumir(db, OP2, 1)).sucesso).toBe(false);
    const r = await assumir(db, OP2, 2);
    expect(r.sucesso).toBe(true);
    const c = await caso(db, 2);
    expect(c.dono).toBe(OP2);
    expect(c.marca).toBeNull();   // trocou de dono: a marca do giro sai
    await db.close();
  });

  it("protegido não é assumido nem depois do 11º dia", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 20, acordoAtivo: true });
    expect((await assumir(db, OP2, 1)).sucesso).toBe(false);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("depois de solto pela rotina, o caso livre é assumido normalmente", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 15 });
    await rodarCron(db);
    expect((await assumir(db, OP2, 1)).sucesso).toBe(true);
    expect((await caso(db, 1)).dono).toBe(OP2);
    await db.close();
  });

  it("caso com dono e SEM marca de giro segue recusado, como antes", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 30 });
    expect((await assumir(db, OP2, 1)).sucesso).toBe(false);
    await db.close();
  });
});

// ===========================================================================
describe("teto do operador — a marca vencida não blinda mais", () => {
  // Teto = 3. OP1 tem 3 casos; entra o 4º. Só o caso de giro parado há 15 dias
  // está fora do prazo, então é o único que o teto pode soltar.
  const montar = async (db) => {
    await cenario(db, 1, { dua: 15, valor: 10 });           // giro vencido, parado
    await cenario(db, 2, { giro: null, dua: 2 });
    await cenario(db, 3, { giro: null, dua: 2 });
    await cenario(db, 4, { giro: null, dua: 2, dono: null });
    await db.query("update public.casos set operador_email=$1, operador_nome='OP UM' where id=$2", [OP1, U(4)]);
    return q1(db, "select count(*) n from public.casos where operador_email=$1", [OP1]);
  };

  it("HOJE: a marca blinda e o operador fica acima do teto", async () => {
    const db = await hoje();
    expect(Number((await montar(db)).n)).toBe(4);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("DEPOIS: o caso de giro fora do prazo é o excedente solto", async () => {
    const db = await novo();
    expect(Number((await montar(db)).n)).toBe(3);
    expect((await caso(db, 1)).dono).toBeNull();
    await db.close();
  });

  it("DEPOIS: caso de giro dentro dos 10 dias não é solto pelo teto", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 4, valor: 10 });
    await cenario(db, 2, { giro: null, dua: 2 });
    await cenario(db, 3, { giro: null, dua: 2 });
    await cenario(db, 4, { giro: null, dua: 2, dono: null });
    await db.query("update public.casos set operador_email=$1, operador_nome='OP UM' where id=$2", [OP1, U(4)]);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });
});

// ===========================================================================
describe("regra 7 (parcial) — o card de risco não lista o que a liberação não solta por giro vigente ou retorno", () => {
  const risco = async (db, email = GESTAO) => {
    await como(db, email);
    const r = await qn(db, "select * from public.casos_risco_perder(null)");
    await como(db, GESTAO);
    return r.map((x) => x.aluno_id).sort();
  };

  it("HOJE: o card marca como risco caso de giro vencido E caso com retorno do operador", async () => {
    const db = await hoje();
    await cenario(db, 1);
    await cenario(db, 2, { giro: 5 });
    await cenario(db, 3, { retorno: 2, retornoOrigem: "OPERADOR" });
    expect(await risco(db)).toEqual([U(1), U(2), U(3)]);
    await db.close();
  });

  it("DEPOIS: giro vigente e retorno do operador saem do card; giro vencido continua", async () => {
    const db = await novo();
    await cenario(db, 1);                                              // giro vencido, parado
    await cenario(db, 2, { giro: 5 });                                 // giro vigente
    await cenario(db, 3, { retorno: 2, retornoOrigem: "OPERADOR" });  // compromisso
    await cenario(db, 4, { giro: null });                              // sem marca
    expect(await risco(db)).toEqual([U(1), U(4)]);
    await db.close();
  });

  it("DEPOIS: tudo que o card lista, nos cenários sem Carteira Geral nem hold, o cron solta (um sentido só)", async () => {
    const db = await novo();
    for (let n = 1; n <= 3; n++) await cenario(db, n, { dua: 12 + n });
    await cenario(db, 4, { giro: 3 });
    await cenario(db, 5, { acordoAtivo: true });
    await cenario(db, 6, { dua: 4 });
    const noCard = await risco(db);
    expect(noCard).toEqual([U(1), U(2), U(3)]);
    expect(await rodarCron(db)).toBe(noCard.length);
    await db.close();
  });

  it("operador comum continua vendo só a própria carteira", async () => {
    const db = await novo();
    await cenario(db, 1);
    await cenario(db, 2, { dono: OP2 });
    await como(db, OP1);
    const r = await qn(db, "select aluno_id from public.casos_risco_perder(null)");
    await como(db, GESTAO);
    expect(r.map((x) => x.aluno_id)).toEqual([U(1)]);
    await db.close();
  });
});

// ===========================================================================
describe("segurança — portão interno de liberar_fidelizacao_caso", () => {
  it("operador autenticado não solta caso chamando a função direto", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 15 });
    await como(db, OP2);
    await expect(db.query("select public.liberar_fidelizacao_caso($1)", [U(1)])).rejects.toThrow(/sem_permissao/);
    await como(db, GESTAO);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("gestão e cron continuam podendo", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 15 });
    await cenario(db, 2, { dua: 15 });
    expect((await q1(db, "select public.liberar_fidelizacao_caso($1) ok", [U(1)])).ok).toBe(true);
    await como(db, null);
    expect((await q1(db, "select public.liberar_fidelizacao_caso($1) ok", [U(2)])).ok).toBe(true);
    await db.close();
  });

  it("grants, dono, SECURITY DEFINER, search_path e assinatura não mudam", async () => {
    const a = await hoje();
    const b = await novo();
    const antes = await retrato(a);
    // a bancada traz a ACL REAL de producao: sem isto a comparacao seria NULL = NULL
    for (const r of antes) {
      expect(r.acl).toMatch(/authenticated=X/);
      expect(r.acl).toMatch(/service_role=X/);
      expect(r.acl).not.toMatch(/^\{=X/);   // sem PUBLIC
    }
    expect(await retrato(b)).toEqual(antes);
    await a.close();
    await b.close();
  });
});

// ===========================================================================
describe("migration e rollback", () => {
  it("a migration não escreve dado: nenhum caso muda ao aplicar", async () => {
    const db = await hoje();
    for (let n = 1; n <= 3; n++) await cenario(db, n, { dua: 20 });
    const foto = () => qn(db, "select id, operador_email, giro_fidelizacao_ate, data_ultimo_acionamento from public.casos order by id");
    const antes = await foto();
    await db.exec(MIGRATION);
    expect(await foto()).toEqual(antes);
    expect((await q1(db, "select count(*) n from public.historico_operadores_alunos")).n).toBe(0);
    await db.close();
  });

  it("é idempotente: aplicar duas vezes não muda o corpo", async () => {
    const db = await novo();
    const antes = await md5s(db);
    await db.exec(MIGRATION);
    const depois = await md5s(db);
    for (const f of ALVOS) expect(depois[`public.${f}`]).toBe(antes[`public.${f}`]);
    await db.close();
  });

  it("recusa aplicar se a função alvo mudou (âncora ausente)", async () => {
    const db = await hoje();
    await db.exec(`
      create or replace function public.trg_impor_teto_operador() returns trigger
      language plpgsql security definer set search_path to 'public' as $f$ begin return new; end; $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ocorrencia/);
    // a transação abortou inteira: liberar_fidelizacao_caso continua a de produção
    await db.exec("rollback");
    expect((await md5s(db))["public.liberar_fidelizacao_caso"]).toBe(MD5_PROD["public.liberar_fidelizacao_caso"]);
    await db.close();
  });

  it("o rollback devolve os quatro corpos de produção, byte a byte", async () => {
    const db = await novo();
    await db.exec(ROLLBACK);
    const m = await md5s(db);
    for (const f of ALVOS) expect(m[`public.${f}`]).toBe(MD5_PROD[`public.${f}`]);
    await cenario(db, 1);
    expect(await rodarCron(db)).toBe(0);   // o defeito volta, como declarado
    await db.close();
  });

  it("depois do rollback a migration reaplica limpa", async () => {
    const db = await novo();
    const aplicada = await md5s(db);
    await db.exec(ROLLBACK);
    await db.exec(MIGRATION);
    const m = await md5s(db);
    for (const f of ALVOS) expect(m[`public.${f}`]).toBe(aplicada[`public.${f}`]);
    await db.close();
  });

  it("o rollback recusa rodar sobre a produção de hoje (nada a reverter)", async () => {
    const db = await hoje();
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/ocorrencia/);
    await db.close();
  });
});
