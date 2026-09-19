// REGRA PERMANENTE DE ENTRADA: PRIME LIQUIDADO NAO E SINONIMO DE PAGAMENTO.
//
// Roda as migrations REAIS (grupo A + regra de entrada) num PostgreSQL real
// (PGlite) em cima do pedaco de producao que elas tocam: a fixture do grupo A
// (tabelas com as colunas de producao e 50 funcoes com o texto exato de
// pg_get_functiondef, cada corpo conferido por md5). Nada de duble nas regras
// sob teste: recalculo, saldo, vinculo, trava terminal -- tudo e producao.
//
// Os 12 cenarios obrigatorios do item 15, mais o corte (item 14) e uma
// MUTACAO da trava do item 10 (valor_pago Prime nao e caixa).
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
const MIGRATION = ler("supabase/migrations/20260918230000_prime_liquidacao_regra_entrada.sql");
const ROLLBACK = ler("supabase/rollbacks/20260918230000_prime_liquidacao_regra_entrada.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const VENC = "2025-11-10";
const IMPORTADO = "2026-01-10";
const LIQ = "2026-03-05";

let DEPOIS; // producao + grupo A + regra de entrada
let HISTORICO; // o titulo liquidado ANTES do corte (aluno 800)

async function abrir(dump) {
  return new PGlite({ loadDataDir: dump, extensions: { unaccent } });
}

async function montar(migration = MIGRATION) {
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
  // O PASSIVO: um titulo ja liquidado na Prime antes da regra existir.
  const al = await novoAluno(db, 800, { operador: OP1 });
  const t = await titulo(db, al, "980001");
  await extrato(db, al, "980001");
  HISTORICO = { al, t };
  await db.exec(migration);
  return db;
}

beforeAll(async () => {
  const db = await montar();
  DEPOIS = await db.dumpDataDir("none");
  await db.close();
}, 180000);

// ---------------------------------------------------------------- ajudantes
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

async function extrato(db, al, doc, o = {}) {
  await db.query(
    `insert into public.prime_extrato (matricula, boleto, cpf, vencimento, liquidado_em, portador,
                                       valor_bruto, valor_pago, coletado_em)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [al.matricula, doc, o.cpfExtrato ?? al.cpf, o.venc ?? VENC, o.liq ?? LIQ, o.portador ?? 195,
     o.bruto ?? 1000, o.pago ?? 1000]
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

// Acordo com composicao documental: cada parcela lista os boletos de origem.
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
const caso = (db, id) => q1(db, `select * from public.casos where id = $1`, [id]);
const aluno = (db, id) => q1(db, `select * from public.alunos where id = $1`, [id]);
const decisao = (db, id) => q1(db, `select * from public.prime_conferencia_decisao where titulo_id = $1`, [id]);
const registros = (db, id) =>
  q(db, `select classificacao, nivel_evidencia, origem_decisao, resultado_titulo, pagamento_id, acordo_id
           from public.prime_liquidacao_classificacao where titulo_id = $1 order by id`, [id]);
const saldo = async (db, alunoId) => (await q1(db, `select public.aluno_saldo_pendente_detalhe($1) s`, [alunoId])).s;
const contar = (db) =>
  q1(db, `select (select count(*) from public.acordos)::int a, (select count(*) from public.parcelas)::int p,
                 (select count(*) from public.pagamentos)::int g`);

// Liquidacao nova sem nada por tras: o cenario base da rota C.
async function cenarioSemProva(db, n = 1, o = {}) {
  const al = await novoAluno(db, n, { operador: OP1, ...o });
  const t = await titulo(db, al, `9${n}0001`);
  await extrato(db, al, `9${n}0001`, o);
  return { al, t };
}

// ------------------------------------------------------------ 14. o corte
describe("corte: o passivo historico nao e reprocessado", () => {
  it("a migration registra o corte, nao suspende nenhum titulo e a rotina ignora o que ja estava liquidado", async () => {
    const db = await abrir(DEPOIS);
    const regra = await q1(db, `select * from public.prime_liquidacao_regra order by id desc limit 1`);
    expect(regra).toMatchObject({ versao: "2026-09-18.1", titulos_fora_do_corte: 1, alunos_fora_do_corte: 1 });
    expect(Number(regra.valor_fora_do_corte)).toBe(1000);
    expect(await registros(db, HISTORICO.t)).toEqual([
      expect.objectContaining({ classificacao: "HISTORICO_FORA_DO_CORTE", nivel_evidencia: "HISTORICO", origem_decisao: "CORTE" }),
    ]);
    expect((await tit(db, HISTORICO.t)).situacao).toBe("ABERTO");

    const r = await classificar(db);
    expect(r).toMatchObject({ aplicado: true, novas: 0 });
    expect((await tit(db, HISTORICO.t)).situacao).toBe("ABERTO");
    expect(await decisao(db, HISTORICO.t)).toBeUndefined();
  });
});

// ------------------------------------------------------------ 15. os 12
describe("rota C: liquidacao sem prova", () => {
  it("1. Prime liquidou sem pagamento/acordo -> EM_CONFIRMACAO / PENDENTE, motivo registrado, nada baixado", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const antes = await contar(db);
    const r = await classificar(db);
    expect(r).toMatchObject({ novas: 1, PRIME_ORIGEM_NAO_COMPROVADA: 1 });

    const x = await tit(db, t);
    expect(x).toMatchObject({ situacao: "EM_CONFIRMACAO", status: "em_confirmacao", origem_liquidacao: null, acordo_id: null });
    expect(Number(x.saldo_corrigido)).toBe(1000);
    expect(await decisao(db, t)).toMatchObject({
      decisao: "PENDENTE", subgrupo: "C_SEM_PROVA", motivo_entrada: "PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA",
    });
    expect(await registros(db, t)).toEqual([
      expect.objectContaining({ classificacao: "PRIME_ORIGEM_NAO_COMPROVADA", nivel_evidencia: "NENHUMA",
        origem_decisao: "ROTINA", resultado_titulo: "EM_CONFIRMACAO" }),
    ]);
    const ev = (await decisao(db, t)).evidencia;
    expect(ev.prime).toMatchObject({ liquidado_em: LIQ, portador: 195, cpf_confere: true, liquidacao_real: true });
    expect(ev.pagamentos_proximos).toEqual([]);
    expect(ev.acordo_composicao).toBeUndefined();
    expect(await contar(db)).toEqual(antes);
    const mov = await q(db, `select tipo, status_novo from public.aluno_movimentacoes where aluno_id = $1`, [al.id]);
    expect(mov).toContainEqual({ tipo: "TITULO_EM_CONFIRMACAO_PRIME", status_novo: "EM_CONFIRMACAO" });
  });

  it("6. valor_pago Prime maior que o bruto, sem dinheiro real -> EM_CONFIRMACAO; a baixa recusa", async () => {
    const db = await abrir(DEPOIS);
    const { t } = await cenarioSemProva(db, 1, { pago: 1900, bruto: 1000 });
    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    expect((await decisao(db, t)).subgrupo).toBe("C_SEM_PROVA");
    await como(db, GESTAO);
    await expect(db.query(`select public.prime_conferencia_baixar($1, 'valor pago acima do bruto')`, [t]))
      .rejects.toThrow(/SEM_PROVA_DE_PAGAMENTO/);
    await expect(db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]))
      .rejects.toThrow(/SEM_PROVA_DE_PAGAMENTO/);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
  });

  it("10 (item 10, historico): A1 corroborado so por valor pago > bruto tambem nao baixa mais", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await titulo(db, al, "910001");
    await extrato(db, al, "910001", { pago: 1900 });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    expect(await decisao(db, t)).toMatchObject({ subgrupo: "A1", corroboracao: "VALOR_PAGO_ACIMA_DO_BRUTO" });
    await expect(db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]))
      .rejects.toThrow(/VALOR_PAGO_PRIME_NAO_E_CAIXA/);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    // com pagamento ReATIVA no dia a baixa continua funcionando
    const al2 = await novoAluno(db, 2, { operador: OP1 });
    const t2 = await titulo(db, al2, "920001");
    await extrato(db, al2, "920001");
    await pagamento(db, al2, { valor: 1000 });
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    expect((await decisao(db, t2)).corroboracao).toBe("PAGAMENTO_REATIVA");
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t2]);
    expect(await tit(db, t2)).toMatchObject({ situacao: "PAGO", origem_liquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
  });

  it("7. aluno com outra divida: so o titulo liquidado sai; o resto continua cobrado, o responsavel fica", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const outro = await titulo(db, al, "910002", { valor: 300 });
    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    expect((await tit(db, outro)).situacao).toBe("ABERTO");
    const a = await aluno(db, al.id);
    expect(a.situacao_operacional).not.toBe("AGUARDANDO_CONFIRMACAO");
    expect(a.situacao_operacional).not.toBe("QUITADO");
    expect(Number((await saldo(db, al.id)).total)).toBe(300);
    expect((await caso(db, al.caso)).operador_email).toBe(OP1);
    expect((await caso(db, al.caso)).encerrado_operacional).not.toBe(true);
    const fila = await q(db, `select outras_dividas from public.prime_conferencia_fila() where titulo_id = $1`, [t]);
    expect(fila[0].outras_dividas).toBe(true);
  });

  it("8. aluno so com titulos em confirmacao -> AGUARDANDO_CONFIRMACAO, nao QUITADO, sem vaga ocupada, responsavel fica", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    // OP1 tem o aluno do passivo (800) e este: duas vagas antes, uma depois
    expect((await q1(db, `select public.contar_carteira_ativa($1) n`, [OP1])).n).toBe(2);
    await classificar(db);
    const a = await aluno(db, al.id);
    expect(a.situacao_operacional).toBe("AGUARDANDO_CONFIRMACAO");
    const c = await caso(db, al.caso);
    expect(c.quitado_em).toBeNull();
    expect(c.operador_email).toBe(OP1);
    expect(c.encerrado_operacional).not.toBe(true);
    expect(Number((await saldo(db, al.id)).total)).toBe(0);
    expect((await q1(db, `select public.contar_carteira_ativa($1) n`, [OP1])).n).toBe(1);
    expect((await q1(db, `select public.caso_protegido_redistribuicao($1, 'Mensagem enviada', false) p`, [al.cpf])).p).toBe(true);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
  });

  it("9. o mesmo evento Prime recebido duas vezes nao duplica nada", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const r1 = await classificar(db);
    // segunda coleta: mesma liquidacao, valor_pago corrigido maior (muda toda semana)
    await db.query(`update public.prime_extrato set valor_pago = 1234.56, coletado_em = now() where boleto = '910001'`);
    const r2 = await classificar(db);
    const r3 = await classificar(db);
    expect(r1.novas).toBe(1);
    expect(r2.novas).toBe(0);
    expect(r3.novas).toBe(0);
    expect(await registros(db, t)).toHaveLength(1);
    const dec = await q(db, `select count(*)::int n from public.prime_conferencia_decisao where titulo_id = $1`, [t]);
    expect(dec[0].n).toBe(1);
    const mov = await q(db, `select count(*)::int n from public.aluno_movimentacoes where aluno_id = $1 and tipo = 'TITULO_EM_CONFIRMACAO_PRIME'`, [al.id]);
    expect(mov[0].n).toBe(1);
  });

  it("11. titulo em confirmacao fica fora das acoes massivas e do saldo cobrado", async () => {
    const db = await abrir(DEPOIS);
    const { al: s } = await cenarioSemProva(db, 1);
    const o = await novoAluno(db, 2, { operador: OP1 });
    await titulo(db, o, "920002", { valor: 300 });
    await classificar(db);
    const pop = await q(db, `select * from public.acoes_massivas_tipo_cobranca_alunos($1::uuid[])`, [[s.id, o.id]]);
    expect(pop.map((x) => x.aluno_id)).toEqual([o.id]);
    expect(Number((await saldo(db, s.id)).total)).toBe(0);
    expect(Number((await q1(db, `select public.saldo_titulos_aberto($1) v`, [s.cpf])).v)).toBe(0);
    expect(Number((await saldo(db, o.id)).total)).toBe(300);
  });

  it("12. titulo em confirmacao nao gera honorario nem recuperacao: nenhum pagamento, acordo ou parcela nasce; nada vira PAGO", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const antes = await contar(db);
    await classificar(db);
    await classificar(db);
    expect(await contar(db)).toEqual(antes);
    expect(Number(antes.g)).toBe(0);
    expect(await tit(db, t)).toMatchObject({ situacao: "EM_CONFIRMACAO", origem_liquidacao: null });
    expect((await aluno(db, al.id)).situacao_operacional).not.toBe("QUITADO");
    // o painel mostra o valor SUSPENSO separado, nao como recuperado
    const painel = (await q1(db, `select public.prime_liquidacao_painel() p`)).p;
    expect(painel.em_confirmacao).toMatchObject({ titulos: 1, alunos: 1 });
    expect(Number(painel.em_confirmacao.valor)).toBe(1000);
    expect(painel.por_classificacao.PRIME_ORIGEM_NAO_COMPROVADA).toMatchObject({ titulos: 1 });
    expect(painel.por_classificacao.PAGAMENTO_COMPROVADO).toBeUndefined();
  });
});

describe("rotas A e B: pagamento e acordo comprovados", () => {
  it("2. Prime liquidou + acordo a vista realmente pago -> a fila sugere o pagamento; o vinculo oficial deixa o titulo PAGO", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const ac = await acordo(db, al, { status: "QUITADO", parcelas: 1, pagas: 1, valor: 1000, origem: "910001" });
    const pg = await pagamento(db, al, { valor: 1080, status: "BAIXADO", boleto: `5${String(ac.numero_acordo).padStart(6, "0")}0001` });
    const r = await classificar(db);
    expect(r).toMatchObject({ novas: 1, PAGAMENTO_COMPROVADO: 1 });
    expect(await decisao(db, t)).toMatchObject({ subgrupo: "A_PAGAMENTO_COMPROVADO", acordo_id: ac.id });
    expect(await registros(db, t)).toEqual([
      expect.objectContaining({ classificacao: "PAGAMENTO_COMPROVADO", nivel_evidencia: "FINANCEIRA", pagamento_id: pg, acordo_id: ac.id }),
    ]);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");

    await como(db, GESTAO);
    await expect(db.query(`select public.prime_conferencia_baixar($1, null)`, [t])).rejects.toThrow(/SEM_PROVA_DE_PAGAMENTO/);
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);
    expect(await tit(db, t)).toMatchObject({ situacao: "PAGO", status: "quitada", acordo_id: ac.id, origem_liquidacao: null });
    expect((await decisao(db, t)).decisao).toBe("VINCULADO");
    expect((await registros(db, t)).at(-1)).toMatchObject({ classificacao: "PAGAMENTO_COMPROVADO", origem_decisao: "GESTAO", resultado_titulo: "QUITADA" });
  });

  it("3. Prime liquidou + parcela 1 de parcelado paga -> NEGOCIADO, nunca PAGO", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const ac = await acordo(db, al, { status: "ATIVO", parcelas: 3, pagas: 1, valor: 1200, origem: "910001" });
    await pagamento(db, al, { valor: 432, status: "BAIXADO", boleto: `5${String(ac.numero_acordo).padStart(6, "0")}0001` });
    const r = await classificar(db);
    expect(r).toMatchObject({ novas: 1, ACORDO_COMPROVADO_fila: 1 });
    expect(await decisao(db, t)).toMatchObject({ subgrupo: "B_ACORDO_COMPROVADO", acordo_id: ac.id });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);
    expect(await tit(db, t)).toMatchObject({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac.id });
    const s = await saldo(db, al.id);
    expect(Number(s.titulos_abertos)).toBe(0);
    expect(Number(s.parcelas_abertas_valor)).toBe(800);
  });

  it("4. Prime liquidou + acordo ATIVO comprovado pela composicao -> NEGOCIADO", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const ac = await acordo(db, al, { status: "ATIVO", parcelas: 2, valor: 1000, origem: "910001, 910009" });
    await classificar(db);
    expect(await decisao(db, t)).toMatchObject({ subgrupo: "B_ACORDO_COMPROVADO", acordo_id: ac.id, revisao_obrigatoria: false });
    expect((await registros(db, t))[0]).toMatchObject({ classificacao: "ACORDO_COMPROVADO", nivel_evidencia: "DOCUMENTAL" });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_vincular($1, null, null)`, [t]);
    expect(await tit(db, t)).toMatchObject({ situacao: "NEGOCIADO", acordo_id: ac.id });
    const v = await q(db, `select acordo_id from public.acordo_titulo_vinculo where titulo_id = $1 and ativo`, [t]);
    expect(v.map((x) => x.acordo_id)).toEqual([ac.id]);
  });

  it("5. acordo QUITADO realmente pago -> PAGO; acordo QUITADO sem dinheiro real -> continua em confirmacao", async () => {
    const db = await abrir(DEPOIS);
    // pago de verdade: dois pagamentos baixados cobrem o total
    const { al: a1, t: t1 } = await cenarioSemProva(db, 1);
    const ac1 = await acordo(db, a1, { status: "QUITADO", parcelas: 2, pagas: 2, valor: 1000, origem: "910001" });
    await pagamento(db, a1, { valor: 540, status: "BAIXADO", data: "2026-03-06" });
    await pagamento(db, a1, { valor: 540, status: "BAIXADO", data: "2026-04-06" });
    // so o status: parcelas PAGO, nenhum pagamento
    const { al: a2, t: t2 } = await cenarioSemProva(db, 2);
    const ac2 = await acordo(db, a2, { status: "QUITADO", parcelas: 1, pagas: 1, valor: 1000, origem: "920001" });
    await classificar(db);

    expect((await decisao(db, t1)).subgrupo).toBe("A_PAGAMENTO_COMPROVADO");
    expect(await decisao(db, t2)).toMatchObject({ subgrupo: "C_SEM_PROVA", revisao_obrigatoria: true });
    expect((await decisao(db, t2)).evidencia.motivo).toMatch(/ACORDO_QUITADO_SEM_PAGAMENTO_REAL/);

    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t1]);
    expect(await tit(db, t1)).toMatchObject({ situacao: "PAGO", acordo_id: ac1.id });

    await expect(db.query(`select public.prime_conferencia_vincular($1, $2, 'o acordo consta como quitado')`, [t2, ac2.id]))
      .rejects.toThrow(/ACORDO_QUITADO_SEM_PAGAMENTO_REAL/);
    expect(await tit(db, t2)).toMatchObject({ situacao: "EM_CONFIRMACAO", acordo_id: null });
  });

  it("rota A pela tela: pagamento identificado e pendente -> 'seguir pagamento' devolve o titulo ao fluxo oficial, registrado", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    const pg = await pagamento(db, al, { valor: 1080, status: "AGUARDANDO_ACORDO", data: LIQ });
    await classificar(db);
    const d = await decisao(db, t);
    expect(d.subgrupo).toBe("C_SEM_PROVA");
    expect(d.evidencia.pagamento_candidato_id).toBe(pg);
    expect(d.evidencia.pagamento_cobre_o_titulo).toBe(true);
    await como(db, OP1);
    await expect(db.query(`select public.prime_conferencia_seguir_pagamento($1, $2, 'pagamento do mesmo dia e valor')`, [t, pg]))
      .rejects.toThrow(/gestao/);
    await como(db, GESTAO);
    await expect(db.query(`select public.prime_conferencia_seguir_pagamento($1, $2, 'curto')`, [t, pg]))
      .rejects.toThrow(/MOTIVO_OBRIGATORIO/);
    const r = (await q1(db, `select public.prime_conferencia_seguir_pagamento($1, $2, 'pagamento do mesmo dia e valor') r`, [t, pg])).r;
    expect(r.ok).toBe(true);
    // volta ABERTO para o motor de pagamentos concluir; nada foi marcado PAGO aqui
    expect(await tit(db, t)).toMatchObject({ situacao: "ABERTO", status: "em_aberto", origem_liquidacao: null });
    expect((await decisao(db, t))).toMatchObject({ decisao: "REJEITADO" });
    expect((await decisao(db, t)).motivo).toMatch(/^ROTA_FINANCEIRA_PAGAMENTO/);
    expect((await registros(db, t)).at(-1)).toMatchObject({ classificacao: "PAGAMENTO_COMPROVADO", origem_decisao: "GESTAO", pagamento_id: pg });
    // a mesma liquidacao nao volta para a fila na proxima rodada
    expect((await classificar(db)).novas).toBe(0);
    expect((await tit(db, t)).situacao).toBe("ABERTO");
  });

  it("ja NEGOCIADO no CRM: a liquidacao so e registrada, o titulo nao muda e nada entra na fila", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await titulo(db, al, "910001");
    const ac = await acordo(db, al, { status: "ATIVO", parcelas: 2, valor: 1000, origem: "910001" });
    await como(db, GESTAO);
    await db.query(`select public.vincular_titulos_acordo($1::uuid[], $2)`, [[t], ac.id]);
    expect((await tit(db, t)).situacao).toBe("NEGOCIADO");
    await extrato(db, al, "910001");
    const r = await classificar(db);
    expect(r).toMatchObject({ novas: 1, ACORDO_COMPROVADO_registro: 1 });
    expect((await tit(db, t)).situacao).toBe("NEGOCIADO");
    expect(await decisao(db, t)).toBeUndefined();
    expect((await registros(db, t))[0]).toMatchObject({ classificacao: "ACORDO_COMPROVADO", resultado_titulo: "NEGOCIADO", acordo_id: ac.id });
  });
});

