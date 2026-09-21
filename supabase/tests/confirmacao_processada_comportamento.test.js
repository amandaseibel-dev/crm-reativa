// CONFIRMACAO JA PROCESSADA + ACORDO_EM_DIA (Blocos 1 e 2).
//
// Roda as migrations REAIS (20260922100000, 100100, 100200) e os rollbacks REAIS num PostgreSQL real (PGlite) sobre a fixture
// confirmacao_d2 (funcoes de producao com texto exato de pg_get_functiondef de 21/09/2026). Dados 100% FICTICIOS (nomes/CPFs
// inventados); as datas sao deslocadas para o dia da execucao. Unicos stubs: auth.*, sistema_sob_carga.
// Aproximacoes: etapas 'reconstruir_parcela_paga_antes' e 'recuperar_acordo_avista' do fluxo ficam desligadas (fora do escopo).
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { ehNaoAcionavel, ehQuitado } from "../../src/utils/carteiraFila.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = ["20260922100000_confirmacao_vinculo_pagamentos", "20260922100100_confirmacao_processada_resolver", "20260922100200_confirmacao_encerramento_processado"];
const FLAG_ON = "update public.fluxo_pagamentos_config set ligado = true where etapa = 'encerrar_confirmacao_processada'";
let PROD, MIGRADO, POSCRON;
const U = (n) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function abrirDump(dump, { auto = false, min = 1 } = {}) {
  const db = H.abrir(dump);
  await db.exec("set check_function_bodies = off; set timezone = 'UTC';");
  if (min) await db.query("insert into public.calibragem_parametros (chave, valor) values ('confirmacao_utc_min', $1::jsonb) on conflict (chave) do update set valor = excluded.valor", [JSON.stringify({ n: min })]);
  if (auto) await db.exec(FLAG_ON);
  await H.como(db, H.GESTAO);
  return db;
}
const clicar = async (db, id) => (await db.query("select public.confirmar_pagamento_solicitacao($1, null) j", [id])).rows[0].j;
const lote = async (db) => {
  await db.query("select set_config('reativa.fluxo_pagamentos','on',false)");
  const j = (await db.query("select public.confirmacao_encerrar_processadas(200) j")).rows[0].j;
  await db.query("select set_config('reativa.fluxo_pagamentos','',false)");
  return j;
};
const proc = async (db, id) => (await db.query("select public.confirmacao_pagamento_processado($1) j", [id])).rows[0].j;
const semFinanceiro = (df) => !df.some((x) => H.FINANCEIRAS.includes(x.t));

// massa: aluno + acordo ATIVO com N parcelas (boleto confiavel), estado de import (AGUARDANDO_BAIXA)
async function massa(db, { n, nome, cpf, parcelas, status = "AGUARDANDO_BAIXA" }) {
  const al = U(n), ac = U(n + 1000);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,status_atual,status_jornada,status_acionamento,responsavel_atual_email) values ($1,$2,$3,$4,0,'CONTATAR','CONTATAR','CONTATAR',$5)", [al, nome, cpf, String(n), H.OP6]);
  await db.query("insert into casos(id,aluno_id,nome,cpf_limpo,cpf,operador_email,operador_nome,status_atual,status_acionamento) values ($1,$2,$3,$4,$4,$5,'Operador Seis','CONTATAR','CONTATAR')", [U(n + 2000), al, nome, cpf, H.OP6]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) values ($1,$2,$3,'ATIVO',1000,1000,$4,$5,$6,$7)", [ac, al, cpf, parcelas.length, String(70000 + n), 9000 + n, H.OP6]);
  const ps = [];
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i]; const id = U(n + 3000 + i); ps.push({ id, boleto: p.boleto, valor: p.valor });
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status,boleto,boleto_confiavel) values ($1,$2,$3,$4,current_date + $5::int,$6,$7,true)", [id, ac, i + 1, p.valor, p.venc, p.status || "VENCIDA", p.boleto]);
  }
  // parcela futura extra (sem boleto): o acordo nunca quita so com o import (quitar libera o caso e mexe no responsavel, fora do escopo destes testes)
  await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,$3,10,current_date + 90,'A_VENCER')", [U(n + 3500), ac, parcelas.length + 1]);
  // estado de import (o gatilho _aluno_aguardando_baixa_ao_confirmar poe o aluno em AGUARDANDO_BAIXA): so depois das parcelas,
  // porque a insercao de parcela aberta em aluno AGUARDANDO_BAIXA o reabre (_reabrir_aluno_com_divida_nova).
  await db.query("update alunos set status_atual=$2, status_jornada=$2, status_acionamento=$2 where id=$1", [al, status]);
  await db.query("update casos set status_atual=$2, status_acionamento='Aguardando confirmação de pagamento' where aluno_id=$1", [al, status]);
  return { al, ac, ps };
}
const importar = (db, nome, al, linhas) =>
  db.query(
    `insert into pagamentos(aluno_id,aluno_nome,data_pagamento,valor_pago,numero_parcela_completo,dados) values ${linhas.map((l) => `($1,$2,current_date,${Number(l.valor)},'${l.boleto}','{}')`).join(",")}`,
    [al, nome]
  );
