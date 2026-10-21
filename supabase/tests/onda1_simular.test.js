// ONDA 1 · SIMULAÇÃO DO LOTE A — comportamento, num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (supabase/migrations/20261021180000_onda1_simular.sql)
// e o ROLLBACK REAL sobre corpos EXATOS de produção, cada um conferido por
// `md5(prosrc)`.
//
// O que estes testes protegem, em ordem de importância:
//   1. a simulação NÃO MOVE NINGUÉM — nenhuma linha de `casos` muda;
//   2. o recorte é o lote A e só ele: quem já tem dono ativo fica de fora,
//      quem não tem caso fica de fora, bloqueado/encerrado/marca viva fica
//      de fora, e quem tem acordo ENTRA;
//   3. a competência fica em ±1 CPF entre operadores;
//   4. o teto é respeitado, e a função RECUSA antes de gravar se estouraria;
//   5. o responsável operacional fica único por aluno.
//
// NENHUM DADO REAL: CPF, nome e e-mail são sintéticos.
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

const BASE = ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql");
const MD5_BASE = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const M3 = ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.sql");
const MD5_M3 = JSON.parse(ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.md5.json"));
const COMPL = ler("supabase/tests/fixtures/onda1_prod_20261021.sql");
const MD5_COMPL = JSON.parse(ler("supabase/tests/fixtures/onda1_prod_20261021.md5.json"));
const MIGRATION = ler("supabase/migrations/20261021180000_onda1_simular.sql");
const ROLLBACK = ler("supabase/rollbacks/20261021180000_onda1_simular.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP = ["cobranca05@aelbra.com.br", "cobranca06@aelbra.com.br", "cobranca08@aelbra.com.br"];
const CG = "carteira.geral@reativa.local";
const OLGA = "cobranca03@aelbra.com.br";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(40000000000 + n);

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

const simular = async (db, crit = {}) =>
  (await q1(db, "select public.onda1_simular($1::jsonb) j", [JSON.stringify(crit)])).j;

// Cria um aluno com caso e divida de 2026. `dono` null = caso sem operador.
async function aluno(db, n, o = {}) {
  const {
    dono = CG, sem2026 = false, semestre = "2026/2", valor = 1000,
    acordo = false, naoAcionar = false, statusAtual = "EM COBRANCA",
    giro = null, semCaso = false, casosExtras = 0,
  } = o;
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, saldo_total, status_atual, status_jornada)
     values ($1,$2,$3,$4,0,'EM COBRANCA','EM COBRANCA')`,
    [U(n), `Aluno ${n}`, CPF(n), String(n)]);

  if (!semCaso) {
    for (let i = 0; i <= casosExtras; i++) {
      await db.query(
        `insert into public.casos
           (id, aluno_id, nome, nome_aluno, cpf, cpf_limpo, chave_unificacao, operador_email, operador_nome,
            status_atual, status_acionamento, status_financeiro, status_jornada, nao_acionar, giro_fidelizacao_ate)
         values ($1,$2,$3,$3,$4,$4,$4,$5,'DONO',$6,'PENDENTE','EM ABERTO','EM COBRANCA',$7,$8)`,
        [U(n * 100 + i), U(n), `Aluno ${n}`, CPF(n), dono, statusAtual, naoAcionar, giro]);
    }
  }
  if (!sem2026) {
    const venc = semestre === "2026/1" ? "2026-03-10" : "2026-09-10";
    await db.query(
      `insert into public.acordos_titulos
         (id, aluno_id, cpf, situacao, status, acordo_id, vencimento, valor_original, valor_em_aberto)
       values ($1,$2,$3,'ABERTO','em_aberto',null,$4::date,$5,$5)`,
      [U(900000 + n), U(n), CPF(n), venc, valor]);
  }
  if (acordo) {
    await db.query(
      `insert into public.acordos (id, aluno_id, cpf, status, valor_total, saldo, qtd_parcelas,
         numero_acordo, operador_responsavel_email, operador_responsavel_nome)
       values ($1,$2,$3,'ATIVO',5000,5000,2,$4,'dono.financeiro@aelbra.com.br','DONO FINANCEIRO')`,
      [U(700000 + n), U(n), CPF(n), 9000 + n]);
    await db.query(
      `insert into public.acordos_titulos
         (id, aluno_id, cpf, situacao, status, acordo_id, vencimento, valor_original, valor_em_aberto, tipo_boleto)
       values ($1,$2,$3,'ABERTO','em_aberto',$4,'2026-09-15',3000,3000,'Acordo')`,
      [U(800000 + n), U(n), CPF(n), U(700000 + n)]);
    await db.query(
      `insert into public.acordo_titulo_vinculo (id, acordo_id, titulo_id, ativo)
       values ($1,$2,$3,true)`, [U(600000 + n), U(700000 + n), U(800000 + n)]);
    await db.query(
      `insert into public.parcelas (id, acordo_id, numero, valor, vencimento, status)
       values ($1,$2,1,2500,'2026-09-20','A_VENCER'), ($3,$2,2,2500,'2026-10-20','A_VENCER')`,
      [U(500000 + n), U(700000 + n), U(400000 + n)]);
  }
}

async function construir(comMigration = true) {
  const db = new PGlite({ extensions: ext });
  await db.exec(BASE);
  await db.exec(M3);
  await db.exec(COMPL);

  // PORTAO DE FIDELIDADE: se qualquer corpo divergir de producao, para aqui.
  const rows = await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries({ ...MD5_BASE, ...MD5_M3, ...MD5_COMPL })) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ('OP UM',   '${OP[0]}', 'operador', true,  'OP UM',   true),
      ('OP DOIS', '${OP[1]}', 'operador', true,  'OP DOIS', true),
      ('OP TRES', '${OP[2]}', 'operador', true,  'OP TRES', true),
      ('OLGA',    '${OLGA}',  'operador', false, 'OLGA',    false),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null, false);
    insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '700'::jsonb)
      on conflict (chave) do update set valor = excluded.valor;
  `);
  await como(db, GESTAO);
  if (comMigration) await db.exec(MIGRATION);
  return db;
}

