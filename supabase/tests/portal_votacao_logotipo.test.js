// Votação do logotipo ReATIVA -- roda a migration REAL
// (supabase/migrations/20261109130000_portal_votacao_logotipo.sql) num PostgreSQL
// real (PGlite). As funções app_usuario_ativo() e usuario_e_gestao() são
// reproduzidas aqui só como stub, com o mesmo contrato das de produção.
//
// O que se prova: um voto por operador ativo; contagem escondida do operador
// enquanto aberta; encerramento só pela gestão; nenhum acesso direto às tabelas.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = join(RAIZ, "supabase", "migrations", "20261109130000_portal_votacao_logotipo.sql");

let db;

const jwt = (email) => JSON.stringify({ role: "authenticated", email });

async function como(email) {
  await db.query("select set_config('test.jwt', $1, false)", [email ? jwt(email) : ""]);
  await db.exec("set role authenticated");
}
async function voltar() {
  await db.exec("reset role");
}

// Executa como o e-mail e devolve {ok, valor} ou {ok:false, erro} sem vazar a exceção.
async function rpc(email, sql, params = []) {
  await como(email);
  try {
    const r = await db.query(sql, params);
    return { ok: true, valor: r.rows[0] ? Object.values(r.rows[0])[0] : null };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    await voltar();
  }
}

const SITUACAO = "select public.portal_logotipo_situacao()";
const VOTAR = (n) => `select public.portal_logotipo_votar(${n}::smallint)`;
const APURACAO = "select public.portal_logotipo_apuracao()";
const ENCERRAR = "select public.portal_logotipo_encerrar()";

