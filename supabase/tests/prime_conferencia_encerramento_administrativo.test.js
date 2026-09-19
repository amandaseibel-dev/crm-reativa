// ENCERRAMENTO ADMINISTRATIVO DA CONFERENCIA PRIME (19/09/2026).
// Saida definitiva sem efeito financeiro: titulo CANCELADA, decisao
// ENCERRADO_ADMINISTRATIVO, aluno pela regra normal (nunca QUITADO).
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
const CADEIA = ler("supabase/migrations/20260919140000_prime_conferencia_triagem_cadeia.sql");
const MIGRATION = ler("supabase/migrations/20260919160000_prime_conferencia_encerramento_administrativo.sql");
const ROLLBACK = ler("supabase/rollbacks/20260919160000_prime_conferencia_encerramento_administrativo.rollback.sql");

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
  create table public.carteira_2026_1_base (titulo_id uuid primary key, cpf text, aluno_id uuid, documento text, vencimento date, entrada_em date, valor_original numeric);
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
  await db.exec(CADEIA);
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
const decisao = (db, id) => q1(db, `select * from public.prime_conferencia_decisao where titulo_id = $1`, [id]);

// Liquidacao nova sem prova: entra pela regra permanente (rota C) e e triada.
async function cenario(db, n, o = {}) {
  const al = await novoAluno(db, n, o);
  const t = await titulo(db, al, `9${n}0001`, o);
  await extrato(db, al, `9${n}0001`, o);
  return { al, t };
}

// Foto de tudo que a classe humana NAO pode mudar.


// acordo com composicao documental opcional e parcela com boleto conhecido


const ENC = "prime_conferencia_encerrar_administrativo";
const tit = (db, id) => q1(db, `select * from public.acordos_titulos where id = $1`, [id]);
const SALDO_HIST = ler("supabase/tests/fixtures/carteira_saldo_historico_recalcular_prod_20260919.sql");
async function classe(db, t, c, obs = "conferido na tela do Prime: baixa administrativa") {
  await como(db, GESTAO);
  await db.query(`select public.prime_conferencia_classificar_humano($1, $2, $3)`, [t, c, obs]);
}
async function encerrar(db, t, obs = "encerramento administrativo conferido pela gestao") {
  await como(db, GESTAO);
  return (await q1(db, `select public.${ENC}($1, $2) r`, [t, obs])).r;
}
const contagens = (db) => q1(db, `select (select count(*) from public.pagamentos)::int pag, (select count(*) from public.acordos)::int ac,
  (select count(*) from public.parcelas)::int parc, (select count(*) from public.acordo_titulo_vinculo)::int vinc,
  (select count(*) from public.reposicao_carteira_fila)::int repo,
  (select count(*) from public.acordos_titulos where situacao = 'PAGO')::int pago,
  (select count(*) from public.acordos_titulos where situacao = 'NEGOCIADO')::int neg`);
const alunoRow = (db, id) => q1(db, `select situacao_operacional, status_jornada, status_atual, responsavel_atual_email, saldo_total from public.alunos where id = $1`, [id]);
const casoRow = (db, id) => q1(db, `select encerrado_operacional, status_acionamento, status_financeiro, quitado_em, origem_quitacao, operador_email, situacao_operacional from public.casos where id = $1`, [id]);

// titulo EM_CONFIRMACAO pela regra permanente, com classe humana administrativa
async function pronto(db, n, c = "CANCELAMENTO_ESTORNO", o = {}) {
  const { al, t } = await cenario(db, n, { valor: 800, ...o });
  await classificar(db);
  await classe(db, t, c);
  return { al, t };
}

