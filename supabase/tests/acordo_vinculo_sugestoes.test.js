// FILA ASSISTIDA DE VINCULO DE MENSALIDADES AOS ACORDOS. Migration REAL (20260922170000) e rollback REAL num PostgreSQL real (PGlite)
// sobre a fixture confirmacao_d2. Dados FICTICIOS (nomes/CPFs/boletos inventados). Unico stub: vincular_titulos_acordo (a funcao oficial de
// producao depende de dezenas de objetos fora da fixture) -- o stub REGISTRA cada chamada e recusa conflito, para provar que a confirmacao usa a RPC oficial.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20260922170000_acordo_vinculo_sugestoes";
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
let BASE, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(H.MIG(M));
  await db.exec(STUB);
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
const calc = async (db, ac) => (await db.query("select *, liquidacao_195::text liq_txt from public.acordo_vinculo_sugestoes_calcular($1)", [ac])).rows[0];
const lista = async (db, ac) => (await db.query("select * from public.acordos_vinculo_sugestoes() where acordo_id = $1", [ac])).rows[0];
const snapFin = async (db) => (await db.query(`select (select md5(coalesce(string_agg(t::text,'|' order by id),'')) from acordos t) a, (select md5(coalesce(string_agg(t::text,'|' order by id),'')) from acordos_titulos t) t,
  (select md5(coalesce(string_agg(t::text,'|' order by id),'')) from parcelas t) p, (select md5(coalesce(string_agg(t::text,'|' order by id),'')) from pagamentos t) g,
  (select count(*)::int from acordo_titulo_vinculo) v`)).rows[0];

