// COMPORTAMENTO da reconstrucao da parcela paga antes da extracao
// (migration 20260917200000), em PGlite, com o motor e os gatilhos de producao.
//
// Os cenarios 72113 e 72153 repetem a estrutura lida em producao em 17/09/2026
// (ver a bancada). Nenhum dado pessoal real.
import { describe, it, expect } from "vitest";
import {
  novoBanco, semearAcordo, pagarEntrada, reconstruir, ligarEtapa, um, foto, boletoDe, CASOS,
  MIGRATION_NOVA, ROLLBACK_NOVA,
} from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const T = 120000;
const CASOS_REAIS = [
  // numero, parcelas importadas, total importado, entrada, qtd depois, total depois
  ["72113", 4, 3356.23, 2000, 5, 5356.23],
  ["72153", 6, 3289.58, 2193.05, 7, 5482.63],
];

async function cenario(numero, o = {}, banco = {}) {
  const db = await novoBanco(banco);
  const acordoId = await semearAcordo(db, numero, o);
  const pid = await pagarEntrada(db, numero, o);
  return { db, acordoId, pid };
}
const linhas = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const acordo = (db, id) => linhas(db, `select qtd_parcelas, valor_total::numeric::float8 as valor_total, saldo::numeric::float8 as saldo, status
                                         from public.acordos where id = $1`, [id]).then((r) => r[0]);
const pagamento = (db, id) => linhas(db, `select status_conciliacao, conciliacao_motivo from public.pagamentos where id = $1`, [id]).then((r) => r[0]);
const fila = (db, id) => linhas(db, `select decisao, decidido_por, status_conciliacao from public.fila_pagamento_sem_vinculo where pagamento_id = $1`, [id]).then((r) => r[0]);
const pendentes = (db) => um(db, `select public.parcela_paga_antes_reconstruir_pendentes(50)`);

describe("hoje: o motor sozinho deixa a entrada sem parcela", () => {
  it.each(CASOS_REAIS)("%s cai em REVISAO e nada é criado com a etapa desligada", async (numero, n, total) => {
    const { db, acordoId, pid } = await cenario(numero);
    expect(await pagamento(db, pid)).toEqual({ status_conciliacao: "REVISAO",
      conciliacao_motivo: `o acordo 0${numero} esta no CRM e nao tem parcela livre para receber o boleto ${boletoDe(numero, 1)}` });
    expect(await fila(db, pid)).toMatchObject({ decisao: null, status_conciliacao: "REVISAO" });
    expect(await acordo(db, acordoId)).toMatchObject({ qtd_parcelas: n, valor_total: total });
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id = $1`, [acordoId])).toBe(n);
    // a etapa nasce desligada
    expect(await um(db, `select ligado from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes'`)).toBe(false);
  }, T);
});

describe("simulação", () => {
  it.each(CASOS_REAIS)("%s: as 14 evidências fecham e NADA é gravado", async (numero, n, total, entrada, qtdDepois, totalDepois) => {
    const { db, pid } = await cenario(numero);
    const antes = await foto(db);
    const r = await reconstruir(db, pid, false);
    expect(await foto(db)).toEqual(antes);

    expect(r).toMatchObject({ modo: "SIMULACAO", gravou: false, aprovado: true, bloqueios: [] });
    expect(r.validacoes).toHaveLength(14);
    expect(r.validacoes.every((v) => v.ok)).toBe(true);
    expect(r.parcela_a_criar).toMatchObject({ numero: 1, boleto: boletoDe(numero, 1), valor: entrada, vencimento: "2026-09-18",
      boleto_confiavel: true, is_entrada: false });
    expect(r.acordo).toMatchObject({ numero_ulbra: numero, qtd_parcelas: n, valor_total: total, saldo: total });
    // a conta: quantidade + 1 e total + valor do boleto; o saldo nao muda (a parcela nasce e e baixada)
    expect(r.acordo_depois).toEqual({ qtd_parcelas: qtdDepois, valor_total: totalDepois, saldo: total });
    expect(Number((total + entrada).toFixed(2))).toBe(totalDepois);
  }, T);
});