describe("12. reversao da Prime", () => {
  it("10. o boleto volta a aparecer em aberto: o titulo sem prova volta a ser cobrado; PAGO e NEGOCIADO com prova nao mexem", async () => {
    const db = await abrir(DEPOIS);
    // (a) sem prova, em confirmacao
    const { al, t } = await cenarioSemProva(db, 1);
    // (b) PAGO com origem oficial pelo caminho do grupo A com pagamento real
    const a2 = await novoAluno(db, 2, { operador: OP1 });
    const t2 = await titulo(db, a2, "920001");
    await extrato(db, a2, "920001");
    await pagamento(db, a2, { valor: 1000 });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t2]);
    expect((await tit(db, t2)).situacao).toBe("PAGO");
    // (c) NEGOCIADO com vinculo
    const a3 = await novoAluno(db, 3, { operador: OP1 });
    const t3 = await titulo(db, a3, "930001");
    const ac3 = await acordo(db, a3, { status: "ATIVO", parcelas: 2, valor: 1000, origem: "930001" });
    await db.query(`select public.vincular_titulos_acordo($1::uuid[], $2)`, [[t3], ac3.id]);
    await extrato(db, a3, "930001");

    await classificar(db);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");

    // a Prime volta os tres para aberto
    await db.query(`update public.prime_extrato set liquidado_em = null, coletado_em = now() where boleto in ('910001','920001','930001')`);
    const r = await classificar(db);
    expect(r.reavaliacao).toMatchObject({ revertidas_pela_prime: 1 });

    expect(await tit(db, t)).toMatchObject({ situacao: "ABERTO", status: "em_aberto" });
    expect(await decisao(db, t)).toMatchObject({ decisao: "REJEITADO" });
    expect((await decisao(db, t)).motivo).toMatch(/^PRIME_REVERTEU_LIQUIDACAO/);
    expect((await registros(db, t)).at(-1)).toMatchObject({ classificacao: "PRIME_REVERTEU_LIQUIDACAO", resultado_titulo: "ABERTO" });
    expect((await aluno(db, al.id)).situacao_operacional).toBe("COBRANCA_VENCIDA");
    expect(await tit(db, t2)).toMatchObject({ situacao: "PAGO", origem_liquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
    expect(await tit(db, t3)).toMatchObject({ situacao: "NEGOCIADO", acordo_id: ac3.id });
    // historico intacto: nada foi apagado
    expect(await registros(db, t)).toHaveLength(2);
  });

  it("7 (item 7): evidencia que surge depois muda a sugestao da fila sem mexer no titulo", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    await classificar(db);
    expect((await decisao(db, t)).subgrupo).toBe("C_SEM_PROVA");
    const ac = await acordo(db, al, { status: "ATIVO", parcelas: 2, valor: 1000, origem: "910001" });
    const r = await classificar(db);
    expect(r.reavaliacao).toMatchObject({ sugestao_atualizada: 1 });
    expect(await decisao(db, t)).toMatchObject({ decisao: "PENDENTE", subgrupo: "B_ACORDO_COMPROVADO", acordo_id: ac.id });
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
  });
});

