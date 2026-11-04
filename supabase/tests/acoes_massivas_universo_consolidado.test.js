// ACOES MASSIVAS: UNIVERSO CONSOLIDADO (giro #682, retorno do operador #685, responsaveis, guard #775 e evidencia v2).
//
// PostgreSQL real (PGlite), em memoria, dados sinteticos. Nao conecta a producao.
// 37 verificacoes: 31 do universo consolidado e 6 da pre-condicao MD5 e do rollback.
//
// A migration e o rollback validados sao lidos do repositorio, sem alteracao:
//   supabase/migrations/20261029183847_acoes_massivas_universo_consolidado_v2.sql
//   supabase/rollbacks/20261029183847_acoes_massivas_universo_consolidado_v2.rollback.sql
// As fixtures em supabase/tests/fixtures/acoes_massivas_universo_consolidado/ sao:
//   setup_base.sql      dependencias de tabelas e funcoes
//   definicao_viva.sql  definicao exportada de producao (MD5 88ec923f...)
//   definicao_19_10.sql definicao do corpo de 19/10 (MD5 da prosrc f49209f6...)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// PGlite inicializa em alguns segundos; o limite padrao de 5s derrubava os testes de forma intermitente.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { PGlite } from '@electric-sql/pglite';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const ler = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SETUP = ler('fixtures/acoes_massivas_universo_consolidado/setup_base.sql');
const DEF_VIVA = ler('fixtures/acoes_massivas_universo_consolidado/definicao_viva.sql');
const DEF_1910 = ler('fixtures/acoes_massivas_universo_consolidado/definicao_19_10.sql');
const MIGRACAO = ler('../migrations/20261029183847_acoes_massivas_universo_consolidado_v2.sql');
const ROLLBACK = ler('../rollbacks/20261029183847_acoes_massivas_universo_consolidado_v2.rollback.sql');

const MD5_VIVA = '88ec923f40294febcd4376491102b37d';
const MD5_PROSRC_1910 = 'f49209f6358dc9b0c22199c455d6d87d';

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const L = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11, L: 12, M: 13, N: 14 };
const REMOVIDOS = ['B', 'C', 'D', 'E', 'F', 'G'];
const FILTROS = [
  ['{}', 'padrao'],
  ['{"tipo_cobranca":"ACORDOS_VENCIDOS"}', 'ACORDOS_VENCIDOS'],
  ['{"tipo_cobranca":"MENSALIDADES_E_ACORDOS"}', 'MENSALIDADES_E_ACORDOS'],
  ['{"tipo_cobranca":"MENSALIDADES"}', 'MENSALIDADES'],
  ['{"responsaveis_caso":["op1@x.test"]}', 'resp_op1'],
  ['{"responsaveis_caso":["op2@x.test"]}', 'resp_op2'],
];
const norm = (x) => JSON.stringify(x, (k, v) => (v === undefined ? null : v));
const nomeDe = (id) => Object.keys(L).find((k) => U(L[k]) === id);
const md5def = async (db) =>
  (await db.query("select md5(pg_get_functiondef('public.acoes_massivas_universo(jsonb)'::regprocedure)) as h")).rows[0].h;

async function montar(definicao) {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec('create extension if not exists unaccent;');
  await db.exec(SETUP);
  await db.exec(definicao);
  await db.exec(`do $$ declare r record; begin for r in select table_name, column_name from information_schema.columns where table_schema='public' loop execute format('alter table public.%I alter column %I drop not null', r.table_name, r.column_name); end loop; end $$;`);
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated","email":"amanda.seibel@aelbra.com.br"}', false)`);
  return db;
}