describe("confirmação: cria só a parcela ausente e o MOTOR baixa", () => {
  it.each(CASOS_REAIS)("%s", async (numero, n, total, entrada, qtdDepois, totalDepois) => {
    const { db, acordoId, pid } = await cenario(numero);
    const c = CASOS[numero];
    const importadasAntes = await linhas(db, `select id, numero, boleto, valor, vencimento, status, boleto_confiavel
                                                from public.parcelas where acordo_id = $1 order by boleto`, [acordoId]);
    const chamadasRecalc = () => um(db, `select case when is_called then last_value::int else 0 end from public.chamadas_recalc`);
    const recalcAntes = await chamadasRecalc();

    const r = await reconstruir(db, pid, true);
    expect(r).toMatchObject({ ok: true, modo: "CONFIRMADO", gravou: true });

    // a parcela: boleto do proprio pagamento, confiavel, paga pelo motor com a referencia do pagamento
    const [nova] = await linhas(db, `select numero, boleto, valor::numeric::float8 as valor, vencimento::text as vencimento, status,
                                            boleto_confiavel, is_entrada, origem_baixa, origem_baixa_ref, pago_em::date::text as pago_em,
                                            confirmado_por_email, honorarios::numeric::float8 as honorarios, observacao
                                       from public.parcelas where acordo_id = $1 and boleto = $2`, [acordoId, boletoDe(numero, 1)]);
    expect(nova).toMatchObject({ numero: 1, boleto: boletoDe(numero, 1), valor: entrada, vencimento: "2026-09-18", status: "PAGO",
      boleto_confiavel: true, is_entrada: false, origem_baixa: "GATILHO_IMPORTACAO", origem_baixa_ref: pid, pago_em: "2026-09-16",
      confirmado_por_email: c.operador, honorarios: c.honorario });
    expect(nova.observacao).toMatch(/^PARCELA_PAGA_ANTES_DA_EXTRACAO \| pagamento /);
    expect(nova.observacao).toMatch(/baixa automatica na importacao: documento/);

    // as importadas nao mudam
    expect(await linhas(db, `select id, numero, boleto, valor, vencimento, status, boleto_confiavel
                               from public.parcelas where acordo_id = $1 and boleto <> $2 order by boleto`, [acordoId, boletoDe(numero, 1)]))
      .toEqual(importadasAntes);

    // o acordo fecha: quantidade e total batem com as parcelas; saldo e status intactos
    expect(await acordo(db, acordoId)).toEqual({ qtd_parcelas: qtdDepois, valor_total: totalDepois, saldo: total, status: "ATIVO" });
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id = $1`, [acordoId])).toBe(qtdDepois);
    expect(await um(db, `select sum(valor)::numeric::float8 from public.parcelas where acordo_id = $1`, [acordoId])).toBe(totalDepois);
    expect(await um(db, `select sum(valor)::numeric::float8 from public.parcelas where acordo_id = $1 and status <> 'PAGO'`, [acordoId]))
      .toBe(total);

    // pagamento baixado, fila resolvida, situacao do aluno recalculada pelo motor
    expect(await pagamento(db, pid)).toEqual({ status_conciliacao: "BAIXADO", conciliacao_motivo: null });
    expect(await fila(db, pid)).toEqual({ decisao: "RESOLVIDO_AUTOMATICO", decidido_por: "conciliacao@sistema", status_conciliacao: "BAIXADO" });
    expect(await chamadasRecalc()).toBeGreaterThan(recalcAntes);

    // efeito do gatilho de reabertura, o mesmo da importacao de acordo
    expect(await um(db, `select status_atual from public.alunos where id = $1`, [c.aluno])).toBe("ACORDO_FECHADO");
    expect(await um(db, `select string_agg(tipo, ',') from public.aluno_movimentacoes where aluno_id = $1`, [c.aluno]))
      .toBe("REABERTURA_DIVIDA_NOVA");

    // auditoria com antes, depois e a resposta do motor
    const aud = await linhas(db, `select usuario, acao, tabela_afetada, detalhes from public.auditoria`);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario: "conciliacao@sistema", acao: "RECONSTRUCAO_PARCELA_PAGA_ANTES_DA_EXTRACAO", tabela_afetada: "parcelas" });
    expect(aud[0].detalhes).toMatchObject({ pagamento_id: pid, acordo_id: acordoId, disparado_por: "rotina",
      motor: { status: "BAIXADO", baixou: true }, antes: { aprovado: true }, depois: { acordo: { qtd_parcelas: qtdDepois } } });
  }, T);
});

describe("reprocessar duas vezes não duplica nada", () => {
  it("segunda confirmação, lote, motor e rodada horária: nenhuma escrita", async () => {
    const { db, pid } = await cenario("72113", {}, { etapaLigada: false });
    await reconstruir(db, pid, true);
    await ligarEtapa(db);
    const depois = await foto(db);

    const r2 = await reconstruir(db, pid, true);
    expect(r2).toMatchObject({ modo: "RECUSADO", gravou: false, aprovado: false });
    expect(r2.bloqueios).toEqual(expect.arrayContaining(["PAGAMENTO_PENDENTE", "BOLETO_SEM_PARCELA", "PARCELA_IMEDIATAMENTE_ANTERIOR"]));
    expect(await foto(db)).toEqual(depois);

    expect(await pendentes(db)).toMatchObject({ avaliados: 0, reconstruidas: 0, erros: 0 });
    expect(await um(db, `select public.pagamento_conciliar_um($1, true)`, [pid])).toMatchObject({ status: "BAIXADO", baixou: false });
    for (let i = 0; i < 2; i++) await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(await foto(db)).toEqual(depois);
    expect(await um(db, `select count(*)::int from public.parcelas where boleto = $1`, [boletoDe("72113", 1)])).toBe(1);
  }, T);

  it("o mesmo boleto chegando de novo depois da reconstrução vira PARCELA_JA_PAGA, sem segunda parcela", async () => {
    const { db, acordoId, pid } = await cenario("72113", {}, { etapaLigada: true });
    expect(await pagamento(db, pid)).toMatchObject({ status_conciliacao: "BAIXADO" });
    const outro = await pagarEntrada(db, "72113", { pagamentoId: "00000000-0000-4000-9000-000000000999" });
    expect(await pagamento(db, outro)).toMatchObject({ status_conciliacao: "PARCELA_JA_PAGA" });
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id = $1`, [acordoId])).toBe(5);
    expect(await um(db, `select count(*)::int from public.auditoria where acao = 'RECONSTRUCAO_PARCELA_PAGA_ANTES_DA_EXTRACAO'`)).toBe(1);
  }, T);

  it("o índice único do boleto barra uma segunda parcela mesmo por fora da função", async () => {
    const { db, acordoId, pid } = await cenario("72113");
    await reconstruir(db, pid, true);
    await expect(db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, boleto) values ($1, 1, 2000, '2026-09-18', $2)`,
      [acordoId, boletoDe("72113", 1)])).rejects.toThrow(/ux_parcelas_boleto|duplicate/);
  }, T);
});

// Cada evidencia falhando SOZINHA: nada e criado, o pagamento continua em
// Pagamentos a conciliar e o motivo sai da previa e do lote.
const EVIDENCIAS = [
  ["PAGAMENTO_PENDENTE", "decisão já registrada na fila", {},
    (db, pid) => db.query(`update public.fila_pagamento_sem_vinculo set decisao = 'MANTER_EM_REVISAO', decidido_por = 'gestao' where pagamento_id = $1`, [pid])],
  ["PAGAMENTO_PENDENTE", "pagamento estornado", { dadosExtra: { estornado_em: "2026-09-17" } }],
  ["ALUNO_IDENTIFICADO", "homônimo na base", {},
    (db) => db.query(`insert into public.alunos (id, nome, cpf, status_atual) values (gen_random_uuid(), 'ALUNA DE TESTE UM', '70000000001', 'EM_COBRANCA')`)],
  ["ALUNO_IDENTIFICADO", "matrícula aponta dois CPFs", {},
    (db) => db.query(`insert into public.prime_contratos (cpf, registration) values ('70000000002', '2026001113')`)],
  ["ALUNO_IDENTIFICADO", "pagamento já ligado a outro aluno", {},
    async (db, pid) => {
      await db.query(`insert into public.alunos (id, nome, cpf, status_atual) values ('00000000-0000-4000-8000-000000000001', 'OUTRA PESSOA', '70000000003', 'EM_COBRANCA')`);
      await db.query(`update public.pagamentos set aluno_id = '00000000-0000-4000-8000-000000000001' where id = $1`, [pid]);
    }],
  ["NUMERO_DO_ACORDO_CONFERE", "número do acordo no arquivo diferente do boleto", { tituloNumero: "72114" }],
  ["PREFIXO_DO_BOLETO_CONFERE", "parcela importada com prefixo de outro acordo", {},
    (db, _pid, acordoId) => db.query(`update public.parcelas set boleto = '50799990005' where acordo_id = $1 and boleto = '50721130005'`, [acordoId])],
  ["BOLETO_SEM_PARCELA", "o boleto já está numa parcela (de outro acordo)", {},
    async (db) => {
      const outro = await um(db, `insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas, criado_por_email)
                                  values (gen_random_uuid(), '70001', 'CANCELADO', 2000, 1, 'importacao@sistema') returning id`);
      await db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, boleto, status) values ($1, 1, 2000, '2026-09-18', '50721130001', 'CANCELADA')`, [outro]);
    }],
  ["ACORDO_IMPORTADO_E_ATIVO", "acordo lançado à mão", { criadoPor: "cobranca12@aelbra.com.br" }],
  ["IMPORTADO_NO_DIA_DO_PAGAMENTO_OU_DEPOIS", "acordo importado antes do pagamento", { importadoEm: "2026-09-10 12:00:00+00" }],
  ["ESTRUTURA_IMPORTADA_INTACTA", "acordo diz 5 parcelas e vieram 4", { qtd: 5 }],
  ["ESTRUTURA_IMPORTADA_INTACTA", "total do acordo diferente da soma", { valorTotal: 3400 }],
  ["SEQUENCIA_COERENTE", "buraco na sequência importada", { pular: [3] }],
  ["SEQUENCIA_COERENTE", "vencimento fora de ordem", {},
    (db, _pid, acordoId) => db.query(`update public.parcelas set vencimento = '2026-12-25' where acordo_id = $1 and boleto = '50721130003'`, [acordoId])],
  ["PARCELA_IMEDIATAMENTE_ANTERIOR", "falta mais de uma parcela antes da primeira importada", { primeiroSufixo: 3 }],
  ["PARCELA_IMEDIATAMENTE_ANTERIOR", "boleto depois da última importada", { boleto: "50721130006", vencEntrada: "2026-09-18" }],
  ["VENCIMENTO_ANTERIOR_A_PRIMEIRA", "vencimento igual ao da primeira importada", { vencEntrada: "2026-10-18" }],
  ["VENCIMENTO_ANTERIOR_A_PRIMEIRA", "arquivo sem vencimento", { vencEntrada: null }],
  ["VALOR_COMPATIVEL", "pago acima de +15%", { valorPago: 2400 }],
  ["VALOR_COMPATIVEL", "pago abaixo do boleto", { valorPago: 1990 }],
  ["VALOR_COMPATIVEL", "arquivo sem valor do boleto", { valorOriginal: null }],
  ["SEM_OUTRA_CANDIDATA", "dois pagamentos com o mesmo boleto", {},
    (db) => pagarEntrada(db, "72113", { pagamentoId: "00000000-0000-4000-9000-000000000998" })],
  ["SEM_OUTRA_CANDIDATA", "parcela sem boleto em outro acordo do aluno", {},
    async (db) => {
      const outro = await um(db, `insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas, criado_por_email)
                                  values ($1, '55557', 'ATIVO', 500, 1, 'importacao@sistema') returning id`, [CASOS["72113"].aluno]);
      await db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, status) values ($1, 1, 500, '2026-11-10', 'A_VENCER')`, [outro]);
    }],
  ["SEM_BAIXA_INCOMPATIVEL", "parcela importada paga sem o pagamento do próprio boleto", {},
    (db, _pid, acordoId) => db.query(`update public.parcelas set status = 'PAGO', confirmado_por_email = 'gestao' where acordo_id = $1 and boleto = '50721130002'`, [acordoId])],
  ["SEM_BAIXA_INCOMPATIVEL", "baixa manual registrada no acordo", {},
    (db, _pid, acordoId) => db.query(`insert into public.baixas_pagamento (parcela_id, baixado_por_email, baixado_em)
                                      select id, 'gestao', now() from public.parcelas where acordo_id = $1 and boleto = '50721130004'`, [acordoId])],
];

describe("evidência que falha: não cria e deixa em Pagamentos a conciliar", () => {
  it.each(EVIDENCIAS)("%s — %s", async (codigo, _nome, opcoes, preparar) => {
    const { db, acordoId, pid } = await cenario("72113", opcoes);
    if (preparar) await preparar(db, pid, acordoId);
    const parcelasAntes = await linhas(db, `select * from public.parcelas order by id`);
    const acordosAntes = await linhas(db, `select * from public.acordos order by id`);

    const antes = await foto(db);
    const r = await reconstruir(db, pid, true);
    expect(r).toMatchObject({ ok: false, modo: "RECUSADO", gravou: false, aprovado: false });
    expect(r.bloqueios).toEqual([codigo]);
    expect(r.validacoes.find((v) => v.codigo === codigo)).toMatchObject({ ok: false });
    expect(await foto(db)).toEqual(antes);

    // com a etapa ligada, nem o lote nem a rodada horaria criam nada
    await ligarEtapa(db);
    const lote = await pendentes(db);
    await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(await linhas(db, `select * from public.parcelas order by id`)).toEqual(parcelasAntes);
    expect(await linhas(db, `select * from public.acordos order by id`)).toEqual(acordosAntes);
    expect((await pagamento(db, pid)).status_conciliacao).not.toBe("BAIXADO");
    expect((await fila(db, pid))?.decisao ?? null).toBe(codigo === "PAGAMENTO_PENDENTE" && preparar ? "MANTER_EM_REVISAO" : null);
    expect(await um(db, `select count(*)::int from public.auditoria where acao like 'RECONSTRUCAO%'`)).toBe(0);
    // o motivo da recusa sai no resultado do lote (quando o pagamento e elegivel a avaliacao)
    if (lote.avaliados > 0) expect(lote.recusados_por_motivo[codigo]).toBeGreaterThanOrEqual(1);
  }, T);
});

describe("importação de pagamentos e rodada horária", () => {
  it("etapa ligada: o próprio INSERT do arquivo reconstrói e baixa os dois casos", async () => {
    const db = await novoBanco({ etapaLigada: true });
    const a1 = await semearAcordo(db, "72113");
    const a2 = await semearAcordo(db, "72153");
    const [c1, c2] = [CASOS["72113"], CASOS["72153"]];
    const linha = (numero, c) => [c.pagamento, boletoDe(numero, 1), JSON.stringify({ vencimento: "2026-09-18", valor_original: c.entrada }),
      numero, c.entrada, c.honorario, "2026-09-16", c.operador, c.nome, c.matricula];
    await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                      data_pagamento, operador_email, aluno_nome, matricula)
                    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10), ($11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [...linha("72113", c1), ...linha("72153", c2)]);

    for (const [pid, aid, qtd, total] of [[c1.pagamento, a1, 5, 5356.23], [c2.pagamento, a2, 7, 5482.63]]) {
      expect(await pagamento(db, pid)).toEqual({ status_conciliacao: "BAIXADO", conciliacao_motivo: null });
      expect((await fila(db, pid)).decisao).toBe("RESOLVIDO_AUTOMATICO");
      expect(await acordo(db, aid)).toMatchObject({ qtd_parcelas: qtd, valor_total: total });
    }
    expect(await um(db, `select count(*)::int from public.auditoria where acao = 'RECONSTRUCAO_PARCELA_PAGA_ANTES_DA_EXTRACAO'`)).toBe(2);
  }, T);

  it("pagamento que chegou antes do acordo: a rodada horária resolve depois da importação do acordo", async () => {
    const db = await novoBanco({ etapaLigada: true });
    // o acordo ainda nao existe: o motor deixa AGUARDANDO_ACORDO e a etapa nao tem o que fazer
    await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operadora', 'cobranca12@aelbra.com.br', 'operador', true)`);
    const pid = await pagarEntrada(db, "72113");
    expect((await pagamento(db, pid)).status_conciliacao).toBe("AGUARDANDO_ACORDO");

    const acordoId = await semearAcordo(db, "72113");
    const r = await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(Object.keys(r.etapas)).toEqual(expect.arrayContaining(["baixa_pelo_relatorio", "reconstruir_parcela_paga_antes"]));
    expect(r.etapas.reconstruir_parcela_paga_antes).toMatchObject({ avaliados: 1, reconstruidas: 1, erros: 0 });
    expect(r.erro).toBeNull();
    expect(await pagamento(db, pid)).toMatchObject({ status_conciliacao: "BAIXADO" });
    expect(await acordo(db, acordoId)).toMatchObject({ qtd_parcelas: 5, valor_total: 5356.23 });
    const exec = await linhas(db, `select resultado from public.fluxo_pagamentos_execucoes order by id desc limit 1`);
    expect(exec[0].resultado.reconstruir_parcela_paga_antes.reconstruidas).toBe(1);
  }, T);

  it("etapa desligada: nem o INSERT nem a rodada horária reconstroem", async () => {
    const { db, acordoId, pid } = await cenario("72113");
    const r = await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(r.etapas).not.toHaveProperty("reconstruir_parcela_paga_antes");
    expect((await pagamento(db, pid)).status_conciliacao).toBe("REVISAO");
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id = $1`, [acordoId])).toBe(4);
  }, T);

  it("se o motor não baixar, tudo volta: nada fica criado e a importação não cai", async () => {
    const db = await novoBanco({ etapaLigada: true });
    const acordoId = await semearAcordo(db, "72113");
    // simula uma baixa que nao acontece: a parcela nao aceita virar PAGO
    await db.exec(`create function public._teste_segura_status() returns trigger language plpgsql as $$
                     begin if new.status = 'PAGO' then new.status := old.status; end if; return new; end $$;
                   create trigger zz_teste_segura_status before update on public.parcelas for each row execute function public._teste_segura_status();`);
    const acordoAntes = await acordo(db, acordoId);
    const pid = await pagarEntrada(db, "72113");

    expect((await pagamento(db, pid)).status_conciliacao).toBe("REVISAO");
    expect(await acordo(db, acordoId)).toEqual(acordoAntes);
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id = $1`, [acordoId])).toBe(4);
    const falhas = await linhas(db, `select acao, detalhes->>'erro' as erro from public.auditoria`);
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toMatchObject({ acao: "RECONSTRUCAO_PARCELA_FALHOU" });
    expect(falhas[0].erro).toMatch(/RECONSTRUCAO_ABORTADA: o motor nao baixou/);

    const antes = await foto(db);
    await expect(reconstruir(db, pid, true)).rejects.toThrow(/RECONSTRUCAO_ABORTADA/);
    expect(await foto(db)).toEqual(antes);
  }, T);
});

