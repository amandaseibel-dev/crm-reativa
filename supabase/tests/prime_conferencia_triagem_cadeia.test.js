// TRIAGEM -- AJUSTE 2: CADEIA OBJETIVA (19/09/2026). Regressao do lote dos 20.
//
// Roda as migrations REAIS (grupo A + regra de entrada + triagem) num
// PostgreSQL real (PGlite) sobre a fixture de producao do grupo A (funcoes
// conferidas por md5). Prova:
//   - as regras de origem provavel e prioridade;
//   - TRAVA 1: cada uma das 7 classes humanas tem ZERO efeito financeiro;
//   - TRAVA 2: a triagem automatica nunca toca classe_humana*;
//   - portoes, painel, ficha e rollback.
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
const TRIAGEM = ler("supabase/migrations/20260919120000_prime_conferencia_triagem.sql");
const MIGRATION = ler("supabase/migrations/20260919140000_prime_conferencia_triagem_cadeia.sql");
const ROLLBACK = ler("supabase/rollbacks/20260919140000_prime_conferencia_triagem_cadeia.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const VENC = "2025-11-10";
const IMPORTADO = "2026-01-10";
const LIQ = "2026-03-05";

let BASE;

// Tabelas que a fixture nao tem e a triagem usa quando existem.
const OPCIONAIS = `
  create table public.prime_contratos (cpf text, registration text, valid_from date, valid_to date, status text,
    tipo text, curso text, campus text, turno text, periodo_curso int, cancelado_em date, coletado_em timestamptz default now());
  create table public.solicitacoes_financeiro (id uuid default gen_random_uuid() primary key, aluno_id text, aluno_nome text,
    motivo text, status text, retorno_financeiro text, retorno_em timestamptz, criado_em timestamptz default now());
  create table public.prime_portador_membro (cpf text, portador int, coletado_em timestamptz default now(), ciclo int);
  create table public.reposicao_carteira_fila (id bigserial primary key, operador_email text, criado_em timestamptz default now());
`;

async function montar() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  const { rows } = await db.query(
    `select n.nspname || '.' || p.proname as nome, md5(p.prosrc) as md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','internal')`
  );
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5_PROD)) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }
  await db.exec(`insert into public.usuarios (nome, email, perfil, ativo) values
    ('Luana', '${OP1}', 'operador', true), ('Amanda', '${GESTAO}', 'gestao', true);`);
  await db.exec(OPCIONAIS);
  await db.exec(GRUPO_A);
  await db.exec(REGRA);
  await db.exec(TRIAGEM);
  await db.exec(MIGRATION);
  return db;
}

beforeAll(async () => {
  const db = await montar();
  BASE = await db.dumpDataDir("none");
  await db.close();
}, 180000);

const abrir = () => new PGlite({ loadDataDir: BASE, extensions: { unaccent } });
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const SUB = { [GESTAO]: U(900001), [OP1]: U(900002) };
async function como(db, email) {
  const quem = email ?? GESTAO;
  const claims = JSON.stringify({ email: quem, sub: SUB[quem], role: "authenticated" });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
}