async function dados(db) {
  for (const k of Object.keys(L)) {
    await db.query(
      `insert into alunos (id, cpf, nome, responsavel_atual_email, retorno_origem, data_retorno) values ($1,$2,$3,$4,$5,$6)`,
      [U(L[k]), '000' + L[k], 'SINTETICO ' + k, k === 'N' ? 'op1@x.test' : null, k === 'M' ? 'OPERADOR' : null, k === 'M' ? '2099-01-01' : null],
    );
    await db.query(
      `insert into acordos (id, aluno_id, status, saldo, valor_total, qtd_parcelas) values ($1,$2,'ATIVO',$3,100,1)`,
      [U(100 + L[k]), U(L[k]), k === 'B' ? 0 : 100],
    );
  }
  const par = (k, n, venc, boleto, st = 'VENCIDA', reneg = null) =>
    db.query(
      `insert into parcelas (id, acordo_id, valor, vencimento, status, boleto, renegociada_no_acordo_id) values ($1,$2,100,$3,$4,$5,$6)`,
      [U(1000 + L[k] * 10 + n), U(100 + L[k]), venc, st, boleto, reneg],
    );
  const tit = (id, aluno, doc, sit, st, v, venc) =>
    db.query(
      `insert into acordos_titulos (id, aluno_id, documento, situacao, status, tipo_boleto, valor_original, valor_em_aberto, saldo_corrigido, valor_cobranca_ajustado, vencimento) values ($1,$2,$3,$4,$5,'Mensalidade',$6,$6,$6,$6,$7)`,
      [U(id), U(aluno), doc, sit, st, v, venc],
    );
  const pag = (id, aluno, boleto) =>
    db.query(`insert into pagamentos (id, aluno_id, numero_parcela_completo, titulo_numero) values ($1,$2,$3,null)`, [U(id), U(aluno), boleto]);
  const caso = (id, aluno, total, giro = null) =>
    db.query(`insert into casos (id, aluno_id, total_em_aberto, giro_fidelizacao_ate) values ($1,$2,$3,$4)`, [U(id), U(aluno), total, giro]);

  await par('A', 1, '2025-03-10', 'BA1');
  await par('B', 1, '2025-03-10', 'BB1');
  await par('C', 1, '2025-03-10', null);
  await par('D', 1, '2025-03-10', 'BD1');
  await pag(5001, 4, 'BD1');
  await par('E', 1, '2025-03-10', 'BE1');
  await db.query(`insert into prime_extrato (boleto, liquidado_em) values ('BE1','2025-04-01')`);
  await par('F', 1, '2025-03-10', 'BF1');
  await db.query(
    `insert into acordos_titulos (id, aluno_id, documento, situacao, status, tipo_boleto, valor_original, valor_em_aberto, saldo_corrigido, valor_cobranca_ajustado, vencimento) values ($1,$2,'BF1','PAGO','quitada','Mensalidade',100,0,0,0,'2025-03-10')`,
    [U(6001), U(6)],
  );
  await par('G', 1, '2025-03-10', 'BG1', 'VENCIDA', U(9999));
  await par('H', 1, '2024-06-10', 'BH1');
  await par('H', 2, '2025-03-10', 'BH2');
  await tit(8001, 8, 'BH9', 'ABERTO', null, 50, '2025-05-10');
  await par('I', 1, '2024-06-10', 'BI1');
  await par('I', 2, '2025-03-10', 'BI2');
  await caso(9001, 9, 300);
  await par('J', 1, '2025-03-10', 'BJ1');
  await par('J', 2, '2024-06-10', 'BJ2');
  await pag(5010, 10, 'BJ2');
  await par('K', 1, '2025-03-10', 'BK1');
  await par('M', 1, '2025-03-10', 'BM1');
  await par('N', 1, '2025-03-10', 'BN1');
  await tit(8012, 12, 'BL9', 'ABERTO', null, 80, '2025-05-10');
  await caso(9012, 12, 300, '2099-01-01');
  await tit(8013, 13, 'BM9', 'ABERTO', null, 80, '2025-05-10');
  await caso(9013, 13, 300);
  await tit(8014, 14, 'BN9', 'ABERTO', null, 80, '2025-05-10');
  await caso(9014, 14, 300);
}

async function universo(db, filtros = '{}') {
  const r = await db.query('select * from acoes_massivas_universo($1::jsonb)', [filtros]);
  const out = {};
  for (const x of r.rows) {
    const k = nomeDe(x.aluno_id);
    if (k) out[k] = x;
  }
  return out;
}

const JWT_OPERADOR = `select set_config('request.jwt.claims', '{"role":"authenticated","email":"operador@exemplo.test"}', false)`;
const JWT_GESTAO = `select set_config('request.jwt.claims', '{"role":"authenticated","email":"amanda.seibel@aelbra.com.br"}', false)`;

