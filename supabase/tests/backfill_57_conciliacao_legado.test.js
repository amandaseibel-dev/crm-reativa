// BACKFILL PONTUAL dos pagamentos legados sem status_conciliacao/origem_vinculo (fix/backfill-57-conciliacao-legado).
// Migration REAL (20260922200000) sobre a fixture confirmacao_d2, que ja tem public.pagamento_conciliar_um
// REAL instalado (a mesma funcao que o trigger oficial de producao chama). Nenhum stub de logica de baixa.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20260922200000_backfill_57_conciliacao_legado";
let BASE, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); return db; };
const U = (a, b) => `a8000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

async function cenario(db, { statusParcela = "A_VENCER", statusAcordo = "ATIVO", boleto, valorParcela = 300, valorPago = 300, boletoConfiavel = true } = {}) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), pr = U(n, 3), pg = U(n, 4);
  const bol = boleto ?? `506${String(9000000 + n).slice(0, 6)}0001`;
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno Backfill ${n}`, String(80000000000 + n), String(n), H.OP6]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,$4,$5,$5,1,$6,$7,now())", [ac, al, String(80000000000 + n), statusAcordo, valorParcela, String(9000 + n), H.OP6]);
  await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status,boleto,boleto_confiavel) values ($1,$2,1,$3,current_date,$4,$5,$6)", [pr, ac, valorParcela, statusParcela, bol, boletoConfiavel]);
  await db.exec("set session_replication_role = replica"); // pagamento legado: sem status_conciliacao/origem_vinculo, anterior ao motor
  await db.query("insert into pagamentos(id,aluno_id,cpf,data_pagamento,valor_pago,numero_parcela_completo,titulo_numero,operador_email) values ($1,$2,$3,current_date,$4,$5,$6,$7)",
    [pg, al, String(80000000000 + n), valorPago, bol, bol.slice(1, 7).replace(/^0+/, "") || "0", H.OP6]);
  await db.exec("set session_replication_role = origin");
  return { al, ac, pr, pg, bol };
}
const rodar = async (db, ids) => (await db.query("select public._backfill_57_conciliacao_legado($1) r", [ids])).rows[0].r;

describe("backfill pontual dos pendentes reais legados", () => {
  it("1) elegivel (ATIVO, A_VENCER, sem status, documento confiavel) baixa pela funcao oficial", async () => {
    const db = await novo(); const c = await cenario(db);
    const r = await rodar(db, [c.pg]);
    expect(r.processados).toBe(1); expect(r.baixados).toBe(1); expect(r.pulados).toBe(0); expect(r.falhas).toBe(0);
    const p = (await db.query("select status_conciliacao from pagamentos where id=$1", [c.pg])).rows[0];
    expect(p.status_conciliacao).toBe("BAIXADO");
    const pr = (await db.query("select status, origem_baixa, origem_baixa_ref from parcelas where id=$1", [c.pr])).rows[0];
    expect(pr.status).toBe("PAGO"); expect(pr.origem_baixa).toBe("GATILHO_IMPORTACAO"); expect(pr.origem_baixa_ref).toBe(c.pg);
    await db.close();
  });
  it("2) acordo CANCELADO: pula no preflight do backfill, nao baixa", async () => {
    const db = await novo(); const c = await cenario(db, { statusAcordo: "CANCELADO", statusParcela: "CANCELADA" });
    const r = await rodar(db, [c.pg]);
    expect(r.processados).toBe(0); expect(r.baixados).toBe(0); expect(r.pulados).toBe(1);
    expect(r.detalhes[0].pulado).toBe("FORA_DO_CRITERIO_NO_MOMENTO_DA_EXECUCAO");
    expect((await db.query("select status_conciliacao from pagamentos where id=$1", [c.pg])).rows[0].status_conciliacao).toBeNull();
    expect((await db.query("select status from parcelas where id=$1", [c.pr])).rows[0].status).toBe("CANCELADA");
    await db.close();
  });
  it("3) parcela ja PAGO antes do backfill: pula no preflight, nao dobra baixa", async () => {
    const db = await novo(); const c = await cenario(db, { statusParcela: "PAGO" });
    const r = await rodar(db, [c.pg]);
    expect(r.pulados).toBe(1); expect(r.detalhes[0].pulado).toBe("FORA_DO_CRITERIO_NO_MOMENTO_DA_EXECUCAO");
    await db.close();
  });
  it("4) pagamento que ja tem status_conciliacao (processado por outro caminho): pula, nao mexe", async () => {
    const db = await novo(); const c = await cenario(db);
    await db.query("update pagamentos set status_conciliacao='BAIXADO', origem_vinculo='BOLETO_EXATO' where id=$1", [c.pg]);
    const r = await rodar(db, [c.pg]);
    expect(r.pulados).toBe(1); expect(r.detalhes[0].pulado).toBe("STATUS_JA_MUDOU");
    await db.close();
  });
  it("5) falha isolada (id inexistente) nao trava o lote: os demais processam normalmente", async () => {
    const db = await novo(); const c = await cenario(db);
    const r = await rodar(db, [c.pg, "00000000-0000-4000-8000-000000000000"]);
    expect(r.baixados).toBe(1); expect(r.pulados).toBe(1);
    await db.close();
  });
  it("6) lote isolado: nao toca pagamento elegivel fora da lista", async () => {
    const db = await novo(); const a = await cenario(db); const b = await cenario(db);
    const r = await rodar(db, [a.pg]);
    expect(r.processados).toBe(1);
    expect((await db.query("select status_conciliacao from pagamentos where id=$1", [b.pg])).rows[0].status_conciliacao).toBeNull();
    expect((await db.query("select status from parcelas where id=$1", [b.pr])).rows[0].status).toBe("A_VENCER");
    await db.close();
  });
  it("7) documento nao confiavel (boleto_confiavel=false) sem parcela candidata unica: vai para REVISAO, nao baixa sozinho", async () => {
    const db = await novo(); const c = await cenario(db, { boletoConfiavel: false });
    const r = await rodar(db, [c.pg]);
    expect(r.processados).toBe(1); expect(r.baixados).toBe(0);
    expect(r.detalhes[0].resultado).toBe("REVISAO");
    expect((await db.query("select status from parcelas where id=$1", [c.pr])).rows[0].status).toBe("A_VENCER");
    await db.close();
  });
  it("8) idempotente: rodar duas vezes sobre o mesmo id nao dobra baixa nem falha na segunda vez", async () => {
    const db = await novo(); const c = await cenario(db);
    const r1 = await rodar(db, [c.pg]); expect(r1.baixados).toBe(1);
    const r2 = await rodar(db, [c.pg]);
    expect(r2.pulados).toBe(1); expect(r2.detalhes[0].pulado).toBe("STATUS_JA_MUDOU"); // ja tem status_conciliacao=BAIXADO
    const pr = (await db.query("select status from parcelas where id=$1", [c.pr])).rows[0];
    expect(pr.status).toBe("PAGO");
    await db.close();
  });
  it("9) migration so instala a funcao: ACL restrita a service_role/postgres", async () => {
    const db = H.abrir(BASE);
    const p = (await db.query(`select has_function_privilege('authenticated','public._backfill_57_conciliacao_legado(uuid[])','EXECUTE') a, has_function_privilege('anon','public._backfill_57_conciliacao_legado(uuid[])','EXECUTE') n, has_function_privilege('service_role','public._backfill_57_conciliacao_legado(uuid[])','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, n: false, s: true });
    await db.close();
  });
});