const GESTAO = "gestora@aelbra.com.br";
const OP_A = "operador.a@aelbra.com.br";
const OP_B = "operador.b@aelbra.com.br";
const OP_C = "operador.c@aelbra.com.br";
const INATIVO = "inativo@aelbra.com.br";
const FORA = "fora@aelbra.com.br";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.jwt() returns jsonb language sql stable as $f$
      select nullif(current_setting('test.jwt', true), '')::jsonb $f$;

    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin;          end if;
    end $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;

    create table public.usuarios (
      id      serial primary key,
      email   text not null,
      perfil  text,
      ativo   boolean not null default true
    );
    insert into public.usuarios (email, perfil, ativo) values
      ('${GESTAO}', 'gestao', true),
      ('${OP_A}', 'operador', true),
      ('${OP_B}', 'operador', true),
      ('${OP_C}', 'operador', true),
      ('${INATIVO}', 'operador', false);

    -- Stubs com o mesmo contrato das funções de produção.
    create or replace function public.app_usuario_ativo() returns boolean
      language sql stable security definer set search_path to 'public' as $$
      select exists (select 1 from public.usuarios u
                      where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                        and u.ativo is true) $$;
    create or replace function public.usuario_e_gestao() returns boolean
      language sql stable security definer set search_path to 'public' as $$
      select exists (select 1 from public.usuarios u
                      where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                        and u.perfil = 'gestao' and u.ativo is true) $$;
    revoke all on function public.app_usuario_ativo() from public;
    revoke all on function public.usuario_e_gestao()  from public;
    grant execute on function public.app_usuario_ativo() to authenticated, anon;
    grant execute on function public.usuario_e_gestao()  to authenticated, anon;
  `);
  await db.exec(readFileSync(MIGRATION, "utf8"));
});

afterAll(async () => {
  await db?.close?.();
});

// Cada teste parte de uma votação aberta e sem votos.
beforeEach(async () => {
  await db.exec(`
    delete from public.portal_votos;
    update public.portal_votacoes
       set status = 'aberta', encerrada_em = null, encerrada_por_email = null
     where slug = 'logotipo-reativa-2026';
  `);
});

describe("situação para o operador", () => {
  it("não devolve contagem, só status e o próprio voto", async () => {
    const r = await rpc(OP_A, SITUACAO);
    expect(r.ok).toBe(true);
    expect(r.valor.existe).toBe(true);
    expect(r.valor.status).toBe("aberta");
    expect(r.valor.minha_opcao).toBeNull();
    expect(r.valor.gestao).toBe(false);
    expect(JSON.stringify(r.valor)).not.toMatch(/votos|opcoes|total/);
  });

  it("reflete o voto de quem já votou", async () => {
    expect((await rpc(OP_A, VOTAR(2))).ok).toBe(true);
    const r = await rpc(OP_A, SITUACAO);
    expect(r.valor.minha_opcao).toBe(2);
  });
});

describe("votar", () => {
  it("registra um voto por operador ativo", async () => {
    const r = await rpc(OP_A, VOTAR(3));
    expect(r.ok).toBe(true);
    expect(r.valor.minha_opcao).toBe(3);
  });

  it("recusa segundo voto da mesma pessoa", async () => {
    await rpc(OP_A, VOTAR(1));
    const r = await rpc(OP_A, VOTAR(4));
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/ja_votou/);
  });

  it("trata o mesmo e-mail com caixa diferente como a mesma pessoa", async () => {
    await rpc(OP_A, VOTAR(1));
    const r = await rpc("Operador.A@AELBRA.com.br", VOTAR(2));
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/ja_votou/);
  });

  it.each([0, 5, -1])("recusa opção inválida (%s)", async (n) => {
    const r = await rpc(OP_B, VOTAR(n));
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/opcao_invalida/);
  });

  it("recusa quem não está ativo ou não está cadastrado", async () => {
    const inativo = await rpc(INATIVO, VOTAR(1));
    const fora = await rpc(FORA, VOTAR(1));
    expect(inativo.erro).toMatch(/acesso_negado/);
    expect(fora.erro).toMatch(/acesso_negado/);
  });

  it("recusa voto depois do encerramento", async () => {
    await rpc(GESTAO, ENCERRAR);
    const r = await rpc(OP_C, VOTAR(1));
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/votacao_encerrada/);
  });
});

describe("apuração", () => {
  it("operador não vê contagem enquanto a votação está aberta", async () => {
    await rpc(OP_A, VOTAR(1));
    const r = await rpc(OP_B, APURACAO);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/resultado_indisponivel/);
  });

  it("gestão acompanha a contagem com a votação aberta", async () => {
    await rpc(OP_A, VOTAR(1));
    await rpc(OP_B, VOTAR(1));
    await rpc(OP_C, VOTAR(4));
    const r = await rpc(GESTAO, APURACAO);
    expect(r.ok).toBe(true);
    expect(r.valor.status).toBe("aberta");
    expect(r.valor.total).toBe(3);
    expect(r.valor.opcoes).toEqual([
      { opcao: 1, votos: 2 },
      { opcao: 2, votos: 0 },
      { opcao: 3, votos: 0 },
      { opcao: 4, votos: 1 },
    ]);
  });

  it("operador passa a ver o resultado final após o encerramento", async () => {
    await rpc(OP_A, VOTAR(2));
    await rpc(GESTAO, ENCERRAR);
    const r = await rpc(OP_B, APURACAO);
    expect(r.ok).toBe(true);
    expect(r.valor.status).toBe("encerrada");
    expect(r.valor.total).toBe(1);
  });

  it("apuração sem votos devolve as quatro opções zeradas", async () => {
    const r = await rpc(GESTAO, APURACAO);
    expect(r.valor.total).toBe(0);
    expect(r.valor.opcoes.map((o) => o.votos)).toEqual([0, 0, 0, 0]);
  });
});

describe("encerramento", () => {
  it("operador não encerra a votação", async () => {
    const r = await rpc(OP_A, ENCERRAR);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/acesso_negado/);
  });

  it("gestão encerra uma vez; a segunda tentativa é recusada", async () => {
    const primeira = await rpc(GESTAO, ENCERRAR);
    expect(primeira.ok).toBe(true);
    expect(primeira.valor.status).toBe("encerrada");
    const segunda = await rpc(GESTAO, ENCERRAR);
    expect(segunda.ok).toBe(false);
    expect(segunda.erro).toMatch(/ja_encerrada/);
  });

  it("grava quem encerrou e quando", async () => {
    await rpc(GESTAO, ENCERRAR);
    const { rows } = await db.query(
      "select status, encerrada_por_email, encerrada_em from public.portal_votacoes where slug = 'logotipo-reativa-2026'"
    );
    expect(rows[0].status).toBe("encerrada");
    expect(rows[0].encerrada_por_email).toBe(GESTAO);
    expect(rows[0].encerrada_em).not.toBeNull();
  });
});

describe("sem acesso direto às tabelas", () => {
  it("operador não lê portal_votos nem portal_votacoes diretamente", async () => {
    await rpc(OP_A, VOTAR(1));
    await como(OP_B);
    await expect(db.query("select * from public.portal_votos")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.portal_votacoes")).rejects.toThrow(/permission denied/);
    await voltar();
  });

  it("operador não grava voto direto, nem altera a votação", async () => {
    await como(OP_B);
    await expect(
      db.query("insert into public.portal_votos (votacao_id, usuario_email, opcao) select id, $1, 1 from public.portal_votacoes", [OP_B])
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query("update public.portal_votacoes set status = 'encerrada'")
    ).rejects.toThrow(/permission denied/);
    await voltar();
  });

  it("anon não executa nenhuma RPC da votação", async () => {
    for (const sql of [SITUACAO, VOTAR(1), APURACAO, ENCERRAR]) {
      await db.exec("set role anon");
      await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      await voltar();
    }
  });
});
