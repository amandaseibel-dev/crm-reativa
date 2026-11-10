// Autorização da Central confere o VÍNCULO ATIVO alta_cpf, não só o status.
// PGlite com stubs de auth (ver 01_ambiente.sql). Sem chamada à ULBRA.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const sqlDe = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
const AMBIENTE = "supabase/tests/ulbra_recebimento/01_ambiente.sql";
const PILOTO = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente";
const IDENTIDADE = "supabase/aguardando_aprovacao/20261110130000_ulbra_identidade_propagada.sql.pendente";
const CENTRAL_BASE = "supabase/tests/central_base.tmp.sql";
const CENTRAL_PATCH = "supabase/aguardando_aprovacao/20261110140000_ulbra_central_vinculo_ativo.sql.pendente";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

async function ambiente() {
  const db = new PGlite();
  await db.exec(sqlDe(AMBIENTE));
  await db.exec(sqlDe(PILOTO));
  await db.exec(`
    create table public.ulbra_vinculos (id uuid primary key default gen_random_uuid(), aluno_id uuid not null references public.alunos(id),
      ulbra_cliente_id text not null, telefone_e164 text, confianca text not null, origem text not null, vinculado_por text,
      vinculado_em timestamptz default now(), desvinculado_em timestamptz, desvinculado_por text);
    create unique index ulbra_vinculos_cliente_ativo_uniq on public.ulbra_vinculos (ulbra_cliente_id) where desvinculado_em is null;
    alter table public.casos add column if not exists data_ultimo_acionamento date;
    insert into public.alunos (id, nome) values ('${A}', 'A'), ('${B}', 'B');
    insert into public.usuarios (email, ativo) values ('cobranca10@aelbra.com.br', true), ('cobranca05@aelbra.com.br', true);`);
  await db.exec(sqlDe(IDENTIDADE));
  await db.exec(sqlDe(CENTRAL_BASE));
  await db.exec(sqlDe(CENTRAL_PATCH));
  return db;
}

async function como(db, email) {
  await db.exec(`select set_config('teste.email', '${email}', false)`);
  const r = await db.query("select public.ulbra_central_operador(null, 200, 0) as j");
  return r.rows[0].j;
}

const ids = (lista) => (lista ?? []).map((x) => x.conversa_id ?? x.aluno_id ?? x.atendimento_id);

describe("Central: autorização pelo vínculo ativo", () => {
  it("vínculo criado DEPOIS da coleta: a conversa aparece para o dono da carteira", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1, 'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('c1','cli-1','A','whatsapp','active','Reativa','cliente', now(), now())");
    expect(ids((await como(db, "cobranca10@aelbra.com.br")).respostas)).toEqual([]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-1', 'alta_cpf', 'cpf')", [A]);
    expect(ids((await como(db, "cobranca10@aelbra.com.br")).respostas)).toEqual(["c1"]);
    await db.close();
  });

  it("revogação some com a conversa mesmo com o status armazenado ainda 'vinculado'", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1, 'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-2', 'alta_cpf', 'cpf')", [A]);
    await db.query("insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('c2','cli-2','A','whatsapp','active','Reativa','cliente', now(), now())");
    expect(ids((await como(db, "cobranca10@aelbra.com.br")).respostas)).toEqual(["c2"]);
    // status armazenado fica DESATUALIZADO de propósito (gatilho desligado)
    await db.exec("alter table public.ulbra_vinculos disable trigger trg_ulbra_vinculos_propaga");
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-2'");
    expect((await db.query("select aluno_status from public.ulbra_conversas where ulbra_conversa_id='c2'")).rows[0].aluno_status).toBe("vinculado");
    expect(ids((await como(db, "cobranca10@aelbra.com.br")).respostas)).toEqual([]);
    await db.close();
  });

  it("responsável histórico de atendimento NÃO mantém acesso após revogação", async () => {
    const db = await ambiente();
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-3', 'alta_cpf', 'cpf')", [A]);
    await db.query("insert into public.ulbra_atendimentos (ulbra_atendimento_id, ulbra_cliente_id, cliente_nome, equipe, situacao, coluna, entrou_em, aluno_id, aluno_status, destino_motivo, responsavel_email) values ('t3','cli-3','A','Reativa','waiting','espera', now(), $1, 'vinculado', 'CARTEIRA', 'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('c3','cli-3','A','whatsapp','active','Reativa','cliente', now(), now())");
    const antes = await como(db, "cobranca10@aelbra.com.br");
    expect(antes.respostas[0].responsavel_reativa).toBe("cobranca10@aelbra.com.br");
    await db.exec("alter table public.ulbra_vinculos disable trigger trg_ulbra_vinculos_propaga");
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-3'");
    // status armazenado continua 'vinculado' (gatilho desligado): o acesso NÃO pode depender dele
    expect((await db.query("select aluno_status from public.ulbra_conversas where ulbra_conversa_id='c3'")).rows[0].aluno_status).toBe("vinculado");
    const depois = await como(db, "cobranca10@aelbra.com.br");
    expect(depois.respostas).toEqual([]);
    expect(depois.sem_interacao).toEqual([]);
    expect(depois.novos).toEqual([]);
    await db.close();
  });

  it("troca de aluno: o dono do caso de A não vê o cliente agora vinculado a B", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1, 'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-4', 'alta_cpf', 'cpf')", [A]);
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-4'");
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-4', 'alta_cpf', 'cpf')", [B]);
    await db.query("insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('c4','cli-4','B','whatsapp','active','Reativa','cliente', now(), now())");
    expect(ids((await como(db, "cobranca10@aelbra.com.br")).respostas)).toEqual([]);
    await db.close();
  });

  it("mensagem do operador não vira resposta do aluno", async () => {
    const db = await ambiente();
    await db.query("insert into public.casos (aluno_id, operador_email) values ($1, 'cobranca10@aelbra.com.br')", [A]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-5', 'alta_cpf', 'cpf')", [A]);
    await db.query("insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em) values ('c5','cli-5','A','whatsapp','active','Reativa','operador', now())");
    expect(ids((await como(db, "cobranca10@aelbra.com.br")).respostas)).toEqual([]);
    await db.close();
  });
});