let COM;
beforeAll(async () => {
  const db = await construir(true);
  COM = await db.dumpDataDir();
  await db.close();
});
const abrir = async () => {
  const db = new PGlite({ loadDataDir: COM, extensions: ext });
  await como(db, GESTAO);
  return db;
};

// ===========================================================================
describe("a bancada reproduz produção", () => {
  it("os corpos conferem por md5 (o portão já roda no beforeAll)", async () => {
    const db = await abrir();
    const m = await q1(db, `select md5(p.prosrc) x from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                             where n.nspname='public' and p.proname='calibragem_teto_operador'`);
    expect(m.x).toBe(MD5_COMPL["public.calibragem_teto_operador"]);
    await db.close();
  });
});

// ===========================================================================
describe("A SIMULAÇÃO NÃO MOVE NINGUÉM", () => {
  it("nenhuma linha de casos muda: dono, marca e impressão digital idênticos", async () => {
    const db = await abrir();
    for (let n = 1; n <= 9; n++) await aluno(db, n, { dono: CG, semestre: n % 2 ? "2026/1" : "2026/2" });
    const antes = await q1(db,
      `select count(*) n,
              md5(coalesce(string_agg(operador_email, ',' order by id),'')) donos,
              md5(coalesce(string_agg(coalesce(giro_fidelizacao_ate::text,'-'), ',' order by id),'')) marcas
         from public.casos`);
    const r = await simular(db);
    expect(r.total_movimentacoes).toBeGreaterThan(0);  // propôs movimentar
    const depois = await q1(db,
      `select count(*) n,
              md5(coalesce(string_agg(operador_email, ',' order by id),'')) donos,
              md5(coalesce(string_agg(coalesce(giro_fidelizacao_ate::text,'-'), ',' order by id),'')) marcas
         from public.casos`);
    expect(depois).toEqual(antes);                     // mas não movimentou NADA
    await db.close();
  });

  it("não toca acordos, alunos nem parcelas", async () => {
    const db = await abrir();
    for (let n = 11; n <= 16; n++) await aluno(db, n, { dono: CG, acordo: true });
    const foto = async () => q1(db,
      `select (select md5(coalesce(string_agg(operador_responsavel_email,',' order by id),'')) from public.acordos) ac,
              (select md5(coalesce(string_agg(coalesce(responsavel_atual_email,'-'),',' order by id),'')) from public.alunos) al,
              (select md5(coalesce(string_agg(status,',' order by id),'')) from public.parcelas) pa`);
    const antes = await foto();
    await simular(db);
    expect(await foto()).toEqual(antes);
    await db.close();
  });

  it("a única escrita é UMA linha RASCUNHO em calibragem_simulacoes", async () => {
    const db = await abrir();
    for (let n = 21; n <= 26; n++) await aluno(db, n, { dono: CG });
    const r = await simular(db);
    const s = await qn(db, "select id::text, status, resultado->>'metrica' metrica from public.calibragem_simulacoes");
    expect(s).toHaveLength(1);
    expect(s[0].status).toBe("RASCUNHO");
    expect(s[0].metrica).toBe("ONDA1_LOTE_A");
    expect(r.simulacao_id).toBe(s[0].id);
    await db.close();
  });
});

