// FIDELIZACAO DE 10 DIAS: OS CAMINHOS AUTOMATICOS QUE RETIRAM CASO DE OPERADOR.
//
// Roda as migrations REAIS (20260929101500 e 20260929101600) e os rollbacks
// REAIS num PostgreSQL real (PGlite) sobre duas fixtures com o texto EXATO de
// producao, conferido por md5 do prosrc: protecao_confirmacao_prod_20260920
// (tabelas + auxiliares) e calibragem_fidelizacao/prod_20260928 (as funcoes de
// fidelizacao, nivelamento e giro, com o texto de hoje).
//
// Unicos dubles: auth.jwt() e exigir_capacidade() -- nenhum dos dois e regra.
// Compara ANTES (producao de hoje) x DEPOIS x ROLLBACK.
// NENHUM DADO REAL: CPFs, nomes e valores sao inventados.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 240000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE_BASE = ler("supabase/tests/fixtures/protecao_confirmacao_prod_20260920.sql");
const FIXTURE_CAL = ler("supabase/tests/fixtures/calibragem_fidelizacao/prod_20260928.sql");
const MD5_PROD = JSON.parse(ler("supabase/tests/fixtures/calibragem_fidelizacao/prod_20260928.md5.json"));
const MIG_FIDEL = ler("supabase/migrations/20260929101500_fidelizacao_10_dias_fechar_caminhos_automaticos.sql");
const MIG_GIRO = ler("supabase/migrations/20260929101600_giro_2026_desativar_execucao.sql");
const RB_FIDEL = ler("supabase/rollbacks/20260929101500_fidelizacao_10_dias_fechar_caminhos_automaticos.rollback.sql");
const RB_GIRO = ler("supabase/rollbacks/20260929101600_giro_2026_desativar_execucao.rollback.sql");

const OP_A = "cobranca01@aelbra.com.br";
const OP_B = "cobranca02@aelbra.com.br";
const GESTAO = "amanda.seibel@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(10000000000 + n);

const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: { unaccent } });
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

let DUMP;

async function montarBase() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE_BASE);
  await db.exec(FIXTURE_CAL);
  const rows = await qn(
    db,
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
      ('Ana', '${OP_A}', 'operador', true),
      ('Bruno', '${OP_B}', 'operador', true),
      ('Amanda', '${GESTAO}', 'gestao', true);
  `);
  return db;
}

// aluno + caso + titulo vencido em aberto (a view calibragem_saldo_aluno le dai).
// dias = dias desde o ultimo acionamento; null = nunca acionado.
async function caso(db, n, { dono = OP_A, dias = null } = {}) {
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, status_jornada, situacao_operacional, saldo_total, matricula,
                                responsavel_atual_email, responsavel_atual_em)
     values ($1,$2,$3,'CONTATAR','COBRANCA_VENCIDA',500,$4,$5, now() - interval '5 days')`,
    [U(n), cpf, `Aluno ${n}`, `M${n}`, dono]
  );
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome, operador,
                               total_em_aberto, caso_atualizado_em, data_ultimo_acionamento)
     values ($1,$2,$3,$3,$4,$5,$6,$7,$8,500, now() - interval '5 days',
             case when $9::int is null then null else (current_date - $9::int) end)`,
    [U(1000 + n), U(n), cpf, `Aluno ${n}`, `chave-${n}`, dono, dono ? "X" : null, dono ? "X" : null, dias]
  );
  await db.query(
    `insert into public.acordos_titulos (id, aluno_id, cpf, situacao, status, saldo_corrigido, vencimento, tipo_boleto)
     values ($1,$2,$3,'ABERTO','em_aberto',500,'2026-03-10','Mensalidade')`,
    [U(2000 + n), U(n), cpf]
  );
  return { aluno: U(n), caso: U(1000 + n), cpf };
}

const dono = async (db, casoId) => (await q1(db, `select operador_email from public.casos where id=$1`, [casoId])).operador_email;
const acionarHoje = (db, casoId) =>
  db.query(`update public.casos set data_ultimo_acionamento = current_date where id=$1`, [casoId]);
const soltar = async (db, casoId) => (await q1(db, `select public.liberar_fidelizacao_caso($1) r`, [casoId])).r;

async function nivelarGestao(db) {
  return (await q1(db, `select public.nivelamento_automatico_gestao(10, true, array[$1::text]) r`, [GESTAO])).r;
}

async function nivelarComSimulacaoForjada(db, movs) {
  const { id } = await q1(
    db,
    `insert into public.calibragem_simulacoes (criterios, resultado, status)
     values ('{}'::jsonb, jsonb_build_object('metrica','SALDO','movimentacoes',$1::jsonb), 'APROVADA')
     returning id`,
    [JSON.stringify(movs)]
  );
  return (await q1(db, `select public.calibragem_executar_simulacao($1) r`, [id])).r;
}

const defs = async (db) =>
  Object.fromEntries(
    (
      await qn(
        db,
        `select n.nspname||'.'||p.proname nome, md5(pg_get_functiondef(p.oid)) m
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname in ('public','internal') and p.prokind='f'
            and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
          order by 1`
      )
    ).map((r) => [r.nome, r.m])
  );

const acl = async (db) =>
  qn(
    db,
    `select n.nspname||'.'||p.proname nome, coalesce(array_to_string(p.proacl,'|'),'') acl
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','internal') and p.prokind='f' order by 1`
  );

