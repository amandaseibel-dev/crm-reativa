// VINCULO AUTOMATICO FORTE: migration REAL (20260922180000) + rollback sobre a fixture confirmacao_d2, com a migration #448 real.
// Stubs: vincular_titulos_acordo (registra chamadas; recusa conflito), pg_cron (contrato do schedule) e auth.email (le request.jwt.claims como o Supabase).
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M0 = "20260922170000_acordo_vinculo_sugestoes", M = "20260922180000_acordo_vinculo_automatico";
const STUB = `
create table public._vinc_log (id serial primary key, chamada jsonb);
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid) returns jsonb language plpgsql security definer as $$
begin
  insert into public._vinc_log(chamada) values (jsonb_build_object('titulos', to_jsonb(p_titulo_ids), 'acordo', p_acordo_id, 'email', auth.email()));
  if exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = any(p_titulo_ids) and v.acordo_id <> p_acordo_id and coalesce(v.ativo,true))
    then return jsonb_build_object('ok', false, 'erro', 'TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO'); end if;
  insert into public.acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) select p_acordo_id, x, true, auth.email() from unnest(p_titulo_ids) x;
  update public.acordos_titulos set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada' where id = any(p_titulo_ids);
  return jsonb_build_object('ok', true, 'vinculados', array_length(p_titulo_ids, 1));
end $$;`;