async function novoAluno(db, n, o = {}) {
  const id = U(n); const caso = U(100000 + n); const cpf = String(10000000000 + n);
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, unidade, curso, status_atual, status_jornada, status_acionamento,
                                responsavel_atual_email, responsavel_atual_em)
     values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, now() - interval '30 days')`,
    [id, `Aluno ${n}`, cpf, o.matricula === null ? null : `M${n}`, o.unidade ?? "CAMPUS CANOAS", o.curso ?? "DIREITO",
     o.status ?? "MENSAGEM_ENVIADA", o.acionamento ?? null, o.operador ?? OP1]
  );
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, matricula, operador_email, operador_nome,
                               status_atual, status_acionamento, total_em_aberto)
     values ($1, $2, $3, $3, $4, $5, $6, 'OP', 'Mensagem enviada', $7, 1000)`,
    [caso, id, cpf, `Aluno ${n}`, `M${n}`, o.operador ?? OP1, o.acionamento ?? null]
  );
  return { id, caso, cpf, matricula: `M${n}` };
}
async function titulo(db, al, doc, o = {}) {
  const r = await q1(db,
    `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
                                         situacao, status, tipo_boleto, created_at)
     values ($1, $2, $3, $4, $5, $5, 'ABERTO', 'em_aberto', 'Mensalidade', $6) returning id`,
    [al.id, al.cpf, doc, o.venc ?? VENC, o.valor ?? 1000, IMPORTADO]);
  return r.id;
}
async function extrato(db, al, doc, o = {}) {
  await db.query(
    `insert into public.prime_extrato (matricula, boleto, cpf, vencimento, liquidado_em, portador, valor_bruto, valor_pago, coletado_em)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [al.matricula, doc, al.cpf, o.venc ?? VENC, o.liq ?? LIQ, o.portador ?? 195, o.bruto ?? 1000, o.pago ?? 1000]);
}
const classificar = async (db) => { await como(db, GESTAO); return (await q1(db, `select public.prime_liquidacao_classificar_novas(500, true) r`)).r; };
const triar = async (db) => { await como(db, GESTAO); return (await q1(db, `select public.prime_conferencia_triagem_recalcular(null) r`)).r; };
const decisao = (db, id) => q1(db, `select * from public.prime_conferencia_decisao where titulo_id = $1`, [id]);
const fila = async (db) => { await como(db, GESTAO); return q(db, `select * from public.prime_conferencia_fila()`); };

// Liquidacao nova sem prova: entra pela regra permanente (rota C) e e triada.
async function cenario(db, n, o = {}) {
  const al = await novoAluno(db, n, o);
  const t = await titulo(db, al, `9${n}0001`, o);
  await extrato(db, al, `9${n}0001`, o);
  return { al, t };
}

// Foto de tudo que a classe humana NAO pode mudar.
async function foto(db, al, t, semTriagem = false) {
  const colsDecisao = semTriagem ? "" : ", triagem, triagem_em";
  return {
    titulo: await q1(db, `select situacao, status, saldo_corrigido, valor_em_aberto, acordo_id, origem_liquidacao, atualizado_em from public.acordos_titulos where id = $1`, [t]),
    decisao: await q1(db, `select decisao, motivo, decidido_por, decidido_em, subgrupo, evidencia${colsDecisao} from public.prime_conferencia_decisao where titulo_id = $1`, [t]),
    aluno: await q1(db, `select situacao_operacional, status_atual, responsavel_atual_email, saldo_total, saldo_vencido, valor_em_aberto from public.alunos where id = $1`, [al.id]),
    caso: await q1(db, `select operador_email, status_atual, encerrado_operacional, quitado_em, total_em_aberto from public.casos where id = $1`, [al.caso]),
    saldo: (await q1(db, `select public.aluno_saldo_pendente_detalhe($1) s`, [al.id])).s,
    contagens: await q1(db, `select (select count(*) from public.pagamentos)::int pag, (select count(*) from public.acordos)::int ac,
      (select count(*) from public.parcelas)::int parc, (select count(*) from public.acordo_titulo_vinculo)::int vinc,
      (select count(*) from public.reposicao_carteira_fila)::int repo, (select count(*) from public.aluno_movimentacoes)::int mov,
      (select count(*) from public.acordos_titulos where situacao = 'PAGO')::int pago,
      (select count(*) from public.acordos_titulos where situacao = 'NEGOCIADO')::int neg`),
  };
}


// acordo com composicao documental opcional e parcela com boleto conhecido
async function acordoCrm(db, al, o = {}) {
  const r = await q1(db,
    `insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em, forma_pagamento)
     values ($1, $2, $3, 1, $4, $5, 'AVISTA') returning id, numero_acordo`,
    [al.id, al.cpf, o.valor ?? 1000, o.status ?? "ATIVO", o.criado ?? LIQ]);
  await db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, titulos_origem)
                  values ($1, 1, $2, '2027-01-10', $3, $4, $5)`,
    [r.id, o.valor ?? 1000, o.parcelaStatus ?? "A_VENCER", o.boleto ?? `5${String(r.numero_acordo).padStart(6, "0")}0001`, o.origem ?? null]);
  return r;
}
const pagar = (db, al, o = {}) => db.query(
  `insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao, numero_parcela_completo)
   values ($1, $2, $3, $4, $5, $6)`, [al.id, al.cpf, o.data ?? LIQ, o.valor ?? 1080, o.status ?? null, o.boleto ?? "50999990001"]);