describe("regra da sugestao (FORTE / REVISAO / SEM_EVIDENCIA)", () => {
  it("1) sugestao FORTE valida: um grupo 195, CPF e documento conferem, titulos ABERTO livres e vencidos na liquidacao", async () => {
    const db = await novo(); const c = await cenario(db);
    const r = await calc(db, c.ac);
    expect(r.nivel).toBe("FORTE"); expect(r.motivo).toBe("UNICO_GRUPO_195_COMPATIVEL");
    expect(r.liq_txt).toBe("2026-08-05");
    expect(r.titulos.map((x) => x.titulo_id).sort()).toEqual([...c.ids].sort());
    expect(r.titulos[0]).toMatchObject({ situacao: "ABERTO", liquidacao_195: "2026-08-05" });
    expect(r.composicao_hash).toMatch(/^[0-9a-f]{32}$/);
    await db.close();
  });
  it("2) CPF divergente e 3) documento divergente => SEM_EVIDENCIA", async () => {
    const db = await novo();
    const a = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05", cpfExtrato: "11111111111" }] });
    expect((await calc(db, a.ac)).nivel).toBe("SEM_EVIDENCIA");
    const b = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05", docExtrato: "5555555" }] });
    expect((await calc(db, b.ac)).nivel).toBe("SEM_EVIDENCIA");
    await db.close();
  });
  it("4) titulo ainda nao vencido na liquidacao nao entra (sozinho => SEM; misturado => so o vencido)", async () => {
    const db = await novo();
    const a = await cenario(db, { titulos: [{ doc: "1", venc: "2026-09-10", liq: "2026-08-05" }] });
    expect((await calc(db, a.ac)).nivel).toBe("SEM_EVIDENCIA");
    const b = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05" }, { doc: "2", venc: "2026-09-10", liq: "2026-08-05" }] });
    const r = await calc(db, b.ac);
    expect(r.nivel).toBe("FORTE"); expect(r.titulos.map((x) => x.titulo_id)).toEqual([b.ids[0]]);
    await db.close();
  });
  it("5) titulo ja vinculado, 6) PAGO, 7) EM_CONFIRMACAO e NEGOCIADO nao entram no conjunto", async () => {
    const db = await novo();
    const a = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05" }, { doc: "2", venc: "2026-06-10", liq: "2026-08-05" }] });
    const outro = await cenario(db, { cr: "2026-01-01" });
    await db.query("insert into acordo_titulo_vinculo(acordo_id,titulo_id,ativo) values ($1,$2,true)", [outro.ac, a.ids[1]]);
    let r = await calc(db, a.ac); expect(r.titulos.map((x) => x.titulo_id)).toEqual([a.ids[0]]);
    for (const [sit, st] of [["PAGO", "quitada"], ["EM_CONFIRMACAO", "em_confirmacao"], ["NEGOCIADO", "vinculada"], ["DUPLICADA", "em_aberto"]]) {
      const b = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05", sit, st }] });
      expect([sit, (await calc(db, b.ac)).nivel]).toEqual([sit, "SEM_EVIDENCIA"]);
    }
    await db.close();
  });
  it("mensalidade do tipo 'Acordo' (boleto do proprio acordo) nunca entra", async () => {
    const db = await novo(); const c = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05", tipo: "Acordo" }] });
    expect((await calc(db, c.ac)).nivel).toBe("SEM_EVIDENCIA"); await db.close();
  });
  it("8) multiplos grupos na janela => REVISAO", async () => {
    const db = await novo();
    const c = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05" }, { doc: "2", venc: "2026-06-10", liq: "2026-08-08" }] });
    const r = await calc(db, c.ac); expect(r.nivel).toBe("REVISAO"); expect(r.motivo).toBe("MULTIPLOS_GRUPOS_195"); expect(r.qtd_grupos_janela).toBe(2);
    await db.close();
  });
  it("9) acordo concorrente ATIVO e 10) CANCELADO => REVISAO (ACORDO_CONCORRENTE)", async () => {
    for (const st of ["ATIVO", "CANCELADO"]) {
      const db = await novo(); const c = await cenario(db);
      await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,criado_em) values ($1,$2,$3,$4,777,777,1,$5,'2026-08-12T12:00:00Z')", [U(c.n, 50), c.al, c.cpf, st, String(99000 + c.n)]);
      const r = await calc(db, c.ac);
      expect([st, r.nivel, r.motivo]).toEqual([st, "REVISAO", "ACORDO_CONCORRENTE"]);
      expect(r.concorrentes).toHaveLength(1);
      await db.close();
    }
  });
  it("11) janela -60/+7: -60 e +7 entram; -61 e +8 ficam fora (SEM_EVIDENCIA, GRUPO_195_FORA_DA_JANELA)", async () => {
    const db = await novo();
    const casos = [["2026-06-11", "FORTE"], ["2026-06-10", "SEM_EVIDENCIA"], ["2026-08-17", "FORTE"], ["2026-08-18", "SEM_EVIDENCIA"]]; // acordo criado em 2026-08-10 (liq 06-11 = -60, 08-17 = +7)
    for (const [liq, esperado] of casos) {
      const c = await cenario(db, { titulos: [{ doc: "1", venc: "2026-01-10", liq }] });
      const r = await calc(db, c.ac);
      expect([liq, r.nivel]).toEqual([liq, esperado]);
      if (esperado === "SEM_EVIDENCIA") expect(r.motivo).toBe("GRUPO_195_FORA_DA_JANELA");
    }
    await db.close();
  });
  it("12) acordo QUITADO tambem e avaliado; acordo CANCELADO nao", async () => {
    const db = await novo();
    const q = await cenario(db, { status: "QUITADO" }); expect((await calc(db, q.ac)).nivel).toBe("FORTE");
    const c = await cenario(db, { status: "CANCELADO" }); expect(await calc(db, c.ac)).toBeUndefined();
    await db.close();
  });
  it("acordo que ja tem mensalidade original vinculada sai da fila", async () => {
    const db = await novo(); const c = await cenario(db);
    await db.query("insert into acordo_titulo_vinculo(acordo_id,titulo_id,ativo) values ($1,$2,true)", [c.ac, c.ids[0]]);
    expect(await calc(db, c.ac)).toBeUndefined(); await db.close();
  });
  it("valor do acordo nunca entra: valores muito diferentes dao a mesma classificacao", async () => {
    const db = await novo(); const c = await cenario(db);
    const a = (await calc(db, c.ac)).nivel;
    await db.query("update acordos set valor_total = 1, saldo = 1 where id = $1", [c.ac]);
    expect((await calc(db, c.ac)).nivel).toBe(a); await db.close();
  });
});

