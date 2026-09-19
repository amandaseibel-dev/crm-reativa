// TRIAGEM OPERACIONAL DA CONFERENCIA PRIME (19/09/2026).
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
const MIGRATION = ler("supabase/migrations/20260919120000_prime_conferencia_triagem.sql");
const ROLLBACK = ler("supabase/rollbacks/20260919120000_prime_conferencia_triagem.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const VENC = "2025-11-10";
const IMPORTADO = "2026-01-10";
const LIQ = "2026-03-05";
const CLASSES = ["PAGAMENTO_REAL", "ACORDO", "LIQUIDACAO_INSTITUCIONAL", "CANCELAMENTO_ESTORNO",
  "ISENCAO_FIES_BOLSA", "SUBSTITUICAO_TITULO", "INCONCLUSIVO"];

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
async function contrato(db, al, o = {}) {
  await db.query(`insert into public.prime_contratos (cpf, registration, valid_from, valid_to, status, tipo, turno, cancelado_em)
                  values ($1, $2, $3, $4, $5, 'Normal', 'NOITE', $6)`,
    [al.cpf, `R${al.cpf.slice(-4)}`, o.de ?? "2026-07-01", o.ate ?? "2026-12-31", o.status ?? "Confirmado", o.cancelado ?? null]);
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

// ------------------------------------------------------------ a migration
describe("migration: so organizacao", () => {
  it("cria as colunas, o CHECK das 7 classes, as 5 funcoes, e nao mexe em titulo/decisao", async () => {
    const db = await abrir();
    const cols = await q(db, `select column_name from information_schema.columns where table_name = 'prime_conferencia_decisao'
      and column_name in ('triagem','triagem_em','classe_humana','classe_humana_obs','classe_humana_por','classe_humana_em')`);
    expect(cols.length).toBe(6);
    const fn = await q(db, `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
      ('prime_conferencia_triagem_recalcular','prime_conferencia_classificar_humano','prime_conferencia_fila','prime_conferencia_painel','prime_conferencia_ficha')`);
    expect(fn.length).toBe(5);
    await expect(db.query(`update public.prime_conferencia_decisao set classe_humana = 'PAGO' where false`)).resolves.toBeTruthy();
    await expect(db.query(`insert into public.prime_conferencia_decisao (titulo_id, decisao, classe_humana) values ($1, 'PENDENTE', 'PAGO')`, [U(1)]))
      .rejects.toThrow(/classe_humana_check|violates/);
    const aud = await q1(db, `select detalhes from public.auditoria where acao = 'CONFERENCIA_PRIME_TRIAGEM_INICIAL'`);
    expect(aud.detalhes).toMatchObject({ triados: 0 });
    await db.close();
  });
});

// ------------------------------------------------------------ as regras
describe("triagem: origem provavel e prioridade", () => {
  it("valor >= 5.000 -> CRITICO; NAO_COMPROVADA; necessita_manual", async () => {
    const db = await abrir();
    const { t } = await cenario(db, 1, { valor: 6000, bruto: 6000, pago: 9000 });
    await classificar(db);
    const r = await triar(db);
    expect(r).toMatchObject({ triados: 1, por_prioridade: { CRITICO: 1 }, por_origem: { NAO_COMPROVADA: 1 } });
    const d = await decisao(db, t);
    expect(d.triagem).toMatchObject({ grupo_historico: "NOVO_APOS_CORTE", origem_provavel: "NAO_COMPROVADA", prioridade: "CRITICO",
      necessita_manual: true, matricula: "M1", campus: "CAMPUS CANOAS", curso: "DIREITO" });
    expect(d.triagem.motivos).toContain("valor >= 5.000");
    expect(d.classe_humana).toBeNull();
    await db.close();
  });

  it("Medicina >= 2.000 -> CRITICO; abaixo disso em outro campus -> NORMAL", async () => {
    const db = await abrir();
    const a = await cenario(db, 1, { valor: 2500, unidade: "ULBRA MEDICINA - MANAUS" });
    const b = await cenario(db, 2, { valor: 2500 });
    await classificar(db); await triar(db);
    expect((await decisao(db, a.t)).triagem.prioridade).toBe("CRITICO");
    expect((await decisao(db, b.t)).triagem.prioridade).toBe("NORMAL");
    await db.close();
  });

  it("aluno ainda em cobranca (outro titulo aberto) -> CRITICO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 300 });
    await titulo(db, al, "910002", { valor: 400 });
    await classificar(db); await triar(db);
    const d = await decisao(db, t);
    expect(d.triagem.prioridade).toBe("CRITICO");
    expect(d.triagem.motivos.some((m) => m.startsWith("aluno ainda em cobranca"))).toBe(true);
    await db.close();
  });

  it("solicitacao financeira so eleva a CRITICO quando esta ativa E ligada a este titulo", async () => {
    const db = await abrir();
    const a = await cenario(db, 1, { valor: 300 });
    const b = await cenario(db, 2, { valor: 300 });
    const c = await cenario(db, 3, { valor: 300 });
    const d = await cenario(db, 4, { valor: 300 });
    // a: solicitacao antiga do aluno, sem relacao com o boleto -> NAO eleva
    await db.query(`insert into public.solicitacoes_financeiro (aluno_id, motivo, status, criado_em) values ($1, 'aluna alega desconto errado em 2025', 'ENVIADO_FINANCEIRO', now() - interval '200 days')`, [a.al.id]);
    // b: confirmacao de pagamento ATIVA com o mesmo titulo_id -> eleva
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento (aluno_id, aluno_nome, operador_email, status, titulo_id) values ($1, 'Aluno 2', $2, 'AGUARDANDO_CONFIRMACAO', $3)`, [b.al.id, OP1, b.t]);
    // c: confirmacao com o mesmo titulo_id, mas ja encerrada -> nao eleva
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento (aluno_id, aluno_nome, operador_email, status, titulo_id) values ($1, 'Aluno 3', $2, 'PAGAMENTO_CONFIRMADO', $3)`, [c.al.id, OP1, c.t]);
    // d: solicitacao financeira aberta que cita o boleto -> eleva
    await db.query(`insert into public.solicitacoes_financeiro (aluno_id, motivo, status) values ($1, 'aluna alega pagamento do boleto 940001', 'ENVIADO_FINANCEIRO')`, [d.al.id]);
    await classificar(db); await triar(db);
    const ta = (await decisao(db, a.t)).triagem;
    expect(ta.prioridade).not.toBe("CRITICO");
    expect(ta.evidencias_resumo.solicitacao_financeira_ligada).toBe(false);
    const tb = (await decisao(db, b.t)).triagem;
    expect(tb.prioridade).toBe("CRITICO");
    expect(tb.motivos).toContain("solicitacao financeira ativa ligada a este titulo");
    expect((await decisao(db, c.t)).triagem.prioridade).not.toBe("CRITICO");
    expect((await decisao(db, d.t)).triagem.prioridade).toBe("CRITICO");
    await db.close();
  });

  it("contrato cancelado no dia da liquidacao -> CANCELAMENTO_PROVAVEL / ALTO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 800 });
    await contrato(db, al, { status: "Cancelado", cancelado: LIQ });
    await classificar(db); await triar(db);
    expect((await decisao(db, t)).triagem).toMatchObject({ origem_provavel: "CANCELAMENTO_PROVAVEL", prioridade: "ALTO" });
    await db.close();
  });

  it("narrativa FIES no atendimento -> FIES_ISENCAO_PROVAVEL / ALTO", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 800 });
    await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_em) values ($1, 'FINALIZACAO_ATENDIMENTO', 'aluna informou que e FIES', now())`, [al.id]);
    await classificar(db); await triar(db);
    expect((await decisao(db, t)).triagem).toMatchObject({ origem_provavel: "FIES_ISENCAO_PROVAVEL", prioridade: "ALTO" });
    await db.close();
  });

  it(">= 3 titulos do aluno na fila -> ALTO; e o grupo do aluno conta", async () => {
    const db = await abrir();
    const al = await novoAluno(db, 1);
    const ts = [];
    for (const d of ["910001", "910002", "910003"]) { ts.push(await titulo(db, al, d, { valor: 300 })); await extrato(db, al, d); }
    await classificar(db); await triar(db);
    for (const t of ts) {
      const tr = (await decisao(db, t)).triagem;
      expect(tr.prioridade).toBe("ALTO");
      expect(tr.evidencias_resumo.titulos_do_aluno_na_fila).toBe(3);
    }
    await db.close();
  });

  it("Santander vencida liquidada no mesmo dia + contrato 2026/2 vivo -> INSTITUCIONAL_PROVAVEL / NORMAL", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 800 });
    await extrato(db, al, "777001", { portador: 95, venc: "2025-10-10" });
    await contrato(db, al, { status: "Confirmado" });
    await classificar(db); await triar(db);
    const tr = (await decisao(db, t)).triagem;
    expect(tr).toMatchObject({ origem_provavel: "INSTITUCIONAL_PROVAVEL", prioridade: "NORMAL" });
    expect(tr.motivos).toContain("Santander vencidas liquidadas no mesmo dia");
    await db.close();
  });

  it("valor < 200 sem marca de risco -> BAIXO; com acordo cancelado no historico -> NORMAL; < 50 -> RESIDUO", async () => {
    const db = await abrir();
    const a = await cenario(db, 1, { valor: 150 });
    const b = await cenario(db, 2, { valor: 150 });
    await db.query(`insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em, forma_pagamento)
                    values ($1, $2, 500, 1, 'CANCELADO', '2025-06-01', 'AVISTA')`, [b.al.id, b.al.cpf]);
    const c = await cenario(db, 3, { valor: 30 });
    await classificar(db); await triar(db);
    expect((await decisao(db, a.t)).triagem.prioridade).toBe("BAIXO");
    const tb = (await decisao(db, b.t)).triagem;
    expect(tb.prioridade).toBe("NORMAL");
    expect(tb.motivos).toContain("acordo cancelado no historico");
    expect((await decisao(db, c.t)).triagem).toMatchObject({ origem_provavel: "RESIDUO", prioridade: "BAIXO" });
    await db.close();
  });

  it("A2 historico que o acordo nao cobre -> divergencia -> CRITICO; e grupo historico A2", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 300, pago: 1500 });
    await db.query(`insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em, forma_pagamento)
                    values ($1, $2, 100, 1, 'ATIVO', $3, 'AVISTA')`, [al.id, al.cpf, LIQ]);
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_detectar_grupo_a(true)`);
    const d0 = await decisao(db, t);
    expect(d0.subgrupo).toMatch(/^A2/);
    await triar(db);
    const tr = (await decisao(db, t)).triagem;
    expect(tr.grupo_historico).toBe("A2_HISTORICO");
    if (d0.subgrupo === "A2_NAO_COBRE") expect(tr.prioridade).toBe("CRITICO");
    await db.close();
  });

  it("matricula vem do contrato quando o CRM nao tem", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 800, matricula: null });
    await contrato(db, al, { status: "Confirmado" });
    await classificar(db); await triar(db);
    expect((await decisao(db, t)).triagem.matricula).toBe(`R${al.cpf.slice(-4)}`);
    await db.close();
  });
});

