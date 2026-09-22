// ATUALIZACAO DIARIA DO EXTRATO PARA O GRUPO B (feat/prime-extrato-diario-pendentes-vinculo). Migration REAL
// (20260922220000) sobre a fixture confirmacao_d2. Unico stub: prime_extrato_fila (nao existe na fixture) e
// pg_cron (contrato do schedule). Nao stub a consulta ao Prime em si -- este teste cobre so o enfileirador.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20260922220000_prime_extrato_diario_pendentes_vinculo";
const STUB = `
create table public.prime_extrato_fila (matricula text primary key, cpf text, motivo text, tentativas int default 0, ultimo_erro text, coletado_em timestamptz, criado_em timestamptz default now());
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
  await db.exec(STUB);
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); return db; };
const U = (a, b) => `aa000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

async function cenario(db, { statusAcordo = "ATIVO", tituloSituacao = "ABERTO", tituloAcordoId = null, comVinculo = false, matricula } = {}) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), tit = U(n, 3);
  const mat = matricula ?? String(500000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno ${n}`, String(91000000000 + n), mat, H.OP6]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,$4,500,500,1,$5,$6,now())", [ac, al, String(91000000000 + n), statusAcordo, String(60000 + n), H.OP6]);
  await db.exec("set session_replication_role = replica");
  await db.query("insert into acordos_titulos(id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,status,tipo_boleto,acordo_id) values ($1,$2,$3,$4,current_date,300,300,$5,$6,'Cursos de Graduação Presencial',$7)",
    [tit, al, String(91000000000 + n), `40${60000 + n}`, tituloSituacao, tituloSituacao === "ABERTO" ? "em_aberto" : "em_confirmacao", tituloAcordoId]);
  await db.exec("set session_replication_role = origin");
  if (comVinculo) {
    await db.query("insert into acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) values ($1,$2,true,$3)", [ac, tit, "vinculo-automatico@sistema"]);
  }
  return { al, ac, tit, mat };
}
const rodar = async (db) => (await db.query("select public.prime_extrato_reenfileirar_pendentes_vinculo() n")).rows[0].n;
const naFila = async (db, mat) => (await db.query("select count(*)::int n from prime_extrato_fila where matricula=$1", [mat])).rows[0].n;

describe("enfileiramento diario do extrato para o grupo B (aguardando dado)", () => {
  it("1) acordo ATIVO sem vinculo + titulo ABERTO livre: matricula entra na fila", async () => {
    const db = await novo();
    const c = await cenario(db);
    const n = await rodar(db);
    expect(n).toBe(1);
    expect(await naFila(db, c.mat)).toBe(1);
    await db.close();
  });
  it("2) acordo QUITADO tambem conta (nao so ATIVO)", async () => {
    const db = await novo();
    const c = await cenario(db, { statusAcordo: "QUITADO" });
    await rodar(db);
    expect(await naFila(db, c.mat)).toBe(1);
    await db.close();
  });
  it("3) titulo EM_CONFIRMACAO tambem entra no universo do grupo B", async () => {
    const db = await novo();
    const c = await cenario(db, { tituloSituacao: "EM_CONFIRMACAO" });
    await rodar(db);
    expect(await naFila(db, c.mat)).toBe(1);
    await db.close();
  });
  it("4) acordo JA vinculado: nao entra na fila (nao e mais grupo B)", async () => {
    const db = await novo();
    const c = await cenario(db, { comVinculo: true });
    await rodar(db);
    expect(await naFila(db, c.mat)).toBe(0);
    await db.close();
  });
  it("5) titulo ja pertence a outro acordo (acordo_id preenchido): nao entra", async () => {
    const db = await novo();
    const c = await cenario(db);
    await db.query("update acordos_titulos set acordo_id=$1 where id=$2", [c.ac, c.tit]);
    await rodar(db);
    expect(await naFila(db, c.mat)).toBe(0);
    await db.close();
  });
  it("6) acordo CANCELADO nao entra (fora do universo ATIVO/QUITADO)", async () => {
    const db = await novo();
    const c = await cenario(db, { statusAcordo: "CANCELADO" });
    await rodar(db);
    expect(await naFila(db, c.mat)).toBe(0);
    await db.close();
  });
  it("7) idempotente: rodar duas vezes nao duplica linha na fila (PK matricula)", async () => {
    const db = await novo();
    const c = await cenario(db);
    await rodar(db);
    await db.query("update prime_extrato_fila set coletado_em=now() where matricula=$1", [c.mat]);
    await rodar(db); // reenfileira (reseta coletado_em) sem duplicar
    expect(await naFila(db, c.mat)).toBe(1);
    expect((await db.query("select coletado_em from prime_extrato_fila where matricula=$1", [c.mat])).rows[0].coletado_em).toBeNull();
    await db.close();
  });
  it("8) migration so instala: 2 jobs (enfileirar + drenar), ACL so service_role, nada enfileirado no DDL", async () => {
    const db = H.abrir(BASE);
    const jobs = (await db.query("select jobname, schedule from cron.job where jobname like 'prime_extrato_pendentes_vinculo_%' order by jobname")).rows;
    expect(jobs).toEqual([
      { jobname: "prime_extrato_pendentes_vinculo_drenar", schedule: "15,35,55 3 * * *" },
      { jobname: "prime_extrato_pendentes_vinculo_enfileirar", schedule: "10 3 * * *" },
    ]);
    const p = (await db.query(`select has_function_privilege('authenticated','public.prime_extrato_reenfileirar_pendentes_vinculo()','EXECUTE') a, has_function_privilege('service_role','public.prime_extrato_reenfileirar_pendentes_vinculo()','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, s: true });
    expect((await db.query("select count(*)::int n from prime_extrato_fila")).rows[0].n).toBe(0);
    await db.close();
  });
});
