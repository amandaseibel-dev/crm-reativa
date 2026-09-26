// CONFIRMACAO AUTOMATICA de fila_acordos_confirmar (feat/fila-acordos-confirmar-automatico). Migration REAL
// (20260922210000) sobre a fixture confirmacao_d2. Unico stub: pg_cron (contrato do schedule).
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20260922210000_fila_acordos_confirmar_automatico";
const CRON = `
create schema if not exists cron;
create table cron.job (jobid serial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(p_name text, p_schedule text, p_cmd text) returns bigint language plpgsql as $$
declare v bigint; begin insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$ begin delete from cron.job where jobname = p_name; return true; end $$;
`;
let BASE, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(CRON);
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); return db; };
const U = (a, b) => `a9000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

async function item(db, { ulbra, qtdFila = 4, valorFila = 900, acordos = [{ qtd: 4, valor: 900, status: "ATIVO" }] } = {}) {
  const n = ++seq, al = U(n, 1);
  const u = ulbra ?? String(40000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno Fila ${n}`, String(90000000000 + n), String(n), H.OP6]);
  const acordoBase = "05" + String(u).padStart(6, "0") + "00";
  const acIds = [];
  for (const a of acordos) {
    const acId = U(n, 100 + acIds.length);
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,$4,$5,$5,$6,$7,$8,now())",
      [acId, al, String(90000000000 + n), a.status, a.valor, a.qtd, u, H.OP6]);
    acIds.push(acId);
  }
  const filaId = U(n, 200);
  await db.query("insert into fila_acordos_confirmar(id,aluno_id,cpf,nome,acordo_base,qtd_parcelas,valor_total,status_confirmacao) values ($1,$2,$3,$4,$5,$6,$7,'A_CONFIRMAR')",
    [filaId, al, String(90000000000 + n), `Aluno Fila ${n}`, acordoBase, qtdFila, valorFila]);
  return { al, filaId, acIds };
}
const rodar = async (db, lim = 500) => (await db.query("select public.fila_acordos_confirmar_automatico($1) r", [lim])).rows[0].r;

describe("confirmacao automatica da fila de acordos", () => {
  it("1) acordo ATIVO unico, qtd e valor batendo: confirma sozinho, com ator de sistema e auditoria", async () => {
    const db = await novo();
    const it1 = await item(db);
    const r = await rodar(db);
    expect(r.confirmados).toBeGreaterThanOrEqual(1); expect(r.falhas).toBe(0);
    const f = (await db.query("select status_confirmacao, operador_email from fila_acordos_confirmar where id=$1", [it1.filaId])).rows[0];
    expect(f.status_confirmacao).toBe("CONFIRMADO"); expect(f.operador_email).toBe("confirmacao-automatica@sistema");
    expect((await db.query("select count(*)::int n from auditoria where acao='FILA_ACORDO_CONFIRMADO_AUTOMATICO' and registro_id=$1", [it1.filaId])).rows[0].n).toBe(1);
    await db.close();
  });
  it("2) sem acordo ATIVO correspondente: continua A_CONFIRMAR", async () => {
    const db = await novo();
    const it1 = await item(db, { acordos: [{ qtd: 4, valor: 900, status: "QUITADO" }] });
    await rodar(db);
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [it1.filaId])).rows[0].status_confirmacao).toBe("A_CONFIRMAR");
    await db.close();
  });
  it("3) dois acordos ATIVO com a mesma base (ambiguo): nao confirma sozinho", async () => {
    const db = await novo();
    const it1 = await item(db, { acordos: [{ qtd: 4, valor: 900, status: "ATIVO" }, { qtd: 4, valor: 901, status: "ATIVO" }] });
    await rodar(db);
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [it1.filaId])).rows[0].status_confirmacao).toBe("A_CONFIRMAR");
    await db.close();
  });
  it("4) qtd_parcelas ou valor_total divergentes do acordo ATIVO: nao confirma sozinho", async () => {
    const db = await novo();
    const it1 = await item(db, { qtdFila: 4, valorFila: 900, acordos: [{ qtd: 5, valor: 1100, status: "ATIVO" }] });
    await rodar(db);
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [it1.filaId])).rows[0].status_confirmacao).toBe("A_CONFIRMAR");
    await db.close();
  });
  it("5) aluno com OUTRO acordo ATIVO de base diferente nao interfere (nao junta so por aluno_id)", async () => {
    const db = await novo();
    const it1 = await item(db, { ulbra: "55501" });
    // outro acordo ATIVO do MESMO aluno, base diferente -- nao deve contar para a decisao
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,'ATIVO',500,500,2,$4,$5,now())",
      [U(9999, 1), it1.al, String(90000000000 + seq), "55502", H.OP6]);
    await rodar(db);
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [it1.filaId])).rows[0].status_confirmacao).toBe("CONFIRMADO");
    await db.close();
  });
  it("6) idempotente: ja CONFIRMADO nao entra de novo, segunda rodada nao acrescenta auditoria", async () => {
    const db = await novo();
    const it1 = await item(db);
    await rodar(db);
    await rodar(db);
    expect((await db.query("select count(*)::int n from auditoria where acao='FILA_ACORDO_CONFIRMADO_AUTOMATICO' and registro_id=$1", [it1.filaId])).rows[0].n).toBe(1);
    await db.close();
  });
  it("7) REJEITADO por gestao nao e reprocessado", async () => {
    const db = await novo();
    const it1 = await item(db);
    await db.query("update fila_acordos_confirmar set status_confirmacao='REJEITADO' where id=$1", [it1.filaId]);
    await rodar(db);
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [it1.filaId])).rows[0].status_confirmacao).toBe("REJEITADO");
    await db.close();
  });
  it("8) falha isolada nao trava o lote", async () => {
    const db = await novo();
    const a = await item(db); const b = await item(db);
    await db.exec(`create or replace function public._explode_um() returns trigger language plpgsql as $$
      begin if new.id::text = '${a.filaId}' then raise exception 'falha simulada'; end if; return new; end $$;
      create trigger trg_explode before update on public.fila_acordos_confirmar for each row execute function public._explode_um();`);
    const r = await rodar(db);
    expect(r.falhas).toBeGreaterThanOrEqual(1);
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [b.filaId])).rows[0].status_confirmacao).toBe("CONFIRMADO");
    expect((await db.query("select status_confirmacao from fila_acordos_confirmar where id=$1", [a.filaId])).rows[0].status_confirmacao).toBe("A_CONFIRMAR");
    await db.close();
  });
  it("9) migration so instala: job unico fora do :40, ACL so service_role, nada confirmado no DDL", async () => {
    const db = H.abrir(BASE);
    const j = (await db.query("select * from cron.job where jobname='fila_acordos_confirmar_automatico'")).rows;
    expect(j.length).toBe(1); expect(j[0].schedule).toBe("5,25,45 * * * *");
    const p = (await db.query(`select has_function_privilege('authenticated','public.fila_acordos_confirmar_automatico(int)','EXECUTE') a, has_function_privilege('service_role','public.fila_acordos_confirmar_automatico(int)','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, s: true });
    expect((await db.query("select count(*)::int n from auditoria where acao='FILA_ACORDO_CONFIRMADO_AUTOMATICO'")).rows[0].n).toBe(0);
    await db.close();
  });
});