const confDe = async (db, al) => (await db.query("select id,status,valor_informado::float v,observacao_adm,confirmado_por from solicitacoes_confirmacao_pagamento where aluno_id=$1 order by criado_em, id", [al])).rows;

beforeAll(async () => {
  const db = await H.montarProd();
  PROD = await db.dumpDataDir();
  for (const m of M) await db.exec(H.MIG(m));
  MIGRADO = await db.dumpDataDir();
  await H.posCron(db);
  POSCRON = await db.dumpDataDir();
  await db.close();
});

describe("Bloco 1a: vinculo gravado na origem", () => {
  it("import de 2 pagamentos do mesmo dia => 1 confirmacao (soma) e 2 vinculos; outro aluno => 1 vinculo; sem backfill do legado", async () => {
    const db = await abrirDump(MIGRADO);
    expect((await H.qn(db, "select count(*)::int n from solicitacao_confirmacao_pagamentos"))[0].n).toBe(0); // legado sem vinculo
    const a = await massa(db, { n: 10, nome: "Aluno Grupo Um", cpf: "10000000010", parcelas: [{ boleto: "50888880001", valor: 100, venc: -2 }, { boleto: "50888880002", valor: 150, venc: -1 }] });
    await importar(db, "Aluno Grupo Um", a.al, [{ boleto: "50888880001", valor: 100 }, { boleto: "50888880002", valor: 150 }]);
    const c = await confDe(db, a.al);
    expect(c).toHaveLength(1);
    expect(c[0].v).toBe(250);
    expect((await H.qn(db, "select count(*)::int n from solicitacao_confirmacao_pagamentos where confirmacao_id=$1", [c[0].id]))[0].n).toBe(2);
    await db.close();
  });
  it("confirmacao manual aberta do mesmo aluno/dia nunca recebe o vinculo do import", async () => {
    const db = await abrirDump(MIGRADO);
    const a = await massa(db, { n: 20, nome: "Aluno Manual Dois", cpf: "10000000020", parcelas: [{ boleto: "50888880011", valor: 100, venc: -2 }] });
    await db.query("insert into solicitacoes_confirmacao_pagamento(id,aluno_id,aluno_nome,valor_informado,data_pagamento,status,motivo) values ($1,$2,'Aluno Manual Dois',100,current_date,'AGUARDANDO_CONFIRMACAO','manual')", [U(9999), a.al]);
    await importar(db, "Aluno Manual Dois", a.al, [{ boleto: "50888880011", valor: 100 }]);
    expect((await H.qn(db, "select count(*)::int n from solicitacao_confirmacao_pagamentos where confirmacao_id=$1", [U(9999)]))[0].n).toBe(0);
    await db.close();
  });
  it("UNIQUE(pagamento_id): o mesmo pagamento nao vai para duas confirmacoes; reimport do mesmo dia ACRESCENTA vinculo sem mover", async () => {
    const db = await abrirDump(MIGRADO);
    const a = await massa(db, { n: 30, nome: "Aluno Reimport Tres", cpf: "10000000030", parcelas: [{ boleto: "50888880021", valor: 100, venc: -2 }, { boleto: "50888880022", valor: 50, venc: -1 }] });
    await importar(db, "Aluno Reimport Tres", a.al, [{ boleto: "50888880021", valor: 100 }]);
    const [c1] = await confDe(db, a.al);
    const antes = (await H.qn(db, "select pagamento_id from solicitacao_confirmacao_pagamentos where confirmacao_id=$1", [c1.id])).map((r) => r.pagamento_id);
    await importar(db, "Aluno Reimport Tres", a.al, [{ boleto: "50888880022", valor: 50 }]);
    expect(await confDe(db, a.al)).toHaveLength(1);
    const dep = (await H.qn(db, "select pagamento_id from solicitacao_confirmacao_pagamentos where confirmacao_id=$1", [c1.id])).map((r) => r.pagamento_id);
    expect(dep).toHaveLength(2);
    antes.forEach((p) => expect(dep).toContain(p));
    await db.query("insert into solicitacoes_confirmacao_pagamento(id,aluno_id,aluno_nome,valor_informado,data_pagamento,status,motivo) values ($1,$2,'x',1,current_date,'AGUARDANDO_CONFIRMACAO','manual')", [U(9998), a.al]);
    await expect(db.query("insert into solicitacao_confirmacao_pagamentos(confirmacao_id,pagamento_id) values ($1,$2)", [U(9998), antes[0]])).rejects.toThrow(/unique|duplicate/i);
    await db.close();
  });
  it("RLS: operador nao le nem escreve; gestao le; anon sem acesso; o trigger definer grava com RLS ligada", async () => {
    const db = await abrirDump(MIGRADO);
    const a = await massa(db, { n: 40, nome: "Aluno Rls Quatro", cpf: "10000000040", parcelas: [{ boleto: "50888880031", valor: 100, venc: -2 }] });
    await importar(db, "Aluno Rls Quatro", a.al, [{ boleto: "50888880031", valor: 100 }]);
    await db.exec("set role authenticated");
    await H.como(db, H.OP6);
    expect((await H.qn(db, "select count(*)::int n from solicitacao_confirmacao_pagamentos"))[0].n).toBe(0);
    await expect(db.query("insert into solicitacao_confirmacao_pagamentos(confirmacao_id,pagamento_id) values ($1,$2)", [U(1), U(2)])).rejects.toThrow(/row-level|permission/i);
    await H.como(db, H.GESTAO);
    expect((await H.qn(db, "select count(*)::int n from solicitacao_confirmacao_pagamentos"))[0].n).toBe(1);
    await db.exec("reset role; set role anon");
    await expect(db.query("select 1 from solicitacao_confirmacao_pagamentos")).rejects.toThrow(/permission denied/i);
    await db.exec("reset role");
    await db.close();
  });
});

