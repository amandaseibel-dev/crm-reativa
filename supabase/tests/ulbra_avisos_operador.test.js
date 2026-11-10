// Avisos do operador responsável (função do servidor), em PGlite com stubs de auth.
// Sem chamada à ULBRA. A migration não é aplicada em nenhum ambiente real.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const sqlDe = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const MIG = "supabase/aguardando_aprovacao/20261110150000_ulbra_avisos_operador.sql.pendente";

async function ambiente() {
  const db = new PGlite();
  await db.exec(sqlDe("supabase/tests/ulbra_recebimento/01_ambiente.sql"));
  await db.exec(sqlDe("supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente"));
  await db.exec(`
    create table public.ulbra_vinculos (id uuid primary key default gen_random_uuid(), aluno_id uuid not null references public.alunos(id),
      ulbra_cliente_id text not null, telefone_e164 text, confianca text not null, origem text not null, vinculado_por text,
      vinculado_em timestamptz default now(), desvinculado_em timestamptz, desvinculado_por text);
    create unique index ulbra_vinculos_cliente_ativo_uniq on public.ulbra_vinculos (ulbra_cliente_id) where desvinculado_em is null;
    alter table public.casos add column if not exists data_ultimo_acionamento date;
    insert into public.alunos (id, nome) values ('${A}','A'), ('${B}','B');
    insert into public.usuarios (email, ativo) values ('cobranca10@aelbra.com.br', true), ('cobranca05@aelbra.com.br', true), ('amanda.seibel@aelbra.com.br', true) on conflict (email) do update set ativo = true;`);
  await db.exec(sqlDe(MIG));
  return db;
}
async function como(db, email) {
  await db.exec(`select set_config('teste.email', '${email}', false)`);
  return (await db.query("select public.ulbra_avisos_operador(200) j")).rows[0].j;
}
const conv = (db, id, cliente, quem = "cliente") => db.query(
  `insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em, aluno_id, aluno_status)
   values ($1,$2,'A','whatsapp','active','Reativa',$3, now(), now(), $4, 'vinculado')`, [id, cliente, quem, A]);
const ids = (j) => (j.avisos ?? []).map((a) => a.ulbra_conversa_id);

describe("avisos do operador responsável (servidor)", () => {
  it("o único operador com caso do aluno recebe a resposta coletada", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1,'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1,'cli-1','alta_cpf','cpf')", [A]);
    await conv(db, "c1", "cli-1");
    expect(ids(await como(db, "cobranca10@aelbra.com.br"))).toEqual(["c1"]);
    expect(ids(await como(db, "cobranca05@aelbra.com.br"))).toEqual([]);
    await db.close();
  });

  it("caso compartilhado por dois operadores: ninguém recebe aviso individual (a definir)", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1,'cobranca10@aelbra.com.br'), ($1,'cobranca05@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1,'cli-2','alta_cpf','cpf')", [A]);
    await conv(db, "c2", "cli-2");
    expect(ids(await como(db, "cobranca10@aelbra.com.br"))).toEqual([]);
    expect(ids(await como(db, "cobranca05@aelbra.com.br"))).toEqual([]);
    await db.close();
  });

  it("mensagem do operador não gera aviso", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1,'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1,'cli-3','alta_cpf','cpf')", [A]);
    await conv(db, "c3", "cli-3", "operador");
    expect(ids(await como(db, "cobranca10@aelbra.com.br"))).toEqual([]);
    await db.close();
  });

  it("revogação do vínculo some com o aviso mesmo com o status armazenado 'vinculado'", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1,'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1,'cli-4','alta_cpf','cpf')", [A]);
    await conv(db, "c4", "cli-4");
    expect(ids(await como(db, "cobranca10@aelbra.com.br"))).toEqual(["c4"]);
    // status armazenado segue 'vinculado' (nenhum gatilho o recalcula aqui)
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id='cli-4'");
    expect((await db.query("select aluno_status from public.ulbra_conversas where ulbra_conversa_id='c4'")).rows[0].aluno_status).toBe("vinculado");
    expect(ids(await como(db, "cobranca10@aelbra.com.br"))).toEqual([]);
    await db.close();
  });

  it("gestão não recebe linha pela função do operador", async () => {
    const db = await ambiente();
    const j = await como(db, "amanda.seibel@aelbra.com.br");
    expect(j.ok).toBe(false);
    await db.close();
  });

  it("leitura da gestão não apaga o aviso do operador", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1,'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1,'cli-5','alta_cpf','cpf')", [A]);
    await conv(db, "c5", "cli-5");
    await db.query("insert into public.ulbra_leitura_usuario (usuario_email, ulbra_conversa_id, lido_ate) values ('amanda.seibel@aelbra.com.br','c5', now())");
    const oper = await como(db, "cobranca10@aelbra.com.br");
    expect(oper.avisos[0].lida).toBe(false);
    await db.close();
  });

  it("a própria leitura do operador marca só a dele", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1,'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1,'cli-6','alta_cpf','cpf')", [A]);
    await conv(db, "c6", "cli-6");
    await db.query("insert into public.ulbra_leitura_usuario (usuario_email, ulbra_conversa_id, lido_ate) values ('cobranca10@aelbra.com.br','c6', now())");
    expect((await como(db, "cobranca10@aelbra.com.br")).avisos[0].lida).toBe(true);
    await db.close();
  });
});