const origem = async (db, t) => { const d = await decisao(db, t); return { o: d.triagem.origem_provavel, m: d.triagem.necessita_manual, ev: d.triagem.evidencias_resumo }; };

describe("cadeia objetiva: pagamento", () => {
  it("pagamento do mesmo CPF no mesmo dia, sem cadeia -> PAGAMENTO_CANDIDATO, manual", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    await pagar(db, al, { valor: 540 }); // boleto de acordo que nao existe no CRM (caso Ivone/Alexandre)
    await classificar(db); await triar(db);
    const r = await origem(db, t);
    expect(r).toMatchObject({ o: "PAGAMENTO_CANDIDATO", m: true });
    expect(r.ev).toMatchObject({ cadeia_pagamento: false, pagamento_candidato: true });
    await db.close();
  });

  it("pagamento -> parcela -> acordo cuja composicao cita o boleto -> PAGAMENTO_COMPROVADO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    const ac = await acordoCrm(db, al, { origem: "910001", parcelaStatus: "PAGO" });
    await pagar(db, al, { valor: 1080, status: "BAIXADO", boleto: `5${String(ac.numero_acordo).padStart(6, "0")}0001` });
    await classificar(db); await triar(db);
    const r = await origem(db, t);
    expect(r).toMatchObject({ o: "PAGAMENTO_COMPROVADO", m: false });
    expect(r.ev.cadeia_pagamento).toBe(true);
    await db.close();
  });

  it("solicitacao de confirmacao com titulo_id + pagamento_id fecha a cadeia", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    await pagar(db, al, { valor: 540 });
    const pg = await q1(db, `select id from public.pagamentos where aluno_id = $1`, [al.id]);
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento (aluno_id, aluno_nome, operador_email, status, titulo_id, pagamento_id)
                    values ($1, 'Aluno 1', $2, 'PAGAMENTO_CONFIRMADO', $3, $4)`, [al.id, OP1, t, pg.id]);
    await classificar(db); await triar(db);
    expect((await origem(db, t)).o).toBe("PAGAMENTO_COMPROVADO");
    await db.close();
  });

  it("A1 historico com 'pagamento ReATIVA no dia' (grupo A) e so candidato", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500, pago: 1500 });
    await pagar(db, al, { valor: 540 });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    expect(await decisao(db, t)).toMatchObject({ subgrupo: "A1", corroboracao: "PAGAMENTO_REATIVA" });
    await triar(db);
    expect((await origem(db, t)).o).toBe("PAGAMENTO_CANDIDATO");
    await db.close();
  });
});

describe("cadeia objetiva: acordo", () => {
  it("acordo do aluno perto da data, sem composicao (caso Jussara/Kelly) -> ACORDO_CANDIDATO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 700, pago: 2000 });
    await acordoCrm(db, al, { valor: 300, criado: LIQ });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    expect((await decisao(db, t)).subgrupo).toMatch(/^A2/);
    await triar(db);
    const r = await origem(db, t);
    expect(r).toMatchObject({ o: "ACORDO_CANDIDATO", m: true });
    expect(r.ev.cadeia_acordo).toBe(false);
    expect(r.ev.acordo_candidato).toBeTruthy();
    await db.close();
  });

  it("composicao documental cita o boleto, acordo ATIVO -> ACORDO_COMPROVADO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    await acordoCrm(db, al, { origem: "910001" });
    await classificar(db); await triar(db);
    const r = await origem(db, t);
    expect(r).toMatchObject({ o: "ACORDO_COMPROVADO", m: false });
    await db.close();
  });

  it("composicao cita o boleto, mas acordo QUITADO sem dinheiro real (caso Andrea/Alexandre) -> candidato", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    await acordoCrm(db, al, { origem: "910001", status: "QUITADO", parcelaStatus: "PAGO" });
    await pagar(db, al, { valor: 540 }); // pagamento do dia, boleto de outro acordo
    await classificar(db); await triar(db);
    expect((await origem(db, t)).o).toBe("PAGAMENTO_CANDIDATO");
    await db.close();
  });

  it("vinculo ativo ja registrado -> ACORDO_COMPROVADO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    const ac = await acordoCrm(db, al, {});
    await classificar(db);
    await db.query(`insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo) values ($1, $2, true)`, [t, ac.id]);
    await triar(db);
    expect((await origem(db, t))).toMatchObject({ o: "ACORDO_COMPROVADO", m: false });
    await db.close();
  });
});

describe("regressao do lote dos 20", () => {
  it("titulos resolvidos (NEGOCIADO/PAGO) nao entram na fila; candidatos nunca aparecem como comprovados", async () => {
    const db = await abrir();
    const { al: a1, t: t1 } = await cenario(db, 1, { valor: 500 });
    await classificar(db);
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_rejeitar($1, 'resolvido por outra rota no teste')`, [t1]);
    const { al, t } = await cenario(db, 2, { valor: 500 });
    await pagar(db, al, { valor: 540 });
    await acordoCrm(db, al, { valor: 300, status: "QUITADO", parcelaStatus: "PAGO" });
    await classificar(db);
    const r = await triar(db);
    expect(r.triados).toBe(1);
    const f = await fila(db);
    expect(f.map((x) => x.titulo_id)).toEqual([t]);
    expect(["PAGAMENTO_COMPROVADO", "ACORDO_COMPROVADO"]).not.toContain(f[0].origem_provavel);
    expect(f[0].necessita_manual).toBe(true);
    expect(a1).toBeTruthy();
    await db.close();
  });

  it("o ajuste nao muda prioridade, classe humana, decisao nem titulo", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 6000 });
    await pagar(db, al, { valor: 540 });
    await classificar(db); await triar(db);
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_classificar_humano($1, 'INCONCLUSIVO', 'conferido no Prime sem conclusao')`, [t]);
    const antes = await foto(db, al, t, true);
    const p0 = (await decisao(db, t)).triagem.prioridade;
    await triar(db);
    const d = await decisao(db, t);
    expect(d.triagem.prioridade).toBe(p0);
    expect(d.triagem.origem_provavel).toBe("PAGAMENTO_CANDIDATO");
    expect(d.classe_humana).toBe("INCONCLUSIVO");
    expect(await foto(db, al, t, true)).toEqual(antes);
    await db.close();
  });
});

describe("rollback do ajuste 2", () => {
  it("volta a funcao anterior e retria sem tocar no financeiro", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 500 });
    await pagar(db, al, { valor: 540 });
    await classificar(db); await triar(db);
    expect((await origem(db, t)).o).toBe("PAGAMENTO_CANDIDATO");
    const antes = await foto(db, al, t, true);
    await db.exec(ROLLBACK);
    const d = await decisao(db, t);
    expect(d.triagem.versao).toBe("2026-09-19.1");
    expect(await foto(db, al, t, true)).toEqual(antes);
    await db.close();
  });
});