beforeAll(async () => {
  const base = await montarBase();
  DUMP = await base.dumpDataDir();
  await base.close();
});

const novo = async ({ migrations = [MIG_FIDEL, MIG_GIRO] } = {}) => {
  const db = abrir(DUMP);
  for (const m of migrations) await db.exec(m);
  return db;
};

// ---------------------------------------------------------------------------
describe("fixture", () => {
  it("19 funcoes conferidas por md5 do prosrc contra producao", async () => {
    expect(Object.keys(MD5_PROD).length).toBe(19);
    const db = abrir(DUMP);
    const rows = await qn(db, `select n.nspname||'.'||p.proname nome, md5(p.prosrc) m
                                 from pg_proc p join pg_namespace n on n.oid=p.pronamespace`);
    const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.m]));
    for (const [nome, m] of Object.entries(MD5_PROD)) expect([nome, noBanco[nome]]).toEqual([nome, m]);
    await db.close();
  });

  it("a regua: 0, 9 e 10 dias estao dentro do prazo; 11 e nunca acionado estao fora", async () => {
    const db = abrir(DUMP);
    const r = await q1(
      db,
      `select public.caso_dentro_prazo_fidelizacao(current_date) d0,
              public.caso_dentro_prazo_fidelizacao(current_date - 9) d9,
              public.caso_dentro_prazo_fidelizacao(current_date - 10) d10,
              public.caso_dentro_prazo_fidelizacao(current_date - 11) d11,
              public.caso_dentro_prazo_fidelizacao(null) dnull`
    );
    expect(r).toEqual({ d0: true, d9: true, d10: true, d11: false, dnull: false });
    await db.close();
  });
});

describe("ANTES (producao de hoje): o furo existe", () => {
  it("liberar_fidelizacao_caso solta um caso acionado HOJE", async () => {
    const db = await novo({ migrations: [] });
    const c = await caso(db, 1, { dias: 0 });
    expect(await soltar(db, c.caso)).toBe(true);
    expect(await dono(db, c.caso)).toBe(null);
    await db.close();
  });

  it("o nivelamento diario da gestao leva um caso acionado HOJE", async () => {
    const db = await novo({ migrations: [] });
    const c = await caso(db, 2, { dono: GESTAO, dias: 0 });
    const r = await nivelarGestao(db);
    expect(r.movidos).toBe(1);
    expect(await dono(db, c.caso)).not.toBe(GESTAO);
    await db.close();
  });
});

describe("liberar_fidelizacao_caso (ponta do cron das 08:20)", () => {
  it("nao solta com 0, 9 e 10 dias; solta no 11o dia e quem nunca foi acionado", async () => {
    const db = await novo();
    const casos = {
      d0: await caso(db, 1, { dias: 0 }),
      d9: await caso(db, 2, { dias: 9 }),
      d10: await caso(db, 3, { dias: 10 }),
      d11: await caso(db, 4, { dias: 11 }),
      nunca: await caso(db, 5, { dias: null }),
    };
    expect(await soltar(db, casos.d0.caso)).toBe(false);
    expect(await soltar(db, casos.d9.caso)).toBe(false);
    expect(await soltar(db, casos.d10.caso)).toBe(false);
    expect(await soltar(db, casos.d11.caso)).toBe(true);
    expect(await soltar(db, casos.nunca.caso)).toBe(true);
    expect(await dono(db, casos.d0.caso)).toBe(OP_A);
    expect(await dono(db, casos.d9.caso)).toBe(OP_A);
    expect(await dono(db, casos.d10.caso)).toBe(OP_A);
    expect(await dono(db, casos.d11.caso)).toBe(null);
    expect(await dono(db, casos.nunca.caso)).toBe(null);
    await db.close();
  });

  it("acionamento novo REINICIA a janela: quem ia sair no 11o dia deixa de sair", async () => {
    const db = await novo();
    const c = await caso(db, 6, { dias: 11 });
    await acionarHoje(db, c.caso);
    expect(await soltar(db, c.caso)).toBe(false);
    expect(await dono(db, c.caso)).toBe(OP_A);
    // e o lote tambem nao o enxerga mais
    const lote = await q1(db, `select public.liberar_casos_fidelizacao_vencida() n`);
    expect(lote.n).toBe(0);
    expect(await dono(db, c.caso)).toBe(OP_A);
    await db.close();
  });

  it("o lote do cron solta so o 11o dia e o nunca acionado", async () => {
    const db = await novo();
    const d10 = await caso(db, 7, { dias: 10 });
    const d11 = await caso(db, 8, { dias: 11 });
    const nunca = await caso(db, 9, { dias: null });
    const lote = await q1(db, `select public.liberar_casos_fidelizacao_vencida() n`);
    expect(lote.n).toBe(2);
    expect(await dono(db, d10.caso)).toBe(OP_A);
    expect(await dono(db, d11.caso)).toBe(null);
    expect(await dono(db, nunca.caso)).toBe(null);
    await db.close();
  });
});