describe("Bloco 1c/2: a Ivina (fictícia) pos-cron, legado sem vinculo, fuso provado", () => {
  it("resolver legado = CHAVE_MESMA_TRANSACAO e processado = PROCESSADO (BAIXADO + parcela PAGO + origem_baixa_ref)", async () => {
    const db = await abrirDump(POSCRON);
    const r = (await H.qn(db, "select * from confirmacao_pagamentos_resolver($1)", [H.CONF_A]));
    expect(r.map((x) => x.prova)).toEqual(["CHAVE_MESMA_TRANSACAO"]);
    const p = await proc(db, H.CONF_A);
    expect(p.estado).toBe("PROCESSADO");
    await db.close();
  });
  it("A) encerramento automatico: sem escrita financeira, obs, sem log, responsavel preservado, aluno = ACORDO_EM_DIA (nunca ACORDO_FECHADO), acordo ATIVO, n4 aberta", async () => {
    const db = await abrirDump(POSCRON);
    const a = await H.snap(db);
    const res = await lote(db);
    const d = await H.snap(db);
    const df = H.diff(a, d);
    expect(res.encerradas).toBe(1);
    expect(semFinanceiro(df)).toBe(true);
    const c = d.solicitacoes.find((x) => x.id === H.CONF_A);
    expect(c.status).toBe("PAGAMENTO_CONFIRMADO");
    expect(c.observacao_adm).toMatch(/^encerrada automaticamente: pagamento já processado \(.*\)/);
    expect(d.log_quitacao_bloqueada).toHaveLength(0);
    const al = d.alunos.find((x) => x.id === H.ALUNO_A);
    expect(al.status_atual).toBe("ACORDO_EM_DIA");
    expect(al.status_jornada).toBe("ACORDO_EM_DIA");
    expect(al.status_acionamento).toBe("ACORDO_EM_DIA");
    expect(al.situacao_operacional).toBe("ACORDO_EM_DIA");
    expect(al.responsavel_atual_email).toBe(H.OP6);
    expect(al.saldo_total).toBe(665.98);
    expect(d.casos.find((x) => x.aluno_id === H.ALUNO_A)).toMatchObject({ operador_email: H.OP6, status_acionamento: "ACORDO_EM_DIA", saldo_total: 665.98 });
    expect(d.acordos.find((x) => x.status === "ATIVO" && x.valor_total === 2663.65)).toBeTruthy();
    expect(d.parcelas.filter((x) => x.status === "A_VENCER")).toHaveLength(1);
    expect(d.baixas_pagamento).toEqual(a.baixas_pagamento);
    expect(JSON.stringify(d.alunos).includes("ACORDO_FECHADO")).toBe(false);
    await db.close();
  });
  it("E) segunda execucao (lote e clique): diff zero", async () => {
    const db = await abrirDump(POSCRON);
    await lote(db);
    const a = await H.snap(db);
    const r2 = await lote(db);
    const r3 = await clicar(db, H.CONF_A);
    expect(r2.encerradas).toBe(0);
    expect(r3.ja_processado).toBe(true);
    expect(H.diff(a, await H.snap(db))).toEqual([]);
    await db.close();
  });
  it("Bloco 2: com ACORDO_EM_DIA o aluno aparece na Fila/Minha Carteira, fora das Acoes Massivas, protegido, fidelizacao 0, nao redistribuivel", async () => {
    const db = await abrirDump(POSCRON);
    await lote(db);
    const al = await H.q1(db, "select * from alunos where id=$1", [H.ALUNO_A]);
    expect(ehNaoAcionavel({ ...al, saldo_total: Number(al.saldo_total) }, new Set())).toBe(false);
    expect(ehQuitado(al)).toBe(false);
    expect(["QUITADO_MANUAL", "QUITADO", "AGUARDANDO_BAIXA", "BAIXA_REALIZADA", "SEM_SALDO_EM_ABERTO"].includes(al.status_jornada)).toBe(false); // FilaOperacional.jsx:422
    const u = await H.qn(db, "select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify({ aluno_ids: [H.ALUNO_A], operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS" })]);
    expect(u).toHaveLength(0);
    const cs = await H.q1(db, "select cpf_limpo,status_acionamento,nao_acionar,status_financeiro,valor_pago,quitado_em,valor_quitado from casos where aluno_id=$1", [H.ALUNO_A]);
    expect((await H.q1(db, "select public.caso_protegido_redistribuicao($1,$2,$3,$4,$5,$6,$7) p", Object.values(cs))).p).toBe(true);
    expect((await H.q1(db, "select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao() where aluno_id=$1", [H.ALUNO_A])).n).toBe(0);
    await db.close();
  });
  it("B) saldo zero: mesma confirmacao encerra e a quitacao segue o fluxo existente (aluno/caso QUITADO); nenhuma parcela/baixa/pagamento muda", async () => {
    const db = await abrirDump(POSCRON);
    await db.query("delete from parcelas where numero = 4 and acordo_id in (select id from acordos where aluno_id=$1)", [H.ALUNO_A]);
    await db.query("select public.recalcular_situacao_aluno($1)", [H.ALUNO_A]);
    const a = await H.snap(db);
    const res = await lote(db);
    const d = await H.snap(db);
    expect(res.encerradas).toBe(1);
    expect(semFinanceiro(H.diff(a, d))).toBe(true);
    expect(d.alunos.find((x) => x.id === H.ALUNO_A).status_atual).toBe("QUITADO");
    expect(d.casos.find((x) => x.aluno_id === H.ALUNO_A).status_financeiro).toBe("QUITADO_CONFIRMACAO");
    expect(d.aluno_movimentacoes.some((m) => m.tipo === "QUITACAO_CONFIRMADA")).toBe(true);
    await db.close();
  });
  it("fuso: com a sessao em America/Sao_Paulo a chave legada falha fechada (SEM_VINCULO) e o lote nao encerra nada", async () => {
    const db = await abrirDump(POSCRON);
    await db.exec("set timezone = 'America/Sao_Paulo'");
    expect((await H.q1(db, "select public.confirmacao_utc_provada() p")).p).toBe(false);
    const r = await H.qn(db, "select * from confirmacao_pagamentos_resolver($1)", [H.CONF_A]);
    expect(r[0].prova).toBe("SEM_VINCULO");
    const a = await H.snap(db);
    const res = await lote(db);
    expect(res.encerradas).toBe(0);
    expect(H.diff(a, await H.snap(db))).toEqual([]);
    await db.close();
  });
  it("fuso: sem amostra que prove UTC (minimo nao atingido) tambem falha fechada", async () => {
    const db = await abrirDump(POSCRON, { min: 50 });
    expect((await H.q1(db, "select public.confirmacao_utc_provada() p")).p).toBe(false);
    expect((await proc(db, H.CONF_A)).estado).toBe("NAO_PROCESSADO");
    await db.close();
  });
  it("fuso: amostra gravada em outro fuso (created_at deslocado -3h) => nao provado", async () => {
    const db = await abrirDump(POSCRON);
    await db.exec("update public.pagamentos set created_at = created_at - interval '3 hours' where created_at::date = current_date");
    expect((await H.q1(db, "select public.confirmacao_utc_provada() p")).p).toBe(false);
    await db.close();
  });
});

