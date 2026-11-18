// Suíte PGlite da RPC carteira_prioridade_bordero (migration 20261117100000).
//
// O que roda aqui: a lógica da função, com dados SINTÉTICOS e dubles mínimos
// das dependências que não existem no repositório (auth, usuario_e_gestao,
// aluno_elegibilidade_cobranca, tabelas). Os corpos reais de usuario_e_gestao e
// aluno_elegibilidade_cobranca foram lidos em produção em 18/11/2026 (ver
// docs/seguranca/propostas/carteira-prioridade-dependencias.md); os dubles
// reproduzem apenas a assinatura e o tipo de retorno.
//
// O que NÃO roda aqui (fica para o CI com PostgreSQL descartável): RLS real,
// grants por role (anon/authenticated) e search_path efetivo em role real.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(AQUI, "../migrations/20261117100000_carteira_prioridade_bordero.sql"),
  "utf8",
);

const DUBLES = `
create schema if not exists auth;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(lower(coalesce(current_setting('request.jwt.claims', true)::json->>'email', '')), '')
$$;

create table usuarios (email text primary key, ativo boolean not null);
create table alunos (id uuid primary key, cpf text, responsavel_atual_email text);
create table casos (id uuid primary key default gen_random_uuid(), aluno_id uuid not null,
  responsavel_atual_email text, encerrado_operacional boolean default false);
create table importacoes (id uuid primary key default gen_random_uuid(), tipo text, created_at timestamp);
create table acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid, importacao_id uuid,
  situacao text, vencimento date, valor_em_aberto numeric, saldo_corrigido numeric);
create table aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text,
  registrado_em timestamptz, lote_id uuid);
create table whatsapp_conversas (id uuid primary key default gen_random_uuid(), aluno_id uuid);
create table whatsapp_mensagens (id uuid primary key default gen_random_uuid(), conversa_id uuid,
  direcao text, status text, timestamp_wa timestamptz, criado_em timestamptz);
create table solicitacoes_confirmacao_pagamento (id bigserial primary key, aluno_id text, status text);
create table acoes_massivas_lotes (id uuid primary key default gen_random_uuid(), aluno_ids text[],
  confirmado_em timestamptz, descartado_em timestamptz);

-- dubles de dependências (assinatura e retorno reais; corpo de teste)
create table dbl_gestao (email text primary key);
create or replace function public.usuario_e_gestao() returns boolean language sql stable security definer
  set search_path = public as $$
  select exists (select 1 from dbl_gestao where email = lower(coalesce(auth.email(), '')))
$$;

create type elegibilidade_cobranca as (aluno_id uuid, motivo_principal text, elegivel boolean);
create table dbl_eleg (aluno_id uuid primary key, motivo_principal text);
create or replace function public.aluno_elegibilidade_cobranca(p_aluno_id uuid)
  returns elegibilidade_cobranca language sql stable security definer set search_path = public as $$
  select p_aluno_id, d.motivo_principal, d.motivo_principal is null
    from (select p_aluno_id) x
    left join dbl_eleg d on d.aluno_id = p_aluno_id
$$;

create role anon;
create role authenticated;
create role service_role;
`;

const jwt = (email) => (email ? JSON.stringify({ email }) : "{}");

async function novoBanco() {
  const db = new PGlite();
  await db.exec(DUBLES);
  await db.exec(MIGRATION);
  return db;
}

// Chama a RPC como um e-mail (ou sem JWT) e devolve as linhas.
async function chamar(db, email, ids) {
  await db.exec(`select set_config('request.jwt.claims', '${jwt(email).replace(/'/g, "''")}', false)`);
  const r = await db.query(
    "select * from public.carteira_prioridade_bordero($1::uuid[])",
    [ids],
  );
  return r.rows;
}

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Cenário mínimo: um operador (op@a), um caso e um borderô de 2026.
async function cenarioBase(db) {
  await db.exec(`
    insert into usuarios values ('op@a.local', true), ('op@b.local', true), ('inativo@a.local', false), ('gestao@x.local', true);
    insert into dbl_gestao values ('gestao@x.local');
    insert into importacoes (id, tipo, created_at) values
      ('${UUID(900)}', 'BORDERO', timestamp '2026-11-06 14:00:00');
  `);
}

async function aluno(db, n, { resp = "op@a.local", saldo = 500, venc = "2026-03-10", bordero = UUID(900) } = {}) {
  const id = UUID(n);
  await db.exec(`
    insert into alunos (id, cpf, responsavel_atual_email) values ('${id}', '${String(n).padStart(11, "0")}', '${resp}');
    insert into casos (aluno_id, responsavel_atual_email) values ('${id}', '${resp}');
    insert into acordos_titulos (aluno_id, importacao_id, situacao, vencimento, valor_em_aberto)
      values ('${id}', '${bordero}', 'ABERTO', date '${venc}', ${saldo});
  `);
  return id;
}