describe("item 2: o liquidador automatico exige que o pagamento cubra o titulo", () => {
  it("parcela de parcelado (base menor que o titulo) nao fecha o titulo; pagamento que cobre continua fechando", async () => {
    const db = await abrir(DEPOIS);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await titulo(db, al, "910001");
    const pequeno = await pagamento(db, al, { valor: 540, status: "AGUARDANDO_ACORDO" }); // base 500
    const inteiro = await pagamento(db, al, { valor: 1188, status: "AGUARDANDO_ACORDO" }); // base 1100
    await como(db, GESTAO);
    const titulos = JSON.stringify([{ boleto: "910001", vencimento: VENC, pago_em: LIQ, portador: 195 }]);
    const r1 = (await q1(db, `select public.conciliacao_liquidar_titulo_por_prime($1, $2::jsonb, false) r`, [pequeno, titulos])).r;
    expect(r1.liquidados).toBe(0);
    expect(r1.recusados[0]).toMatchObject({ porque: "PAGAMENTO_NAO_COBRE_O_TITULO", base_do_pagamento: 500, teto: 575 });
    const r2 = (await q1(db, `select public.conciliacao_liquidar_titulo_por_prime($1, $2::jsonb, false) r`, [inteiro, titulos])).r;
    expect(r2.liquidados).toBe(1);
    expect((await tit(db, t)).situacao).toBe("ABERTO"); // previa nao escreve
  });
});