describe("rejeicao (composicao), confirmacao (revalidacao + RPC oficial)", () => {
  it("13) composicao rejeitada nao reaparece como pendencia; 14) composicao DIFERENTE reaparece", async () => {
    const db = await novo(); const c = await cenario(db);
    const r0 = await lista(db, c.ac); expect(r0.rejeitada).toBe(false);
    const rej = (await db.query("select public.acordo_vinculo_sugestao_rejeitar($1,$2,$3) j", [c.ac, r0.composicao_hash, "nao e desse acordo"])).rows[0].j;
    expect(rej.ok).toBe(true);
    const r1 = await lista(db, c.ac); expect(r1.rejeitada).toBe(true); expect(r1.rejeitado_por).toBe(H.GESTAO); expect(r1.motivo_rejeicao).toBe("nao e desse acordo");
    // repetir e idempotente
    expect((await db.query("select public.acordo_vinculo_sugestao_rejeitar($1,$2,null) j", [c.ac, r0.composicao_hash])).rows[0].j.ja_rejeitada).toBe(true);
    expect((await db.query("select count(*)::int n from acordo_vinculo_sugestao_decisao where acordo_id=$1 and decisao='REJEITADA'", [c.ac])).rows[0].n).toBe(1);
    // nova mensalidade elegivel no mesmo grupo => composicao diferente => volta a ser pendencia
    await db.query("insert into acordos_titulos(id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,status,tipo_boleto) values ($1,$2,$3,'9990001','2026-05-10',300,300,'ABERTO','em_aberto','Cursos de Graduação Presencial')", [U(c.n, 300), c.al, c.cpf]);
    await db.query("insert into prime_extrato(matricula,boleto,cpf,vencimento,liquidado_em,valor_liquido,portador) values ('MX','9990001',$1,'2026-05-10','2026-08-05',300,195)", [c.cpf]);
    const r2 = await lista(db, c.ac);
    expect(r2.composicao_hash).not.toBe(r0.composicao_hash); expect(r2.rejeitada).toBe(false);
    await db.close();
  });
  it("15/16) confirmar revalida no servidor: vinculo concorrente surgido depois da leitura impede a confirmacao (nada e vinculado)", async () => {
    const db = await novo(); const c = await cenario(db);
    const lido = await lista(db, c.ac);
    const outro = await cenario(db, { cr: "2026-01-01" });
    await db.query("insert into acordo_titulo_vinculo(acordo_id,titulo_id,ativo) values ($1,$2,true)", [outro.ac, c.ids[0]]); // surge entre a leitura e o clique
    const r = (await db.query("select public.acordo_vinculo_sugestao_confirmar($1,$2) j", [c.ac, lido.composicao_hash])).rows[0].j;
    expect(r.ok).toBe(false); expect(["SUGESTAO_MUDOU", "SUGESTAO_NAO_E_FORTE"]).toContain(r.erro);
    expect((await db.query("select count(*)::int n from _vinc_log")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from acordo_titulo_vinculo where acordo_id=$1", [c.ac])).rows[0].n).toBe(0);
    await db.close();
  });
  it("17) confirmar so vale para FORTE com a MESMA composicao e chama vincular_titulos_acordo (RPC oficial) com os titulos exatos; audita; sai da fila", async () => {
    const db = await novo(); const c = await cenario(db);
    const lido = await lista(db, c.ac);
    // hash errado => recusado sem chamar a RPC oficial
    expect((await db.query("select public.acordo_vinculo_sugestao_confirmar($1,'x') j", [c.ac])).rows[0].j.erro).toBe("SUGESTAO_MUDOU");
    expect((await db.query("select count(*)::int n from _vinc_log")).rows[0].n).toBe(0);
    const r = (await db.query("select public.acordo_vinculo_sugestao_confirmar($1,$2) j", [c.ac, lido.composicao_hash])).rows[0].j;
    expect(r.ok).toBe(true);
    const log = (await db.query("select chamada from _vinc_log")).rows;
    expect(log).toHaveLength(1);
    expect(log[0].chamada.acordo).toBe(c.ac); expect([...log[0].chamada.titulos].sort()).toEqual([...c.ids].sort()); expect(log[0].chamada.email).toBe(H.GESTAO);
    expect((await db.query("select decisao from acordo_vinculo_sugestao_decisao where acordo_id=$1", [c.ac])).rows.map((x) => x.decisao)).toEqual(["CONFIRMADA"]);
    expect((await db.query("select count(*)::int n from auditoria where acao='SUGESTAO_VINCULO_CONFIRMADA' and registro_id=$1", [c.ac])).rows[0].n).toBe(1);
    expect(await lista(db, c.ac)).toBeUndefined(); // saiu das pendencias
    await db.close();
  });
  it("confirmar REVISAO ou SEM_EVIDENCIA e recusado (so FORTE vincula)", async () => {
    const db = await novo();
    const c = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2026-08-05" }, { doc: "2", venc: "2026-06-10", liq: "2026-08-08" }] });
    const r = await calc(db, c.ac);
    expect((await db.query("select public.acordo_vinculo_sugestao_confirmar($1,$2) j", [c.ac, r.composicao_hash])).rows[0].j.erro).toBe("SUGESTAO_NAO_E_FORTE");
    expect((await db.query("select count(*)::int n from _vinc_log")).rows[0].n).toBe(0);
    await db.close();
  });
  it("18) rejeitar NAO altera acordo, mensalidades, parcelas, pagamentos nem vinculos; so decisao + auditoria", async () => {
    const db = await novo(); const c = await cenario(db);
    const lido = await lista(db, c.ac); const antes = await snapFin(db);
    await db.query("select public.acordo_vinculo_sugestao_rejeitar($1,$2,'teste')", [c.ac, lido.composicao_hash]);
    expect(await snapFin(db)).toEqual(antes);
    expect((await db.query("select count(*)::int n from auditoria where acao='SUGESTAO_VINCULO_REJEITADA' and registro_id=$1", [c.ac])).rows[0].n).toBe(1);
    await db.close();
  });
  it("rejeitar composicao desatualizada ou SEM composicao e recusado", async () => {
    const db = await novo(); const c = await cenario(db);
    expect((await db.query("select public.acordo_vinculo_sugestao_rejeitar($1,'zzz',null) j", [c.ac])).rows[0].j.erro).toBe("SUGESTAO_MUDOU");
    const sem = await cenario(db, { titulos: [{ doc: "1", venc: "2026-06-10", liq: "2025-01-01" }] });
    expect((await db.query("select public.acordo_vinculo_sugestao_rejeitar($1,'x',null) j", [sem.ac])).rows[0].j.erro).toBe("SEM_COMPOSICAO_PARA_REJEITAR");
    await db.close();
  });
});

describe("seguranca, ACL/RLS, escopo", () => {
  it("19) ACL: nucleo interno so service_role; RPCs sem anon/PUBLIC; tabela com RLS, sem escrita para anon/authenticated", async () => {
    const db = H.abrir(BASE);
    const f = (n) => `select has_function_privilege('anon','public.${n}','execute') a, has_function_privilege('authenticated','public.${n}','execute') u, (select coalesce(p.proacl::text ~ '(^\\\\{|,)=X/', false) from pg_proc p where p.oid='public.${n}'::regprocedure) pub`;
    expect((await db.query(f("acordo_vinculo_sugestoes_calcular(uuid)"))).rows[0]).toEqual({ a: false, u: false, pub: false });
    for (const n of ["acordos_vinculo_sugestoes()", "acordo_vinculo_sugestao_confirmar(uuid,text)", "acordo_vinculo_sugestao_rejeitar(uuid,text,text)"]) {
      expect((await db.query(f(n))).rows[0]).toEqual({ a: false, u: true, pub: false });
    }
    expect((await db.query("select relrowsecurity r from pg_class where relname='acordo_vinculo_sugestao_decisao'")).rows[0].r).toBe(true);
    const t = (await db.query("select has_table_privilege('anon','public.acordo_vinculo_sugestao_decisao','select') a, has_table_privilege('authenticated','public.acordo_vinculo_sugestao_decisao','insert') i, has_table_privilege('authenticated','public.acordo_vinculo_sugestao_decisao','update') u, has_table_privilege('authenticated','public.acordo_vinculo_sugestao_decisao','delete') d")).rows[0];
    expect(t).toEqual({ a: false, i: false, u: false, d: false });
    await db.close();
  });
  it("20) usuario nao gestor: lista vazia; confirmar e rejeitar recusados (42501) sem escrever", async () => {
    const db = await novo(); const c = await cenario(db);
    const lido = await lista(db, c.ac);
    await H.como(db, H.OP6);
    expect((await db.query("select count(*)::int n from public.acordos_vinculo_sugestoes()")).rows[0].n).toBe(0);
    await expect(db.query("select public.acordo_vinculo_sugestao_confirmar($1,$2)", [c.ac, lido.composicao_hash])).rejects.toThrow(/somente gestao|42501/i);
    await expect(db.query("select public.acordo_vinculo_sugestao_rejeitar($1,$2,null)", [c.ac, lido.composicao_hash])).rejects.toThrow(/somente gestao|42501/i);
    expect((await db.query("select count(*)::int n from _vinc_log")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from acordo_vinculo_sugestao_decisao")).rows[0].n).toBe(0);
    await db.close();
  });
  it("ordena FORTE antes de REVISAO antes de SEM_EVIDENCIA", async () => {
    const db = await novo();
    await cenario(db, { titulos: [{ doc: "1", venc: "2026-01-10", liq: "2020-01-01" }] });
    const f = await cenario(db);
    const rows = (await db.query("select nivel from public.acordos_vinculo_sugestoes()")).rows.map((x) => x.nivel);
    const ord = { FORTE: 1, REVISAO: 2, SEM_EVIDENCIA: 3 };
    expect(rows.map((x) => ord[x])).toEqual([...rows.map((x) => ord[x])].sort((a, b) => a - b));
    expect(rows).toContain("FORTE"); expect(f).toBeTruthy();
    await db.close();
  });
  it("17b) a migration NAO replica a gravacao do vinculo (so chama a RPC oficial), nao cria cron/job e nao mexe em pagamentos/confirmacoes/D-2", async () => {
    const sql = H.MIG(M).replace(/--.*$/gm, "");
    expect(sql).toMatch(/public\.vincular_titulos_acordo\(/);
    expect(sql).not.toMatch(/insert\s+into\s+public\.acordo_titulo_vinculo|update\s+public\.acordos_titulos|update\s+public\.acordos\b|cron\.|acordo_alertas|solicitacoes_confirmacao|pagamentos/i);
  });
  it("rollback remove funcoes e tabela", async () => {
    const db = H.abrir(BASE); await db.exec(H.ROLL(M));
    expect((await db.query("select count(*)::int n from pg_proc where proname like 'acordo_vinculo_sugestao%' or proname='acordos_vinculo_sugestoes'")).rows[0].n).toBe(0);
    expect((await db.query("select to_regclass('public.acordo_vinculo_sugestao_decisao') t")).rows[0].t).toBeNull();
    await db.close();
  });
});
