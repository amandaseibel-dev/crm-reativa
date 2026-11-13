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
const AUDITORIA = ler("supabase/audits/retorno_vinculo_auditoria_20261113.sql");
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
  // Retorno de OPERADOR nasce de um atendimento real do responsavel (regra de 13/11).
  // `semAtendimento` monta o retorno "solto" (envio em lote, digitado sem atender).
  if (retorno !== null && String(retornoOrigem || "").toUpperCase().startsWith("OPERADOR") && !o.semAtendimento && !o.semMov && dono) {
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_por_nome, registrado_em, data_retorno)
       values ($1, 'FINALIZACAO_ATENDIMENTO', 'atendimento sintetico', $2, 'DONO',
               (current_date - $3::int)::timestamp + interval '15 hours', (current_date + $4::int)::timestamp)`,
      [U(n), String(o.atendidoPor || dono).toLowerCase(), o.atendidoHa ?? dua ?? 0, retorno]);
  }
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
// Liberacao e assuncao sobre o MESMO caso: o resultado tem de ser coerente nos dois
// caminhos (regra 7 da gestao). Devolve o que o cron soltou, se outro operador
// conseguiu assumir e quem ficou com o caso.
const ambos = async (db) => {
  const cron = await rodarCron(db);
  const dono1 = (await caso(db, 1)).dono;
  const r = dono1 ? await assumir(db, OP2, 1) : { sucesso: null };
  return { cron, assumiu: r.sucesso, dono: (await caso(db, 1)).dono };
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
    await cenario(db, 1, { dua: 12, retorno: d, retornoOrigem: "OPERADOR" });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("retorno OPERADOR_EM_CONFIRMACAO (prefixo, como em retornoOrigem.js) também preserva", async () => {
    const db = await novo();
    await cenario(db, 1, { dua: 12, retorno: 2, retornoOrigem: "OPERADOR_EM_CONFIRMACAO" });
    await cenario(db, 2, { dua: 12, retorno: 2, retornoOrigem: "operador" });  // caixa baixa: upper() normaliza
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

  it("F1 / Q3 + G1: troca de mão com irmão LIVRE da Carteira Geral → permitida (a regra aprovada)", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    await irmaoDe(db, 2, 1, "carteira.geral@reativa.local", { dua: 40, statusAtual: "SEM SALDO EM ABERTO" });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(true);
    expect((await caso(db, 2)).dono).toBe(OP2);
    await db.close();
  });

  it("G1 regra 2: irmão da Carteira Geral COM fidelização vigente segura a troca de mão", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: OP1, giro: -17, dua: 15 });
    await irmaoDe(db, 2, 1, "carteira.geral@reativa.local", { dua: 2, statusAtual: "SEM SALDO EM ABERTO" });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(false);
    expect((await caso(db, 1)).dono).toBe(OP1);
    expect((await caso(db, 2)).dono).toBe("carteira.geral@reativa.local");
    await db.close();
  });

  it("G1 regra 2 (cron): irmão da Carteira Geral com fidelização vigente segura o aluno", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoDe(db, 2, 1, "carteira.geral@reativa.local", { dua: 2, statusAtual: "SEM SALDO EM ABERTO" });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("G1 regra 3: pool de EX-OPERADOR (inativo) sem proteção vigente é livre → não segura", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoDe(db, 2, 1, "ex.operador@aelbra.com.br", { dua: 40, statusAtual: "SEM SALDO EM ABERTO" });
    expect(await rodarCron(db)).toBe(1);
    expect((await caso(db, 1)).dono).toBeNull();
    await db.close();
  });

  it("G1 regra 3: pool de EX-OPERADOR com fidelização vigente segura o aluno", async () => {
    const db = await novo();
    await cenario(db, 1, { giro: null, dua: 15 });
    await irmaoDe(db, 2, 1, "ex.operador@aelbra.com.br", { dua: 2, statusAtual: "SEM SALDO EM ABERTO" });
    expect(await rodarCron(db)).toBe(0);
    expect((await caso(db, 1)).dono).toBe(OP1);
    await db.close();
  });

  it("G1 regra 4: assumir um caso LIVRE não transfere irmão PROTEGIDO de outro operador", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: null });                          // caso livre, alvo da assuncao
    await irmaoDe(db, 2, 1, OP1, { dua: 2, statusAtual: "SEM SALDO EM ABERTO" });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(false);
    expect((await caso(db, 1)).dono).toBeNull();
    expect((await caso(db, 2)).dono).toBe(OP1);
    await db.close();
  });

  it("G1 regra 1/5: caso livre com irmão livre (sem dono) continua assumível", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: null });
    await db.exec("alter table public.casos disable trigger user");
    await db.query(
      `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
          status_atual, data_ultimo_acionamento, ultima_tabulacao_em, total_em_aberto, caso_codigo, caso_atualizado_em, nao_acionar, encerrado_operacional)
       values ($1,$2,$3,$3,'Irmao',$3,null,null,'SEM SALDO EM ABERTO', current_date - 40, now(), 100, 96, now() - interval '30 days', false, true)`,
      [U(2), U(1), CPF(1)]);
    await db.exec("alter table public.casos enable trigger user");
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(true);
    await db.close();
  });

  it("G1 regra 5: caso da Carteira Geral sem irmão protegido segue de LIVRE ASSUNÇÃO", async () => {
    const db = await novo();
    await cenario(db, 1, { dono: "carteira.geral@reativa.local", giro: null, dua: 30 });
    const r = await assumir(db, OP2, 1);
    expect(r.sucesso).toBe(true);
    expect((await caso(db, 1)).dono).toBe(OP2);
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

  it.each([["acionado há 2 dias", { giro: null, dua: 2 }], ["sob giro vigente", { giro: 5, dua: 15 }]])(
    "H1: carteira cheia — caso do próprio operador %s NÃO é solto na troca", async (_n, extra) => {
      const db = await novo();
      await db.query("update public.calibragem_parametros set valor = '1'::jsonb where chave = 'limite_carteira'");
      await cenario(db, 1, { dono: OP2, ...extra });
      await db.query("update public.casos set ultima_tabulacao_em = null where id = $1", [U(1)]);
      await cenario(db, 3, { dono: null });
      const r = await assumir(db, OP2, 3);
      expect(r.sucesso).toBe(false);
      expect((await caso(db, 1)).dono).toBe(OP2);
      await db.close();
    });

  it("A2 / G1 regra 5: irmão LIVRE na Carteira Geral (sem fidelização vigente) NÃO segura o aluno", async () => {
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
    expect(await rodarCron(db)).toBe(1);
    expect((await caso(db, 1)).dono).toBeNull();
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [U(41)])).e).toBeNull();
    await db.close();
  });
});

// ===========================================================================
describe("retorno agendado (decisão da gestão, 13/11) — liberação e assunção com a MESMA regra", () => {
  // caso de giro vencido do OP1, atendido ha `dua` dias, com retorno do operador.
  const alvo = (db, extra) => cenario(db, 1, { dono: OP1, giro: -17, dua: 12, retornoOrigem: "OPERADOR", ...extra });

  it.each([["futuro (daqui a 2 dias)", 2], ["de hoje", 0]])("retorno %s, válido: cron NÃO solta e outro operador NÃO assume", async (_n, ret) => {
    const db = await novo();
    await alvo(db, { retorno: ret });
    expect(await ambos(db)).toEqual({ cron: 0, assumiu: false, dono: OP1 });
    await db.close();
  });

  it("retorno VENCIDO (ontem): não protege — cron solta", async () => {
    const db = await novo();
    await alvo(db, { retorno: -1 });
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("retorno vencido não protege a assunção: outro operador assume", async () => {
    const db = await novo();
    await alvo(db, { retorno: -1 });
    expect((await assumir(db, OP2, 1)).sucesso).toBe(true);
    await db.close();
  });

  it("retorno CANCELADO (data apagada): não protege", async () => {
    const db = await novo();
    await alvo(db, { retorno: 2 });
    await db.query("update public.alunos set data_retorno = null where id = $1", [U(1)]);
    expect((await assumir(db, OP2, 1)).sucesso).toBe(true);
    await db.close();
  });

  it("retorno CONCLUÍDO (confirmado): não protege", async () => {
    const db = await novo();
    await alvo(db, { retorno: 2 });
    await db.query("update public.alunos set retorno_confirmado_em = now() where id = $1", [U(1)]);
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("retorno INVÁLIDO (sem atendimento real, ex.: envio em lote): não protege", async () => {
    const db = await novo();
    await alvo(db, { retorno: 2, semAtendimento: true });
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("retorno AUTOMÁTICO futuro: não protege a assunção", async () => {
    const db = await novo();
    await alvo(db, { retorno: 2, retornoOrigem: "AUTOMATICO" });
    expect((await assumir(db, OP2, 1)).sucesso).toBe(true);
    await db.close();
  });

  it("TROCA DE RESPONSÁVEL: retorno marcado pelo operador anterior não protege o atual", async () => {
    const db = await novo();
    await alvo(db, { retorno: 2, atendidoPor: OP2 });       // quem atendeu e marcou foi outro; o dono hoje e OP1
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("SEM RENOVAÇÃO: retorno a mais de 15 dias do atendimento que o marcou não protege", async () => {
    const db = await novo();
    await alvo(db, { dua: 20, retorno: 2 });                // atendimento ha 20 dias, retorno em +2 = 22 dias depois
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("remarcar o retorno SEM atender de novo não prolonga a proteção", async () => {
    const db = await novo();
    await alvo(db, { retorno: 0 });
    await db.query("update public.alunos set data_retorno = current_date + 10 where id = $1", [U(1)]);   // so empurrou a data
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("o próprio responsável não é barrado pelo seu retorno; e o card de risco não lista o caso protegido", async () => {
    const db = await novo();
    await alvo(db, { retorno: 2 });
    await como(db, OP1);
    const r = await qn(db, "select aluno_id from public.casos_risco_perder(null)");
    await como(db, GESTAO);
    expect(r.length).toBe(0);
    await db.close();
  });

  it("carteira cheia e teto não soltam caso do próprio operador com retorno válido", async () => {
    const db = await novo();
    await db.query("update public.calibragem_parametros set valor = '1'::jsonb where chave = 'limite_carteira'");
    await cenario(db, 1, { dono: OP2, giro: null, dua: 12, retorno: 2, retornoOrigem: "OPERADOR" });
    await db.query("update public.casos set ultima_tabulacao_em = null where id = $1", [U(1)]);
    await cenario(db, 3, { dono: null });
    expect((await assumir(db, OP2, 3)).sucesso).toBe(false);
    expect((await caso(db, 1)).dono).toBe(OP2);
    await db.close();
  });
});

// ===========================================================================
describe("vínculo do retorno — via explícita e alternativa de 10 dias (gestão, 13/11)", () => {
  // IMPORTANTE: registrar um FINALIZACAO_ATENDIMENTO dispara
  // fn_atualizar_ultimo_acionamento, que reinicia a fidelizacao normal de 10 dias.
  // Para medir SO a regra de retorno, estes testes forcam o ultimo acionamento de
  // volta para 15 dias atras depois de inserir o atendimento: o caso fica elegivel
  // ao cron e a unica protecao possivel passa a ser o retorno.
  const atendimento = (db, n, { email, diasAtras, comDataRetornoEm = null }) =>
    db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_por_nome, registrado_em, data_retorno)
       values ($1, 'FINALIZACAO_ATENDIMENTO', 'atendimento sintetico', $2, 'OP',
               (current_date - $3::int)::timestamp + interval '15 hours',
               case when $4::int is null then null else (current_date + $4::int)::timestamp end)`,
      [U(n), email, diasAtras, comDataRetornoEm]);
  const retornoEm = (db, n, dias) =>
    db.query("update public.alunos set data_retorno = current_date + $2::int, retorno_origem = 'OPERADOR' where id = $1", [U(n), dias]);
  const forcarParado = async (db, n) => {
    await db.exec("alter table public.casos disable trigger user");
    await db.exec("alter table public.alunos disable trigger user");
    await db.query("update public.casos set data_ultimo_acionamento = current_date - 15 where id = $1", [U(n)]);
    await db.query("update public.alunos set data_ultimo_acionamento = now() - interval '15 days' where id = $1", [U(n)]);
    await db.exec("alter table public.alunos enable trigger user");
    await db.exec("alter table public.casos enable trigger user");
  };
  // caso de giro vencido, sem movimentacao propria; o teste monta o atendimento.
  const base = (db, extra = {}) => cenario(db, 1, { dono: OP1, giro: -17, dua: 15, retorno: null, semMov: true, ...extra });

  it("ALTERNATIVA: atendimento do responsável há 3 dias, sem data na movimentação → protege", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    expect(await ambos(db)).toEqual({ cron: 0, assumiu: false, dono: OP1 });
    await db.close();
  });

  it("ALTERNATIVA: atendimento há 12 dias (fora dos 10), sem data na movimentação → NÃO protege", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 12 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("REMARCAR sem atender não renova: atendimento há 12 dias e retorno empurrado para +3 → NÃO protege", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: -9 });  // retorno antigo, ja vencido
    await retornoEm(db, 1, 3);                                                       // remarcado, sem atendimento novo
    await forcarParado(db, 1);
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("EXPLÍCITA: atendimento há 12 dias COM a mesma data de retorno (+3, dentro dos 15) → protege", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    expect(await ambos(db)).toEqual({ cron: 0, assumiu: false, dono: OP1 });
    await db.close();
  });

  it("EXPLÍCITA: retorno a mais de 15 dias do atendimento → NÃO protege", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: 6 });   // 12 + 6 = 18 dias
    await retornoEm(db, 1, 6);
    await forcarParado(db, 1);
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("EX-OPERADOR (inativo): retorno com vínculo explícito NÃO bloqueia", async () => {
    const db = await novo();
    await base(db, { dono: "ex.operador@aelbra.com.br" });
    await atendimento(db, 1, { email: "ex.operador@aelbra.com.br", diasAtras: 12, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("X → Y → X: atendimento de X ANTERIOR à última troca não revalida o retorno", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    // o aluno saiu e voltou para OP1 ha 2 dias: o atendimento de 12 dias e anterior a volta
    await db.exec("alter table public.alunos disable trigger user");
    await db.query("update public.alunos set responsavel_atual_em = now() - interval '2 days' where id = $1", [U(1)]);
    await db.exec("alter table public.alunos enable trigger user");
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  it("X → Y → X: atendimento de X POSTERIOR à volta continua protegendo", async () => {
    const db = await novo();
    await base(db);
    await db.exec("alter table public.alunos disable trigger user");
    await db.query("update public.alunos set responsavel_atual_em = now() - interval '20 days' where id = $1", [U(1)]);
    await db.exec("alter table public.alunos enable trigger user");
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    expect(await ambos(db)).toEqual({ cron: 0, assumiu: false, dono: OP1 });
    await db.close();
  });

  it("retorno CONCLUÍDO não protege, mesmo com vínculo explícito", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await db.query("update public.alunos set retorno_confirmado_em = now() where id = $1", [U(1)]);
    await forcarParado(db, 1);
    expect((await ambos(db)).cron).toBe(1);
    await db.close();
  });

  // ACHADO (13/11): a via alternativa de 10 dias e REDUNDANTE no fluxo normal.
  // FINALIZACAO_ATENDIMENTO conta como acionamento (eh_tipo_acionamento) e o gatilho
  // fn_atualizar_ultimo_acionamento reinicia a fidelizacao de 10 dias. Logo, um
  // atendimento nos ultimos 10 dias JA protege o caso pela fidelizacao normal, sem
  // precisar da regra de retorno. A alternativa so muda o resultado quando o ultimo
  // acionamento esta dessincronizado do atendimento (e por isso os testes acima
  // forcam essa dessincronizacao para medir a regra isoladamente).
  it("ACHADO: atendimento há 3 dias já protege pela fidelização normal, sem a regra de retorno", async () => {
    const db = await novo();
    await base(db, { retorno: null });
    await atendimento(db, 1, { email: OP1, diasAtras: 3 });
    // retorno AUTOMATICO: a regra de retorno NAO se aplica
    await db.query("update public.alunos set data_retorno = current_date + 3, retorno_origem = 'AUTOMATICO' where id = $1", [U(1)]);
    const c = await q1(db, "select data_ultimo_acionamento dua, public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) dentro from public.casos where id = $1", [U(1)]);
    expect(c.dentro).toBe(true);              // o atendimento reiniciou os 10 dias
    expect(await rodarCron(db)).toBe(0);      // protegido pela fidelizacao normal
    await db.close();
  });

  // A consulta de auditoria versionada (supabase/audits/) tem de classificar
  // exatamente como a funcao. Se uma das duas mudar sozinha, este teste quebra.
  it("a consulta de auditoria roda e concorda com a regra, caso a caso", async () => {
    const db = await novo();
    await base(db);                                                    // 1: via explicita
    await atendimento(db, 1, { email: OP1, diasAtras: 12, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    await cenario(db, 2, { dono: OP1, giro: -17, dua: 15, retorno: null, semMov: true });   // 2: via alternativa
    await atendimento(db, 2, { email: OP1, diasAtras: 3 });
    await retornoEm(db, 2, 3);
    await forcarParado(db, 2);
    await cenario(db, 3, { dono: OP1, giro: -17, dua: 15, retorno: null, semMov: true });   // 3: sem protecao
    await atendimento(db, 3, { email: OP1, diasAtras: 20 });
    await retornoEm(db, 3, 3);
    await forcarParado(db, 3);

    const vig = {};
    for (const n of [1, 2, 3]) {
      vig[n] = (await q1(db, "select public.aluno_retorno_operador_vigente($1) v", [U(n)])).v;
    }
    expect(vig).toEqual({ 1: true, 2: true, 3: false });

    const linhas = await qn(db, AUDITORIA);
    const achar = (item) => Number(linhas.find((l) => l.item.startsWith(item))?.valor);
    expect(achar("total")).toBe(3);
    expect(achar("protegidos SO pela via explicita")).toBe(1);
    expect(achar("protegidos SO pela via alternativa")).toBe(1);
    expect(achar("sem protecao")).toBe(1);
    await db.close();
  });

  it("atendimento de OUTRO operador não protege o responsável atual", async () => {
    const db = await novo();
    await base(db);
    await atendimento(db, 1, { email: OP2, diasAtras: 3, comDataRetornoEm: 3 });
    await retornoEm(db, 1, 3);
    await forcarParado(db, 1);
    expect((await ambos(db)).cron).toBe(1);
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
    await cenario(db, 3, { dua: 12, retorno: 2, retornoOrigem: "OPERADOR" });
    expect(await risco(db)).toEqual([U(1), U(2), U(3)]);
    await db.close();
  });

  it("DEPOIS: giro vigente e retorno do operador saem do card; giro vencido continua", async () => {
    const db = await novo();
    await cenario(db, 1);                                              // giro vencido, parado
    await cenario(db, 2, { giro: 5 });                                 // giro vigente
    await cenario(db, 3, { dua: 12, retorno: 2, retornoOrigem: "OPERADOR" });  // compromisso
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
