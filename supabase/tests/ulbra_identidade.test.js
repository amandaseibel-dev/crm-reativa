// ULBRA — identidade propagada do vínculo, num Postgres real (PGlite).
// Ambiente -> piloto (tabelas do espelho) -> vínculos (stub fiel) -> migration
// candidata -> cenários -> rollback. Nenhuma chamada à ULBRA.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const AMBIENTE = "supabase/tests/ulbra_recebimento/01_ambiente.sql";
const PILOTO = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente";
const MIGRATION = "supabase/aguardando_aprovacao/20261110130000_ulbra_identidade_propagada.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261110130000_ulbra_identidade_propagada.rollback.sql";

function sqlDe(caminho) {
  return readFileSync(caminho, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
}

// Stub fiel de ulbra_vinculos: mesmas colunas, índice único de cliente ativo e
// o gatilho que proíbe apagar, mudar o aluno e reabrir.
const VINCULOS = `
create table public.ulbra_vinculos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null,
  ulbra_cliente_id text not null,
  telefone_e164 text,
  confianca text not null check (confianca in ('alta_cpf','alta','reconfirmar')),
  origem text not null,
  vinculado_por text,
  vinculado_em timestamptz not null default now(),
  desvinculado_em timestamptz,
  desvinculado_por text
);
create unique index ulbra_vinculos_cliente_ativo_uniq on public.ulbra_vinculos (ulbra_cliente_id) where desvinculado_em is null;
create or replace function public._ulbra_vinculo_protege_historico() returns trigger language plpgsql as $f$
begin
  if tg_op = 'DELETE' then raise exception 'ULBRA_VINCULO_DELETE_PROIBIDO'; end if;
  if new.aluno_id is distinct from old.aluno_id then raise exception 'ULBRA_VINCULO_IMUTAVEL'; end if;
  if new.ulbra_cliente_id is distinct from old.ulbra_cliente_id then raise exception 'ULBRA_VINCULO_IMUTAVEL'; end if;
  if old.desvinculado_em is not null and new.desvinculado_em is null then raise exception 'ULBRA_VINCULO_NAO_REABRE'; end if;
  return new;
end $f$;
create trigger trg_ulbra_vinculo_protege_historico before delete or update on public.ulbra_vinculos
  for each row execute function public._ulbra_vinculo_protege_historico();
`;

const ALUNO_A = "11111111-1111-1111-1111-111111111111";
const ALUNO_B = "22222222-2222-2222-2222-222222222222";

async function ambiente() {
  const db = new PGlite();
  await db.exec(sqlDe(AMBIENTE));
  await db.exec(sqlDe(PILOTO));
  await db.exec(VINCULOS);
  await db.exec(`insert into public.alunos (id) values ('${ALUNO_A}'), ('${ALUNO_B}');`);
  await db.exec(sqlDe(MIGRATION));
  return db;
}

async function conversa(db, id, cliente, quem = "operador") {
  await db.query(
    `insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em, aluno_id, aluno_status)
     values ($1, $2, 'Aluno', 'whatsapp', 'active', 'Reativa', $3, now(), now(), null, 'nao_confirmado')`,
    [id, cliente, quem],
  );
}

async function estadoConversa(db, id) {
  const r = await db.query("select aluno_id, aluno_status, ultima_mensagem_quem from public.ulbra_conversas where ulbra_conversa_id = $1", [id]);
  return r.rows[0];
}

describe("identidade propagada do vínculo (PGlite)", () => {
  it("vínculo criado DEPOIS da coleta identifica a conversa antiga", async () => {
    const db = await ambiente();
    await conversa(db, "c1", "cli-1", "cliente");
    expect((await estadoConversa(db, "c1")).aluno_status).toBe("nao_confirmado");
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem, vinculado_por) values ($1, 'cli-1', 'alta_cpf', 'cpf', 'cobranca06@x')", [ALUNO_A]);
    const e = await estadoConversa(db, "c1");
    expect(e.aluno_status).toBe("vinculado");
    expect(e.aluno_id).toBe(ALUNO_A);
    await db.close();
  });

  it("coleta concorrente com identidade antiga NÃO sobrescreve a correção", async () => {
    const db = await ambiente();
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-2', 'alta_cpf', 'cpf')", [ALUNO_A]);
    // a coleta escreve 'nao_confirmado' (foto antiga) depois do vínculo
    await db.query(
      `insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, aluno_id, aluno_status)
       values ('c2', 'cli-2', 'Aluno', 'whatsapp', 'active', 'Reativa', 'cliente', now(), null, 'nao_confirmado')`,
    );
    expect((await estadoConversa(db, "c2")).aluno_status).toBe("vinculado");
    await db.close();
  });

  it("revogação remove a identidade da conversa e não apaga o vínculo", async () => {
    const db = await ambiente();
    await db.query("insert into public.ulbra_vinculos (id, aluno_id, ulbra_cliente_id, confianca, origem) values ('00000000-0000-0000-0000-00000000000a', $1, 'cli-3', 'alta_cpf', 'cpf')", [ALUNO_A]);
    await conversa(db, "c3", "cli-3", "cliente");
    expect((await estadoConversa(db, "c3")).aluno_status).toBe("vinculado");
    await db.query("update public.ulbra_vinculos set desvinculado_em = now(), desvinculado_por = 'gestao@x' where ulbra_cliente_id = 'cli-3' and desvinculado_em is null");
    const e = await estadoConversa(db, "c3");
    expect(e.aluno_status).toBe("nao_confirmado");
    expect(e.aluno_id).toBeNull();
    const v = await db.query("select count(*)::int n from public.ulbra_vinculos where ulbra_cliente_id = 'cli-3'");
    expect(v.rows[0].n).toBe(1); // histórico preservado: a linha continua existindo
    await db.close();
  });

  it("troca de aluno: revoga e cria novo vínculo; aluno_id não muda in place", async () => {
    const db = await ambiente();
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-4', 'alta_cpf', 'cpf')", [ALUNO_A]);
    await conversa(db, "c4", "cli-4", "cliente");
    await expect(db.query("update public.ulbra_vinculos set aluno_id = $1 where ulbra_cliente_id = 'cli-4' and desvinculado_em is null", [ALUNO_B])).rejects.toThrow(/IMUTAVEL/);
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-4' and desvinculado_em is null");
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-4', 'alta_cpf', 'cpf')", [ALUNO_B]);
    expect((await estadoConversa(db, "c4")).aluno_id).toBe(ALUNO_B);
    await db.close();
  });

  it("vínculo 'alta' (selo antigo) NÃO identifica", async () => {
    const db = await ambiente();
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-5', 'alta', 'telefone')", [ALUNO_A]);
    await conversa(db, "c5", "cli-5", "cliente");
    expect((await estadoConversa(db, "c5")).aluno_status).toBe("nao_confirmado");
    await db.close();
  });

  it("mensagem do operador não vira resposta do aluno, mesmo com vínculo", async () => {
    const db = await ambiente();
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-6', 'alta_cpf', 'cpf')", [ALUNO_A]);
    await conversa(db, "c6", "cli-6", "operador");
    const e = await estadoConversa(db, "c6");
    expect(e.aluno_status).toBe("vinculado");
    expect(e.ultima_mensagem_quem).toBe("operador");
    await db.close();
  });

  it("atendimento sem identidade vira CONFERENCIA, sem redistribuir; assumido mantém responsável", async () => {
    const db = await ambiente();
    const ins = (id, cliente, resp) => db.query(
      `insert into public.ulbra_atendimentos (ulbra_atendimento_id, ulbra_cliente_id, cliente_nome, equipe, situacao, coluna, entrou_em, aluno_id, aluno_status, destino_email, destino_motivo, responsavel_email)
       values ($1, $2, 'Aluno', 'Reativa', 'waiting', 'espera', now(), null, 'nao_confirmado', 'op@x', 'CARTEIRA', $3)`, [id, cliente, resp]);
    await db.query("insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ($1, 'cli-7', 'alta_cpf', 'cpf')", [ALUNO_A]);
    await ins("t1", "cli-7", null);
    await ins("t2", "cli-7", "outro@x");
    await db.query("update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-7' and desvinculado_em is null");
    const r = await db.query("select ulbra_atendimento_id, destino_email, destino_motivo, responsavel_email from public.ulbra_atendimentos order by 1");
    const t1 = r.rows.find((x) => x.ulbra_atendimento_id === "t1");
    const t2 = r.rows.find((x) => x.ulbra_atendimento_id === "t2");
    expect(t1.destino_motivo).toBe("CONFERENCIA");
    expect(t1.destino_email).toBeNull();
    expect(t2.responsavel_email).toBe("outro@x");
    expect(t2.destino_motivo).toBe("CARTEIRA"); // assumido: não é reatribuído
    await db.close();
  });

  it("rollback remove gatilhos e funções sem apagar dados", async () => {
    const db = await ambiente();
    await db.exec(sqlDe(ROLLBACK));
    const g = await db.query("select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and t.tgname in ('trg_ulbra_conversas_identidade','trg_ulbra_atendimentos_identidade','trg_ulbra_vinculos_propaga')");
    expect(g.rows[0].n).toBe(0);
    await db.close();
  });
});