describe("a fila", () => {
  it("mostra a classificacao e o motivo de entrada, so para a gestao, com os comprovados primeiro", async () => {
    const db = await abrir(DEPOIS);
    const { al: a1 } = await cenarioSemProva(db, 1);
    const { al: a2, t: t2 } = await cenarioSemProva(db, 2);
    await acordo(db, a2, { status: "ATIVO", parcelas: 2, valor: 1000, origem: "920001" });
    await classificar(db);
    const fila = await q(db, `select documento, subgrupo, classificacao, motivo_entrada, liquidado_em::text as liquidado_em, portador from public.prime_conferencia_fila()`);
    expect(fila.map((f) => f.documento)).toEqual(["920001", "910001"]);
    expect(fila[0]).toMatchObject({ subgrupo: "B_ACORDO_COMPROVADO", classificacao: "ACORDO_COMPROVADO", motivo_entrada: "PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA", portador: 195 });
    expect(fila[1]).toMatchObject({ subgrupo: "C_SEM_PROVA", classificacao: "PRIME_ORIGEM_NAO_COMPROVADA" });
    expect(String(fila[1].liquidado_em).slice(0, 10)).toBe(LIQ);
    await como(db, OP1);
    await expect(db.query(`select * from public.prime_conferencia_fila()`)).rejects.toThrow(/gestao/);
    void a1; void t2;
  });
});