describe("legado 62866: baixa antiga deslocada não é tocada", () => {
  it("parcela com o boleto já existe e está paga por outro documento: fora do alcance", async () => {
    const db = await novoBanco({ etapaLigada: true });
    const legado = { aluno: "00000000-0000-4000-8000-000000062866", cpf: "70000062866", matricula: "2026062866", nome: "ALUNO LEGADO",
      operador: "cobranca12@aelbra.com.br", parcelas: [4000, 4000, 4000, 4000, 4000], primeiroSufixo: 2,
      vencPrimeira: "2026-09-10", importadoEm: "2026-08-31 12:00:00+00", honorario: 0 };
    const acordoId = await semearAcordo(db, "62866", legado);
    // o documento 0002 baixou a parcela certa; a baixa legada por sufixo marcou tambem a 0004 com ele
    const antigo = await pagarEntrada(db, "62866", { ...legado, boleto: boletoDe("62866", 2), vencEntrada: "2026-09-10",
      valorOriginal: 4000, valorPago: 4000, pagamentoId: "00000000-0000-4000-9000-000000062866", dataPagamento: "2026-09-08" });
    expect((await pagamento(db, antigo)).status_conciliacao).toBe("BAIXADO");
    await db.query(`update public.parcelas set status = 'PAGO', origem_baixa = 'LEGADO_SUFIXO', origem_baixa_ref = $2
                    where acordo_id = $1 and boleto = $3`, [acordoId, antigo, boletoDe("62866", 4)]);

    const antes = await foto(db);
    expect(await pendentes(db)).toMatchObject({ avaliados: 0 });
    await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(await foto(db)).toEqual(antes);
    const r = await reconstruir(db, antigo, true);
    expect(r).toMatchObject({ modo: "RECUSADO", gravou: false });
    expect(r.bloqueios).toEqual(expect.arrayContaining(["PAGAMENTO_PENDENTE", "BOLETO_SEM_PARCELA", "SEM_BAIXA_INCOMPATIVEL"]));
    expect(await foto(db)).toEqual(antes);
  }, T);
});