describe("carteira_prioridade_bordero: autorização", () => {
  let db;
  beforeAll(async () => {
    db = await novoBanco();
    await cenarioBase(db);
  });

  it("sem JWT: acesso negado", async () => {
    await expect(chamar(db, null, [UUID(1)])).rejects.toThrow(/acesso negado/);
  });

  it("usuário inativo: acesso negado", async () => {
    await aluno(db, 1);
    await expect(chamar(db, "inativo@a.local", [UUID(1)])).rejects.toThrow(/acesso negado/);
  });

  it("usuário sem cadastro: acesso negado", async () => {
    await expect(chamar(db, "fantasma@x.local", [UUID(1)])).rejects.toThrow(/acesso negado/);
  });

  it("operador consulta a própria carteira", async () => {
    const rows = await chamar(db, "op@a.local", [UUID(1)]);
    expect(rows.map((r) => r.aluno_id)).toEqual([UUID(1)]);
  });

  it("operador NÃO recebe linha de aluno de outra carteira (ausência, não vazamento)", async () => {
    await aluno(db, 2, { resp: "op@b.local" });
    const rows = await chamar(db, "op@a.local", [UUID(2)]);
    expect(rows).toHaveLength(0);
  });

  it("gestão consulta o escopo solicitado, inclusive de outro operador", async () => {
    const rows = await chamar(db, "gestao@x.local", [UUID(1), UUID(2)]);
    expect(rows.map((r) => r.aluno_id).sort()).toEqual([UUID(1), UUID(2)].sort());
  });

  it("parâmetro do cliente não amplia o operador: ids alheios não voltam", async () => {
    const rows = await chamar(db, "op@a.local", [UUID(1), UUID(2)]);
    expect(rows.map((r) => r.aluno_id)).toEqual([UUID(1)]);
  });
});

describe("carteira_prioridade_bordero: regras de decisão", () => {
  let db;
  beforeAll(async () => {
    db = await novoBanco();
    await cenarioBase(db);
  });

  it("aluno elegível, em 2026, sem contato: prioridade", async () => {
    const id = await aluno(db, 10);
    const [r] = await chamar(db, "op@a.local", [id]);
    expect(r.prioridade).toBe(true);
    expect(r.exclui_guiado).toBe(false);
    expect(Number(r.saldo_bordero_2026)).toBe(500);
  });

  it("bloqueado é excluído do guiado e perde a prioridade", async () => {
    const id = await aluno(db, 11);
    await db.exec(`insert into dbl_eleg values ('${id}', 'SUSPENSAO_COBRANCA')`);
    const [r] = await chamar(db, "op@a.local", [id]);
    expect(r.exclui_guiado).toBe(true);
    expect(r.motivo_exclusao).toBe("BLOQUEADO");
    expect(r.prioridade).toBe(false);
  });

  it("pagamento pendente (estado atual) exclui; quitação histórica NÃO", async () => {
    const pend = await aluno(db, 12);
    await db.exec(`insert into solicitacoes_confirmacao_pagamento (aluno_id, status)
                   values ('${pend}', 'AGUARDANDO_CONFIRMACAO')`);
    const [r1] = await chamar(db, "op@a.local", [pend]);
    expect(r1.motivo_exclusao).toBe("PAGAMENTO_PENDENTE");

    const quit = await aluno(db, 13);
    await db.exec(`insert into aluno_movimentacoes (aluno_id, tipo, registrado_em)
                   values ('${quit}', 'QUITADO_MANUAL', now())`);
    const [r2] = await chamar(db, "op@a.local", [quit]);
    expect(r2.exclui_guiado).toBe(false);
    expect(r2.acionado_desde_entrada).toBe(false); // quitação não é contato
  });

  it("lote pendente exclui (contato duplicado); lote confirmado NÃO", async () => {
    const pend = await aluno(db, 14);
    await db.exec(`insert into acoes_massivas_lotes (aluno_ids) values (array['${pend}'])`);
    const [r1] = await chamar(db, "op@a.local", [pend]);
    expect(r1.motivo_exclusao).toBe("LOTE_PENDENTE");
    expect(r1.envio_realizado).toBe(false); // lote pendente não é envio

    const conf = await aluno(db, 15);
    await db.exec(`insert into acoes_massivas_lotes (aluno_ids, confirmado_em) values (array['${conf}'], now())`);
    const [r2] = await chamar(db, "op@a.local", [conf]);
    expect(r2.exclui_guiado).toBe(false);
  });

  it("acionamento de um dos três tipos da §9 após a entrada tira a prioridade", async () => {
    const id = await aluno(db, 16);
    await db.exec(`insert into aluno_movimentacoes (aluno_id, tipo, registrado_em)
                   values ('${id}', 'FINALIZACAO_ATENDIMENTO', timestamp '2026-11-10 10:00:00+00')`);
    const [r] = await chamar(db, "op@a.local", [id]);
    expect(r.acionado_desde_entrada).toBe(true);
    expect(r.prioridade).toBe(false);
  });

  it("contato ANTERIOR à entrada do borderô não tira a prioridade", async () => {
    const id = await aluno(db, 17);
    await db.exec(`insert into aluno_movimentacoes (aluno_id, tipo, registrado_em)
                   values ('${id}', 'FINALIZACAO_ATENDIMENTO', timestamp '2026-10-01 10:00:00+00')`);
    const [r] = await chamar(db, "op@a.local", [id]);
    expect(r.prioridade).toBe(true);
  });

  it("borderô novo: contato após o borderô antigo não esconde títulos que entraram depois", async () => {
    await db.exec(`insert into importacoes (id, tipo, created_at) values
                   ('${UUID(901)}', 'BORDERO', timestamp '2026-11-16 09:00:00')`);
    const id = await aluno(db, 18, { bordero: UUID(900) });
    await db.exec(`insert into acordos_titulos (aluno_id, importacao_id, situacao, vencimento, valor_em_aberto)
                   values ('${id}', '${UUID(901)}', 'ABERTO', date '2026-04-10', 300)`);
    await db.exec(`insert into aluno_movimentacoes (aluno_id, tipo, registrado_em)
                   values ('${id}', 'FINALIZACAO_ATENDIMENTO', timestamp '2026-11-08 10:00:00+00')`);
    const [r] = await chamar(db, "op@a.local", [id]);
    expect(r.entrada_bordero.toISOString()).toBe("2026-11-16T09:00:00.000Z"); // mais recente, UTC
    expect(r.prioridade).toBe(true);
  });

  it("título fora de 2026 não gera prioridade de 2026", async () => {
    const id = await aluno(db, 19, { venc: "2025-06-10" });
    const [r] = await chamar(db, "op@a.local", [id]);
    expect(r.em_populacao_2026).toBe(false);
    expect(r.prioridade).toBe(false);
  });
});