describe("encerramento administrativo: o titulo", () => {
  for (const c of ["CANCELAMENTO_ESTORNO", "ISENCAO_FIES_BOLSA"]) {
    it(`${c}: titulo vira CANCELADA/cancelada, decisao ENCERRADO_ADMINISTRATIVO, proveniencia administrativa, origem_liquidacao intacta`, async () => {
      const db = await abrir();
      const { al, t } = await pronto(db, 1, c);
      const antes = await contagens(db);
      const r = await encerrar(db, t);
      expect(r).toMatchObject({ ok: true, decisao: "ENCERRADO_ADMINISTRATIVO", situacao_titulo: "CANCELADA", classe_humana: c, efeito_financeiro: "nenhum" });
      const x = await tit(db, t);
      expect(x).toMatchObject({ situacao: "CANCELADA", status: "cancelada", origem_liquidacao: null, origem_liquidacao_ref: null,
        origem_encerramento: "CONFERENCIA_PRIME_ADMINISTRATIVA", origem_encerramento_ref: `conferencia_prime:${t}`, acordo_id: null });
      expect(x.origem_encerramento_em).toBeTruthy();
      expect(Number(x.saldo_corrigido)).toBe(800);
      expect(x.motivo_ajuste).toMatch(/encerrado administrativamente pela Conferencia Prime: classe humana /);
      expect(x.motivo_ajuste).toContain(c);
      expect(x.motivo_ajuste).toContain("conferido na tela do Prime");
      expect(x.motivo_ajuste).toContain(GESTAO);
      const d = await decisao(db, t);
      expect(d).toMatchObject({ decisao: "ENCERRADO_ADMINISTRATIVO", decidido_por: GESTAO, classe_humana: c });
      expect(await contagens(db)).toEqual(antes); // 7-12, 18: nada financeiro, nada de reposicao
      const mov = await q(db, `select tipo, status_novo from public.aluno_movimentacoes where aluno_id = $1 order by registrado_em`, [al.id]);
      expect(mov).toContainEqual({ tipo: "TITULO_ENCERRADO_ADMINISTRATIVO", status_novo: "CANCELADA" });
      const aud = await q1(db, `select detalhes from public.auditoria where acao = 'CONFERENCIA_PRIME_ENCERRAMENTO_ADMINISTRATIVO' and registro_id = $1`, [t]);
      expect(aud.detalhes).toMatchObject({ classe_humana: c, sem_efeito_financeiro: true });
      expect(await q(db, `select * from public.prime_conferencia_fila()`)).toEqual([]);
      const cls = await q(db, `select classificacao, origem_decisao, resultado_titulo from public.prime_liquidacao_classificacao where titulo_id = $1 and origem_decisao = 'GESTAO'`, [t]);
      expect(cls).toEqual([{ classificacao: "LIQUIDACAO_INSTITUCIONAL", origem_decisao: "GESTAO", resultado_titulo: "CANCELADA" }]);
      await db.close();
    });
  }

  it("13. nenhum honorario/comissao/recuperacao: sem pagamento, sem PAGO, carteira 2026/1 recuperacao = 0", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await encerrar(db, t);
    expect((await q1(db, `select count(*)::int n from public.pagamentos where aluno_id = $1`, [al.id])).n).toBe(0);
    await db.query(`insert into public.carteira_2026_1_base (titulo_id, cpf, aluno_id, documento, vencimento, entrada_em, valor_original) values ($1, $2, $3, '910001', $4, $5, 800)`, [t, al.cpf, al.id, VENC, IMPORTADO]);
    const c = await q1(db, `select faixa, sub_faixa, ef_pago, ef_negociado, ef_convertido, inadimplencia, recuperacao_financeira from public.carteira_2026_1_classificar() where titulo_id = $1`, [t]);
    expect(c.faixa).toBe("FORA_DA_BASE"); // 21
    expect(c.sub_faixa).toMatch(/fora da base/);
    for (const k of ["ef_pago", "ef_negociado", "ef_convertido", "inadimplencia", "recuperacao_financeira"]) expect(Number(c[k])).toBe(0);
    await db.close();
  });
});