describe("boleto confiável: só parcelas NOVAS da importação, com o prefixo do acordo", () => {
  // acordo recem-importado, ainda sem parcela, e os titulos dele no relatorio
  // (documento com 12 digitos, como vem da Prime: 0 + 5 + acordo(6) + parcela(4))
  async function importar(db, { n, numeroUlbra, documentos }) {
    const aluno = "00000000-0000-4000-8000-0000000c00" + String(n).padStart(2, "0");
    await db.query(`insert into public.alunos (id, nome, cpf, status_atual) values ($1, 'ALUNO IMPORTADO', $2, 'EM_COBRANCA')`,
      [aluno, "7000000c0" + String(n).padStart(2, "0")]);
    const valores = documentos.map((_, i) => 300 + i);
    const id = await um(db, `insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas, criado_por_email)
                             values ($1, $2, 'ATIVO', $3, $4, 'importacao@sistema') returning id`,
      [aluno, numeroUlbra, valores.reduce((s, v) => s + v, 0), documentos.length]);
    for (const [i, doc] of documentos.entries()) {
      await db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, situacao, status, tipo_boleto)
                      values (gen_random_uuid(), $1, $2, $3, $4, 'ABERTO', 'em_aberto', 'Acordo')`, [aluno, doc, `2026-1${i}-10`, valores[i]]);
    }
    await linhas(db, `select * from public.completar_parcelas_acordo(10, false, 'lote_teste', 'teste')`);
    return linhas(db, `select boleto, boleto_confiavel from public.parcelas where acordo_id = $1 order by boleto`, [id]);
  }

  it("prefixo = número do acordo: nasce confiável; divergente, sem número ou fora do padrão: não", async () => {
    const db = await novoBanco();
    const todas = (boletos, confiavel) => boletos.map((boleto) => ({ boleto, boleto_confiavel: confiavel }));
    expect(await importar(db, { n: 1, numeroUlbra: "72300", documentos: ["050723000001", "050723000002"] }))
      .toEqual(todas(["50723000001", "50723000002"], true));
    // os 4 casos antigos de 17/09 (39927, 45660, 63700, 70460): o documento e de outro numero
    expect(await importar(db, { n: 2, numeroUlbra: "39927", documentos: ["050697070004", "050697070005"] }))
      .toEqual(todas(["50697070004", "50697070005"], false));
    // numero do acordo vazio: 497 parcelas antigas estao assim
    expect(await importar(db, { n: 3, numeroUlbra: null, documentos: ["050723200001", "050723200002"] }))
      .toEqual(todas(["50723200001", "50723200002"], false));
    // fora do padrao 5 + acordo(6) + parcela(4)
    expect(await importar(db, { n: 4, numeroUlbra: "45270", documentos: ["0452700001", "0452700002"] }))
      .toEqual(todas(["452700001", "452700002"], false));
  }, T);

  it("parcelas antigas não são atualizadas: a mudança vale só no INSERT de acordo sem parcela", async () => {
    const db = await novoBanco();
    const antigo = await semearAcordo(db, "72113");
    const antes = await linhas(db, `select id, boleto, boleto_confiavel, atualizado_em from public.parcelas where acordo_id = $1 order by boleto`, [antigo]);
    expect(antes.every((p) => p.boleto_confiavel === false)).toBe(true);
    await importar(db, { n: 1, numeroUlbra: "72300", documentos: ["050723000001"] });
    expect(await linhas(db, `select id, boleto, boleto_confiavel, atualizado_em from public.parcelas where acordo_id = $1 order by boleto`, [antigo]))
      .toEqual(antes);
  }, T);

  it("no estado de produção (sem o patch) a mesma importação nasce toda não confiável", async () => {
    const db = await novoBanco({ patch: false });
    expect(await importar(db, { n: 1, numeroUlbra: "72300", documentos: ["050723000001", "050723000002"] }))
      .toEqual([{ boleto: "50723000001", boleto_confiavel: false }, { boleto: "50723000002", boleto_confiavel: false }]);
  }, T);
});

describe("instalação e rollback", () => {
  const MD5_PRODUCAO = {
    _pagamentos_baixar_lote: "6a0a351ce133c8d5e1ab89050a12f456",
    fluxo_pagamentos_rodar: "8255c8d416683c59ddcaa28b5c5195a2",
    completar_parcelas_acordo: "1e4c6853005940da5048bb5e052f9153",
    pagamento_conciliar_um: "fa3d64add73e0e73e587e16f0c0624d1",
    acordo_avista_previa: "9e062e7600cd7b04a17fb9db65469bfe",
  };
  const corpos = async (db) => Object.fromEntries((await linhas(db,
    `select p.proname, md5(p.prosrc) as h from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1)`, [[...Object.keys(MD5_PRODUCAO), "parcela_paga_antes_previa",
      "parcela_paga_antes_reconstruir", "parcela_paga_antes_reconstruir_pendentes"]])).map((r) => [r.proname, r.h]));

  it("sem o patch a bancada está no estado de produção; o patch não toca motor nem prévia do à vista", async () => {
    const semPatch = await corpos(await novoBanco({ patch: false }));
    expect(semPatch).toEqual(MD5_PRODUCAO);
    const comPatch = await corpos(await novoBanco());
    expect(comPatch.pagamento_conciliar_um).toBe(MD5_PRODUCAO.pagamento_conciliar_um);
    expect(comPatch.acordo_avista_previa).toBe(MD5_PRODUCAO.acordo_avista_previa);
    expect(Object.keys(comPatch)).toHaveLength(8);
  }, T);

  it("as funções novas não são chamáveis por anon nem authenticated; a migration roda de novo sem erro", async () => {
    const db = await novoBanco();
    for (const f of ["parcela_paga_antes_previa(uuid)", "parcela_paga_antes_reconstruir(uuid,boolean)", "parcela_paga_antes_reconstruir_pendentes(integer)"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(await um(db, `select has_function_privilege($1, $2, 'EXECUTE')`, [papel, `public.${f}`])).toBe(false);
      }
    }
    await db.exec(MIGRATION_NOVA);
    expect(await um(db, `select count(*)::int from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes'`)).toBe(1);
  }, T);

  it("rollback devolve os três corpos de produção e remove as funções novas", async () => {
    const db = await novoBanco();
    await db.exec(ROLLBACK_NOVA);
    expect(await corpos(db)).toEqual(MD5_PRODUCAO);
    // a etapa fica registrada (desligada): o rollback nao apaga configuracao
    expect(await um(db, `select ligado from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes'`)).toBe(false);
  }, T);
});
