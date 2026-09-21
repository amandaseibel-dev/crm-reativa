// D-2: agendamento diario 08:30 Brasilia (11:30 UTC). PGlite nao tem pg_cron: um STUB minimo de cron.job/schedule/unschedule reproduz o
// contrato do pg_cron (schedule com jobname existente ATUALIZA; nao executa o comando). Migration e rollback REAIS.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const CADEIA = ["20260922100000_confirmacao_vinculo_pagamentos", "20260922100100_confirmacao_processada_resolver", "20260922100150_confirmacao_processada_acl",
  "20260922100200_confirmacao_encerramento_processado", "20260922100250_acl_gatilho_confirmacao_encerra", "20260922110000_acordo_alertas_parcela",
  "20260922110100_acl_gatilhos_d2", "20260922120000_acordo_alertas_triggers_failsafe", "20260922130000_d2_bloqueio_operacional", "20260922140000_d2_geracao_exata"];
const MC = "20260922150000_d2_cron_diario";
const STUB = `
create schema if not exists cron;
create table cron.job (jobid serial primary key, jobname text unique, schedule text not null, command text not null, active boolean default true, execucoes int default 0);
create function cron.schedule(p_name text, p_schedule text, p_cmd text) returns bigint language plpgsql as $$
declare v bigint; begin
  insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$
begin
  if not exists (select 1 from cron.job where jobname = p_name) then raise exception 'could not find valid entry for job %', p_name; end if;
  delete from cron.job where jobname = p_name; return true; end $$;
insert into cron.job(jobname, schedule, command) values ('fluxo_pagamentos_horario','40 * * * *','select public.fluxo_pagamentos_rodar(''cron'')'),
  ('nivelamento_automatico_gestao','20 9 * * *','select public.nivelamento_automatico_gestao(10, true)'), ('vigia_carga','*/2 * * * *','select public.sistema_carga_vigia();');
`;
let BASE; let seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  for (const m of CADEIA) await db.exec(H.MIG(m));
  await db.exec(STUB);
  // 9 alertas "ja existentes" (fictios) para provar que a instalacao nao os altera
  await db.exec("set timezone='UTC'");
  BASE = await db.dumpDataDir();
  await db.close();
});
const U = (a, b) => `a6000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;
async function alerta(db) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), p = U(n, 3), cpf = String(60000000000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada,status_acionamento) values ($1,'Teste Cron',$2,$3,0,'op1@x','ACORDO_EM_DIA','ACORDO_EM_DIA','ACORDO_EM_DIA')", [al, cpf, String(n)]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) values ($1,$2,$3,'ATIVO',1000,1000,1,$4,$5,'op1@x')", [ac, al, cpf, String(68000 + n), 9600 + n]);
  await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,100,'2026-10-19','A_VENCER')", [p, ac]);
  await db.query("insert into acordo_alertas_parcela(acordo_id,parcela_id,aluno_id,numero_parcela,vencimento,valor,data_alerta,responsavel_email) values ($1,$2,$3,1,'2026-10-19',100,'2026-10-17','op1@x')", [ac, p, al]);
}
const jobs = async (db) => (await db.query("select jobname, schedule, command, execucoes from cron.job order by jobname")).rows;
const snapAlertas = async (db) => (await db.query("select md5(coalesce(string_agg(t::text,'|' order by id),'')) h, count(*)::int n from acordo_alertas_parcela t")).rows[0];

describe("cron diario do D-2", () => {
  it("instala exatamente 1 job com 08:30 Brasilia (11:30 UTC), chamando somente acordo_alertas_gerar(); nada e executado, nenhum alerta alterado/criado", async () => {
    const db = H.abrir(BASE); for (let i = 0; i < 9; i++) await alerta(db);
    const antes = await snapAlertas(db), jobsAntes = await jobs(db);
    await db.exec(H.MIG(MC));
    const depois = await jobs(db);
    const d2 = depois.filter((j) => j.jobname === "acordo_alertas_d2_diario");
    expect(d2).toHaveLength(1);
    expect(d2[0].schedule).toBe("30 11 * * *");
    expect(d2[0].command.trim()).toBe("select public.acordo_alertas_gerar();");
    expect(d2[0].execucoes).toBe(0);
    expect(depois.length).toBe(jobsAntes.length + 1);
    expect(depois.filter((j) => j.jobname !== "acordo_alertas_d2_diario")).toEqual(jobsAntes);
    expect(await snapAlertas(db)).toEqual(antes); // 9 alertas identicos, nenhum novo
    expect(antes.n).toBe(9);
    // 08:30 Brasilia = 11:30 UTC (UTC-3, sem horario de verao)
    const brt = (await db.query("select ((timestamp '2026-09-22 11:30:00' at time zone 'UTC') at time zone 'America/Sao_Paulo')::time::text t")).rows[0].t;
    expect(brt).toBe("08:30:00");
    await db.close();
  });
  it("idempotente: reaplicar a migration nao duplica o job", async () => {
    const db = H.abrir(BASE);
    await db.exec(H.MIG(MC)); await db.exec(H.MIG(MC)); await db.exec(H.MIG(MC));
    expect((await jobs(db)).filter((j) => j.jobname === "acordo_alertas_d2_diario")).toHaveLength(1);
    await db.close();
  });
  it("a migration nao referencia confirmacao, flag, backfill, saldo nem outras funcoes; ACL/RLS, #443/#444/#445 e flag OFF intactos", async () => {
    const sql = H.MIG(MC).replace(/--.*$/gm, "");
    expect(sql).toMatch(/cron\.schedule\('acordo_alertas_d2_diario'/);
    expect(sql).not.toMatch(/confirmacao|encerrar_confirmacao|backfill|saldo|insert\s|update\s|delete\s|alter\s|create\s|grant|revoke/i);
    expect((sql.match(/acordo_alertas_gerar/g) || []).length).toBe(1);
    const db = H.abrir(BASE); await db.exec(H.MIG(MC));
    const h = async (n) => (await db.query("select md5(prosrc) m from pg_proc where proname=$1", [n])).rows[0].m;
    const antes = { g: await h("acordo_alertas_gerar"), r: await h("acordo_alertas_resolver"), b: await h("aluno_bloqueado_para_d2"), tp: await h("tg_acordo_alerta_resolve_parcela") };
    expect((await db.query("select prosrc like '%p_hoje = public.acordo_alerta_data%' e, prosrc like '%aluno_bloqueado_para_d2%' b from pg_proc where proname='acordo_alertas_gerar'")).rows[0]).toEqual({ e: true, b: true });
    expect((await db.query("select prosrc like '%exception when others%' f from pg_proc where proname='tg_acordo_alerta_resolve_parcela'")).rows[0].f).toBe(true);
    expect(antes.g).toBeTruthy();
    expect((await db.query("select relrowsecurity r from pg_class where relname='acordo_alertas_parcela'")).rows[0].r).toBe(true);
    expect((await db.query("select has_function_privilege('anon','public.acordo_alertas_gerar(date,int,text)','execute') a, has_function_privilege('authenticated','public.acordo_alertas_gerar(date,int,text)','execute') u")).rows[0]).toEqual({ a: false, u: false });
    expect((await db.query("select ligado from fluxo_pagamentos_config where etapa='encerrar_confirmacao_processada'")).rows[0].ligado).toBe(false);
    await db.close();
  });
  it("rollback remove SOMENTE o job D-2 (demais intactos, alertas existentes preservados) e e seguro se o job nao existe", async () => {
    const db = H.abrir(BASE); await alerta(db);
    const jobsAntes = await jobs(db), alAntes = await snapAlertas(db);
    await db.exec(H.MIG(MC)); await db.exec(H.ROLL(MC));
    expect(await jobs(db)).toEqual(jobsAntes);
    expect(await snapAlertas(db)).toEqual(alAntes);
    await db.exec(H.ROLL(MC)); // sem job: nao falha
    expect(await jobs(db)).toEqual(jobsAntes);
    await db.close();
  });
});
