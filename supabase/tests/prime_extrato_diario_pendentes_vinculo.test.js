// ATUALIZACAO DIARIA DO EXTRATO PARA O GRUPO B (feat/prime-extrato-diario-pendentes-vinculo, corrigida em
// 20260922230000: matricula precisa vir de prime_contratos.registration por CPF, nao de alunos.matricula --
// medido em producao: alunos.matricula e ID interno do CRM, nao existe como registration no Prime, 100% 404
// na primeira rodada real). Migrations REAIS 20260922220000 + 20260922230000 sobre a fixture confirmacao_d2.
// Stubs: prime_extrato_fila (nao existe na fixture) e pg_cron.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M1 = "20260922220000_prime_extrato_diario_pendentes_vinculo", M2 = "20260922230000_prime_extrato_pendentes_vinculo_matricula_prime";
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
  await db.exec(H.MIG(M1));
  await db.exec(H.MIG(M2));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); return db; };
const U = (a, b) => `aa000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

async function cenario(db, { statusAcordo = "ATIVO", tituloSituacao = "ABERTO", tituloAcordoId = null, comVinculo = false, semRegistration = false } = {}) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), tit = U(n, 3);
  const cpf = String(91000000000 + n);
  const registration = String(200000000 + n);
  const matriculaInterna = String(500000 + n); // ID interno do CRM -- diferente do registration do Prime
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno ${n}`, cpf, matriculaInterna, H.OP6]);
  if (!semRegistration) {
    await db.query("insert into prime_contratos(cpf, registration, valid_from, status) values ($1,$2,current_date,'ATIVO')", [cpf, registration]);
  }
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,$4,500,500,1,$5,$6,now())", [ac, al, cpf, statusAcordo, String(60000 + n), H.OP6]);
  await db.exec("set session_replication_role = replica");
  await db.query("insert into acordos_titulos(id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,status,tipo_boleto,acordo_id) values ($1,$2,$3,$4,current_date,300,300,$5,$6,'Cursos de Graduação Presencial',$7)",
    [tit, al, cpf, `40${60000 + n}`, tituloSituacao, tituloSituacao === "ABERTO" ? "em_aberto" : "em_confirmacao", tituloAcordoId]);
  await db.exec("set session_replication_role = origin");
  if (comVinculo) {
    await db.query("insert into acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) values ($1,$2,true,$3)", [ac, tit, "vinculo-automatico@sistema"]);
  }
  return { al, ac, tit, matriculaInterna, registration, cpf };
}
const rodar = async (db) => (await db.query("select public.prime_extrato_reenfileirar_pendentes_vinculo() n")).rows[0].n;
const naFila = async (db, mat) => (await db.query("select count(*)::int n from prime_extrato_fila where matricula=$1", [mat])).rows[0].n;

describe("enfileiramento diario do extrato para o grupo B, com registration real do Prime", () => {
  it("1) enfileira pelo registration do Prime (prime_contratos), NAO pela matricula interna do CRM", async () => {
    const db = await novo();
    const c = await cenario(db);
    const n = await rodar(db);
    expect(n).toBe(1);
    expect(await naFila(db, c.registration)).toBe(1);
    expect(await naFila(db, c.matriculaInterna)).toBe(0); // nunca a ID interna
    await db.close();
  });
  it("2) sem prime_contratos (sem registration conhecido): nao enfileira nada (nao inventa matricula)", async () => {
    const db = await novo();
    await cenario(db, { semRegistration: true });
    const n = await rodar(db);
    expect(n).toBe(0);
    await db.close();
  });
  it("3) acordo QUITADO tambem conta", async () => {
    const db = await novo();
    const c = await cenario(db, { statusAcordo: "QUITADO" });
    await rodar(db);
    expect(await naFila(db, c.registration)).toBe(1);
    await db.close();
  });
  it("4) titulo EM_CONFIRMACAO tambem entra no universo do grupo B", async () => {
    const db = await novo();
    const c = await cenario(db, { tituloSituacao: "EM_CONFIRMACAO" });
    await rodar(db);
    expect(await naFila(db, c.registration)).toBe(1);
    await db.close();
  });
  it("5) acordo JA vinculado: nao entra na fila", async () => {
    const db = await novo();
    const c = await cenario(db, { comVinculo: true });
    await rodar(db);
    expect(await naFila(db, c.registration)).toBe(0);
    await db.close();
  });
  it("6) titulo ja pertence a outro acordo: nao entra", async () => {
    const db = await novo();
    const c = await cenario(db);
    await db.query("update acordos_titulos set acordo_id=$1 where id=$2", [c.ac, c.tit]);
    await rodar(db);
    expect(await naFila(db, c.registration)).toBe(0);
    await db.close();
  });
  it("7) acordo CANCELADO nao entra", async () => {
    const db = await novo();
    const c = await cenario(db, { statusAcordo: "CANCELADO" });
    await rodar(db);
    expect(await naFila(db, c.registration)).toBe(0);
    await db.close();
  });
  it("8) idempotente: rodar duas vezes nao duplica (PK matricula=registration)", async () => {
    const db = await novo();
    const c = await cenario(db);
    await rodar(db);
    await db.query("update prime_extrato_fila set coletado_em=now() where matricula=$1", [c.registration]);
    await rodar(db);
    expect(await naFila(db, c.registration)).toBe(1);
    expect((await db.query("select coletado_em from prime_extrato_fila where matricula=$1", [c.registration])).rows[0].coletado_em).toBeNull();
    await db.close();
  });
  it("9) migration so instala: 2 jobs, ACL so service_role, nada enfileirado no DDL", async () => {
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
