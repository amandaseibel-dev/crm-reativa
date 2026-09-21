// GUARDA DO VINCULO AUTOMATICO: reproduz o caminho que falhou em producao (acordo e377a2bd): o vinculo mexe em alunos_unificados
// (status_jornada -> QUITADO) e o gatilho bloquear_alteracoes_restritas_aluno chama crm_usuario_pode_quitar_baixar(); com request.jwt.claims
// injetado pelo job, auth.jwt() deixa de ser nulo e o ator de sistema era recusado. Migrations REAIS 20260922170000, 180000 e 190000.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M0 = "20260922170000_acordo_vinculo_sugestoes", M1 = "20260922180000_acordo_vinculo_automatico", M2 = "20260922190000_vinculo_automatico_guarda_quitar";
const STUB = `
create table public._vinc_log (id serial primary key, chamada jsonb);
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid) returns jsonb language plpgsql security definer as $$
begin
  insert into public._vinc_log(chamada) values (jsonb_build_object('titulos', to_jsonb(p_titulo_ids), 'acordo', p_acordo_id, 'email', auth.email()));
  if exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = any(p_titulo_ids) and v.acordo_id <> p_acordo_id and coalesce(v.ativo,true))
    then return jsonb_build_object('ok', false, 'erro', 'TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO'); end if;
  insert into public.acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) select p_acordo_id, x, true, auth.email() from unnest(p_titulo_ids) x;
  update public.acordos_titulos set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada' where id = any(p_titulo_ids);
  update public.alunos_unificados set status_jornada = 'QUITADO' where chave_unificacao = (select aluno_id::text from public.acordos where id = p_acordo_id);
  return jsonb_build_object('ok', true, 'vinculados', array_length(p_titulo_ids, 1));
end $$;`;

const CRON = `
create schema if not exists cron;
create table cron.job (jobid serial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(p_name text, p_schedule text, p_cmd text) returns bigint language plpgsql as $$
declare v bigint; begin insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$ begin delete from cron.job where jobname = p_name; return true; end $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, nullif(current_setting('test.jwt', true), '')::jsonb) $$;
create or replace function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;`;