const CRON = `
create schema if not exists cron;
create table cron.job (jobid serial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(p_name text, p_schedule text, p_cmd text) returns bigint language plpgsql as $$
declare v bigint; begin insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$ begin delete from cron.job where jobname = p_name; return true; end $$;
create or replace function auth.email() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', auth.jwt()->>'email') $$;`;
let BASE, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(H.MIG(M0));
  await db.exec(STUB); await db.exec(CRON);
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async (email = H.GESTAO) => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); await H.como(db, email); return db; };
const U = (a, b) => `a7000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

// aluno + acordo (criado em `cr`) + titulos (cada um com extrato 195 em `liq`), tudo configuravel
async function cenario(db, { cpf, cr = "2026-08-10", status = "ATIVO", titulos = [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05" }, { doc: "2", venc: "2026-07-10", liq: "2026-08-05" }], extratoCpf, sit = "ABERTO" } = {}) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), cpfn = cpf ?? String(70000000000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno Sugestao ${n}`, cpfn, String(n), H.OP6]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,$4,$5,$5,2,$6,$7,$8::timestamptz)", [ac, al, cpfn, status, 1000 + n, String(80000 + n), H.OP6, `${cr}T12:00:00Z`]);
  const ids = [];
  for (let i = 0; i < titulos.length; i++) {
    const t = titulos[i], id = U(n, 100 + i), doc = `${9000000 + n * 10 + i}`; ids.push(id);
    await db.exec("set session_replication_role = replica"); // fixture: EM_CONFIRMACAO/NEGOCIADO so nascem por rotinas protegidas por gatilho
    await db.query("insert into acordos_titulos(id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,status,tipo_boleto) values ($1,$2,$3,$4,$5::date,300,300,$6,$7,$8)",
      [id, al, cpfn, doc, t.venc, t.sit ?? sit, t.st ?? "em_aberto", t.tipo ?? "Cursos de Graduação Presencial"]);
    await db.exec("set session_replication_role = origin");
    if (t.liq) await db.query("insert into prime_extrato(matricula,boleto,cpf,vencimento,liquidado_em,valor_liquido,portador) values ($1,$2,$3,$4::date,$5::date,300,195)",
      [`M${n}`, t.docExtrato ?? doc, t.cpfExtrato ?? extratoCpf ?? cpfn, t.venc, t.liq]);
  }
  return { n, al, ac, ids, cpf: cpfn };
};
const calc = async (db, ac) => (await db.query("select * from public.acordo_vinculo_sugestoes_calcular($1)", [ac])).rows[0];
const rodar = async (db, lim = 40) => (await db.query("select public.acordo_vinculo_automatico_processar($1) r", [lim])).rows[0].r;
const vinc = async (db, ac) => (await db.query("select titulo_id from acordo_titulo_vinculo where acordo_id=$1 and ativo", [ac])).rows.length;
describe("vinculo automatico FORTE", () => {
  it("1) FORTE vincula sozinho via RPC oficial, com ator de sistema, decisao CONFIRMADA e auditoria", async () => {
    const db = await novo(null); const c = await cenario(db);
    const r = await rodar(db); expect(r.vinculados).toBe(1);
    expect(await vinc(db, c.ac)).toBe(2);
    const log = (await db.query("select chamada from _vinc_log")).rows;
    expect(log.length).toBe(1); expect(log[0].chamada.email).toBe("vinculo-automatico@sistema");
    expect((await db.query("select decisao, decidido_por from acordo_vinculo_sugestao_decisao where acordo_id=$1", [c.ac])).rows[0]).toEqual({ decisao: "CONFIRMADA", decidido_por: "vinculo-automatico@sistema" });
    expect((await db.query("select count(*)::int n from auditoria where acao='SUGESTAO_VINCULO_AUTOMATICO' and registro_id=$1", [c.ac])).rows[0].n).toBe(1);
    await db.close();
  });
  it("2) REVISAO e SEM_EVIDENCIA nunca vinculam", async () => {
    const db = await novo(null);
    const sem = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05", cpfExtrato: "11111111111" }] });
    const rev = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05" }, { doc: "2", venc: "2026-06-10", liq: "2026-07-20" }] });
    expect((await calc(db, rev.ac)).nivel).toBe("REVISAO");
    const r = await rodar(db); expect(r.vinculados).toBe(0);
    expect(await vinc(db, sem.ac)).toBe(0); expect(await vinc(db, rev.ac)).toBe(0);
    expect((await db.query("select count(*)::int n from _vinc_log")).rows[0].n).toBe(0);
    await db.close();
  });
  it("3) idempotente: segunda rodada nao chama a RPC de novo", async () => {
    const db = await novo(null); await cenario(db);
    await rodar(db); const r2 = await rodar(db);
    expect(r2.vinculados).toBe(0);
    expect((await db.query("select count(*)::int n from _vinc_log")).rows[0].n).toBe(1);
    await db.close();
  });
  it("4) composicao rejeitada nao vincula; composicao diferente volta a valer", async () => {
    const db = await novo(null); const c = await cenario(db);
    const s = await calc(db, c.ac);
    await db.query("insert into acordo_vinculo_sugestao_decisao(acordo_id,composicao_hash,titulo_ids,decisao,decidido_por) values ($1,$2,$3,'REJEITADA','gestao')", [c.ac, s.composicao_hash, c.ids]);
    expect((await rodar(db)).vinculados).toBe(0); expect(await vinc(db, c.ac)).toBe(0);
    await db.query("update acordo_vinculo_sugestao_decisao set composicao_hash='outra' where acordo_id=$1", [c.ac]);
    expect((await rodar(db)).vinculados).toBe(1);
    await db.close();
  });
  it("5) falha em um acordo (RPC recusa) nao interrompe os demais nem deixa vinculo parcial", async () => {
    const db = await novo(null);
    const a = await cenario(db); const b = await cenario(db);
    await db.exec(`create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid) returns jsonb language plpgsql as $$
      begin
        if p_acordo_id = '${a.ac}' then
          insert into public.acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) values (p_acordo_id, p_titulo_ids[1], true, 'x');
          return jsonb_build_object('ok', false, 'erro', 'RECUSADO');
        end if;
        insert into public.acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) select p_acordo_id, x, true, auth.email() from unnest(p_titulo_ids) x;
        return jsonb_build_object('ok', true); end $$;`);
    const r = await rodar(db); expect(r.falhas).toBe(1); expect(r.vinculados).toBe(1);
    expect(await vinc(db, a.ac)).toBe(0); expect(await vinc(db, b.ac)).toBe(2);
    expect((await db.query("select count(*)::int n from auditoria where acao='SUGESTAO_VINCULO_AUTOMATICO_FALHA'")).rows[0].n).toBe(1);
    await db.close();
  });
  it("6) limite por rodada: estoque e drenado em rodadas sucessivas", async () => {
    const db = await novo(null); for (let i = 0; i < 3; i++) await cenario(db);
    expect((await rodar(db, 2)).vinculados).toBe(2); expect((await rodar(db, 2)).vinculados).toBe(1); expect((await rodar(db, 2)).vinculados).toBe(0);
    await db.close();
  });
  it("7) migration so instala: nada vinculado no DDL; job unico fora do :40; ACL so service_role; rollback remove", async () => {
    const db = H.abrir(BASE);
    const j = (await db.query("select * from cron.job where jobname='acordo_vinculo_automatico'")).rows;
    expect(j.length).toBe(1); expect(j[0].schedule).toBe("0,15,30,45 * * * *"); expect(j[0].command).toContain("acordo_vinculo_automatico_processar");
    expect((await db.query("select count(*)::int n from acordo_titulo_vinculo")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from cron.job where jobname='fluxo_pagamentos_horario'")).rows[0].n).toBe(0);
    const p = (await db.query(`select has_function_privilege('authenticated','public.acordo_vinculo_automatico_processar(int)','EXECUTE') a, has_function_privilege('anon','public.acordo_vinculo_automatico_processar(int)','EXECUTE') n, has_function_privilege('service_role','public.acordo_vinculo_automatico_processar(int)','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, n: false, s: true });
    await db.exec(H.lerRepo ? H.lerRepo("supabase/rollbacks/20260922180000_acordo_vinculo_automatico.rollback.sql") : "");
    expect((await db.query("select count(*)::int n from cron.job where jobname='acordo_vinculo_automatico'")).rows[0].n).toBe(0);
    await db.close();
  });
});