describe("nivelamento_automatico_gestao (cron diario das 09:20)", () => {
  it("nao leva com 0, 9 e 10 dias; leva no 11o dia e quem nunca foi acionado", async () => {
    const db = await novo();
    const d0 = await caso(db, 1, { dono: GESTAO, dias: 0 });
    const d9 = await caso(db, 2, { dono: GESTAO, dias: 9 });
    const d10 = await caso(db, 3, { dono: GESTAO, dias: 10 });
    const d11 = await caso(db, 4, { dono: GESTAO, dias: 11 });
    const nunca = await caso(db, 5, { dono: GESTAO, dias: null });
    const r = await nivelarGestao(db);
    expect([r.elegiveis, r.movidos]).toEqual([2, 2]);
    expect(await dono(db, d0.caso)).toBe(GESTAO);
    expect(await dono(db, d9.caso)).toBe(GESTAO);
    expect(await dono(db, d10.caso)).toBe(GESTAO);
    expect(await dono(db, d11.caso)).not.toBe(GESTAO);
    expect(await dono(db, nunca.caso)).not.toBe(GESTAO);
    await db.close();
  });

  it("acionamento novo REINICIA a janela tambem aqui", async () => {
    const db = await novo();
    const c = await caso(db, 6, { dono: GESTAO, dias: 11 });
    await acionarHoje(db, c.caso);
    const r = await nivelarGestao(db);
    expect([r.elegiveis, r.movidos]).toEqual([0, 0]);
    expect(await dono(db, c.caso)).toBe(GESTAO);
    await db.close();
  });
});

describe("GIRO_2026 desativado", () => {
  it("simular e executar recusam a chamada, com motivo", async () => {
    const db = await novo();
    await expect(db.query(`select public.calibragem_simular_giro_2026('{"ano":2026}'::jsonb)`)).rejects.toThrow(
      /Giro de carteira desativado/
    );
    const { id } = await q1(
      db,
      `insert into public.calibragem_simulacoes (criterios, resultado, status)
       values ('{}'::jsonb, jsonb_build_object('metrica','GIRO_2026','movimentacoes','[]'::jsonb), 'APROVADA') returning id`
    );
    await expect(db.query(`select public.calibragem_executar_giro_lote_impl($1, 500)`, [id])).rejects.toThrow(
      /Giro de carteira desativado/
    );
    await expect(db.query(`select public.calibragem_executar_giro_lote($1, 500)`, [id])).rejects.toThrow(
      /Giro de carteira desativado/
    );
    await db.close();
  });

  it("a recusa nao toca no historico: simulacoes, auditoria e casos ficam como estavam", async () => {
    const db = await novo();
    const c = await caso(db, 10, { dias: 30 });
    const { id } = await q1(
      db,
      `insert into public.calibragem_simulacoes (criterios, resultado, status, executado_em)
       values ('{}'::jsonb, jsonb_build_object('metrica','GIRO_2026','movimentacoes','[]'::jsonb), 'EXECUTADA', now()) returning id`
    );
    await db.query(
      `insert into public.calibragem_auditoria (evento, simulacao_id, caso_id, regra)
       values ('MOVIMENTACAO_NIVELAMENTO', $1, $2, 'GIRO_2026')`,
      [id, c.caso]
    );
    const antes = await q1(
      db,
      `select (select count(*) from public.calibragem_simulacoes) s,
              (select count(*) from public.calibragem_auditoria) a,
              (select status from public.calibragem_simulacoes where id=$1) st`,
      [id]
    );
    await expect(db.query(`select public.calibragem_executar_giro_lote_impl($1, 500)`, [id])).rejects.toThrow();
    const depois = await q1(
      db,
      `select (select count(*) from public.calibragem_simulacoes) s,
              (select count(*) from public.calibragem_auditoria) a,
              (select status from public.calibragem_simulacoes where id=$1) st`,
      [id]
    );
    expect(depois).toEqual(antes);
    expect(await dono(db, c.caso)).toBe(OP_A);
    await db.close();
  });
});

