// ALERTA D-2 POR ACORDO+PARCELA (Blocos 3 e 4).
//
// Roda a migration REAL (20260922110000) e o rollback REAL sobre a fixture confirmacao_d2 (funcoes de producao com texto exato).
// Dados FICTICIOS. As datas do alerta sao simuladas por p_hoje (nao depende do relogio); onde a cobranca real entra
// (recalcular_situacao_aluno) as parcelas sao relativas a current_date.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const MA = "20260922110000_acordo_alertas_parcela";
const MC = ["20260922100000_confirmacao_vinculo_pagamentos", "20260922100100_confirmacao_processada_resolver", "20260922100200_confirmacao_encerramento_processado"];
const D = "2026-10-19"; // segunda
let BASE, BASE_POSCRON;
let seq = 0;

beforeAll(async () => {
  const db = await H.montarProd();
  for (const m of MC) await db.exec(H.MIG(m));
  await db.exec(H.MIG(MA));
  BASE = await db.dumpDataDir();
  await H.posCron(db);
  BASE_POSCRON = await db.dumpDataDir();
  await db.close();
});
const novo = async (dump = BASE) => {
  const db = H.abrir(dump);
  await db.exec("set check_function_bodies = off; set timezone = 'UTC';");
  await H.como(db, H.GESTAO);
  return db;
};
const U = (a, b) => `a2000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;
async function mk(db, { nome, resp = null, respAlu = undefined, status = "ATIVO", parcelas }) {
  const n = ++seq;
  const al = U(n, 1), ac = U(n, 2);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'ACORDO_EM_DIA','ACORDO_EM_DIA')", [al, nome, String(20000000000 + n), String(n), respAlu === undefined ? resp : respAlu]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) values ($1,$2,$3,$4,1000,1000,$5,$6,$7,$8)", [ac, al, String(20000000000 + n), status, parcelas.length, String(60000 + n), 9100 + n, resp]);
  const ps = [];
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i]; const id = U(n, 100 + i); ps.push(id);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,$3,$4,$5::date,$6)", [id, ac, p.n ?? i + 1, p.valor ?? 100, p.venc, p.status ?? "A_VENCER"]);
  }
  return { al, ac, ps };
}
const gerar = async (db, hoje, dias = null, modo = null) => (await db.query("select public.acordo_alertas_gerar($1::date,$2::int,$3::text) j", [hoje, dias, modo])).rows[0].j;
const alertas = async (db, ac) => (await db.query(`select numero_parcela n, vencimento::text v, data_alerta::text da, responsavel_email r, resolucao res, (resolvido_em is not null) fechado from acordo_alertas_parcela ${ac ? "where acordo_id=$1" : ""} order by criado_em, id`, ac ? [ac] : [])).rows;
const fixo = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
const iso = (t) => t.toISOString().slice(0, 10);

describe("parametro e data do alerta (D-2 corrido)", () => {
  it("parametro semeado = 2 dias / CORRIDO; 19/10 => 17/10 (sabado), sem dia util", async () => {
    const db = await novo();
    expect((await H.q1(db, "select valor from calibragem_parametros where chave='alerta_parcela_d2'")).valor).toEqual({ dias: 2, modo: "CORRIDO" });
    const t = await H.qn(db, "select dias, modo, public.acordo_alerta_data($1::date,dias,modo)::text data from (values (2,'CORRIDO'),(2,'UTIL'),(3,'CORRIDO'),(3,'UTIL')) v(dias,modo)", [D]);
    expect(t.map((x) => x.data)).toEqual(["2026-10-17", "2026-10-16", "2026-10-16", "2026-10-16"]);
    await db.close();
  });
});

describe("A-M: geracao, resolucao e idempotencia", () => {
  it("A) parcela futura (> D-2): nenhum alerta", async () => {
    const db = await novo(); const { ac } = await mk(db, { nome: "Teste A", resp: "op1@x", parcelas: [{ venc: D }] });
    expect((await gerar(db, "2026-10-10")).criados).toBe(0);
    expect(await alertas(db, ac)).toHaveLength(0);
    await db.close();
  });
  it("B) entrando em D-2 (default CORRIDO): 16/10 nada, 17/10 alerta (sabado), responsavel do acordo", async () => {
    const db = await novo(); const { ac } = await mk(db, { nome: "Teste B", resp: "op1@x", parcelas: [{ venc: D }] });
    await gerar(db, "2026-10-16"); expect(await alertas(db, ac)).toHaveLength(0);
    await gerar(db, "2026-10-17"); const a = await alertas(db, ac);
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ da: "2026-10-17", r: "op1@x", n: 1 });
    await db.close();
  });
  it("C) D-1 sem rodada anterior: alerta criado (janela, nao data exata); D) vence hoje: criado; venceu ontem: sem D2", async () => {
    const db = await novo(); const c = await mk(db, { nome: "Teste C", resp: "op1@x", parcelas: [{ venc: D }] });
    await gerar(db, "2026-10-18"); expect(await alertas(db, c.ac)).toHaveLength(1);
    const d = await novo(); const e = await mk(d, { nome: "Teste D", resp: "op1@x", parcelas: [{ venc: D }] });
    await gerar(d, D); expect(await alertas(d, e.ac)).toHaveLength(1);
    const f = await novo(); const g = await mk(f, { nome: "Teste D2", resp: "op1@x", parcelas: [{ venc: D }] });
    await gerar(f, "2026-10-20"); expect(await alertas(f, g.ac)).toHaveLength(0);
    await db.close(); await d.close(); await f.close();
  });
  it("E) pago antes do alerta: sem alerta e a proxima parcela e a seguinte; parcela PAGO e pulada", async () => {
    const db = await novo(); const { ac, ps } = await mk(db, { nome: "Teste E", resp: "op1@x", parcelas: [{ venc: D }, { venc: "2026-11-19" }] });
    await db.query("update parcelas set status='PAGO' where id=$1", [ps[0]]);
    await gerar(db, "2026-10-17");
    expect(await alertas(db, ac)).toHaveLength(0);
    const cl = (await db.query("select public.acordo_classificar($1,'2026-10-17'::date) j", [ac])).rows[0].j;
    expect(cl).toMatchObject({ classe: "em_dia", proxima_numero: 2 });
    await db.close();
  });
  it("F) pago depois do alerta: resolve PAGA por trigger e a rodada seguinte nao recria", async () => {
    const db = await novo(); const { ac, ps } = await mk(db, { nome: "Teste F", resp: "op1@x", parcelas: [{ venc: D }, { venc: "2026-11-19" }] });
    await gerar(db, "2026-10-17"); expect((await alertas(db, ac))[0].fechado).toBe(false);
    await db.query("update parcelas set status='PAGO' where id=$1", [ps[0]]);
    expect((await alertas(db, ac))[0].res).toBe("PAGA");
    await gerar(db, "2026-10-18"); expect(await alertas(db, ac)).toHaveLength(1);
    await db.close();
  });
  it("G) acordo QUITADO / H) acordo CANCELADO: alerta encerrado e nao recriado; parcela cancelada => SUBSTITUIDA", async () => {
    for (const [st, res] of [["QUITADO", "ACORDO_QUITADO"], ["CANCELADO", "ACORDO_CANCELADO"]]) {
      const db = await novo(); const { ac } = await mk(db, { nome: "Teste " + st, resp: "op1@x", parcelas: [{ venc: D }] });
      await gerar(db, "2026-10-17"); await db.query("update acordos set status=$1 where id=$2", [st, ac]);
      expect((await alertas(db, ac))[0].res).toBe(res);
      await gerar(db, "2026-10-18"); expect(await alertas(db, ac)).toHaveLength(1);
      await db.close();
    }
    const db = await novo(); const { ac, ps } = await mk(db, { nome: "Teste Canc", resp: "op1@x", parcelas: [{ venc: D }, { venc: "2026-11-19" }] });
    await gerar(db, "2026-10-17"); await db.query("update parcelas set status='CANCELADA' where id=$1", [ps[0]]);
    expect((await alertas(db, ac))[0].res).toBe("SUBSTITUIDA");
    await db.close();
  });
  it("varredura: parcela que passou do vencimento sem pagar => VENCIDA", async () => {
    const db = await novo(); const { ac } = await mk(db, { nome: "Teste V", resp: "op1@x", parcelas: [{ venc: D }] });
    await gerar(db, "2026-10-18"); await gerar(db, "2026-10-21");
    expect((await alertas(db, ac))[0].res).toBe("VENCIDA");
    await db.close();
  });
  it("I) acordo com parcela vencida: classe vencido, sem D2 para si", async () => {
    const db = await novo(); const { ac } = await mk(db, { nome: "Teste I", resp: "op1@x", parcelas: [{ venc: "2026-10-01", status: "VENCIDA" }, { venc: D }] });
    await gerar(db, "2026-10-17");
    expect((await db.query("select public.acordo_classificar($1,'2026-10-17'::date) j", [ac])).rows[0].j.classe).toBe("vencido");
    expect(await alertas(db, ac)).toHaveLength(0);
    await db.close();
  });
  it("J) dois acordos ativos do mesmo aluno: um alerta por acordo+parcela, cada um com o responsavel do proprio acordo", async () => {
    const db = await novo(); const a1 = await mk(db, { nome: "Teste J", resp: "op1@x", parcelas: [{ venc: D }] });
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) select $1,aluno_id,cpf,'ATIVO',500,500,1,'88123',9901,'op2@x' from acordos where id=$2", [U(900, 1), a1.ac]);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,100,$3::date,'A_VENCER')", [U(900, 2), U(900, 1), D]);
    await gerar(db, "2026-10-17");
    const a = await alertas(db);
    expect(a).toHaveLength(2); expect(new Set(a.map((x) => x.r))).toEqual(new Set(["op1@x", "op2@x"]));
    await db.close();
  });
  it("K) acordo sem responsavel: alerta com responsavel NULL; RPC so-gestao lista; nada e distribuido", async () => {
    const db = await novo(); const { al, ac } = await mk(db, { nome: "Teste K", resp: null, parcelas: [{ venc: D }] });
    await gerar(db, "2026-10-17");
    expect((await alertas(db, ac))[0].r).toBeNull();
    const lista = await H.qn(db, "select * from public.acordo_alertas_sem_responsavel()");
    expect(lista.map((x) => x.aluno_id)).toContain(al);
    await db.exec("set role authenticated"); await H.como(db, H.OP6);
    await expect(db.query("select * from public.acordo_alertas_sem_responsavel()")).rejects.toThrow(/somente gestao/i);
    await db.exec("reset role");
    expect((await H.q1(db, "select responsavel_atual_email from alunos where id=$1", [al])).responsavel_atual_email).toBeNull();
    await db.close();
  });
  it("L) rotina duas vezes (e no dia seguinte): 1 alerta; criados=0 na repeticao", async () => {
    const db = await novo(); const { ac } = await mk(db, { nome: "Teste L", resp: "op1@x", parcelas: [{ venc: D }] });
    await gerar(db, "2026-10-17"); const r2 = await gerar(db, "2026-10-17"); await gerar(db, "2026-10-18");
    expect(await alertas(db, ac)).toHaveLength(1); expect(r2.criados).toBe(0);
    await db.close();
  });
  it("A vencido + B em dia (entrando em D-2): alerta so de B; aluno segue COBRANCA_VENCIDA; nada escondido; A nao gera D-2; demais tabelas intactas", async () => {
    const db = await novo();
    const hoje = iso(new Date());
    const dia = (n) => iso(new Date(fixo(hoje).getTime() + n * 86400000));
    const A = await mk(db, { nome: "Teste AB", resp: "op1@x", parcelas: [{ venc: dia(-10), status: "VENCIDA" }, { venc: dia(2) }] });
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) select $1,aluno_id,cpf,'ATIVO',500,500,1,'88999',9902,'op1@x' from acordos where id=$2", [U(901, 1), A.ac]);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,100,$3::date,'A_VENCER')", [U(901, 2), U(901, 1), dia(2)]);
    await db.query("select public.recalcular_situacao_aluno($1)", [A.al]);
    const antes = await H.snap(db);
    const r = await gerar(db, hoje);
    const a = await alertas(db);
    expect(r.criados).toBe(1);
    expect(a).toHaveLength(1);
    expect((await H.q1(db, "select acordo_id from acordo_alertas_parcela")).acordo_id).toBe(U(901, 1));
    const dep = await H.snap(db);
    expect(H.diff(antes, dep).every((x) => x.t === "alertas")).toBe(true);
    expect((await H.q1(db, "select situacao_operacional from alunos where id=$1", [A.al])).situacao_operacional).toBe("COBRANCA_VENCIDA");
    await db.close();
  });
});

describe("RPCs de consumo (RLS/JWT)", () => {
  it("operador ve so os seus, gestao ve todos, nao-responsavel 0, dois acordos => duas linhas; p_aluno_id filtra; campos completos", async () => {
    const db = await novo();
    const hoje = iso(new Date()); const dia = (n) => iso(new Date(fixo(hoje).getTime() + n * 86400000));
    const a1 = await mk(db, { nome: "Aluno Rpc Um", resp: H.OP6, parcelas: [{ venc: dia(2), valor: 111.11 }] });
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) select $1,aluno_id,cpf,'ATIVO',500,500,1,'88777',9903,$3 from acordos where id=$2", [U(902, 1), a1.ac, H.OP6]);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,50,$3::date,'A_VENCER')", [U(902, 2), U(902, 1), dia(1)]);
    const b = await mk(db, { nome: "Aluno Rpc Dois", resp: "outro@aelbra.com.br", parcelas: [{ venc: dia(2) }] });
    await gerar(db, hoje);
    await db.exec("set role authenticated");
    await H.como(db, H.OP6);
    const meus = await H.qn(db, "select * from public.acordo_alertas_do_operador()");
    expect(meus).toHaveLength(2);
    expect(meus.every((x) => x.responsavel_email === H.OP6)).toBe(true);
    expect(Object.keys(meus[0]).sort()).toEqual(["acordo_id", "aluno_id", "aluno_nome", "data_alerta", "dias_restantes", "numero_acordo", "numero_parcela", "parcela_id", "responsavel_email", "valor", "vencimento"]);
    expect(meus.map((x) => x.dias_restantes).sort()).toEqual([1, 2]);
    expect(await H.qn(db, "select * from public.acordo_alertas_do_operador($1)", [b.al])).toHaveLength(0);
    expect(await H.qn(db, "select * from public.acordo_alertas_do_operador($1)", [a1.al])).toHaveLength(2);
    await H.como(db, "naoresp@aelbra.com.br");
    expect(await H.qn(db, "select * from public.acordo_alertas_do_operador()")).toHaveLength(0);
    await H.como(db, H.GESTAO);
    expect((await H.qn(db, "select * from public.acordo_alertas_do_operador()")).length).toBeGreaterThanOrEqual(3);
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from public.acordo_alertas_do_operador()")).rejects.toThrow(/permission denied/i);
    await db.exec("reset role");
    await db.close();
  });
  it("tabela de alertas: operador so le o proprio (RLS) e nao escreve; anon nada", async () => {
    const db = await novo(); await mk(db, { nome: "Teste Rls", resp: H.OP6, parcelas: [{ venc: D }] }); await gerar(db, "2026-10-17");
    await db.exec("set role authenticated"); await H.como(db, "outro@aelbra.com.br");
    expect((await H.qn(db, "select count(*)::int n from acordo_alertas_parcela"))[0].n).toBe(0);
    await expect(db.query("delete from acordo_alertas_parcela")).rejects.toThrow(/permission denied/i);
    await H.como(db, H.OP6);
    expect((await H.qn(db, "select count(*)::int n from acordo_alertas_parcela"))[0].n).toBe(1);
    await db.close();
  });
});

describe("parametro retorno_antecedencia_dias 3 -> 2 (migration separada, data-only, reversivel)", () => {
  const MP = "20260922110100_param_retorno_antecedencia_2";
  it("muda so a linha do parametro (3 -> 2), nao toca outra linha, e o rollback devolve {dias:3}", async () => {
    const db = await novo();
    await db.query("insert into calibragem_parametros (chave, valor) values ('retorno_antecedencia_dias', '{\"dias\": 3}'::jsonb) on conflict (chave) do update set valor = excluded.valor");
    const outras = (await H.qn(db, "select chave, valor from calibragem_parametros where chave <> 'retorno_antecedencia_dias' order by chave"));
    await db.exec(H.MIG(MP));
    expect((await H.q1(db, "select valor from calibragem_parametros where chave='retorno_antecedencia_dias'")).valor).toEqual({ dias: 2 });
    expect(await H.qn(db, "select chave, valor from calibragem_parametros where chave <> 'retorno_antecedencia_dias' order by chave")).toEqual(outras);
    await db.exec(H.ROLL(MP));
    expect((await H.q1(db, "select valor from calibragem_parametros where chave='retorno_antecedencia_dias'")).valor).toEqual({ dias: 3 });
    // idempotente: rodar de novo nao muda nada de errado
    await db.exec(H.MIG(MP)); await db.exec(H.MIG(MP));
    expect((await H.q1(db, "select valor from calibragem_parametros where chave='retorno_antecedencia_dias'")).valor).toEqual({ dias: 2 });
    await db.close();
  });
  it("e data-only: sem DDL nem funcao", () => {
    const sql = H.MIG(MP).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?(function|table|trigger)|alter\s+table|drop\s+/i);
  });
});

describe("isolamento: o alerta nunca altera nada operacional e nao muda elegibilidade (Bloco 4)", () => {
  it("Ivina (ficticia) apos confirmacao processada: gerar alerta em D-2 => diff de TODAS as tabelas operacionais vazio; fora das Acoes Massivas, protegida, fidelizacao 0, nao redistribuivel", async () => {
    const db = await novo(BASE_POSCRON);
    await db.query("insert into calibragem_parametros (chave, valor) values ('confirmacao_utc_min','{\"n\":1}') on conflict (chave) do update set valor = excluded.valor");
    await db.query("select set_config('reativa.fluxo_pagamentos','on',false)");
    await db.query("select public.confirmacao_encerrar_processadas(200)");
    await db.query("select set_config('reativa.fluxo_pagamentos','',false)");
    expect((await H.q1(db, "select situacao_operacional from alunos where id=$1", [H.ALUNO_A])).situacao_operacional).toBe("ACORDO_EM_DIA");
    const n4 = (await H.q1(db, "select vencimento::text v from parcelas where status='A_VENCER' and acordo_id in (select id from acordos where aluno_id=$1)", [H.ALUNO_A])).v;
    const hoje = iso(new Date(fixo(n4).getTime() - 2 * 86400000));
    const antes = await H.snap(db);
    await gerar(db, hoje);
    const dep = await H.snap(db);
    const df = H.diff(antes, dep);
    expect(df.every((x) => x.t === "alertas")).toBe(true);
    expect(df).toHaveLength(1);
    expect((await H.qn(db, "select responsavel_email from acordo_alertas_parcela"))[0].responsavel_email).toBe(H.OP6);
    const u = await H.qn(db, "select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify({ aluno_ids: [H.ALUNO_A], operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS" })]);
    expect(u).toHaveLength(0);
    const cs = await H.q1(db, "select cpf_limpo,status_acionamento,nao_acionar,status_financeiro,valor_pago,quitado_em,valor_quitado from casos where aluno_id=$1", [H.ALUNO_A]);
    expect((await H.q1(db, "select public.caso_protegido_redistribuicao($1,$2,$3,$4,$5,$6,$7) p", Object.values(cs))).p).toBe(true);
    expect((await H.q1(db, "select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao() where aluno_id=$1", [H.ALUNO_A])).n).toBe(0);
    await db.close();
  });
  it("a migration nao cria cron/job, nao referencia acordos.saldo e nao escreve em alunos/casos/parcelas/acordos", () => {
    const sql = H.MIG(MA).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/cron\.schedule|cron\.job|pg_cron/i);
    expect(sql).not.toMatch(/\ba\.saldo\b|acordos\.saldo/i);
    expect(sql).not.toMatch(/(update|insert\s+into|delete\s+from)\s+public\.(alunos|casos|parcelas|acordos)\b/i);
  });
  it("rollback remove tudo o que a migration criou", async () => {
    const db = H.abrir(BASE); await db.exec(H.ROLL(MA));
    expect((await H.q1(db, "select to_regclass('public.acordo_alertas_parcela') t")).t).toBeNull();
    expect((await H.q1(db, "select count(*)::int n from pg_proc where proname like 'acordo_alert%' or proname='acordo_classificar'")).n).toBe(0);
    expect((await H.q1(db, "select count(*)::int n from calibragem_parametros where chave='alerta_parcela_d2'")).n).toBe(0);
    await db.close();
  });
});
