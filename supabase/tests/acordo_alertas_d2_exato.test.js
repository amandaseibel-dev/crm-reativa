// D-2 EXATO: o alerta so nasce quando hoje = vencimento - 2 dias corridos. Migrations REAIS (ate 20260922140000) e rollback REAL (PGlite),
// fixture confirmacao_d2 (funcoes de producao com texto exato). Dados FICTICIOS; datas simuladas por p_hoje.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const CADEIA = ["20260922100000_confirmacao_vinculo_pagamentos", "20260922100100_confirmacao_processada_resolver", "20260922100150_confirmacao_processada_acl",
  "20260922100200_confirmacao_encerramento_processado", "20260922100250_acl_gatilho_confirmacao_encerra", "20260922110000_acordo_alertas_parcela",
  "20260922110100_acl_gatilhos_d2", "20260922120000_acordo_alertas_triggers_failsafe", "20260922130000_d2_bloqueio_operacional"];
const ME = "20260922140000_d2_geracao_exata";
const VENC = "2026-10-19"; // segunda; D-2 = 2026-10-17
let PRE, POS, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  for (const m of CADEIA) await db.exec(H.MIG(m));
  PRE = await db.dumpDataDir();
  await db.exec(H.MIG(ME));
  POS = await db.dumpDataDir();
  await db.close();
});
const novo = async (dump = POS) => { const db = H.abrir(dump); await db.exec("set check_function_bodies = off; set timezone = 'UTC';"); await H.como(db, H.GESTAO); return db; };
const U = (a, b) => `a5000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;
async function mk(db, { statusAluno = "ACORDO_EM_DIA", naoAcionar = false, parcelas = [{ venc: VENC }] } = {}) {
  const n = ++seq, al = U(n, 1), ac = U(n, 2), cs = U(n, 5), cpf = String(50000000000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada,status_acionamento) values ($1,'Teste Exato',$2,$3,0,'op1@x',$4,$4,$4)", [al, cpf, String(n), statusAluno]);
  await db.query("insert into casos(id,aluno_id,nome,cpf_limpo,cpf,operador_email,operador_nome,status_atual,status_acionamento,nao_acionar) values ($1,$2,'Teste Exato',$3,$3,'op1@x','Op Um','CONTATAR','CONTATAR',$4)", [cs, al, cpf, naoAcionar]);
  await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,numero_acordo,operador_responsavel_email) values ($1,$2,$3,'ATIVO',1000,1000,$4,$5,$6,'op1@x')", [ac, al, cpf, parcelas.length, String(67000 + n), 9500 + n]);
  const ps = [];
  for (let i = 0; i < parcelas.length; i++) { const id = U(n, 10 + i); ps.push(id);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$2,$3,100,$4::date,$5)", [id, ac, i + 1, parcelas[i].venc, parcelas[i].status ?? "A_VENCER"]); }
  return { al, ac, cs, ps };
}
const gerar = async (db, hoje) => (await db.query("select public.acordo_alertas_gerar($1::date,null,null) j", [hoje])).rows[0].j;
const al = async (db, ac) => (await db.query("select numero_parcela n, vencimento::text v, data_alerta::text da, resolucao res from acordo_alertas_parcela where acordo_id=$1 order by criado_em, id", [ac])).rows;

describe("D-2 exato", () => {
  it("1) D-2 exato gera (data_alerta = vencimento - 2 corridos)", async () => {
    const db = await novo(); const a = await mk(db);
    expect((await gerar(db, "2026-10-17")).criados).toBe(1);
    expect(await al(db, a.ac)).toEqual([{ n: 1, v: VENC, da: "2026-10-17", res: null }]);
    await db.close();
  });
  it("2) D-1 nao gera, 3) vence hoje nao gera, 4) vencida nao gera; 3 dias antes tambem nao (dia perdido nao e recuperado)", async () => {
    for (const hoje of ["2026-10-16", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-25"]) {
      const db = await novo(); const a = await mk(db);
      expect([hoje, (await gerar(db, hoje)).criados, await al(db, a.ac)]).toEqual([hoje, 0, []]);
      await db.close();
    }
  });
  it("controle: SEM o patch (janela acumulada) o D-1 e o vence-hoje geravam", async () => {
    for (const hoje of ["2026-10-18", "2026-10-19"]) {
      const db = await novo(PRE); const a = await mk(db);
      expect([hoje, (await gerar(db, hoje)).criados, (await al(db, a.ac)).length]).toEqual([hoje, 1, 1]);
      await db.close();
    }
  });
  it("5) segunda execucao no mesmo D-2 e idempotente; dias seguintes nao recriam nem duplicam e o alerta aberto permanece ate resolver", async () => {
    const db = await novo(); const a = await mk(db);
    await gerar(db, "2026-10-17");
    const antes = await al(db, a.ac);
    expect((await gerar(db, "2026-10-17")).criados).toBe(0);
    expect(await al(db, a.ac)).toEqual(antes);
    await gerar(db, "2026-10-18"); expect(await al(db, a.ac)).toEqual(antes); // segue aberto em D-1
    await gerar(db, "2026-10-20"); expect((await al(db, a.ac))[0].res).toBe("VENCIDA"); // resolucao inalterada
    await db.close();
  });
  it("6) bloqueado em D-2 nao gera (#444 preservado): status e nao_acionar", async () => {
    const db = await novo();
    const a = await mk(db, { statusAluno: "SUSPENSAO_COBRANCA" }), b = await mk(db, { naoAcionar: true }), c = await mk(db);
    expect((await gerar(db, "2026-10-17")).criados).toBe(1);
    expect(await al(db, a.ac)).toEqual([]); expect(await al(db, b.ac)).toEqual([]); expect((await al(db, c.ac)).length).toBe(1);
    await db.close();
  });
  it("7) acordo ja vencido (outra parcela em atraso) com parcela futura em D-2 nao gera; parcela pulada/paga nao gera; 2 acordos independentes", async () => {
    const db = await novo();
    const v = await mk(db, { parcelas: [{ venc: "2026-10-01", status: "VENCIDA" }, { venc: VENC }] });
    const p = await mk(db, { parcelas: [{ venc: VENC, status: "PAGO" }, { venc: "2026-11-19" }] });
    const ok = await mk(db);
    expect((await gerar(db, "2026-10-17")).criados).toBe(1);
    expect(await al(db, v.ac)).toEqual([]); expect(await al(db, p.ac)).toEqual([]); expect((await al(db, ok.ac)).length).toBe(1);
    await db.close();
  });
  it("8) nenhum dado financeiro e alterado pela geracao", async () => {
    const db = await novo(); await mk(db); await mk(db, { statusAluno: "JURIDICO" });
    const snap = async () => (await db.query(`select (select md5(string_agg(t::text,'|' order by id)) from parcelas t) p, (select md5(string_agg(t::text,'|' order by id)) from acordos t) a,
      (select md5(string_agg(t::text,'|' order by id)) from pagamentos t) g, (select md5(string_agg(t::text,'|' order by id)) from alunos t) al, (select md5(string_agg(t::text,'|' order by id)) from casos t) c`)).rows[0];
    const antes = await snap(); await gerar(db, "2026-10-17"); await gerar(db, "2026-10-17");
    expect(await snap()).toEqual(antes);
    await db.close();
  });
  it("9) fail-safe #443: baixa prevalece com a resolucao do alerta quebrada; 10) bloqueio posterior resolve BLOQUEADO (#444)", async () => {
    const db = await novo(); const a = await mk(db, { parcelas: [{ venc: VENC }, { venc: "2026-11-19" }] }); await gerar(db, "2026-10-17");
    await db.exec(`create or replace function public._teste_quebra() returns trigger language plpgsql as $$ begin raise exception 'erro proposital'; end $$;
      create trigger _teste_quebra before update on public.acordo_alertas_parcela for each row execute function public._teste_quebra();`);
    await db.query("update parcelas set status='PAGO' where id=$1", [a.ps[0]]);
    expect((await db.query("select status from parcelas where id=$1", [a.ps[0]])).rows[0].status).toBe("PAGO");
    await db.close();
    const d2 = await novo(); const b = await mk(d2); await gerar(d2, "2026-10-17");
    await d2.query("update casos set nao_acionar = true where id=$1", [b.cs]); await gerar(d2, "2026-10-17");
    expect((await al(d2, b.ac))[0].res).toBe("BLOQUEADO");
    await d2.close();
  });
  it("11) a migration nao executa acordo_alertas_gerar nem cria alertas; 12) nenhum cron; ACL/flag intactas; rollback restaura a janela", async () => {
    const db = H.abrir(POS);
    expect((await db.query("select count(*)::int n from acordo_alertas_parcela")).rows[0].n).toBe(0);
    expect((await db.query("select ligado from fluxo_pagamentos_config where etapa='encerrar_confirmacao_processada'")).rows[0].ligado).toBe(false);
    const sql = H.MIG(ME).replace(/--.*$/gm, "").replace(/\$function\$[\s\S]*?\$function\$/g, "");
    expect(sql).not.toMatch(/cron\.|insert\s+into|select\s+public\.acordo_alertas_gerar|perform\s+public\.acordo_alertas_gerar/i);
    const r = (await db.query(`select has_function_privilege('anon','public.acordo_alertas_gerar(date,int,text)','execute') a, has_function_privilege('authenticated','public.acordo_alertas_gerar(date,int,text)','execute') u,
      (select coalesce(p.proacl::text ~ '(^\\\\{|,)=X/', false) from pg_proc p where p.oid='public.acordo_alertas_gerar(date,int,text)'::regprocedure) pub`)).rows[0];
    expect(r).toEqual({ a: false, u: false, pub: false });
    await db.exec(H.ROLL(ME));
    const a = await mk(db); await db.exec("select public.acordo_alertas_gerar('2026-10-18'::date,null,null)");
    expect((await al(db, a.ac)).length).toBe(1);
    await db.close();
  });
});