describe("REGRESSAO", () => {
  it("o nivelamento da calibragem continua bloqueando fidelizado e movendo o 11o dia -- igual antes e depois", async () => {
    for (const migrations of [[], [MIG_FIDEL, MIG_GIRO]]) {
      const db = await novo({ migrations });
      const dentro = await caso(db, 11, { dias: 2 });
      const fora = await caso(db, 12, { dias: 11 });
      const r = await nivelarComSimulacaoForjada(db, [
        { caso_id: dentro.caso, cpf: dentro.cpf, nome: "A11", valor: 500, de_email: OP_A, de_nome: "Ana", para_email: OP_B, para_nome: "Bruno", motivo: "n" },
        { caso_id: fora.caso, cpf: fora.cpf, nome: "A12", valor: 500, de_email: OP_A, de_nome: "Ana", para_email: OP_B, para_nome: "Bruno", motivo: "n" },
      ]);
      expect([migrations.length, r.executados, r.pulados]).toEqual([migrations.length, 1, 1]);
      expect(await dono(db, dentro.caso)).toBe(OP_A);
      expect(await dono(db, fora.caso)).toBe(OP_B);
      await db.close();
    }
  });

  it("as duas migrations mudam o texto de EXATAMENTE 4 funcoes; o resto fica byte a byte igual", async () => {
    const antes = abrir(DUMP);
    const depois = await novo();
    const a = await defs(antes);
    const d = await defs(depois);
    expect(Object.keys(d).sort()).toEqual(Object.keys(a).sort());
    expect(Object.keys(a).filter((k) => a[k] !== d[k]).sort()).toEqual([
      "public.calibragem_executar_giro_lote_impl",
      "public.calibragem_simular_giro_2026",
      "public.liberar_fidelizacao_caso",
      "public.nivelamento_automatico_gestao",
    ]);
    await antes.close();
    await depois.close();
  });

  it("acordos ficam INTOCADOS neste PR", async () => {
    const antes = abrir(DUMP);
    const depois = await novo();
    const a = await defs(antes);
    const d = await defs(depois);
    for (const f of ["public.calibragem_executar_acordos"]) expect([f, d[f]]).toEqual([f, a[f]]);
    expect(MIG_FIDEL + MIG_GIRO).not.toMatch(/executar_acordos|operador_responsavel_email/);
    await antes.close();
    await depois.close();
  });

  it("nenhuma migration mexe em ACL, score, teto, prioridade ou protecao financeira", async () => {
    const semComentario = (t) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const m of [MIG_FIDEL, MIG_GIRO]) {
      const sql = semComentario(m);
      expect(sql).not.toMatch(/\bgrant\b|\brevoke\b|\balter\s+default\s+privileges\b/i);
      expect(sql).not.toMatch(/\bdrop\s+function\b|\bdelete\s+from\b|\btruncate\b/i);
      expect(sql).not.toMatch(/criticidade|score|teto|prioridade|caso_protegido_redistribuicao/i);
      expect(sql).not.toMatch(/\+\s*10\b/); // nenhuma copia inline da regra dos 10 dias
    }
    expect(semComentario(MIG_FIDEL)).toMatch(/caso_dentro_prazo_fidelizacao/);
    const antes = abrir(DUMP);
    const depois = await novo();
    expect(await acl(depois)).toEqual(await acl(antes));
    await antes.close();
    await depois.close();
  });

  it("as migrations sao idempotentes: rodar duas vezes nao muda mais nada", async () => {
    const db = await novo();
    const a = await defs(db);
    await db.exec(MIG_FIDEL);
    await db.exec(MIG_GIRO);
    expect(await defs(db)).toEqual(a);
    await db.close();
  });

  it("os rollbacks devolvem o texto de producao das 4 funcoes", async () => {
    const base = abrir(DUMP);
    const db = await novo();
    await db.exec(RB_FIDEL);
    await db.exec(RB_GIRO);
    const a = await defs(base);
    const d = await defs(db);
    expect(Object.keys(a).filter((k) => a[k] !== d[k])).toEqual([]);
    await base.close();
    await db.close();
  });
});
