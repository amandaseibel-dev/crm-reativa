// D-2: gatilhos de resolucao FAIL-SAFE. Roda as migrations REAIS (ate 20260922120000) e o rollback REAL num PostgreSQL real (PGlite).
// Dados FICTICIOS. O erro e provocado por um gatilho de teste em acordo_alertas_parcela que sempre falha.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const MIGS = ["20260922100000_confirmacao_vinculo_pagamentos", "20260922100100_confirmacao_processada_resolver", "20260922100150_confirmacao_processada_acl",
  "20260922100200_confirmacao_encerramento_processado", "20260922100250_acl_gatilho_confirmacao_encerra", "20260922110000_acordo_alertas_parcela", "20260922110100_acl_gatilhos_d2"];
const MF = "20260922120000_acordo_alertas_triggers_failsafe";
let PRE, POS, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  for (const m of MIGS) await db.exec(H.MIG(m));
  PRE = await db.dumpDataDir();
  await db.exec(H.MIG(MF));
  POS = await db.dumpDataDir();
  await db.close();
});
const novo = async (dump = POS) => { const db = H.abrir(dump); await db.exec("set check_function_bodies = off; set timezone = 'UTC';"); await H.como(db, H.GESTAO); return db; };
const U = (a, b) => `a3000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;
async function mk(db) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), p1 = U(n, 3), p2 = U(n, 4);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,'Teste FS',$2,$3,0,'op1@x','ACORDO_EM_DIA','ACORDO_EM_DIA')", [al, String(30000000000 + n), String(n)]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) values ($1,$2,$3,'ATIVO',1000,1000,2,$4,$5,'op1@x')", [ac, al, String(30000000000 + n), String(65000 + n), 9300 + n]);
  await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,100,'2026-10-19','A_VENCER'),($3,$2,2,100,'2026-11-19','A_VENCER')", [p1, ac, p2]);
  await db.query("insert into acordo_alertas_parcela(acordo_id,parcela_id,aluno_id,numero_parcela,vencimento,valor,data_alerta,responsavel_email) values ($1,$2,$3,1,'2026-10-19',100,'2026-10-17','op1@x')", [ac, p1, al]);
  return { al, ac, p1, p2 };
}
const alerta = async (db, ac) => (await db.query("select resolucao, (resolvido_em is not null) f from acordo_alertas_parcela where acordo_id=$1", [ac])).rows;
const QUEBRA = `create or replace function public._teste_quebra() returns trigger language plpgsql as $$ begin raise exception 'erro proposital do alerta'; end $$;
  create trigger _teste_quebra before update on public.acordo_alertas_parcela for each row execute function public._teste_quebra();`;
const falhas = async (db) => (await db.query("select registro_id::text r, detalhes->>'erro' e from auditoria where acao='ALERTA_D2_RESOLVE_FALHOU' order by id")).rows;

describe("resolucao normal e idempotencia", () => {
  it("parcela PAGO resolve PAGA; repetir nao altera; acordo QUITADO/CANCELADO resolvem", async () => {
    const db = await novo(); const { ac, p1 } = await mk(db);
    await db.query("update parcelas set status='PAGO' where id=$1", [p1]);
    expect(await alerta(db, ac)).toEqual([{ resolucao: "PAGA", f: true }]);
    const t1 = (await db.query("select resolvido_em from acordo_alertas_parcela where acordo_id=$1", [ac])).rows[0].resolvido_em;
    await db.query("update parcelas set status='PAGO', valor=101 where id=$1", [p1]); // 2a execucao: sem mudanca de status, gatilho nem dispara
    await db.query("update acordos set status='QUITADO' where id=$1", [ac]);         // alerta ja fechado: nada a resolver
    expect((await db.query("select resolvido_em from acordo_alertas_parcela where acordo_id=$1", [ac])).rows[0].resolvido_em).toEqual(t1);
    expect(await falhas(db)).toEqual([]);
    for (const [st, res] of [["QUITADO", "ACORDO_QUITADO"], ["CANCELADO", "ACORDO_CANCELADO"]]) {
      const x = await mk(db); await db.query("update acordos set status=$2 where id=$1", [x.ac, st]);
      expect(await alerta(db, x.ac)).toEqual([{ resolucao: res, f: true }]);
    }
    await db.close();
  });
});
describe("falha no alerta NAO aborta a operacao financeira", () => {
  it("parcela: PAGO e CANCELADA seguem gravadas; falha registrada em auditoria; alerta fica aberto", async () => {
    const db = await novo(); await db.exec(QUEBRA);
    for (const st of ["PAGO", "CANCELADA"]) {
      const { ac, p1 } = await mk(db);
      await db.query("update parcelas set status=$2 where id=$1", [p1, st]);
      expect((await db.query("select status from parcelas where id=$1", [p1])).rows[0].status).toBe(st);
      expect(await alerta(db, ac)).toEqual([{ resolucao: null, f: false }]);
    }
    expect((await falhas(db)).length).toBe(2);
    expect((await falhas(db))[0].e).toBe("erro proposital do alerta");
    await db.close();
  });
  it("acordo: QUITADO e CANCELADO seguem gravados; falha registrada", async () => {
    const db = await novo(); await db.exec(QUEBRA);
    for (const st of ["QUITADO", "CANCELADO"]) {
      const { ac } = await mk(db);
      await db.query("update acordos set status=$2 where id=$1", [ac, st]);
      expect((await db.query("select status from acordos where id=$1", [ac])).rows[0].status).toBe(st);
    }
    expect((await falhas(db)).length).toBe(2);
    await db.close();
  });
  it("controle: SEM o fail-safe (estado anterior) o mesmo erro aborta a baixa", async () => {
    const db = await novo(PRE); await db.exec(QUEBRA);
    const { p1 } = await mk(db);
    await expect(db.query("update parcelas set status='PAGO' where id=$1", [p1])).rejects.toThrow(/erro proposital/);
    await db.close();
  });
});
describe("ACL/RLS, indice, inercia e rollback", () => {
  it("ACL dos gatilhos e da tabela inalteradas; RLS ligada; indice por parcela_id; migration nao cria alerta", async () => {
    const db = await H.abrir(POS);
    for (const f of ["tg_acordo_alerta_resolve_parcela()", "tg_acordo_alerta_resolve_acordo()"]) {
      const r = (await db.query(`select has_function_privilege('anon','public.${f}','execute') a, has_function_privilege('authenticated','public.${f}','execute') u,
        (select p.proacl::text ~ '(^\\\\{|,)=X/' from pg_proc p where p.oid='public.${f}'::regprocedure) pub, (select prosecdef from pg_proc p where p.oid='public.${f}'::regprocedure) d`)).rows[0];
      expect(r).toEqual({ a: false, u: false, pub: false, d: true });
    }
    expect((await db.query("select relrowsecurity r from pg_class where relname='acordo_alertas_parcela'")).rows[0].r).toBe(true);
    expect((await db.query("select has_table_privilege('anon','public.acordo_alertas_parcela','select') a, has_table_privilege('authenticated','public.acordo_alertas_parcela','insert') i")).rows[0]).toEqual({ a: false, i: false });
    expect((await db.query("select count(*)::int n from pg_indexes where indexname='acordo_alertas_parcela_parcela_idx'")).rows[0].n).toBe(1);
    expect((await db.query("select count(*)::int n from acordo_alertas_parcela")).rows[0].n).toBe(0);
    expect(H.MIG(MF)).not.toMatch(/insert\s+into\s+public\.acordo_alertas_parcela|acordo_alertas_gerar\(|cron\./i);
    await db.close();
  });
  it("rollback restaura os gatilhos e remove o indice", async () => {
    const db = H.abrir(POS); await db.exec(H.ROLL(MF));
    expect((await db.query("select count(*)::int n from pg_indexes where indexname='acordo_alertas_parcela_parcela_idx'")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from pg_proc where proname like 'tg_acordo_alerta_resolve%' and prosrc like '%exception%'")).rows[0].n).toBe(0);
    await db.close();
  });
});
