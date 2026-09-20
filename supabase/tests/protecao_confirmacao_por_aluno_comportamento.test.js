// PROTECAO DE CONFIRMACAO FINANCEIRA ABERTA, POR ALUNO.
//
// Roda a migration REAL (20260920140000) e o rollback REAL num PostgreSQL real
// (PGlite) sobre a fixture protecao_confirmacao_prod_20260920: funcoes com o texto
// EXATO de producao (pg_get_functiondef de 20/09/2026), cada corpo conferido por
// md5 do prosrc. Nada de duble nas regras sob teste. Unicos stubs: auth.jwt(),
// auth.role() e sistema_sob_carga() (infraestrutura, nao regra).
//
// Compara ANTES (producao de hoje) x DEPOIS (com a migration) x ROLLBACK.
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

const FIXTURE = ler("supabase/tests/fixtures/protecao_confirmacao_prod_20260920.sql");
const MD5_PROD = JSON.parse(ler("supabase/tests/fixtures/protecao_confirmacao_prod_20260920.md5.json"));
const MIGRATION = ler("supabase/migrations/20260920140000_protecao_confirmacao_financeira_por_aluno.sql");
const ROLLBACK = ler("supabase/rollbacks/20260920140000_protecao_confirmacao_financeira_por_aluno.rollback.sql");

const OP = "cobranca05@aelbra.com.br";
const OP2 = "cobranca06@aelbra.com.br";
const GESTAO = "amanda.seibel@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(10000000000 + n); // 11 digitos, inventado
const ABERTAS = ["AGUARDANDO_CONFIRMACAO", "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO"];

let DUMP; // fixture verificada, sem migration
const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: { unaccent } });
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