// ------------------------------------------------------------ TRAVA 1
describe("TRAVA 1: classe humana nao executa efeito financeiro", () => {
  for (const classe of CLASSES) {
    it(`${classe}: so grava as 4 colunas + auditoria`, async () => {
      const db = await abrir();
      const { al, t } = await cenario(db, 1, { valor: 900 });
      await classificar(db); await triar(db);
      const antes = await foto(db, al, t);
      const aud0 = (await q1(db, `select count(*)::int n from public.auditoria`)).n;
      await como(db, GESTAO);
      const r = (await q1(db, `select public.prime_conferencia_classificar_humano($1, $2, 'vi no Prime: baixa registrada com este motivo') r`, [t, classe])).r;
      expect(r).toMatchObject({ ok: true, classe_humana: classe, decisao: "PENDENTE", efeito_financeiro: "nenhum" });
      const depois = await foto(db, al, t);
      expect(depois).toEqual(antes);
      const d = await decisao(db, t);
      expect(d).toMatchObject({ decisao: "PENDENTE", classe_humana: classe, classe_humana_por: GESTAO,
        classe_humana_obs: "vi no Prime: baixa registrada com este motivo" });
      expect(d.classe_humana_em).toBeTruthy();
      expect((await q1(db, `select situacao from public.acordos_titulos where id = $1`, [t])).situacao).toBe("EM_CONFIRMACAO");
      const aud = await q(db, `select acao, detalhes from public.auditoria order by created_at desc, id desc limit 1`);
      expect((await q1(db, `select count(*)::int n from public.auditoria`)).n).toBe(aud0 + 1);
      expect(aud[0].acao).toBe("CONFERENCIA_PRIME_CLASSE_HUMANA");
      expect(aud[0].detalhes).toMatchObject({ classe, sem_efeito_financeiro: true });
      await db.close();
    });
  }

  it("portoes: operador recebe 42501; classe invalida, motivo curto e titulo decidido sao recusados", async () => {
    const db = await abrir();
    const { t } = await cenario(db, 1, { valor: 900 });
    await classificar(db);
    await como(db, OP1);
    await expect(db.query(`select public.prime_conferencia_classificar_humano($1, 'ACORDO', 'motivo longo o bastante')`, [t])).rejects.toThrow(/gestao/);
    await como(db, GESTAO);
    await expect(db.query(`select public.prime_conferencia_classificar_humano($1, 'PAGO', 'motivo longo o bastante')`, [t])).rejects.toThrow(/CLASSE_INVALIDA/);
    await expect(db.query(`select public.prime_conferencia_classificar_humano($1, 'ACORDO', 'curto')`, [t])).rejects.toThrow(/MOTIVO_OBRIGATORIO/);
    await db.query(`select public.prime_conferencia_rejeitar($1, 'volta para a cobranca por teste')`, [t]);
    await expect(db.query(`select public.prime_conferencia_classificar_humano($1, 'ACORDO', 'motivo longo o bastante')`, [t])).rejects.toThrow(/SEM_DECISAO_PENDENTE/);
    await db.close();
  });
});