describe('universo consolidado: 31 verificacoes', () => {
  let dbCons, db19, dbLive, dbRb;
  let pro19, cAll, oAll, lAll, n1, n2;
  const res = {};

  beforeAll(async () => {
    dbCons = await montar(DEF_VIVA);
    await dbCons.exec(MIGRACAO);
    db19 = await montar(DEF_1910);
    dbLive = await montar(DEF_VIVA);
    dbRb = await montar(DEF_VIVA);
    await dbRb.exec(MIGRACAO);
    for (const d of [dbCons, db19, dbLive, dbRb]) await dados(d);
    pro19 = (await db19.query("select prosrc from pg_proc where proname = 'acoes_massivas_universo'")).rows[0].prosrc;
    for (const [f, nome] of FILTROS) res[nome] = { c: await universo(dbCons, f), o: await universo(db19, f) };
    cAll = await universo(dbCons);
    oAll = await universo(db19);
    lAll = await universo(dbLive);
    n1 = await universo(dbCons, '{"responsaveis_caso":["op1@x.test"]}');
    n2 = await universo(dbCons, '{"responsaveis_caso":["op2@x.test"]}');
  }, 180000);

  afterAll(async () => {
    for (const d of [dbCons, db19, dbLive, dbRb]) if (d) await d.close();
  });

  describe('integridade', () => {
    it('19/10: prosrc carregado tem MD5 f49209f6', () => {
      expect(crypto.createHash('md5').update(pro19).digest('hex')).toBe(MD5_PROSRC_1910);
    });
    it('producao viva: definicao carregada tem MD5 88ec923f', async () => {
      expect(await md5def(dbLive)).toBe(MD5_VIVA);
    });
  });

  describe('regressao contra 19/10 por modalidade e responsavel', () => {
    for (const [, nome] of FILTROS) {
      it(`REG ${nome}: removidos sao B..G presentes em 19/10, nenhum inserido`, () => {
        const { c, o } = res[nome];
        const removidos = Object.keys(o).filter((k) => !c[k]).sort();
        const inseridos = Object.keys(c).filter((k) => !o[k]);
        expect(norm(removidos)).toBe(norm(REMOVIDOS.filter((k) => o[k]).sort()));
        expect(inseridos).toEqual([]);
      });
      it(`REG ${nome}: linhas comuns identicas, exceto anos de J`, () => {
        const { c, o } = res[nome];
        const dif = Object.keys(c).filter((k) => o[k] && norm(c[k]) !== norm(o[k]) && k !== 'J').sort();
        expect(dif).toEqual([]);
      });
      it(`REG ${nome}: anos de J restritos a evidencia`, () => {
        const { c, o } = res[nome];
        expect(norm(c.J.anos)).toBe(norm([2025]));
        expect(norm(o.J.anos)).toBe(norm([2024, 2025]));
      });
    }
  });

  describe('regras preservadas e fronteira de populacao', () => {
    it('GIRO L preservado: motivo giro_fidelizado', () => {
      expect(cAll.L).toBeDefined();
      expect(norm(cAll.L.motivo)).toBe(norm(oAll.L.motivo));
      expect(String(cAll.L.motivo)).toMatch(/giro/i);
    });
    it('RETORNO M preservado: motivo igual ao de 19/10', () => {
      expect(cAll.M).toBeDefined();
      expect(norm(cAll.M.motivo)).toBe(norm(oAll.M.motivo));
    });
    it('RESPONSAVEIS N: op1 nao e bloqueado e op2 recebe outro_responsavel', () => {
      expect(n1.N).toBeDefined();
      expect(n1.N.motivo).not.toBe('outro_responsavel');
      expect(n2.N.motivo).toBe('outro_responsavel');
    });
    it('T1 entram so por evidencia: A, J e K', () => {
      expect(Object.keys(cAll).filter((k) => !lAll[k]).sort()).toEqual(['A', 'J', 'K']);
    });
    it('T7 nenhuma remocao em relacao a producao viva', () => {
      expect(Object.keys(lAll).filter((k) => !cAll[k])).toEqual([]);
    });
    it('T3/T4 legados H e I: mesma pertenca e anos da producao viva', () => {
      expect(norm(cAll.H.anos)).toBe(norm(lAll.H.anos));
      expect(norm(cAll.I.anos)).toBe(norm(lAll.I.anos));
    });
    it('T2 inconclusivos, pagos, liquidados, renegociados e saldo zero ficam fora', () => {
      for (const k of REMOVIDOS) expect(cAll[k]).toBeUndefined();
    });
    it('T5 gate: usuario nao gestor recebe erro de acesso', async () => {
      await dbCons.query(JWT_OPERADOR);
      try {
        await expect(universo(dbCons)).rejects.toThrow('restrito a gestao');
      } finally {
        await dbCons.query(JWT_GESTAO);
      }
    });
    it('REG #685: acoes_massivas_fora_do_universo executa com a consolidada', async () => {
      const r = await dbCons.query('select * from acoes_massivas_fora_do_universo()');
      expect(Array.isArray(r.rows)).toBe(true);
    });
  });

  describe('rollback validado', () => {
    it('T6 rollback: MD5 restaurado = producao viva', async () => {
      await dbRb.exec(ROLLBACK);
      expect(await md5def(dbRb)).toBe(MD5_VIVA);
    });
    it('T6 rollback: saida identica a producao viva', async () => {
      expect(norm(await universo(dbRb))).toBe(norm(lAll));
    });
  });
});

describe('pre-condicao MD5 e rollback do arquivo gravado', () => {
  let dbA;
  let dbB;
  let antesB;

  afterAll(async () => {
    for (const d of [dbA, dbB]) if (d) await d.close();
  });

  it('A: definicao viva carregada tem MD5 88ec923f', async () => {
    dbA = await montar(DEF_VIVA);
    expect(await md5def(dbA)).toBe(MD5_VIVA);
  });
  it('A: migration aplicada com a pre-condicao satisfeita', async () => {
    await expect(dbA.exec(MIGRACAO)).resolves.toBeDefined();
  });
  it('A: definicao aplicada difere da viva (e a correcao)', async () => {
    expect(await md5def(dbA)).not.toBe(MD5_VIVA);
  });
  it('A: rollback gravado restaura MD5 88ec923f', async () => {
    await dbA.exec(ROLLBACK);
    expect(await md5def(dbA)).toBe(MD5_VIVA);
  });
  it('B: pre-condicao bloqueia a definicao 19/10 com erro PRE-CONDICAO', async () => {
    dbB = await montar(DEF_1910);
    antesB = await md5def(dbB);
    await expect(dbB.exec(MIGRACAO)).rejects.toThrow('PRE-CONDICAO');
  });
  it('B: nada e alterado apos a falha da pre-condicao', async () => {
    expect(await md5def(dbB)).toBe(antesB);
  });
});
