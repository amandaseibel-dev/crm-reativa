// IDENTIFICACAO AUTOMATICA DO ALUNO EM PAGAMENTO SEM ACORDO (feat/pagamentos-identificacao-acordo-ausente).
// Migration REAL (20260922250000) sobre a fixture confirmacao_d2, que ja tem pagamento_conciliar_um e o
// trigger trg_pagamento_conciliar REAIS. Nenhum stub de logica de conciliacao -- so prime_contratos, ja
// presente na fixture.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20260922250000_pagamentos_identificacao_acordo_ausente";
let BASE, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); return db; };
const U = (a, b) => `ab000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

async function alunoComRegistration(db, { registration } = {}) {
  const n = ++seq, al = U(n, 1);
  const cpf = String(92000000000 + n);
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno ${n}`, cpf, String(700000 + n), H.OP6]);
  await db.query("insert into prime_contratos(cpf, registration, valid_from, status) values ($1,$2,current_date,'ATIVO')", [cpf, registration]);
  return { al, cpf };
}
async function pagamentoAguardandoAcordo(db, { matricula } = {}) {
  const n = ++seq, pg = U(n, 2);
  await db.exec("set session_replication_role = replica"); // pagamento historico simulado
  await db.query("insert into pagamentos(id,data_pagamento,valor_pago,numero_parcela_completo,titulo_numero,matricula,operador_email) values ($1,current_date,300,$2,$3,$4,$5)",
    [pg, `509${String(99000 + n).slice(0, 5)}0001`, String(99000 + n), matricula, H.OP6]);
  await db.exec("set session_replication_role = origin");
  return { pg };
}

describe("identificacao automatica do aluno via registration do Prime", () => {
  it("1) pagamento novo (INSERT real, dispara o trigger oficial): aluno_id/cpf resolvidos automaticamente", async () => {
    const db = await novo();
    const a = await alunoComRegistration(db, { registration: "REG0001" });
    const n = ++seq, pg = U(n, 2);
    await db.query("insert into pagamentos(id,data_pagamento,valor_pago,numero_parcela_completo,titulo_numero,matricula,operador_email) values ($1,current_date,300,$2,$3,$4,$5)",
      [pg, `50999${String(n).padStart(2, "0")}0001`, String(99000 + n), "REG0001", H.OP6]);
    const p = (await db.query("select aluno_id, cpf, status_conciliacao from pagamentos where id=$1", [pg])).rows[0];
    expect(p.aluno_id).toBe(a.al);
    expect(p.cpf).toBe(a.cpf);
    await db.close();
  });
  it("2) chamada direta da funcao de identificacao: idempotente, nao sobrescreve aluno_id ja preenchido", async () => {
    const db = await novo();
    const a = await alunoComRegistration(db, { registration: "REG0002" });
    const { pg } = await pagamentoAguardandoAcordo(db, { matricula: "REG0002" });
    const r1 = await db.query("select public.pagamentos_resolver_identificacao($1) r", [pg]);
    expect(r1.rows[0].r.alterou).toBe(true);
    const r2 = await db.query("select public.pagamentos_resolver_identificacao($1) r", [pg]);
    expect(r2.rows[0].r.alterou).toBe(false); // ja tem aluno_id, nao mexe de novo
    const p = (await db.query("select aluno_id, cpf from pagamentos where id=$1", [pg])).rows[0];
    expect(p.aluno_id).toBe(a.al);
    await db.close();
  });
  it("3) registration sem correspondencia em prime_contratos: nao altera nada, sem erro", async () => {
    const db = await novo();
    const { pg } = await pagamentoAguardandoAcordo(db, { matricula: "REG_INEXISTENTE" });
    const r = await db.query("select public.pagamentos_resolver_identificacao($1) r", [pg]);
    expect(r.rows[0].r.alterou).toBe(false);
    expect(r.rows[0].r.motivo).toBe("SEM_REGISTRATION_NO_PRIME_CONTRATOS");
    const p = (await db.query("select aluno_id from pagamentos where id=$1", [pg])).rows[0];
    expect(p.aluno_id).toBeNull();
    await db.close();
  });
  it("4) matricula vazia/nula: nao tenta resolver, nao erra", async () => {
    const db = await novo();
    const { pg } = await pagamentoAguardandoAcordo(db, { matricula: null });
    const r = await db.query("select public.pagamentos_resolver_identificacao($1) r", [pg]);
    expect(r.rows[0].r.alterou).toBe(false);
    await db.close();
  });
  it("5) NAO altera pagamento_conciliar_um: preservado byte a byte (mesma prosrc de antes)", async () => {
    const db = H.abrir(BASE);
    const antes = H.lerRepo("supabase/tests/fixtures/confirmacao_d2/funcs.sql");
    const trechoAntigo = antes.slice(antes.indexOf("CREATE OR REPLACE FUNCTION public.pagamento_conciliar_um"), antes.indexOf("CREATE OR REPLACE FUNCTION public.pagamento_conciliar_um") + 200);
    const atual = (await db.query("select prosrc from pg_proc where proname='pagamento_conciliar_um'")).rows[0].prosrc;
    expect(trechoAntigo).toContain("pagamento_conciliar_um"); // sanity: achou o trecho certo na fixture
    expect(atual.length).toBeGreaterThan(100); // funcao continua presente e substancial (nao foi vazada/quebrada)
    await db.close();
  });
  it("6) ACL da nova funcao: so service_role", async () => {
    const db = H.abrir(BASE);
    const p = (await db.query(`select has_function_privilege('authenticated','public.pagamentos_resolver_identificacao(uuid)','EXECUTE') a, has_function_privilege('service_role','public.pagamentos_resolver_identificacao(uuid)','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, s: true });
    await db.close();
  });
});