describe("Bloco 1c: fluxo de import com vinculo (automatico, flag ligada) e casos de borda", () => {
  it("flag DESLIGADA (padrao da migration): o import nao encerra nada; ligar nao processa o legado sem vinculo", async () => {
    const db = await abrirDump(MIGRADO); // flag off por padrao
    expect((await H.q1(db, "select ligado from fluxo_pagamentos_config where etapa='encerrar_confirmacao_processada'")).ligado).toBe(false);
    const a = await massa(db, { n: 50, nome: "Aluno Flag Cinco", cpf: "10000000050", parcelas: [{ boleto: "50888880041", valor: 100, venc: -2 }, { boleto: "50888880042", valor: 100, venc: 30, status: "A_VENCER" }] });
    await importar(db, "Aluno Flag Cinco", a.al, [{ boleto: "50888880041", valor: 100 }]);
    expect((await confDe(db, a.al))[0].status).toBe("AGUARDANDO_CONFIRMACAO");
    await db.close();
  });
  it("import com todos os pagamentos baixados e flag ligada: confirmacao encerra sozinha na mesma importacao (uma so vez) e o aluno vira ACORDO_EM_DIA", async () => {
    const db = await abrirDump(MIGRADO, { auto: true });
    const a = await massa(db, { n: 60, nome: "Aluno Auto Seis", cpf: "10000000060", parcelas: [{ boleto: "50888880051", valor: 100, venc: -2 }, { boleto: "50888880052", valor: 150, venc: -1 }, { boleto: "50888880053", valor: 200, venc: 30, status: "A_VENCER" }] });
    const antes = await H.snap(db);
    await importar(db, "Aluno Auto Seis", a.al, [{ boleto: "50888880051", valor: 100 }, { boleto: "50888880052", valor: 150 }]);
    const [c] = await confDe(db, a.al);
    expect(c.status).toBe("PAGAMENTO_CONFIRMADO");
    expect(c.observacao_adm).toMatch(/encerrada automaticamente: pagamento já processado \(.*,.*\)/);
    expect(c.confirmado_por).toBe("sistema_confirmacao_automatica");
    const d = await H.snap(db);
    expect(d.parcelas.filter((p) => p.acordo_id === a.ac && p.status === "PAGO")).toHaveLength(2);
    expect(d.parcelas.filter((p) => p.acordo_id === a.ac && p.status === "PAGO").every((p) => p.origem_baixa === "GATILHO_IMPORTACAO")).toBe(true);
    expect(d.baixas_pagamento).toEqual(antes.baixas_pagamento);
    expect(d.log_quitacao_bloqueada).toHaveLength(0);
    const al = d.alunos.find((x) => x.id === a.al);
    expect(al.status_atual).toBe("ACORDO_EM_DIA");
    expect(al.responsavel_atual_email).toBe(H.OP6);
    // idempotencia: lote de novo e reprocessamento do motor nao mexem
    const s1 = await H.snap(db);
    await lote(db);
    await db.query("select set_config('reativa.fluxo_pagamentos','on',false)");
    await db.query("select public.conciliacao_reprocessar(true,5000)");
    await db.query("select set_config('reativa.fluxo_pagamentos','',false)");
    expect(H.diff(s1, await H.snap(db)).filter((x) => x.t !== "pagamentos" && x.t !== "auditoria")).toEqual([]);
    await db.close();
  });
  it("baixa posterior (pagamento vira BAIXADO depois pela conciliacao) dispara o encerramento pelo trigger, sem recursao", async () => {
    const db = await abrirDump(MIGRADO, { auto: true });
    const a = await massa(db, { n: 70, nome: "Aluno Tardio Sete", cpf: "10000000070", parcelas: [{ boleto: "50888880061", valor: 100, venc: -2, status: "VENCIDA" }, { boleto: "50888880062", valor: 100, venc: 30, status: "A_VENCER" }] });
    // boleto do pagamento ainda nao amarrado: fica pendente; confirmacao nasce aberta
    await importar(db, "Aluno Tardio Sete", a.al, [{ boleto: "50888889999", valor: 100 }]);
    expect((await confDe(db, a.al))[0].status).toBe("AGUARDANDO_CONFIRMACAO");
    await db.query("update parcelas set boleto = '50888889999' where id = $1", [a.ps[0].id]); // amarracao posterior
    await db.query("select set_config('reativa.fluxo_pagamentos','on',false)");
    await db.query("select public.conciliacao_reprocessar(true,5000)");
    await db.query("select set_config('reativa.fluxo_pagamentos','',false)");
    expect((await confDe(db, a.al))[0].status).toBe("PAGAMENTO_CONFIRMADO");
    expect((await H.q1(db, "select count(*)::int n from baixas_pagamento where aluno_id=$1", [a.al])).n).toBe(0);
    await db.close();
  });
  it("grupo PARCIALMENTE processado => REVISAO (nao encerra, nao baixa, nao reverte; so auditoria); clique do grupo e 2a execucao: diff zero", async () => {
    const db = await abrirDump(MIGRADO, { auto: true });
    const a = await massa(db, { n: 80, nome: "Aluno Parcial Oito", cpf: "10000000080", parcelas: [{ boleto: "50888880071", valor: 100, venc: -2 }, { boleto: "50888880072", valor: 150, venc: -1 }] });
    await importar(db, "Aluno Parcial Oito", a.al, [{ boleto: "50888880071", valor: 100 }, { boleto: "50888889998", valor: 150 }]); // 2o boleto nao amarrado
    const [c] = await confDe(db, a.al);
    expect(c.status).toBe("AGUARDANDO_CONFIRMACAO");
    const p = await proc(db, c.id);
    expect(p.estado).toBe("REVISAO");
    expect(p.motivo).toBe("GRUPO_PARCIALMENTE_PROCESSADO");
    expect(p.provas_por_pagamento).toHaveLength(2);
    const ant = await H.snap(db);
    const r1 = await clicar(db, c.id);
    expect(r1).toMatchObject({ revisao: true });
    expect(r1.motivo).toBe("GRUPO_PARCIALMENTE_PROCESSADO");
    const d1 = await H.snap(db);
    const df = H.diff(ant, d1);
    expect(df.every((x) => x.t === "auditoria")).toBe(true);
    expect(d1.parcelas.filter((x) => x.acordo_id === a.ac && x.status === "PAGO")).toHaveLength(1); // a parcela 1 continua paga uma vez
    expect(d1.baixas_pagamento).toEqual(ant.baixas_pagamento);
    const r2 = await clicar(db, c.id);
    expect(r2.revisao).toBe(true);
    expect(H.diff(d1, await H.snap(db))).toEqual([]);
    const lot = await lote(db);
    expect(lot.encerradas).toBe(0);
    expect(lot.revisao).toBe(1);
    await db.close();
  });
  it("ambiguo (reimport: soma nao confere) => REVISAO; soma incorreta => REVISAO; pagamento de outro aluno no grupo => REVISAO", async () => {
    const db = await abrirDump(MIGRADO, { auto: true });
    const a = await massa(db, { n: 90, nome: "Aluno Ambiguo Nove", cpf: "10000000090", parcelas: [{ boleto: "50888880081", valor: 100, venc: -2 }, { boleto: "50888880082", valor: 50, venc: -1 }, { boleto: "50888880083", valor: 300, venc: 30, status: "A_VENCER" }] });
    await importar(db, "Aluno Ambiguo Nove", a.al, [{ boleto: "50888889997", valor: 100 }]);            // pendente
    await importar(db, "Aluno Ambiguo Nove", a.al, [{ boleto: "50888889996", valor: 50 }]);              // reimport do dia: valor_informado = so o lote novo
    const [c] = await confDe(db, a.al);
    const p = await proc(db, c.id);
    expect(p.estado).toBe("REVISAO");
    const r = await clicar(db, c.id);
    expect(r.revisao).toBe(true);
    await db.query("update solicitacoes_confirmacao_pagamento set valor_informado = 999 where id=$1", [c.id]);
    expect((await proc(db, c.id)).estado).toBe("REVISAO");
    await db.query("update pagamentos set aluno_id = $1 where numero_parcela_completo = '50888889997'", [H.ALUNO_B]);
    expect((await proc(db, c.id)).estado).toBe("REVISAO");
    expect((await lote(db)).encerradas).toBe(0);
    await db.close();
  });
  it("sem vinculo (confirmacao manual) => fluxo atual: o lote pula, o clique confirma como hoje; baixa em baixas_pagamento sem origem_baixa_ref nao prova", async () => {
    const db = await abrirDump(MIGRADO, { auto: true });
    const a = await massa(db, { n: 100, nome: "Aluno Manual Dez", cpf: "10000000100", parcelas: [{ boleto: "50888880091", valor: 100, venc: -2, status: "PAGO" }, { boleto: "50888880092", valor: 100, venc: 30, status: "A_VENCER" }] });
    await db.query("insert into solicitacoes_confirmacao_pagamento(id,aluno_id,aluno_nome,valor_informado,data_pagamento,status,motivo) values ($1,$2,'Aluno Manual Dez',100,current_date,'AGUARDANDO_CONFIRMACAO','manual')", [U(9990), a.al]);
    await db.query("insert into baixas_pagamento(id,aluno_id,parcela_id,acordo_id,status_baixa,valor_pago,baixado_por_email) values (gen_random_uuid(),$1,$2,$3,'REALIZADA',100,'x@y')", [a.al, a.ps[0].id, a.ac]);
    const p = await proc(db, U(9990));
    expect(p.estado).toBe("NAO_PROCESSADO");
    expect((await lote(db)).encerradas).toBe(0);
    const r = await clicar(db, U(9990));
    expect(r.revisao).toBeUndefined();
    expect((await H.q1(db, "select status from solicitacoes_confirmacao_pagamento where id=$1", [U(9990)])).status).toBe("PAGAMENTO_CONFIRMADO");
    await db.close();
  });
  it("pagamento NAO baixado (AGUARDANDO_ACORDO/PARCELA_JA_PAGA) nao e processado: comportamento atual preservado (igual a producao)", async () => {
    const setup = async (dump) => {
      const db = await abrirDump(dump);
      const a = await massa(db, { n: 110, nome: "Aluno Pendente Onze", cpf: "10000000110", parcelas: [{ boleto: "50888880101", valor: 100, venc: 30, status: "A_VENCER" }] });
      await importar(db, "Aluno Pendente Onze", a.al, [{ boleto: "50888889995", valor: 100 }]);
      return { db, a };
    };
    const P = await setup(PROD), N = await setup(MIGRADO);
    const cp = (await confDe(P.db, P.a.al))[0], cn = (await confDe(N.db, N.a.al))[0];
    expect((await proc(N.db, cn.id)).estado).toBe("NAO_PROCESSADO");
    const sp = await H.snap(P.db), sn = await H.snap(N.db);
    const rp = await clicar(P.db, cp.id), rn = await clicar(N.db, cn.id);
    delete rp.detalhe.confirmacao_ignorada; delete rn.detalhe.confirmacao_ignorada; // uuid aleatorio de cada banco
    expect(rn).toEqual(rp);
    const norm = (df) => df.filter((x) => x.t !== "vinculo").map((x) => [x.t, x.tipo]);
    expect(norm(H.diff(sn, await H.snap(N.db)))).toEqual(norm(H.diff(sp, await H.snap(P.db))));
    await P.db.close(); await N.db.close();
  });
  it("outra confirmacao aberta (nao processada) do mesmo aluno: so a processada encerra; o aluno segue AGUARDANDO_CONFIRMACAO", async () => {
    const db = await abrirDump(MIGRADO, { auto: true });
    const a = await massa(db, { n: 120, nome: "Aluno Outra Doze", cpf: "10000000120", parcelas: [{ boleto: "50888880111", valor: 100, venc: -2 }, { boleto: "50888880112", valor: 100, venc: 30, status: "A_VENCER" }] });
    await db.query("insert into solicitacoes_confirmacao_pagamento(id,aluno_id,aluno_nome,valor_informado,data_pagamento,status,motivo) values ($1,$2,'Aluno Outra Doze',80,current_date - 3,'AGUARDANDO_CONFIRMACAO','manual')", [U(9991), a.al]);
    await importar(db, "Aluno Outra Doze", a.al, [{ boleto: "50888880111", valor: 100 }]);
    const cs = await confDe(db, a.al);
    expect(cs.find((x) => x.id !== U(9991)).status).toBe("PAGAMENTO_CONFIRMADO");
    expect(cs.find((x) => x.id === U(9991)).status).toBe("AGUARDANDO_CONFIRMACAO");
    const al = await H.q1(db, "select status_atual,situacao_operacional from alunos where id=$1", [a.al]);
    expect(al.status_atual).toBe("AGUARDANDO_BAIXA");
    expect(al.situacao_operacional).toBe("AGUARDANDO_CONFIRMACAO");
    await db.close();
  });
  it("COBRANCA_VENCIDA legitima (outra divida vencida) nao e alterada: aluno sai do limbo para o status anterior/CONTATAR, situacao continua vencida", async () => {
    const db = await abrirDump(POSCRON);
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) select $1,aluno_id,cpf,'ATIVO',300,300,1,'71999',9777,$3 from acordos where aluno_id=$2 limit 1", [U(7001), H.ALUNO_A, H.OP6]);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,300,current_date - 10,'VENCIDA')", [U(7002), U(7001)]);
    // (existente em producao: divida nova em aluno AGUARDANDO_BAIXA o reabre como ACORDO_FECHADO; aqui volta ao limbo para testar a saida dele)
    await db.query("update alunos set status_atual='AGUARDANDO_BAIXA', status_jornada='AGUARDANDO_BAIXA', status_acionamento='AGUARDANDO_BAIXA' where id=$1", [H.ALUNO_A]);
    const res = await lote(db);
    expect(res.encerradas).toBe(1);
    const al = await H.q1(db, "select status_atual,situacao_operacional,saldo_vencido::float sv,responsavel_atual_email from alunos where id=$1", [H.ALUNO_A]);
    expect(al.situacao_operacional).toBe("COBRANCA_VENCIDA");
    expect(al.sv).toBe(300);
    expect(al.status_atual).toBe("CONTATAR");
    expect(al.responsavel_atual_email).toBe(H.OP6);
    await db.close();
  });
  it("Raissa (ficticia): PARCELA_JA_PAGA nao e processado, nao encerra indevidamente", async () => {
    const db = await abrirDump(POSCRON);
    await db.query("insert into solicitacoes_confirmacao_pagamento(id,aluno_id,aluno_nome,valor_informado,data_pagamento,status,motivo,criado_em) select $1,aluno_id::text,'Aluna Teste Beta',valor_pago,data_pagamento,'AGUARDANDO_CONFIRMACAO','Gerado do import de pagamentos Santander',created_at::timestamptz from pagamentos where aluno_id=$2 and status_conciliacao='PARCELA_JA_PAGA'", [U(8001), H.ALUNO_B]);
    const p = await proc(db, U(8001));
    expect(p.estado).toBe("NAO_PROCESSADO");
    expect((await lote(db)).encerradas).toBe(1); // so a da Alfa; a da Beta permanece aberta
    expect((await H.q1(db, "select status from solicitacoes_confirmacao_pagamento where id=$1", [U(8001)])).status).toBe("AGUARDANDO_CONFIRMACAO");
    await db.close();
  });
  it("falsos positivos: aluno/data/valor iguais em OUTRA transacao, mesma tx em OUTRA data, mesma tx com nome diferente => SEM_VINCULO", async () => {
    const db = await abrirDump(POSCRON);
    const ins = (id, aluno, nome, valor, data, tx) =>
      db.query("insert into solicitacoes_confirmacao_pagamento(id,aluno_id,aluno_nome,valor_informado,data_pagamento,status,motivo,criado_em) values ($1,$2,$3,$4,$5,'AGUARDANDO_CONFIRMACAO','manual',$6)", [id, aluno, nome, valor, data, tx]);
    const base = await H.q1(db, "select created_at::text c, data_pagamento::text d, valor_pago::float v from pagamentos where id='517638d0-6bb9-459a-95fb-146245c539f7'");
    await ins(U(6001), H.ALUNO_A, "Aluna Teste Alfa", base.v, base.d, "2001-01-01T00:00:00Z");
    await ins(U(6002), H.ALUNO_A, "Aluna Teste Alfa", base.v, "2001-01-01", base.c.replace(" ", "T") + "Z");
    await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total) values ($1,'Outra Pessoa Diferente','10000000199','199',0)", [U(6100)]);
    await ins(U(6003), U(6100), "Outra Pessoa Diferente", base.v, base.d, base.c.replace(" ", "T") + "Z");
    for (const id of [U(6001), U(6002), U(6003)]) {
      const r = await H.qn(db, "select prova from confirmacao_pagamentos_resolver($1)", [id]);
      expect(r[0].prova).toBe("SEM_VINCULO");
    }
    await db.close();
  });
});