describe("encerramento administrativo: o aluno e o caso", () => {
  it("14. com outra divida exigivel: segue COBRANCA_VENCIDA, caso ativo, responsavel mantido", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await titulo(db, al, "910002", { valor: 400 }); // outra mensalidade aberta
    const r = await encerrar(db, t);
    expect(r.aluno).toBe("COBRANCA_VENCIDA");
    expect(r.caso).toMatchObject({ encerrado: false, porque: "TEM_DIVIDA_EXIGIVEL" });
    expect(await alunoRow(db, al.id)).toMatchObject({ situacao_operacional: "COBRANCA_VENCIDA", responsavel_atual_email: OP1 });
    expect(await casoRow(db, al.caso)).toMatchObject({ encerrado_operacional: false, operador_email: OP1, quitado_em: null });
    await db.close();
  });

  it("15/16. sem outra divida: SEM_PENDENCIA (nunca QUITADO) e caso encerrado SEM_SALDO_EM_ABERTO na mesma operacao", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    const r = await encerrar(db, t);
    expect(r.aluno).toBe("SEM_PENDENCIA");
    expect(r.caso).toMatchObject({ encerrado: true, status_aluno: "SEM_SALDO_EM_ABERTO" });
    const a = await alunoRow(db, al.id);
    expect(a).toMatchObject({ situacao_operacional: "SEM_PENDENCIA", status_jornada: "SEM_SALDO_EM_ABERTO", status_atual: "SEM_SALDO_EM_ABERTO", responsavel_atual_email: OP1 });
    expect(Number(a.saldo_total)).toBe(0);
    const k = await casoRow(db, al.caso);
    expect(k).toMatchObject({ encerrado_operacional: true, status_acionamento: "SEM_SALDO_EM_ABERTO", quitado_em: null, origem_quitacao: null, operador_email: OP1 });
    expect(k.status_financeiro).not.toMatch(/QUITADO/);
    const mov = await q1(db, `select descricao, status_novo from public.aluno_movimentacoes where aluno_id = $1 and tipo = 'ZERADO_REAL_SEM_SALDO'`, [al.id]);
    expect(mov.status_novo).toBe("SEM_SALDO_EM_ABERTO");
    expect(mov.descricao).toMatch(/Sem baixa\/quitacao\. Encerramento administrativo da divida/);
    expect((await q1(db, `select count(*)::int n from public.aluno_movimentacoes where aluno_id = $1 and (tipo ilike '%QUITA%' or status_novo ilike 'QUITADO%')`, [al.id])).n).toBe(0);
    expect((await q1(db, `select count(*)::int n from public.reposicao_carteira_fila`)).n).toBe(0); // 18
    await db.close();
  });

  it("15b. aluno travado (SUSPENSAO_COBRANCA) sem divida: nao encerra o caso, mas tambem nao vira QUITADO", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA', status_atual = 'SUSPENSAO_COBRANCA' where id = $1`, [al.id]);
    const r = await encerrar(db, t);
    expect(r.caso).toMatchObject({ encerrado: false, porque: "ALUNO_TRAVADO" });
    expect(r.aluno).toBe("SEM_PENDENCIA");
    const a = await alunoRow(db, al.id);
    expect(a.situacao_operacional).toBe("SEM_PENDENCIA");
    expect(a.status_jornada).toBe("SUSPENSAO_COBRANCA");
    expect((await casoRow(db, al.caso)).quitado_em).toBeNull();
    await db.close();
  });

  it("17. com outro titulo EM_CONFIRMACAO: permanece AGUARDANDO_CONFIRMACAO e o caso nao encerra", async () => {
    const db = await abrir();
    const al = await novoAluno(db, 1);
    const t1 = await titulo(db, al, "910001", { valor: 800 }); await extrato(db, al, "910001");
    const t2 = await titulo(db, al, "910002", { valor: 300 }); await extrato(db, al, "910002");
    await classificar(db);
    await classe(db, t1, "ISENCAO_FIES_BOLSA");
    const r = await encerrar(db, t1);
    expect(r.aluno).toBe("AGUARDANDO_CONFIRMACAO");
    expect(r.caso).toMatchObject({ encerrado: false, porque: "OUTRO_TITULO_EM_CONFIRMACAO" });
    expect((await tit(db, t2)).situacao).toBe("EM_CONFIRMACAO");
    expect(await casoRow(db, al.caso)).toMatchObject({ encerrado_operacional: false, quitado_em: null });
    expect((await alunoRow(db, al.id)).situacao_operacional).toBe("AGUARDANDO_CONFIRMACAO");
    await db.close();
  });

  it("4. o gatilho de quitacao automatica ignora a saida para CANCELADA (regressao)", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await encerrar(db, t);
    const k = await casoRow(db, al.caso);
    expect(k.quitado_em).toBeNull();
    expect(k.origem_quitacao).toBeNull();
    expect(k.status_financeiro).not.toBe("QUITADO_AUTOMATICO");
    expect((await alunoRow(db, al.id)).status_jornada).not.toMatch(/QUITADO/);
    // e a baixa oficial (PAGO) continua quitando: o gatilho so ignora CANCELADA
    const src = (await q1(db, `select prosrc from pg_proc where proname = '_trg_auto_quitar_titulo'`)).prosrc;
    expect(src).toMatch(/= 'CANCELADA' then\s+return new/);
    expect(src).toMatch(/_talvez_quitar_aluno/);
    await db.close();
  });
});