async function montarBase() {
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
      ('Luana', '${OP}', 'operador', true),
      ('Mauricio', '${OP2}', 'operador', true),
      ('Amanda', '${GESTAO}', 'gestao', true);
  `);
  return db;
}

// aluno + caso + titulo em aberto vencido (saldo > 0).
async function cenario(db, n, { operador = null, statusAcion = null, sol = null, solCpf = null, vencido = "2025-01-10", cpf } = {}) {
  const c = cpf ?? CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, status_jornada, situacao_operacional, saldo_total, matricula)
     values ($1,$2,$3,'CONTATAR','COBRANCA_VENCIDA',500,$4)`,
    [U(n), c, `Aluno ${n}`, `M${n}`]
  );
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, operador_email, operador_nome, operador,
                               status_acionamento, total_em_aberto, chave_unificacao)
     values ($1,$2,$3,$3,$4,$5,$6,$7,$8,500,$9)`,
    [U(1000 + n), U(n), c, `Aluno ${n}`, operador, operador ? "X" : null, operador ? "X" : null, statusAcion, `chave-${n}`]
  );
  await db.query(
    `insert into public.acordos_titulos (id, aluno_id, cpf, situacao, status, saldo_corrigido, vencimento, tipo_boleto)
     values ($1,$2,$3,'ABERTO','em_aberto',500,$4,'Mensalidade')`,
    [U(2000 + n), U(n), c, vencido]
  );
  if (sol) {
    await db.query(
      `insert into public.solicitacoes_confirmacao_pagamento (aluno_id, aluno_cpf, status, motivo)
       values ($1,$2,$3,'TESTE')`,
      [U(n), solCpf, sol]
    );
  }
  return { aluno: U(n), caso: U(1000 + n), cpf: c };
}

const protegido = async (db, caso) =>
  (
    await q1(
      db,
      `select public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
              c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) p
         from public.casos c where c.id = $1`,
      [caso]
    )
  ).p;

async function comoOperador(db, email) {
  await db.query(`select set_config('test.jwt', $1, false)`, [JSON.stringify({ email })]);
}

async function hashTabelas(db) {
  const tabs = ["alunos", "casos", "parcelas", "acordos", "acordos_titulos", "solicitacoes_confirmacao_pagamento", "baixas_pagamento", "links_pagamento"];
  const out = {};
  for (const t of tabs) {
    out[t] = (await q1(db, `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.${t} x`)).h;
  }
  return out;
}

let ANTES;
let DEPOIS;

beforeAll(async () => {
  const base = await montarBase();
  DUMP = await base.dumpDataDir();
  await base.close();
  ANTES = await abrir(DUMP);
  DEPOIS = await abrir(DUMP);
  await DEPOIS.exec(MIGRATION);
});

describe("fixture e migration", () => {
  it("a fixture e alinhada a producao: 22 funcoes conferidas por md5", () => {
    expect(Object.keys(MD5_PROD).length).toBe(22);
    expect(MD5_PROD["public.caso_protegido_redistribuicao"]).toBe("11caab2c73df87ad68e801075bd95fe3");
    expect(MD5_PROD["public.nivelamento_automatico_gestao"]).toBe("af551b61fd4d419bc8a49ba8344b7f2c");
  });

  it("a migration e so funcoes: nenhum DML/DDL de dado", () => {
    const sem = MIGRATION.replace(/--.*$/gm, "").replace(/\$function\$[\s\S]*?\$function\$/g, "");
    expect(sem).not.toMatch(/\b(insert|update|delete|truncate|alter\s+table|drop\s+table|create\s+table)\b/i);
  });
});

describe("caso_protegido_redistribuicao -- confirmacao aberta por aluno", () => {
  for (const status of ABERTAS) {
    it(`A/B: ${status} com aluno_cpf NULO: ANTES nao protege, DEPOIS protege`, async () => {
      const n = 1 + ABERTAS.indexOf(status);
      const a = await cenario(ANTES, n, { sol: status });
      const d = await cenario(DEPOIS, n, { sol: status });
      expect(await protegido(ANTES, a.caso)).toBe(false); // o defeito de producao
      expect(await protegido(DEPOIS, d.caso)).toBe(true);
    });
  }

  it("C: confirmacao concluida/rejeitada/cancelada nao protege (comportamento normal)", async () => {
    let n = 10;
    for (const st of ["PAGAMENTO_CONFIRMADO", "PAGAMENTO_REJEITADO", "CANCELADO", "CONCLUIDA_SALDO_ZERO"]) {
      n += 1;
      const x = await cenario(DEPOIS, n, { sol: st });
      expect(await protegido(DEPOIS, x.caso)).toBe(false);
    }
  });

  it("D: aluno sem confirmacao: comportamento atual preservado (ANTES == DEPOIS)", async () => {
    const a = await cenario(ANTES, 20);
    const d = await cenario(DEPOIS, 20);
    expect(await protegido(ANTES, a.caso)).toBe(false);
    expect(await protegido(DEPOIS, d.caso)).toBe(false);
  });

  it("as demais protecoes seguem funcionando (status na lista, nao_acionar, acordo ativo)", async () => {
    const lista = await cenario(DEPOIS, 21, { statusAcion: "ACORDO FECHADO" });
    expect(await protegido(DEPOIS, lista.caso)).toBe(true);
    const nao = await cenario(DEPOIS, 22);
    await DEPOIS.query(`update public.casos set nao_acionar = true where id = $1`, [nao.caso]);
    expect(await protegido(DEPOIS, nao.caso)).toBe(true);
    const ac = await cenario(DEPOIS, 23);
    await DEPOIS.query(`insert into public.acordos (id, aluno_id, cpf, status) values ($1,$2,$3,'ATIVO')`, [U(3023), ac.aluno, ac.cpf]);
    expect(await protegido(DEPOIS, ac.caso)).toBe(true);
  });

  it("o teste antigo por aluno_cpf continua valendo (solicitacao com CPF preenchido)", async () => {
    const x = await cenario(ANTES, 24, { sol: "AGUARDANDO_CONFIRMACAO", solCpf: CPF(24) });
    const y = await cenario(DEPOIS, 24, { sol: "AGUARDANDO_CONFIRMACAO", solCpf: CPF(24) });
    expect(await protegido(ANTES, x.caso)).toBe(true);
    expect(await protegido(DEPOIS, y.caso)).toBe(true);
  });

  it("caso sem CPF utilizavel: nao explode e nao protege por engano", async () => {
    const x = await cenario(DEPOIS, 25, { sol: "AGUARDANDO_CONFIRMACAO", cpf: "00000000000" });
    expect(await protegido(DEPOIS, x.caso)).toBe(false);
  });

  it("CPF de ficha duplicada: a solicitacao de UMA das fichas protege o caso (falha para o lado seguro)", async () => {
    const x = await cenario(DEPOIS, 26, { sol: "AGUARDANDO_CONFIRMACAO", cpf: CPF(26) });
    await DEPOIS.query(
      `insert into public.alunos (id, cpf, nome, status_jornada, situacao_operacional, saldo_total) values ($1,$2,'Irma','CONTATAR','COBRANCA_VENCIDA',10)`,
      [U(9026), CPF(26)]
    );
    expect(await protegido(DEPOIS, x.caso)).toBe(true);
  });

  it("a funcao e STABLE, sem SECURITY DEFINER, com search_path=public (atributos de producao)", async () => {
    const r = await q1(
      DEPOIS,
      `select provolatile, prosecdef, proconfig::text cfg from pg_proc where proname='caso_protegido_redistribuicao'`
    );
    expect(r.provolatile).toBe("s");
    expect(r.prosecdef).toBe(false);
    expect(r.cfg).toContain("search_path=public");
  });
});

describe("E: assumir_caso_livre -- 5 casos assumiveis viram 0", () => {
  async function cinco(db, base) {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await cenario(db, base + i, { sol: i === 4 ? "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO" : "AGUARDANDO_CONFIRMACAO" }));
    return ids;
  }
  async function tentar(db, ids) {
    await comoOperador(db, OP);
    const r = [];
    for (const x of ids) {
      const linha = await q1(db, `select * from public.assumir_caso_livre($1)`, [x.caso]);
      r.push(linha.sucesso ? true : `nao: ${linha.mensagem}`);
    }
    return r;
  }

  it("ANTES: 5 assumiveis; DEPOIS: 0; e o caso sem confirmacao continua assumivel", async () => {
    const a = await cinco(ANTES, 100);
    const d = await cinco(DEPOIS, 100);
    const controleA = await cenario(ANTES, 110);
    const controleD = await cenario(DEPOIS, 110);
    expect(await tentar(ANTES, a)).toEqual([true, true, true, true, true]);
    expect((await tentar(DEPOIS, d)).filter((x) => x === true).length).toBe(0);
    expect((await tentar(ANTES, [controleA]))[0]).toBe(true);
    expect((await tentar(DEPOIS, [controleD]))[0]).toBe(true);
    // nenhum caso protegido mudou de responsavel
    const dono = await qn(DEPOIS, `select operador_email from public.casos where id = any($1)`, [d.map((x) => x.caso)]);
    expect(dono.every((r) => r.operador_email === null)).toBe(true);
  });

  it("assumir_caso_livre_aluno: o predicado de elegibilidade passa de 1 para 0 e a funcao real recusa", async () => {
    const d = await cenario(DEPOIS, 120, { sol: "AGUARDANDO_CONFIRMACAO" });
    const a = await cenario(ANTES, 120, { sol: "AGUARDANDO_CONFIRMACAO" });
    // o mesmo `select` de elegibilidade que a funcao usa (assumir_caso_livre_aluno)
    const elegiveis = (db, aluno) =>
      q1(
        db,
        `select count(*)::int n from public.casos c
          where c.aluno_id = $1 and c.operador_email is null
            and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
            and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
            and public.saldo_titulos_aberto(c.cpf_limpo) > 0`,
        [aluno]
      );
    expect((await elegiveis(ANTES, a.aluno)).n).toBe(1);
    expect((await elegiveis(DEPOIS, d.aluno)).n).toBe(0);
    await comoOperador(DEPOIS, OP);
    const r = await q1(DEPOIS, `select * from public.assumir_caso_livre_aluno($1)`, [d.aluno]);
    expect(Object.values(r)[0]).toBe(false);
  });
});

describe("F: reposicao_carteira_processar (funcao real, cron segue desligado em producao)", () => {
  async function rodar(db) {
    const abertos = [];
    for (let i = 0; i < 5; i++) abertos.push(await cenario(db, 200 + i, { sol: i === 4 ? "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO" : "AGUARDANDO_CONFIRMACAO" }));
    const livres = [];
    for (let i = 0; i < 3; i++) livres.push(await cenario(db, 210 + i));
    await db.query(
      `insert into public.reposicao_carteira_fila (operador_email, operador_nome, operador_upper, tipo, caso_origem_id)
       values ($1,'Luana','LUANA','FECHADO',$2)`,
      [OP, U(999)]
    );
    await q1(db, `select public.reposicao_carteira_processar(10)`);
    const com = async (xs) => (await qn(db, `select id from public.casos where id = any($1) and operador_email = $2`, [xs.map((x) => x.caso), OP])).length;
    return { abertos: await com(abertos), livres: await com(livres) };
  }

  it("ANTES: os 5 com confirmacao aberta seriam repostos; DEPOIS: 0; os 3 livres seguem", async () => {
    const a = await rodar(ANTES);
    const d = await rodar(DEPOIS);
    expect(a).toEqual({ abertos: 5, livres: 3 });
    expect(d).toEqual({ abertos: 0, livres: 3 });
  });
});

describe("nivelamento_automatico_gestao (funcao real) -- dependencia de aluno_cpf eliminada", () => {
  async function rodar(db, aplicar, b = 300) {
    await db.query(`select set_config('test.jwt', '', false)`); // auth.jwt() nulo = contexto de sistema (como o cron)
    // base da gestao: 1 caso normal (controle) + 2 com confirmacao aberta (um por estado)
    const ctl = await cenario(db, b, { operador: GESTAO });
    const c1 = await cenario(db, b + 1, { operador: GESTAO, sol: "AGUARDANDO_CONFIRMACAO" });
    const c2 = await cenario(db, b + 2, { operador: GESTAO, sol: "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO" });
    const r = await q1(db, `select public.nivelamento_automatico_gestao(10, $1) r`, [aplicar]);
    const donos = await qn(db, `select id, operador_email from public.casos where id = any($1)`, [[ctl.caso, c1.caso, c2.caso]]);
    return { res: r.r, donos: Object.fromEntries(donos.map((d) => [d.id, d.operador_email])), ids: { ctl: ctl.caso, c1: c1.caso, c2: c2.caso } };
  }

  it("simulacao: ANTES 3 elegiveis (defeito); DEPOIS 1 (so o controle)", async () => {
    const a = await rodar(ANTES, false);
    const d = await rodar(DEPOIS, false);
    expect(a.res.elegiveis).toBe(3);
    expect(d.res.elegiveis).toBe(1);
  });

  it("aplicando: DEPOIS os casos com confirmacao ficam na gestao e so o controle se move", async () => {
    const d = await rodar(DEPOIS, true, 320);
    expect(d.res.movidos).toBeGreaterThanOrEqual(1); // o controle (e o da simulacao anterior, ainda na gestao)
    expect(d.donos[d.ids.ctl]).not.toBe(GESTAO);
    const presos = await qn(
      DEPOIS,
      `select c.id from public.casos c
        where c.operador_email = $1
          and exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = c.aluno_id::text and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))`,
      [GESTAO]
    );
    expect(presos.length).toBeGreaterThanOrEqual(2); // nenhum caso com confirmacao aberta saiu da gestao
    expect(d.donos[d.ids.c1]).toBe(GESTAO);
    expect(d.donos[d.ids.c2]).toBe(GESTAO);
  });
});

describe("gatilhos reais: abrir a confirmacao nao solta o operador", () => {
  it("caso com operador + confirmacao criada: o responsavel continua (ANTES e DEPOIS)", async () => {
    for (const [nome, db] of [["antes", ANTES], ["depois", DEPOIS]]) {
      const x = await cenario(db, 400, { operador: OP });
      await db.query(
        `insert into public.solicitacoes_confirmacao_pagamento (aluno_id, status, motivo) values ($1,'AGUARDANDO_CONFIRMACAO','TESTE')`,
        [x.aluno]
      );
      const r = await q1(db, `select operador_email, status_acionamento from public.casos where id = $1`, [x.caso]);
      expect(r.operador_email, nome).toBe(OP);
      const fila = await q1(db, `select count(*)::int n from public.reposicao_carteira_fila where caso_origem_id = $1`, [x.caso]);
      expect(fila.n, nome).toBe(0);
    }
  });
});

describe("J, K, L, M: a protecao nao escreve em nada", () => {
  it("chamar a regra em todos os casos e a simulacao do nivelamento nao altera nenhuma tabela", async () => {
    const db = DEPOIS;
    await cenario(db, 500, { operador: OP, sol: "AGUARDANDO_CONFIRMACAO" });
    await cenario(db, 501, { sol: "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO" });
    await cenario(db, 502, { operador: GESTAO });
    const antes = await hashTabelas(db);
    await qn(
      db,
      `select public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro,
              c.valor_pago, c.quitado_em, c.valor_quitado) from public.casos c`
    );
    await q1(db, `select public.nivelamento_automatico_gestao(10, false)`);
    await q1(db, `select public.alunos_em_confirmacao_pendente()`);
    expect(await hashTabelas(db)).toEqual(antes);
  });

  it("responsavel, fidelizacao (data_ultimo_acionamento), retorno e agenda de um caso protegido ficam intactos", async () => {
    const x = await cenario(DEPOIS, 510, { operador: OP, sol: "AGUARDANDO_CONFIRMACAO" });
    const ler = () =>
      q1(
        DEPOIS,
        `select operador_email, data_ultimo_acionamento, data_retorno, proxima_acao_automatica, data_retorno_nova, hora_retorno
           from public.casos where id = $1`,
        [x.caso]
      );
    const antes = await ler();
    await protegido(DEPOIS, x.caso);
    expect(await ler()).toEqual(antes);
  });
});

describe("rollback restaura EXATAMENTE a producao", () => {
  it("apos o rollback: md5 do pg_get_functiondef das duas funcoes == producao e o defeito volta", async () => {
    const db = abrir(DUMP);
    await db.exec(MIGRATION);
    const dep = await cenario(db, 600, { sol: "AGUARDANDO_CONFIRMACAO" });
    expect(await protegido(db, dep.caso)).toBe(true);
    await db.exec(ROLLBACK);
    const md5 = async (assinatura) =>
      (await q1(db, `select md5(pg_get_functiondef($1::regprocedure)) m`, [assinatura])).m;
    expect(await md5("public.caso_protegido_redistribuicao(text,text,boolean,text,numeric,date,numeric)")).toBe("c497631ffeec5e06bce6ddcc974af48b");
    expect(await md5("public.nivelamento_automatico_gestao(integer,boolean,text[])")).toBe("7ae72fea9af90386aee288c189f9f12a");
    expect(await protegido(db, dep.caso)).toBe(false);
    await db.close();
  });
});