describe("rollback", () => {
  it("devolve o texto de producao, apaga a rotina e devolve para a cobranca so o que a regra nova suspendeu", async () => {
    const db = await abrir(DEPOIS);
    const { al, t } = await cenarioSemProva(db);
    await classificar(db);
    await como(db, null);
    await db.exec(ROLLBACK);
    expect(await tit(db, t)).toMatchObject({ situacao: "ABERTO", status: "em_aberto" });
    expect(await decisao(db, t)).toBeUndefined();
    expect((await aluno(db, al.id)).situacao_operacional).toBe("COBRANCA_VENCIDA");
    const { rows } = await db.query(
      `select n.nspname || '.' || p.proname as nome, md5(p.prosrc) as md5
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','internal')`
    );
    const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
    for (const nova of ["public.prime_liquidacao_classificar_novas", "public.prime_liquidacao_reavaliar_pendentes",
      "public.prime_liquidacao_evidencias", "public.prime_conferencia_seguir_pagamento", "public.prime_liquidacao_painel"]) {
      expect(noBanco[nova]).toBeUndefined();
    }
    // o registro fica (historico), a rotina nao
    expect(await registros(db, t)).toHaveLength(1);
    // as funcoes do grupo A voltam ao texto da migration do grupo A (sem a trava nova)
    const baixar = (await q1(db, `select prosrc from pg_proc where proname = 'prime_conferencia_baixar'`)).prosrc;
    expect(baixar).not.toContain("VALOR_PAGO_PRIME_NAO_E_CAIXA");
  });
});