describe("regra permanente: recalculo nao transforma encerramento administrativo em QUITADO", () => {
  const recalc = async (db, al) => (await q1(db, `select public.recalcular_situacao_aluno($1, 'teste') r`, [al.id])).r;

  it("1-3, 5-7. encerramento -> SEM_PENDENCIA; recalcular de novo (duas vezes) continua SEM_PENDENCIA; sem quitado_em, sem QUITACAO_AUTOMATICA, sem reposicao", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await encerrar(db, t);
    expect((await alunoRow(db, al.id)).situacao_operacional).toBe("SEM_PENDENCIA");
    const r1 = await recalc(db, al);
    expect(r1).toMatchObject({ situacao: "SEM_PENDENCIA", encerramento_administrativo: true });
    const r2 = await recalc(db, al);
    expect(r2.situacao).toBe("SEM_PENDENCIA");
    expect(await alunoRow(db, al.id)).toMatchObject({ situacao_operacional: "SEM_PENDENCIA", status_jornada: "SEM_SALDO_EM_ABERTO" });
    const k = await casoRow(db, al.caso);
    expect(k).toMatchObject({ situacao_operacional: "SEM_PENDENCIA", quitado_em: null, origem_quitacao: null, encerrado_operacional: true });
    expect(k.status_financeiro).not.toMatch(/QUITADO_AUTOMATICO/);
    expect((await q1(db, `select count(*)::int n from public.reposicao_carteira_fila`)).n).toBe(0);
    await db.close();
  });

  it("4. divida nova depois do encerramento: volta para COBRANCA_VENCIDA normalmente", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await encerrar(db, t);
    expect((await alunoRow(db, al.id)).situacao_operacional).toBe("SEM_PENDENCIA");
    await titulo(db, al, "910009", { valor: 350 }); // mensalidade nova, vencida
    const r = await recalc(db, al);
    expect(r.situacao).toBe("COBRANCA_VENCIDA");
    expect(Number(r.saldo_vencido)).toBe(350);
    expect((await tit(db, t)).situacao).toBe("CANCELADA"); // o encerrado nao volta
    await db.close();
  });

  it("8. quitacao financeira legitima posterior continua possivel (pagamento + titulo PAGO depois -> QUITADO)", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await encerrar(db, t);
    const t2 = await titulo(db, al, "910009", { valor: 350 });
    expect((await recalc(db, al)).situacao).toBe("COBRANCA_VENCIDA");
    // dinheiro real depois do encerramento: pagamento + baixa do titulo
    await db.query(`insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao) values ($1, $2, current_date, 378, 'BAIXADO')`, [al.id, al.cpf]);
    await db.query(`update public.acordos_titulos set situacao = 'PAGO', status = 'quitada', atualizado_em = now() where id = $1`, [t2]);
    const r = await recalc(db, al);
    expect(r.situacao).toBe("QUITADO");
    expect(r.encerramento_administrativo).toBe(false);
    await db.close();
  });

  it("9. aluno historico QUITADO por pagamento continua QUITADO; 10. zerados historicos nao sao reclassificados", async () => {
    const db = await abrir();
    // quitado por pagamento (sem encerramento administrativo)
    const al = await novoAluno(db, 1);
    const t = await titulo(db, al, "910001", { valor: 500 });
    await db.query(`insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao) values ($1, $2, current_date, 540, 'BAIXADO')`, [al.id, al.cpf]);
    await db.query(`update public.acordos_titulos set situacao = 'PAGO', status = 'quitada' where id = $1`, [t]);
    expect((await recalc(db, al)).situacao).toBe("QUITADO");
    // zerado historico: sem titulos, SEM_SALDO_EM_ABERTO de antes, sem origem_encerramento
    const z = await novoAluno(db, 2);
    await db.query(`update public.alunos set status_jornada = 'SEM_SALDO_EM_ABERTO', situacao_operacional = 'QUITADO' where id = $1`, [z.id]);
    const rz = await recalc(db, z);
    expect(rz.situacao).toBe("QUITADO");
    expect(rz.encerramento_administrativo).toBe(false);
    // a migration nao tocou em nenhum aluno: nenhum titulo tem origem_encerramento
    expect((await q1(db, `select count(*)::int n from public.acordos_titulos where origem_encerramento is not null`)).n).toBe(0);
    expect((await q1(db, `select count(*)::int n from public.alunos where situacao_operacional = 'SEM_PENDENCIA'`)).n).toBe(0);
    await db.close();
  });
});