// ------------------------------------------------------------ TRAVA 2
describe("TRAVA 2: triagem automatica nao sobrescreve decisao humana", () => {
  it("recalcular (cron/botao) atualiza triagem e preserva classe_humana*, mesmo com dado novo", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 900 });
    await classificar(db); await triar(db);
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_classificar_humano($1, 'CANCELAMENTO_ESTORNO', 'estorno visto na tela do Prime')`, [t]);
    const h1 = await decisao(db, t);
    // fato novo: contrato cancelado no dia -> a triagem muda de origem
    await contrato(db, al, { status: "Cancelado", cancelado: LIQ });
    await new Promise((r) => setTimeout(r, 20));
    const r = await triar(db);
    expect(r.triados).toBe(1);
    const h2 = await decisao(db, t);
    expect(h2.triagem.origem_provavel).toBe("CANCELAMENTO_PROVAVEL");
    expect(new Date(h2.triagem_em) >= new Date(h1.triagem_em)).toBe(true);
    expect({ c: h2.classe_humana, o: h2.classe_humana_obs, p: h2.classe_humana_por, e: String(h2.classe_humana_em) })
      .toEqual({ c: h1.classe_humana, o: h1.classe_humana_obs, p: h1.classe_humana_por, e: String(h1.classe_humana_em) });
    // so nova acao humana muda
    await db.query(`select public.prime_conferencia_classificar_humano($1, 'INCONCLUSIVO', 'revisto: nao da para afirmar')`, [t]);
    expect((await decisao(db, t)).classe_humana).toBe("INCONCLUSIVO");
    const aud = await q1(db, `select detalhes from public.auditoria where acao = 'CONFERENCIA_PRIME_CLASSE_HUMANA' order by created_at desc, id desc limit 1`);
    expect(aud.detalhes).toMatchObject({ classe: "INCONCLUSIVO", classe_anterior: "CANCELAMENTO_ESTORNO" });
    await db.close();
  });

  it("o texto da funcao de triagem nao contem classe_humana no SET", async () => {
    const db = await abrir();
    const src = (await q1(db, `select prosrc from pg_proc where proname = 'prime_conferencia_triagem_recalcular'`)).prosrc;
    const sets = [...src.matchAll(/set\s+([a-z_]+)\s*=/gi)].map((m) => m[1].toLowerCase());
    expect(sets.every((c) => c === "triagem")).toBe(true);
    expect(src).toMatch(/triagem_em = now\(\)/);
    expect(src).not.toMatch(/classe_humana\s*=/);
    await db.close();
  });
});

// ------------------------------------------------------------ fila, painel, ficha
describe("fila, painel e ficha", () => {
  it("a fila traz triagem, dias pendente e classe humana; ordena CRITICO primeiro", async () => {
    const db = await abrir();
    const a = await cenario(db, 1, { valor: 150 });
    const b = await cenario(db, 2, { valor: 7000, bruto: 7000, pago: 7000 });
    await classificar(db); await triar(db);
    const f = await fila(db);
    expect(f.length).toBe(2);
    expect(f[0].titulo_id).toBe(b.t);
    expect(f[0]).toMatchObject({ prioridade: "CRITICO", origem_provavel: "NAO_COMPROVADA", grupo_historico: "NOVO_APOS_CORTE",
      necessita_manual: true, dias_pendente: 0, classe_humana: null, campus: "CAMPUS CANOAS", matricula: "M2" });
    expect(f[1]).toMatchObject({ titulo_id: a.t, prioridade: "BAIXO" });
    await como(db, OP1);
    await expect(db.query(`select * from public.prime_conferencia_fila()`)).rejects.toThrow(/gestao/);
    await db.close();
  });

  it("o painel conta total, valor, novos x historicos, prazos e cortes por origem/prioridade/campus", async () => {
    const db = await abrir();
    await cenario(db, 1, { valor: 150 });
    const b = await cenario(db, 2, { valor: 7000 });
    await classificar(db); await triar(db);
    await db.query(`update public.prime_conferencia_decisao set detectado_em = now() - interval '8 days' where titulo_id = $1`, [b.t]);
    await como(db, GESTAO);
    await db.query(`select public.prime_conferencia_classificar_humano($1, 'ACORDO', 'acordo visto na tela do Prime')`, [b.t]);
    const p = (await q1(db, `select public.prime_conferencia_painel() p`)).p;
    expect(p).toMatchObject({ total: 2, alunos: 2, novos_apos_corte: 2, historicos: 0, resolvidos_hoje: 0, classificados_hoje: 1,
      com_classe_humana: 1, necessita_manual: 2, pendentes_mais_1_dia: 1, pendentes_mais_3_dias: 1, pendentes_mais_7_dias: 1, sem_triagem: 0 });
    expect(Number(p.valor)).toBe(7150);
    expect(p.por_prioridade).toEqual({ CRITICO: 1, BAIXO: 1 });
    expect(p.por_origem).toEqual({ NAO_COMPROVADA: 2 });
    expect(p.por_campus).toEqual({ "CAMPUS CANOAS": 2 });
    expect(p.por_classe_humana).toEqual({ ACORDO: 1, "-": 1 });
    await db.close();
  });

  it("a ficha reune titulo, aluno, decisao, evidencias, contratos, mesmo evento, outros na fila, narrativas e solicitacoes", async () => {
    const db = await abrir();
    const al = await novoAluno(db, 1);
    const t1 = await titulo(db, al, "910001", { valor: 800 }); await extrato(db, al, "910001");
    await titulo(db, al, "910002", { valor: 300 }); await extrato(db, al, "910002");
    await extrato(db, al, "777001", { portador: 95, venc: "2025-10-10" });
    await contrato(db, al, { status: "Confirmado" });
    await db.query(`insert into public.solicitacoes_financeiro (aluno_id, motivo, status) values ($1, 'aluna alega FIES', 'ENVIADO_FINANCEIRO')`, [al.id]);
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento (aluno_id, aluno_nome, operador_email, status, titulo_id) values ($1, 'Aluno 1', $2, 'AGUARDANDO_CONFIRMACAO', $3)`, [al.id, OP1, t1]);
    await classificar(db); await triar(db);
    await como(db, GESTAO);
    const f = (await q1(db, `select public.prime_conferencia_ficha($1) f`, [t1])).f;
    expect(f.titulo).toMatchObject({ documento: "910001", situacao: "EM_CONFIRMACAO" });
    expect(f.aluno).toMatchObject({ nome: "Aluno 1", matricula: "M1", campus: "CAMPUS CANOAS", responsavel: OP1 });
    expect(f.decisao).toMatchObject({ decisao: "PENDENTE", subgrupo: "C_SEM_PROVA" });
    expect(f.decisao.triagem.origem_provavel).toBe("FIES_ISENCAO_PROVAVEL");
    expect(f.evidencias.prime).toMatchObject({ portador: 195, liquidado_em: LIQ });
    expect(f.contratos).toHaveLength(1);
    expect(f.mesmo_evento.map((x) => x.boleto).sort()).toEqual(["777001", "910002"]);
    expect(f.outros_na_fila).toHaveLength(1);
    expect(f.outros_na_fila[0].documento).toBe("910002");
    expect(f.solicitacoes).toHaveLength(2);
    expect(f.narrativas.some((n) => n.tipo === "TITULO_EM_CONFIRMACAO_PRIME")).toBe(true);
    await db.close();
  });
});

// ------------------------------------------------------------ rollback
describe("rollback", () => {
  it("remove colunas, funcoes e cron; a fila antiga volta; nada financeiro muda", async () => {
    const db = await abrir();
    const { al, t } = await cenario(db, 1, { valor: 900 });
    await classificar(db); await triar(db);
    const antes = await foto(db, al, t, true);
    await db.exec(ROLLBACK);
    const cols = await q(db, `select column_name from information_schema.columns where table_name = 'prime_conferencia_decisao' and (column_name like 'classe_humana%' or column_name like 'triagem%')`);
    expect(cols.length).toBe(0);
    const fn = await q(db, `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
      ('prime_conferencia_triagem_recalcular','prime_conferencia_classificar_humano','prime_conferencia_painel','prime_conferencia_ficha')`);
    expect(fn.length).toBe(0);
    const f = await fila(db);
    expect(f.length).toBe(1);
    expect(f[0].prioridade).toBeUndefined();
    const depois = await foto(db, al, t, true);
    expect(depois).toEqual(antes);
    await db.close();
  });
});