describe("carteira_prioridade_bordero: população grande e revalidação", () => {
  it("mais de 1.000 alunos em lotes de 500, sem truncamento", async () => {
    const db = await novoBanco();
    await cenarioBase(db);
    const N = 1200;
    const ids = [];
    for (let n = 1000; n < 1000 + N; n++) {
      ids.push(await aluno(db, n));
    }
    let total = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const parte = await chamar(db, "op@a.local", ids.slice(i, i + 500));
      total += parte.length;
    }
    expect(total).toBe(N);
  });

  it("mudança de elegibilidade entre o início e a revalidação muda a decisão", async () => {
    const db = await novoBanco();
    await cenarioBase(db);
    const id = await aluno(db, 30);
    const antes = await chamar(db, "op@a.local", [id]);
    expect(antes[0].prioridade).toBe(true);
    await db.exec(`insert into dbl_eleg values ('${id}', 'JURIDICO')`);
    const depois = await chamar(db, "op@a.local", [id]);
    expect(depois[0].exclui_guiado).toBe(true);
    expect(depois[0].motivo_exclusao).toBe("BLOQUEADO");
  });

  it("função de lote não vaza para o operador: lote de outra carteira não aparece", async () => {
    const db = await novoBanco();
    await cenarioBase(db);
    const alheio = await aluno(db, 40, { resp: "op@b.local" });
    await db.exec(`insert into acoes_massivas_lotes (aluno_ids) values (array['${alheio}'])`);
    const rows = await chamar(db, "op@a.local", [alheio]);
    expect(rows).toHaveLength(0); // sem linha = excluído pela tela
  });
});

describe("migration: propriedades estáticas", () => {
  it("SECURITY DEFINER com search_path fixo", () => {
    expect(MIGRATION).toMatch(/security definer/i);
    expect(MIGRATION).toMatch(/set search_path = public/i);
  });
  it("grants: revoga de public e anon, concede a authenticated e service_role", () => {
    expect(MIGRATION).toMatch(/revoke all on function public\.carteira_prioridade_bordero\(uuid\[\]\) from public/);
    expect(MIGRATION).toMatch(/revoke all on function public\.carteira_prioridade_bordero\(uuid\[\]\) from anon/);
    expect(MIGRATION).toMatch(/grant execute on function public\.carteira_prioridade_bordero\(uuid\[\]\) to authenticated/);
  });
  it("não altera eh_tipo_acionamento", () => {
    expect(MIGRATION).not.toMatch(/create or replace function public\.eh_tipo_acionamento/i);
  });
});
