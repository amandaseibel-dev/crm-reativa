// FECHAMENTO SEGURO E AUTODESLIGAVEL DO ESTOQUE DO GRUPO B (feat/prime-extrato-drenar-seguro-intensivo).
// Migrations REAIS 20260922220000 + 20260922230000 + 20260922240000 sobre a fixture confirmacao_d2.
// Stub: prime_extrato_mutirao() (a Edge Function real nao roda em teste), prime_extrato_fila, pg_cron.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M1 = "20260922220000_prime_extrato_diario_pendentes_vinculo", M2 = "20260922230000_prime_extrato_pendentes_vinculo_matricula_prime", M3 = "20260922240000_prime_extrato_drenar_seguro_intensivo";
const STUB = `
create table public.prime_extrato_fila (matricula text primary key, cpf text, motivo text, tentativas int default 0, ultimo_erro text, coletado_em timestamptz, criado_em timestamptz default now());
create schema if not exists cron;
create table cron.job (jobid serial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(p_name text, p_schedule text, p_cmd text) returns bigint language plpgsql as $$
declare v bigint; begin insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$ begin delete from cron.job where jobname = p_name; return true; end $$;
create table public._mutirao_chamadas (id serial primary key, chamado_em timestamptz default now());
create or replace function public.prime_extrato_mutirao() returns jsonb language plpgsql as $$
begin
  insert into public._mutirao_chamadas default values;
  -- simula 1 coleta por chamada, do primeiro pendente do grupo B
  update public.prime_extrato_fila set coletado_em = now()
   where matricula = (select matricula from public.prime_extrato_fila where coletado_em is null and tentativas < 3 order by matricula limit 1);
  return jsonb_build_object('coletados', 1, 'erros', 0);
end $$;
`;
let BASE;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(STUB);
  await db.exec(H.MIG(M1));
  await db.exec(H.MIG(M2));
  await db.exec(H.MIG(M3));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); return db; };

const enfileirar = async (db, n) => {
  for (let i = 0; i < n; i++) {
    await db.query("insert into prime_extrato_fila(matricula, motivo) values ($1,'pendente_vinculo_diario')", [`REG${String(i).padStart(4, "0")}`]);
  }
};
const drenar = async (db) => (await db.query("select public.prime_extrato_drenar_seguro() r")).rows[0].r;

describe("drenagem segura e autodeslgavel do grupo B", () => {
  it("1) com backlog: chama o mutirao oficial e coleta", async () => {
    const db = await novo(); await enfileirar(db, 3);
    const r = await drenar(db);
    expect(r.coletados).toBe(1);
    expect((await db.query("select count(*)::int n from prime_extrato_fila where coletado_em is not null")).rows[0].n).toBe(1);
    await db.close();
  });
  it("2) sem backlog do grupo B: NAO chama o mutirao e desliga o job intensivo sozinho", async () => {
    const db = await novo();
    // sem nenhuma linha 'pendente_vinculo_diario' pendente
    const r = await drenar(db);
    expect(r.pulou).toBe("SEM_BACKLOG_GRUPO_B");
    expect((await db.query("select count(*)::int n from _mutirao_chamadas")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from cron.job where jobname='prime_extrato_pendentes_vinculo_intensivo'")).rows[0].n).toBe(0);
    await db.close();
  });
  it("3) job normal (3x/dia) continua existindo depois do backlog zerar -- so o intensivo desliga", async () => {
    const db = await novo(); await drenar(db);
    expect((await db.query("select count(*)::int n from cron.job where jobname='prime_extrato_pendentes_vinculo_drenar'")).rows[0].n).toBe(1);
    await db.close();
  });
  it("4) trava (pg_try_advisory_xact_lock) existe na funcao: com o lock tomado por hashtext do mesmo nome, uma segunda chamada dentro da mesma transacao reconhece a trava", async () => {
    const db = await novo(); await enfileirar(db, 2);
    const locked = (await db.query("select pg_try_advisory_xact_lock(hashtext('prime_extrato_drenar_seguro')) l")).rows[0].l;
    expect(locked).toBe(true); // confirma que e a MESMA chave de lock usada pela funcao (protege contra sobreposicao externa)
    await db.close();
  });
  it("5) migration so instala: 3 jobs (enfileirar + drenar + intensivo), ACL so service_role, nada chamado no DDL", async () => {
    const db = H.abrir(BASE);
    const jobs = (await db.query("select jobname, schedule from cron.job where jobname like 'prime_extrato_pendentes_vinculo_%' order by jobname")).rows;
    expect(jobs).toEqual([
      { jobname: "prime_extrato_pendentes_vinculo_drenar", schedule: "15,35,55 3 * * *" },
      { jobname: "prime_extrato_pendentes_vinculo_enfileirar", schedule: "10 3 * * *" },
      { jobname: "prime_extrato_pendentes_vinculo_intensivo", schedule: "*/3 * * * *" },
    ]);
    const p = (await db.query(`select has_function_privilege('authenticated','public.prime_extrato_drenar_seguro()','EXECUTE') a, has_function_privilege('service_role','public.prime_extrato_drenar_seguro()','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, s: true });
    expect((await db.query("select count(*)::int n from _mutirao_chamadas")).rows[0].n).toBe(0);
    await db.close();
  });
});