// ===========================================================================
describe("o recorte é o lote A, e só ele", () => {
  it("quem JÁ tem dono ativo fica de fora", async () => {
    const db = await abrir();
    await aluno(db, 31, { dono: CG });
    await aluno(db, 32, { dono: OP[0] });            // já na operação
    const r = await simular(db);
    expect(r.universo.lote_a_elegivel).toBe(1);
    expect(r.fora_da_onda.ja_tem_dono_ativo).toBe(1);
    expect(JSON.stringify(r.movimentacoes)).not.toMatch(/Aluno 32/);
    await db.close();
  });

  it("quem NÃO tem caso fica de fora — é o lote B", async () => {
    const db = await abrir();
    await aluno(db, 41, { dono: CG });
    await aluno(db, 42, { semCaso: true });
    const r = await simular(db);
    expect(r.universo.lote_a_elegivel).toBe(1);
    expect(r.fora_da_onda.sem_caso_lote_b).toBe(1);
    await db.close();
  });

  for (const [rotulo, extra] of [
    ["nao_acionar", { naoAcionar: true }],
    ["suspensão de cobrança", { statusAtual: "SUSPENSAO COBRANCA" }],
    ["marca de giro viva", { giro: "2099-12-31" }],
  ]) {
    it(`bloqueado por ${rotulo} fica de fora`, async () => {
      const db = await abrir();
      await aluno(db, 51, { dono: CG });
      await aluno(db, 52, { dono: CG, ...extra });
      const r = await simular(db);
      expect(r.universo.lote_a_elegivel).toBe(1);
      expect(r.fora_da_onda.bloqueado_ou_encerrado).toBe(1);
      await db.close();
    });
  }

  it("quem tem ACORDO vivo ENTRA — é a diferença para o giro de 16/10", async () => {
    const db = await abrir();
    await aluno(db, 61, { dono: CG, acordo: true });
    await aluno(db, 62, { dono: CG, acordo: true, sem2026: true }); // só acordo
    const r = await simular(db);
    expect(r.universo.lote_a_elegivel).toBe(2);
    const sac = r.depois.reduce((t, o) => t + Number(o.saldo_acordo), 0);
    expect(sac).toBeGreaterThan(0);
    await db.close();
  });

  it("caso da Olga (operadora INATIVA) entra: ela não é dono ativo", async () => {
    const db = await abrir();
    await aluno(db, 71, { dono: OLGA });
    const r = await simular(db);
    expect(r.universo.lote_a_elegivel).toBe(1);
    await db.close();
  });

  it("o saldo do acordo NÃO vira competência fictícia", async () => {
    const db = await abrir();
    await aluno(db, 81, { dono: CG, acordo: true, sem2026: true });
    const r = await simular(db);
    const t1 = r.depois.reduce((t, o) => t + Number(o.cpfs_2026_1), 0);
    const t2 = r.depois.reduce((t, o) => t + Number(o.cpfs_2026_2), 0);
    const sa = r.depois.reduce((t, o) => t + Number(o.cpfs_so_acordo), 0);
    expect(t1).toBe(0);
    expect(t2).toBe(0);
    expect(sa).toBe(1);
    await db.close();
  });
});