const GATILHO = `
create or replace function public.bloquear_alteracoes_restritas_aluno() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if public.crm_usuario_pode_quitar_baixar() then return new; end if;
  if (new.status_jornada = 'QUITADO' and old.status_jornada is distinct from new.status_jornada) then
    raise exception 'Acao permitida somente para Amanda gestora, Fernanda ou Amanda ADM.'; end if;
  return new; end $$;
create trigger trg_bloquear_alteracoes_restritas_aluno before update on public.alunos_unificados for each row execute function public.bloquear_alteracoes_restritas_aluno();`;
let ANTES, DEPOIS, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(H.MIG(M0)); await db.exec(STUB); await db.exec(CRON); await db.exec(H.MIG(M1)); await db.exec(GATILHO);
  ANTES = await db.dumpDataDir();
  await db.exec(H.MIG(M2));
  DEPOIS = await db.dumpDataDir();
  await db.close();
});
const abrir = async (base) => { const db = H.abrir(base); await db.exec("set timezone = 'UTC'"); await H.como(db, null); return db; };
const U = (a, b) => `a7000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;
// aluno + acordo + titulos com extrato 195 (FORTE)
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
  await db.query("insert into alunos_unificados(chave_unificacao, status_jornada) values ($1,'EM_COBRANCA')", [al]);
  return { n, al, ac, ids, cpf: cpfn };
};

const rodar = async (db) => (await db.query("select public.acordo_vinculo_automatico_processar(40) r")).rows[0].r;
const vinc = async (db, ac) => (await db.query("select 1 from acordo_titulo_vinculo where acordo_id=$1 and ativo", [ac])).rows.length;
const pode = async (db, email, chave) => {
  await db.query("select set_config('request.jwt.claims', $1, false)", [email ? JSON.stringify({ email, role: "authenticated" }) : ""]);
  await db.query("select set_config('reativa.vinculo_automatico', $1, false)", [chave ? "on" : "off"]);
  return (await db.query("select public.crm_usuario_pode_quitar_baixar() p")).rows[0].p;
};
describe("guarda crm_usuario_pode_quitar_baixar x vinculo automatico", () => {
  it("1) REPRODUZ a falha antes do patch: vinculo que quita o aluno e recusado, sem vinculo parcial, erro auditado", async () => {
    const db = await abrir(ANTES); const c = await cenario(db);
    const r = await rodar(db);
    expect(r.falhas).toBe(1); expect(r.vinculados).toBe(0); expect(await vinc(db, c.ac)).toBe(0);
    const a = (await db.query("select detalhes from auditoria where acao='SUGESTAO_VINCULO_AUTOMATICO_FALHA'")).rows[0];
    expect(JSON.stringify(a.detalhes)).toContain("Acao permitida somente para Amanda gestora");
    await db.close();
  });
  it("2) depois do patch o mesmo caminho vincula, aluno vira QUITADO e o ator segue vinculo-automatico@sistema", async () => {
    const db = await abrir(DEPOIS); const c = await cenario(db);
    const r = await rodar(db);
    expect(r.vinculados).toBe(1); expect(r.falhas).toBe(0); expect(await vinc(db, c.ac)).toBe(2);
    expect((await db.query("select status_jornada from alunos_unificados where chave_unificacao=$1", [c.al])).rows[0].status_jornada).toBe("QUITADO");
    expect((await db.query("select decidido_por from acordo_vinculo_sugestao_decisao where acordo_id=$1", [c.ac])).rows[0].decidido_por).toBe("vinculo-automatico@sistema");
    expect((await db.query("select usuario from auditoria where acao='SUGESTAO_VINCULO_AUTOMATICO' and registro_id=$1", [c.ac])).rows[0].usuario).toBe("vinculo-automatico@sistema");
    expect((await db.query("select chamada->>'email' e from _vinc_log")).rows[0].e).toBe("vinculo-automatico@sistema");
    await db.close();
  });
  it("3) o ator NAO virou gestor: fora do job (mesmo com chave acesa ou e-mail forjado) a guarda continua negando; gestores e operadores inalterados", async () => {
    const db = await abrir(DEPOIS);
    expect(await pode(db, "vinculo-automatico@sistema", false)).toBe(false);
    expect(await pode(db, "vinculo-automatico@sistema", true)).toBe(false); // chave sem a pilha do job
    expect(await pode(db, H.OP6, true)).toBe(false);
    expect(await pode(db, H.GESTAO, false)).toBe(true);
    expect(await pode(db, "cobranca04@aelbra.com.br", false)).toBe(true);
    expect(await pode(db, null, false)).toBe(true); // sem JWT: papel do banco (postgres) como antes
    await db.query("select set_config('request.jwt.claims','',false)");
    await db.close();
  });
  it("4) authenticated nao executa a funcao do job; ACL segue so service_role", async () => {
    const db = await abrir(DEPOIS);
    const p = (await db.query(`select has_function_privilege('authenticated','public.acordo_vinculo_automatico_processar(int)','EXECUTE') a, has_function_privilege('service_role','public.acordo_vinculo_automatico_processar(int)','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, s: true });
    await db.close();
  });
  it("5) erro em um acordo continua isolado e sem vinculo parcial; o outro vincula", async () => {
    const db = await abrir(DEPOIS); const a = await cenario(db); const b = await cenario(db);
    await db.exec(`create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid) returns jsonb language plpgsql as $$
      begin
        insert into public.acordo_titulo_vinculo(acordo_id, titulo_id, ativo, vinculado_por) select p_acordo_id, x, true, auth.email() from unnest(p_titulo_ids) x;
        if p_acordo_id = '${a.ac}' then raise exception 'falha simulada'; end if;
        return jsonb_build_object('ok', true); end $$;`);
    const r = await rodar(db); expect(r.falhas).toBe(1); expect(r.vinculados).toBe(1);
    expect(await vinc(db, a.ac)).toBe(0); expect(await vinc(db, b.ac)).toBe(2);
    await db.close();
  });
});