describe("rollback restaura EXATAMENTE a producao", () => {
  it("apos os 3 rollbacks: md5 do pg_get_functiondef == producao; tabela e funcoes novas somem", async () => {
    const db = H.abrir(MIGRADO);
    await db.exec(H.ROLL(M[2])); await db.exec(H.ROLL(M[1])); await db.exec(H.ROLL(M[0]));
    const md5 = async (assin) => (await H.q1(db, "select md5(pg_get_functiondef($1::regprocedure)) m", [assin])).m;
    expect(await md5("public.confirmar_pagamento_solicitacao(uuid,text)")).toBe("1d9c24aa48fe34b7385a1b2627d73a88");
    expect(await md5("public._pagamentos_baixar_lote()")).toBe("34ad52699f58e2657c0a5eb21d84821e");
    expect(await md5("public.trg_pagamentos_gerar_confirmacao()")).toBe("9ba8d57594960ff839d22f92f3240066");
    expect((await H.q1(db, "select to_regclass('public.solicitacao_confirmacao_pagamentos') t")).t).toBeNull();
    expect((await H.q1(db, "select count(*)::int n from pg_proc where proname in ('confirmacao_encerrar_uma','confirmacao_pagamentos_resolver','confirmacao_encerrar_processadas')")).n).toBe(0);
    await db.close();
  });
  it("a migration aplicada ao texto de producao: o corpo de trg_pagamentos_gerar_confirmacao antes do bloco V-VINCULO e o de producao", async () => {
    const dep = H.abrir(MIGRADO);
    const src = (await H.q1(dep, "select prosrc from pg_proc where proname='trg_pagamentos_gerar_confirmacao'")).prosrc;
    const prod = H.abrir(PROD);
    const srcProd = (await H.q1(prod, "select prosrc from pg_proc where proname='trg_pagamentos_gerar_confirmacao'")).prosrc;
    expect(src.startsWith(srcProd.replace(/\n {2}return null;\nend;\n$/, ""))).toBe(true);
    await dep.close(); await prod.close();
  });
});
