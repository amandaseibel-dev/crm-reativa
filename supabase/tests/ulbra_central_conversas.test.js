// Conversas da equipe Reativa por período: recorte, vínculo por CPF, direção e ordem.
// PGlite com stubs de auth (ver 01_ambiente.sql). Sem chamada à ULBRA.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const sqlDe = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
const AMBIENTE = "supabase/tests/ulbra_recebimento/01_ambiente.sql";
const PILOTO = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente";
const MIG = "supabase/aguardando_aprovacao/20261111120000_ulbra_central_conversas_periodo.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261111120000_ulbra_central_conversas_periodo.rollback.sql";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const DESDE = "2026-11-01T03:00:00Z";

async function ambiente() {
  const db = new PGlite();
  await db.exec(sqlDe(AMBIENTE));
  await db.exec(sqlDe(PILOTO));
  await db.exec(`
    create table public.ulbra_vinculos (id uuid primary key default gen_random_uuid(), aluno_id uuid not null references public.alunos(id),
      ulbra_cliente_id text not null, telefone_e164 text, confianca text not null, origem text not null, vinculado_por text,
      vinculado_em timestamptz default now(), desvinculado_em timestamptz, desvinculado_por text);
    insert into public.alunos (id, nome) values ('${A}', 'A'), ('${B}', 'B');
    insert into public.usuarios (email, ativo) values ('cobranca10@aelbra.com.br', true), ('cobranca05@aelbra.com.br', true), ('amanda.seibel@aelbra.com.br', true) on conflict (email) do update set ativo = true;
    insert into public.casos (aluno_id, operador_email) values ('${A}', 'cobranca10@aelbra.com.br'), ('${B}', 'cobranca05@aelbra.com.br');
    insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ('${A}', 'cli-a', 'alta_cpf', 'cpf'), ('${B}', 'cli-b', 'alta_cpf', 'cpf');`);
  await db.exec(sqlDe(MIG));
  return db;
}
const conv = (db, id, cliente, quem, em, status = "vinculado", aluno = null) => db.query(
  `insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em, ultima_mensagem_previa, aluno_id, aluno_status)
   values ($1,$2,'X','whatsapp','active','Reativa',$3,$4, case when $3 = 'cliente' then $4::timestamptz end, 'oi', $5, $6)`,
  [id, cliente, quem, em, aluno, status]);
async function como(db, email, op = null) {
  await db.exec(`select set_config('teste.email', '${email}', false)`);
  const r = await db.query("select public.ulbra_central_conversas($1, $2, 100, 0) as j", [DESDE, op]);
  return r.rows[0].j;
}
const ids = (j) => (j.conversas ?? []).map((c) => c.conversa_id);

describe("conversas do período (servidor)", () => {
  it("operador: só as próprias (por carteira), só do período, mais recente primeiro, com direção", async () => {
    const db = await ambiente();
    await conv(db, "a-out", "cli-a", "cliente", "2026-10-28T12:00:00Z", "vinculado", A);
    await conv(db, "a-nov1", "cli-a", "operador", "2026-11-03T12:00:00Z", "vinculado", A);
    await conv(db, "a-nov2", "cli-a", "cliente", "2026-11-09T12:00:00Z", "vinculado", A);
    await conv(db, "b-nov", "cli-b", "cliente", "2026-11-08T12:00:00Z", "vinculado", B);
    const j = await como(db, "cobranca10@aelbra.com.br");
    expect(j.ok).toBe(true);
    expect(j.eh_gestao).toBe(false);
    expect(ids(j)).toEqual(["a-nov2", "a-nov1"]);
    expect(j.conversas.map((c) => c.direcao)).toEqual(["recebida", "enviada"]);
    expect(j.conversas[0].aguardando).toBe(true);
    expect(j.totais).toEqual({ conversas: 2, aguardando: 1, sem_cpf: null });
    // p_operador de outro é ignorado para quem não é gestão
    expect(ids(await como(db, "cobranca10@aelbra.com.br", "cobranca05@aelbra.com.br"))).toEqual(["a-nov2", "a-nov1"]);
    await db.close();
  });

  it("sem CPF confirmado não sai para ninguém; gestão recebe só a contagem", async () => {
    const db = await ambiente();
    await conv(db, "a-nov", "cli-a", "cliente", "2026-11-05T12:00:00Z", "vinculado", A);
    await conv(db, "x-nov", "cli-x", "cliente", "2026-11-06T12:00:00Z", "nao_confirmado", null);
    await conv(db, "x-out", "cli-y", "cliente", "2026-10-06T12:00:00Z", "nao_confirmado", null);
    expect(ids(await como(db, "cobranca10@aelbra.com.br"))).toEqual(["a-nov"]);
    const g = await como(db, "amanda.seibel@aelbra.com.br");
    expect(g.eh_gestao).toBe(true);
    expect(ids(g)).toEqual(["a-nov"]);
    expect(g.totais.sem_cpf).toBe(1);
    await db.close();
  });

  it("vínculo revogado some mesmo com status armazenado 'vinculado'; gestão com filtro vê só o operador pedido", async () => {
    const db = await ambiente();
    await conv(db, "a-nov", "cli-a", "cliente", "2026-11-05T12:00:00Z", "vinculado", A);
    await conv(db, "b-nov", "cli-b", "operador", "2026-11-07T12:00:00Z", "vinculado", B);
    expect(ids(await como(db, "amanda.seibel@aelbra.com.br"))).toEqual(["b-nov", "a-nov"]);
    expect(ids(await como(db, "amanda.seibel@aelbra.com.br", "cobranca05@aelbra.com.br"))).toEqual(["b-nov"]);
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-b'");
    expect(ids(await como(db, "amanda.seibel@aelbra.com.br"))).toEqual(["a-nov"]);
    expect(ids(await como(db, "cobranca05@aelbra.com.br"))).toEqual([]);
    await db.close();
  });

  it("inativo e painel: ACESSO_NEGADO; rollback remove a função; grants só authenticated", async () => {
    const db = await ambiente();
    await db.query("update public.usuarios set ativo = false where email = 'cobranca05@aelbra.com.br'");
    expect((await como(db, "cobranca05@aelbra.com.br")).motivo).toBe("ACESSO_NEGADO");
    const uid = (await db.query("select id from public.usuarios where email = 'painel.tv@reativa.local'")).rows[0].id;
    await db.exec(`select set_config('teste.uid', '${uid}', false)`);
    expect((await como(db, "painel.tv@reativa.local")).motivo).toBe("ACESSO_NEGADO");
    const g = await db.query("select grantee from information_schema.routine_privileges where routine_name = 'ulbra_central_conversas' order by 1");
    expect(g.rows.map((r) => r.grantee)).not.toContain("anon");
    expect(g.rows.map((r) => r.grantee)).toContain("authenticated");
    await db.exec(sqlDe(ROLLBACK));
    expect((await db.query("select count(*)::int as n from pg_proc where proname = 'ulbra_central_conversas'")).rows[0].n).toBe(0);
    await db.close();
  });
});