describe("terminal: CANCELADA nao ressuscita", () => {
  it("19. upsert do bordero (situacao ABERTO por documento) e recusado no banco; a tela tambem pula CANCELADA", async () => {
    const db = await abrir();
    const { t } = await pronto(db, 1);
    await encerrar(db, t);
    await db.query(`update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto', origem_encerramento = null where id = $1`, [t]);
    expect(await tit(db, t)).toMatchObject({ situacao: "CANCELADA", status: "cancelada", origem_encerramento: "CONFERENCIA_PRIME_ADMINISTRATIVA" });
    const aud = await q(db, `select 1 from public.auditoria where acao = 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA' and registro_id = $1`, [t]);
    expect(aud.length).toBe(1);
    await db.close();
  });

  it("20. titulo_reavaliar, vinculo, regra permanente e reversao da Prime nao trazem o titulo de volta", async () => {
    const db = await abrir();
    const { al, t } = await pronto(db, 1);
    await encerrar(db, t);
    await db.query(`select public.titulo_reavaliar($1)`, [t]);
    expect((await tit(db, t)).situacao).toBe("CANCELADA");
    await db.query(`insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em, forma_pagamento) values ($1, $2, 800, 1, 'ATIVO', now(), 'AVISTA')`, [al.id, al.cpf]);
    const ac = await q1(db, `select id from public.acordos where aluno_id = $1`, [al.id]);
    await como(db, GESTAO);
    const v = (await q1(db, `select public.vincular_titulos_acordo(array[$1]::uuid[], $2) r`, [t, ac.id])).r;
    expect(v.vinculados ?? 0).toBe(0);
    expect((await tit(db, t)).situacao).toBe("CANCELADA");
    expect((await classificar(db)).novas).toBe(0);
    await db.query(`select public.prime_liquidacao_reavaliar_pendentes('teste')`);
    expect((await tit(db, t)).situacao).toBe("CANCELADA");
    expect((await decisao(db, t)).decisao).toBe("ENCERRADO_ADMINISTRATIVO");
    await db.close();
  });

  it("22. saldo historico: so ABERTO entra como aberto/inadimplente; PAGO e negociado como recebido; CANCELADA fica de fora", async () => {
    const db = await abrir();
    // texto de producao (pg_get_functiondef de 19/09): a funcao nao esta na fixture do grupo A
    const src = SALDO_HIST;
    const cand = src.slice(src.indexOf("cand as materialized"), src.indexOf("cand_marcada as materialized"));
    expect(cand).toMatch(/situacao,''\)\) = 'ABERTO'/);
    expect(src).not.toMatch(/CANCELADA/); // nenhum ramo conta CANCELADA
    const hist = src.slice(src.indexOf("hist as materialized"), src.indexOf("por_ano_aberto as materialized"));
    expect(hist).toMatch(/when t\.negociado then/);
    expect(hist).toMatch(/= 'PAGO' then greatest/);
    await db.close();
  });
});