// ===========================================================================
describe("o equilíbrio por competência", () => {
  it("2026/2: diferença máxima de UM CPF entre operadores", async () => {
    const db = await abrir();
    for (let n = 100; n < 120; n++) await aluno(db, n, { dono: CG, semestre: "2026/2", valor: 100 + n });
    const r = await simular(db);
    const v = r.depois.map((o) => Number(o.cpfs_2026_2));
    expect(v.reduce((a, b) => a + b, 0)).toBe(20);
    expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(1);
    await db.close();
  });

  it("2026/1: diferença máxima de UM CPF entre operadores", async () => {
    const db = await abrir();
    for (let n = 130; n < 148; n++) await aluno(db, n, { dono: CG, semestre: "2026/1", valor: 200 + n });
    const r = await simular(db);
    const v = r.depois.map((o) => Number(o.cpfs_2026_1));
    expect(v.reduce((a, b) => a + b, 0)).toBe(18);
    expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(1);
    await db.close();
  });

  it("as duas competências juntas ficam equilibradas cada uma por si", async () => {
    const db = await abrir();
    for (let n = 160; n < 172; n++) await aluno(db, n, { dono: CG, semestre: "2026/1", valor: n });
    for (let n = 180; n < 198; n++) await aluno(db, n, { dono: CG, semestre: "2026/2", valor: n });
    const r = await simular(db);
    const a = r.depois.map((o) => Number(o.cpfs_2026_1));
    const b = r.depois.map((o) => Number(o.cpfs_2026_2));
    expect(Math.max(...a) - Math.min(...a)).toBeLessThanOrEqual(1);
    expect(Math.max(...b) - Math.min(...b)).toBeLessThanOrEqual(1);
    await db.close();
  });

  it("o valor é espalhado, não concentrado: a serpentina alterna os maiores", async () => {
    const db = await abrir();
    for (let n = 200; n < 212; n++) await aluno(db, n, { dono: CG, semestre: "2026/2", valor: (212 - n) * 1000 });
    const r = await simular(db);
    const s = r.depois.map((o) => Number(o.saldo_2026_2));
    const media = s.reduce((a, b) => a + b, 0) / s.length;
    // amplitude abaixo de 25% da media: sem serpentina daria mais de 100%.
    expect((Math.max(...s) - Math.min(...s)) / media).toBeLessThan(0.25);
    await db.close();
  });
});

// ===========================================================================
describe("teto, unicidade e permissão", () => {
  it("RECUSA antes de gravar se a distribuição passaria do teto", async () => {
    const db = await abrir();
    await db.exec("update public.calibragem_parametros set valor = '1'::jsonb where chave='limite_carteira'");
    for (let n = 220; n < 232; n++) await aluno(db, n, { dono: CG });
    await expect(db.query("select public.onda1_simular('{}'::jsonb)")).rejects.toThrow(/passaria do teto/i);
    expect(Number((await q1(db, "select count(*)::int n from public.calibragem_simulacoes")).n)).toBe(0);
    await db.close();
  });

  it("dentro do teto, grava e a folga sai no resultado", async () => {
    const db = await abrir();
    for (let n = 240; n < 246; n++) await aluno(db, n, { dono: CG });
    const r = await simular(db);
    for (const o of r.depois) {
      expect(Number(o.folga)).toBeGreaterThanOrEqual(0);
      expect(Number(o.casos_ativos) + Number(o.folga)).toBe(700);
    }
    await db.close();
  });

  it("responsável único por aluno: o BANCO nem deixa existir um segundo caso", async () => {
    // Descoberto ao escrever este teste: a base tem gatilho proprio que recusa
    // um segundo caso aberto para o mesmo aluno (ALUNO_JA_TEM_CASO_ABERTO).
    // Entao a unicidade do responsavel nao depende da Onda 1 -- ja esta
    // garantida uma camada abaixo. O teste passa a afirmar isso.
    const db = await abrir();
    await aluno(db, 250, { dono: CG });
    await expect(aluno(db, 250, { dono: CG })).rejects.toThrow(/ALUNO_JA_TEM_CASO_ABERTO|duplicate|unique/i);
    const r = await simular(db);
    const destinos = new Set(r.movimentacoes.map((m) => m.para_email));
    expect(r.movimentacoes).toHaveLength(1);
    expect(destinos.size).toBe(1);
    await db.close();
  });

  it("confirmação financeira aberta segura o caso, e isso aparece no resultado", async () => {
    const db = await abrir();
    await aluno(db, 252, { dono: CG });
    await aluno(db, 253, { dono: CG });
    await db.query(
      `insert into public.solicitacoes_confirmacao_pagamento (id, aluno_id, status)
       values ($1, $2, 'AGUARDANDO_CONFIRMACAO')`, [U(253253), U(253)]);
    const r = await simular(db);
    expect(r.universo.lote_a_elegivel).toBe(1);
    expect(r.fora_da_onda.confirmacao_financeira_aberta).toBe(1);
    expect(r.incluir_confirmacao_aberta).toBe(false);
    await db.close();
  });

  it("a gestão pode sobrepor a guarda da confirmação, e fica registrado no critério", async () => {
    const db = await abrir();
    await aluno(db, 254, { dono: CG });
    await db.query(
      `insert into public.solicitacoes_confirmacao_pagamento (id, aluno_id, status)
       values ($1, $2, 'AGUARDANDO_CONFIRMACAO')`, [U(254254), U(254)]);
    expect((await simular(db)).universo.lote_a_elegivel).toBe(0);
    const r = await simular(db, { incluir_confirmacao_aberta: true });
    expect(r.universo.lote_a_elegivel).toBe(1);
    expect(r.incluir_confirmacao_aberta).toBe(true);
    await db.close();
  });

  it("quem não é gestão e tem JWT é recusado", async () => {
    const db = await abrir();
    await aluno(db, 260, { dono: CG });
    await como(db, OP[0]);
    await expect(db.query("select public.onda1_simular('{}'::jsonb)")).rejects.toThrow(/sem permiss/i);
    await db.close();
  });

  it("semestre_metodo inválido é recusado", async () => {
    const db = await abrir();
    await expect(db.query(`select public.onda1_simular('{"semestre_metodo":"chute"}'::jsonb)`))
      .rejects.toThrow(/hibrido ou vencimento/i);
    await db.close();
  });
});

