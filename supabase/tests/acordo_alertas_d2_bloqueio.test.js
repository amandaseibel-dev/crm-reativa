// D-2: aluno que nao pode ser acionado nao gera/mantem alerta. Migrations REAIS (ate 20260922130000) e rollback REAL num PostgreSQL real (PGlite),
// sobre a fixture confirmacao_d2 (funcoes de producao com texto exato). Dados FICTICIOS. Datas simuladas por p_hoje.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const CADEIA = ["20260922100000_confirmacao_vinculo_pagamentos", "20260922100100_confirmacao_processada_resolver", "20260922100150_confirmacao_processada_acl",
  "20260922100200_confirmacao_encerramento_processado", "20260922100250_acl_gatilho_confirmacao_encerra", "20260922110000_acordo_alertas_parcela",
  "20260922110100_acl_gatilhos_d2", "20260922120000_acordo_alertas_triggers_failsafe"];
const MEXATO = "20260922140000_d2_geracao_exata";
const MB = "20260922130000_d2_bloqueio_operacional";
const D = "2026-10-19", HOJE = "2026-10-17";
let PRE, POS, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  for (const m of CADEIA) await db.exec(H.MIG(m));
  PRE = await db.dumpDataDir();
  await db.exec(H.MIG(MB));
  await db.exec(H.MIG(MEXATO));
  POS = await db.dumpDataDir();
  await db.close();
});
const novo = async (dump = POS) => { const db = H.abrir(dump); await db.exec("set check_function_bodies = off; set timezone = 'UTC';"); await H.como(db, H.GESTAO); return db; };
const U = (a, b) => `a4000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;
async function mk(db, { status = "ATIVO", statusAluno = "ACORDO_EM_DIA", statusCaso = "CONTATAR", naoAcionar = false, venc = D } = {}) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), p1 = U(n, 3), p2 = U(n, 4), cs = U(n, 5), cpf = String(40000000000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada,status_acionamento) values ($1,'Teste Bloqueio',$2,$3,0,'op1@x',$4,$4,$4)", [al, cpf, String(n), statusAluno]);
  await db.query("insert into casos(id,aluno_id,nome,cpf_limpo,cpf,operador_email,operador_nome,status_atual,status_acionamento,nao_acionar) values ($1,$2,'Teste Bloqueio',$3,$3,'op1@x','Op Um',$4,$4,$5)", [cs, al, cpf, statusCaso, naoAcionar]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) values ($1,$2,$3,$4,1000,1000,2,$5,$6,'op1@x')", [ac, al, cpf, status, String(66000 + n), 9400 + n]);
  await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,1,100,$3::date,'A_VENCER'),($4,$2,2,100,'2026-11-19','A_VENCER')", [p1, ac, venc, p2]);
  return { al, ac, p1, p2, cs };
}
const gerar = async (db, hoje = HOJE) => (await db.query("select public.acordo_alertas_gerar($1::date,null,null) j", [hoje])).rows[0].j;
const al = async (db, ac) => (await db.query("select numero_parcela n, resolucao res, (resolvido_em is not null) f from acordo_alertas_parcela where acordo_id=$1 order by criado_em, id", [ac])).rows;
const setAluno = (db, id, st) => db.query("update alunos set status_atual=$2, status_jornada=$2, status_acionamento=$2 where id=$1", [id, st]);

describe("nao gera para aluno que nao pode ser acionado", () => {
  it("aluno normal + parcela D-2 => gera; 'CANCELADO' puro e texto aproximado NAO bloqueiam (fora do escopo)", async () => {
    const db = await novo();
    const a = await mk(db); await gerar(db);
    expect(await al(db, a.ac)).toEqual([{ n: 1, res: null, f: false }]);
    for (const st of ["CANCELADO", "CANCELADO_ACORDO", "CANCEL"]) {
      const x = await mk(db, { statusAluno: st, statusCaso: st }); await gerar(db);
      expect((await al(db, x.ac)).length).toBe(1);
    }
    await db.close();
  });
  it("SUSPENSAO_COBRANCA / 'SUSPENSAO DE COBRANCA' / JURIDICO / Juridico / CANCELAMENTO_COBRANCA no ALUNO => nao gera", async () => {
    const db = await novo();
    for (const st of ["SUSPENSAO_COBRANCA", "SUSPENSAO DE COBRANCA", "JURIDICO", "Juridico", "CANCELAMENTO_COBRANCA", "CANCELAMENTO COBRANCA"]) {
      const x = await mk(db, { statusAluno: st }); await gerar(db);
      expect([st, await al(db, x.ac)]).toEqual([st, []]);
    }
    await db.close();
  });
  it("as mesmas condicoes no CASO (status_atual/acionamento) => nao gera", async () => {
    const db = await novo();
    for (const st of ["SUSPENSAO_COBRANCA", "JURIDICO", "CANCELAMENTO_COBRANCA"]) {
      const x = await mk(db, { statusCaso: st }); await gerar(db);
      expect([st, await al(db, x.ac)]).toEqual([st, []]);
    }
    await db.close();
  });
  it("nao_acionar = true => nao gera; nao_acionar = false => gera; acordos de outro aluno seguem independentes", async () => {
    const db = await novo();
    const a = await mk(db, { naoAcionar: true }), b = await mk(db), c = await mk(db, { naoAcionar: false });
    await gerar(db);
    expect(await al(db, a.ac)).toEqual([]);
    expect((await al(db, b.ac)).length).toBe(1); expect((await al(db, c.ac)).length).toBe(1);
    await db.close();
  });
});
describe("bloqueio posterior resolve, desbloqueio volta a gerar", () => {
  it("alerta aberto + suspensao posterior => resolve BLOQUEADO; idempotente", async () => {
    const db = await novo(); const a = await mk(db); await gerar(db);
    expect((await al(db, a.ac))[0].f).toBe(false);
    await setAluno(db, a.al, "SUSPENSAO_COBRANCA");
    const j = await gerar(db);
    expect(j.resolvidos).toBe(1);
    expect(await al(db, a.ac)).toEqual([{ n: 1, res: "BLOQUEADO", f: true }]);
    await gerar(db); expect(await al(db, a.ac)).toHaveLength(1);
    await db.close();
  });
  it("alerta aberto + nao_acionar posterior => resolve BLOQUEADO", async () => {
    const db = await novo(); const a = await mk(db); await gerar(db);
    await db.query("update casos set nao_acionar = true where id=$1", [a.cs]);
    await gerar(db);
    expect(await al(db, a.ac)).toEqual([{ n: 1, res: "BLOQUEADO", f: true }]);
    await db.close();
  });
  it("desbloqueio + parcela ainda elegivel => gera de novo (o alerta antigo fica resolvido)", async () => {
    const db = await novo(); const a = await mk(db); await gerar(db);
    await db.query("update casos set nao_acionar = true where id=$1", [a.cs]); await gerar(db);
    await db.query("update casos set nao_acionar = false where id=$1", [a.cs]); await gerar(db);
    expect(await al(db, a.ac)).toEqual([{ n: 1, res: "BLOQUEADO", f: true }, { n: 1, res: null, f: false }]);
    await db.close();
  });
  it("desbloqueio quando a parcela ja nao e elegivel (vencida) => nao gera", async () => {
    const db = await novo(); const a = await mk(db); await gerar(db);
    await setAluno(db, a.al, "JURIDICO"); await gerar(db);
    await setAluno(db, a.al, "ACORDO_EM_DIA"); await gerar(db, "2026-10-25");
    expect((await al(db, a.ac)).filter((x) => !x.f)).toEqual([]);
    await db.close();
  });
  it("precedencia: acordo QUITADO/parcela PAGA continuam resolvendo pelo motivo financeiro, mesmo bloqueado", async () => {
    const db = await novo();
    const q = await mk(db); await gerar(db);
    await setAluno(db, q.al, "JURIDICO");
    await db.query("update acordos set status='QUITADO' where id=$1", [q.ac]); // trigger resolve
    expect((await al(db, q.ac))[0].res).toBe("ACORDO_QUITADO");
    const p = await mk(db); await gerar(db);
    await setAluno(db, p.al, "SUSPENSAO_COBRANCA");
    await db.query("update parcelas set status='PAGO' where id=$1", [p.p1]);
    expect((await al(db, p.ac))[0].res).toBe("PAGA");
    await db.close();
  });
});
describe("financeiro intacto, fail-safe preservado, ACL/RLS, inercia", () => {
  it("gerar/resolver nao alteram parcelas, acordos, saldo, alunos.saldo_total nem status financeiro", async () => {
    const db = await novo(); const a = await mk(db); await mk(db, { statusAluno: "SUSPENSAO_COBRANCA" });
    const snap = async () => (await db.query(`select (select md5(string_agg(t::text,'|' order by id)) from parcelas t) p, (select md5(string_agg(t::text,'|' order by id)) from acordos t) a,
      (select md5(string_agg(t::text,'|' order by id)) from pagamentos t) g, (select md5(string_agg(saldo_total::text,'|' order by id)) from alunos) al`)).rows[0];
    const antes = await snap(); await gerar(db); await setAluno(db, a.al, "JURIDICO"); await gerar(db);
    expect(await snap()).toEqual(antes);
    await db.close();
  });
  it("pagamento continua prevalecendo mesmo se a resolucao do alerta falhar (fail-safe do #443 intacto)", async () => {
    const db = await novo(); const a = await mk(db); await gerar(db);
    await db.exec(`create or replace function public._teste_quebra() returns trigger language plpgsql as $$ begin raise exception 'erro proposital'; end $$;
      create trigger _teste_quebra before update on public.acordo_alertas_parcela for each row execute function public._teste_quebra();`);
    await db.query("update parcelas set status='PAGO' where id=$1", [a.p1]);
    expect((await db.query("select status from parcelas where id=$1", [a.p1])).rows[0].status).toBe("PAGO");
    await db.close();
  });
  it("ACL/RLS: helper e rotinas so service_role/postgres; anon/authenticated/PUBLIC sem EXECUTE; RLS e ACL da tabela intactas; check aceita BLOQUEADO", async () => {
    const db = H.abrir(POS);
    for (const f of ["aluno_bloqueado_para_d2(uuid)", "acordo_alertas_gerar(date,int,text)", "acordo_alertas_resolver(date)"]) {
      const r = (await db.query(`select has_function_privilege('anon','public.${f}','execute') a, has_function_privilege('authenticated','public.${f}','execute') u,
        (select coalesce(p.proacl::text ~ '(^\\\\{|,)=X/', false) from pg_proc p where p.oid='public.${f}'::regprocedure) pub, (select prosecdef from pg_proc p where p.oid='public.${f}'::regprocedure) d`)).rows[0];
      expect([f, r]).toEqual([f, { a: false, u: false, pub: false, d: true }]);
    }
    expect((await db.query("select relrowsecurity r from pg_class where relname='acordo_alertas_parcela'")).rows[0].r).toBe(true);
    expect((await db.query("select has_table_privilege('anon','public.acordo_alertas_parcela','select') a, has_table_privilege('authenticated','public.acordo_alertas_parcela','insert') i")).rows[0]).toEqual({ a: false, i: false });
    expect((await db.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='acordo_alertas_parcela_resolucao_check'")).rows[0].d).toContain("BLOQUEADO");
    await db.close();
  });
  it("migration nao cria alertas, nao agenda cron e a flag de confirmacao continua OFF", async () => {
    const db = H.abrir(POS);
    expect((await db.query("select count(*)::int n from acordo_alertas_parcela")).rows[0].n).toBe(0);
    expect((await db.query("select ligado from fluxo_pagamentos_config where etapa='encerrar_confirmacao_processada'")).rows[0].ligado).toBe(false);
    const sql = H.MIG(MB).replace(/--.*$/gm, "").replace(/\$function\$[\s\S]*?\$function\$/g, ""); // fora dos corpos de funcao
    expect(sql).not.toMatch(/cron\.|insert\s+into\s+public\.acordo_alertas_parcela|acordo_alertas_gerar\(\s*current|confirmacao_encerrar_processadas\(/i);
    await db.close();
  });
  it("rollback restaura gerar/resolver e remove o helper", async () => {
    const db = H.abrir(POS); await db.exec(H.ROLL(MB));
    expect((await db.query("select count(*)::int n from pg_proc where proname='aluno_bloqueado_para_d2'")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from pg_proc where proname in ('acordo_alertas_gerar','acordo_alertas_resolver') and prosrc like '%aluno_bloqueado_para_d2%'")).rows[0].n).toBe(0);
    expect((await db.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='acordo_alertas_parcela_resolucao_check'")).rows[0].d).not.toContain("BLOQUEADO");
    await db.close();
  });
});