describe("portoes", () => {
  it("23. classe humana invalida ou ausente e recusada", async () => {
    const db = await abrir();
    const { t } = await cenario(db, 1, { valor: 800 });
    await classificar(db);
    await como(db, GESTAO);
    await expect(db.query(`select public.${ENC}($1, 'motivo longo o bastante')`, [t])).rejects.toThrow(/SEM_CLASSE_HUMANA/);
    await classe(db, t, "INCONCLUSIVO");
    await expect(db.query(`select public.${ENC}($1, 'motivo longo o bastante')`, [t])).rejects.toThrow(/CLASSE_NAO_ADMINISTRATIVA/);
    await classe(db, t, "PAGAMENTO_REAL");
    await expect(db.query(`select public.${ENC}($1, 'motivo longo o bastante')`, [t])).rejects.toThrow(/CLASSE_NAO_ADMINISTRATIVA/);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    await db.close();
  });

  it("24. titulo que nao esta PENDENTE/EM_CONFIRMACAO e recusado; motivo curto e recusado", async () => {
    const db = await abrir();
    const { t } = await pronto(db, 1);
    await como(db, GESTAO);
    await expect(db.query(`select public.${ENC}($1, 'curto')`, [t])).rejects.toThrow(/MOTIVO_OBRIGATORIO/);
    await db.query(`select public.prime_conferencia_rejeitar($1, 'volta para a cobranca')`, [t]);
    await expect(db.query(`select public.${ENC}($1, 'motivo longo o bastante')`, [t])).rejects.toThrow(/NAO_ESTA_EM_CONFIRMACAO|SEM_DECISAO_PENDENTE/);
    const { t: t2 } = await pronto(db, 2);
    await encerrar(db, t2);
    await expect(db.query(`select public.${ENC}($1, 'motivo longo o bastante')`, [t2])).rejects.toThrow(/NAO_ESTA_EM_CONFIRMACAO|SEM_DECISAO_PENDENTE/);
    await db.close();
  });

  it("25. operador nao encerra; helper interno nao e exposto", async () => {
    const db = await abrir();
    const { t, al } = await pronto(db, 1);
    await como(db, OP1);
    await expect(db.query(`select public.${ENC}($1, 'motivo longo o bastante')`, [t])).rejects.toThrow(/gestao/);
    const acl = await q1(db, `select has_function_privilege('authenticated', 'public.prime_conferencia_encerrar_zerado_aluno(uuid, text)', 'EXECUTE') ok`);
    expect(acl.ok).toBe(false);
    expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    expect(al).toBeTruthy();
    await db.close();
  });
});

describe("rollback", () => {
  it("26. sem encerrados: restaura estrutura anterior; com encerrado: bloqueia", async () => {
    const db = await abrir();
    await db.exec(ROLLBACK);
    const cols = await q(db, `select column_name from information_schema.columns where table_name = 'acordos_titulos' and column_name like 'origem_encerramento%'`);
    expect(cols.length).toBe(0);
    const fn = await q(db, `select proname from pg_proc where proname in ('prime_conferencia_encerrar_administrativo','prime_conferencia_encerrar_zerado_aluno','_titulo_encerrado_administrativo_protegido')`);
    expect(fn.length).toBe(0);
    const chk = (await q1(db, `select pg_get_constraintdef(oid) d from pg_constraint where conname = 'prime_conferencia_decisao_decisao_check'`)).d;
    expect(chk).not.toContain("ENCERRADO_ADMINISTRATIVO");
    expect((await q1(db, `select prosrc from pg_proc where proname = '_trg_auto_quitar_titulo'`)).prosrc).not.toContain("CANCELADA");
    expect((await q1(db, `select prosrc from pg_proc where proname = 'carteira_2026_1_classificar'`)).prosrc).not.toContain("FORA_DA_BASE");
    expect((await q1(db, `select md5(prosrc) m from pg_proc where proname = 'recalcular_situacao_aluno'`)).m).toBe("f4e1db1892aad74a64245963459d6715");
    await db.close();
    const db2 = await abrir();
    const { t } = await pronto(db2, 1);
    await encerrar(db2, t);
    await expect(db2.exec(ROLLBACK)).rejects.toThrow(/ROLLBACK_BLOQUEADO/);
    await db2.exec("rollback"); // o bloco 'begin;' do rollback ficou abortado; nada foi gravado
    expect((await tit(db2, t)).situacao).toBe("CANCELADA");
    expect((await q(db2, `select 1 from pg_proc where proname = 'prime_conferencia_encerrar_administrativo'`)).length).toBe(1);
    await db2.close();
  });
});