// ===========================================================================
describe("a migration mexe só no que diz", () => {
  it("não traz DDL de tabela/gatilho, nem DML de operação, nem agendamento", () => {
    const exec = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    for (const proibido of [
      "create table public.", "alter table public.", "drop table", "create trigger", "drop trigger",
      "update public.casos", "update public.acordos", "update public.alunos", "delete from",
      "truncate", "cron.schedule", "cron.alter_job", "cron.unschedule", "grant ", "revoke ",
    ]) {
      expect(exec).not.toContain(proibido);
    }
  });

  it("a única escrita declarada é o insert da simulação", () => {
    const exec = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    const inserts = (exec.match(/insert into/g) || []).length;
    expect(inserts).toBe(1);
    expect(exec).toContain("insert into public.calibragem_simulacoes");
  });

  it("nenhuma outra função teve o corpo alterado", async () => {
    const semM = await construir(false);
    const comM = await abrir();
    const corpos = async (db) => qn(db,
      `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal') and p.proname <> 'onda1_simular' order by 1`);
    expect(await corpos(comM)).toEqual(await corpos(semM));
    await semM.close(); await comM.close();
  });
});

// ===========================================================================
describe("idempotência e rollback", () => {
  it("aplicar a migration duas vezes não muda o corpo", async () => {
    const db = await abrir();
    const antes = (await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                  where n.nspname='public' and p.proname='onda1_simular'`)).m;
    await db.exec(MIGRATION);
    const depois = (await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                   where n.nspname='public' and p.proname='onda1_simular'`)).m;
    expect(depois).toBe(antes);
    await db.close();
  });

  it("o rollback remove a função e PRESERVA as simulações já gravadas", async () => {
    const db = await abrir();
    for (let n = 270; n < 276; n++) await aluno(db, n, { dono: CG });
    await simular(db);
    expect(Number((await q1(db, "select count(*)::int n from public.calibragem_simulacoes")).n)).toBe(1);
    await db.exec(ROLLBACK);
    const existe = await q1(db,
      `select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace
        where x.nspname='public' and p.proname='onda1_simular'`);
    expect(Number(existe.n)).toBe(0);
    // A trilha fica: apagar destruiria a prova de que a simulação não moveu nada.
    expect(Number((await q1(db, "select count(*)::int n from public.calibragem_simulacoes")).n)).toBe(1);
    await db.close();
  });

  it("depois do rollback a migration pode ser reaplicada", async () => {
    const db = await abrir();
    await db.exec(ROLLBACK);
    await db.exec(MIGRATION);
    await aluno(db, 280, { dono: CG });
    expect((await simular(db)).universo.lote_a_elegivel).toBe(1);
    await db.close();
  });
});