// ============================================================ MUTACAO
// Arranca a trava do item 10 e mostra o estrago: o A1 corroborado so por
// valor_pago > bruto vira PAGO.
function mutar(velho, novo = "", vezes = 1) {
  const n = MIGRATION.split(velho).length - 1;
  if (n !== vezes) throw new Error(`ancora da mutacao achada ${n} vez(es): ${velho.slice(0, 80)}`);
  return MIGRATION.split(velho).join(novo);
}

describe("mutacao: sem a trava do valor_pago, a liquidacao vira PAGO sem dinheiro", () => {
  it("a trava e o que segura", async () => {
    const semTrava = mutar(
      `  if coalesce(v_ev.corroboracao,'') <> 'PAGAMENTO_REATIVA' then
    raise exception 'VALOR_PAGO_PRIME_NAO_E_CAIXA`,
      `  if false then
    raise exception 'VALOR_PAGO_PRIME_NAO_E_CAIXA`
    );
    const db = await montar(semTrava);
    const al = await novoAluno(db, 1, { operador: OP1 });
    const t = await titulo(db, al, "910001");
    await extrato(db, al, "910001", { pago: 1900 });
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    await db.query(`select public.prime_conferencia_confirmar($1, null)`, [t]);
    expect((await tit(db, t)).situacao).toBe("PAGO"); // o estrago
    await db.close();
  });
});
