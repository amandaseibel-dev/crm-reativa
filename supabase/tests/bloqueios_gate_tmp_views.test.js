// BLOQUEIOS DO SECURITY GATE (14/11/2026) — migração pendente
// 20261114120000_bloqueios_gate_tmp_views.sql.pendente e o rollback.
//
// Bancada PGlite com o MESMO estado de produção que importa para os bloqueios:
//   - 5 views com security_invoker desligado e escrita concedida a authenticated;
//   - tabela-base com RLS e ZERO policies (pagamento_suspeita_duplicidade);
//   - _tmp_fila2 sem RLS, com ALL para authenticated;
//   - usuario_e_gestao() com a mesma lista de e-mails de produção.
// NENHUM DADO REAL. Não encosta em produção.
//
// Prova: (1) o defeito existe antes da migração; (2) depois, operador não lê
// nada das views e a gestão lê o que lia; (3) _tmp_fila2 mantém as 186 linhas
// (aqui, N linhas de teste) sem privilégio de cliente; (4) o rollback volta
// exatamente ao estado anterior.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(here, "..", "..");
const PENDENTE = readFileSync(resolve(RAIZ, "supabase/aguardando_aprovacao/20261114120000_bloqueios_gate_tmp_views.sql.pendente"), "utf8");
const ROLLBACK = readFileSync(resolve(RAIZ, "supabase/aguardando_aprovacao/20261114120000_bloqueios_gate_tmp_views.rollback.sql"), "utf8");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OPERADOR = "cobranca05@aelbra.com.br";
const VIEWS = ["vw_extracao_calibragem", "vw_extracao_observabilidade", "vw_extracao_validacao_trilha",
               "vw_pagamento_suspeita_pendente", "vw_titulo_presenca_historico"];

const ESTADO_DE_PRODUCAO = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable
    as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create function public.usuario_e_gestao() returns boolean language sql stable security definer set search_path to 'public'
    as $$ select lower(coalesce(auth.jwt()->>'email','')) in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') $$;

  -- tabelas-base: a da gestao (RLS so gestao) e a suspeita (RLS, ZERO policies)
  create table public.extracao_escopo (id int primary key, scope_key text);
  alter table public.extracao_escopo enable row level security;
  create policy p_escopo_leitura on public.extracao_escopo for select to authenticated using (public.usuario_e_gestao());
  create table public.titulo_presenca_importacao (id int primary key, documento text);
  alter table public.titulo_presenca_importacao enable row level security;
  create policy p_presenca_leitura on public.titulo_presenca_importacao for select to authenticated using (public.usuario_e_gestao());
  create table public.pagamento_suspeita_duplicidade (id int primary key, valor numeric);
  alter table public.pagamento_suspeita_duplicidade enable row level security;

  insert into public.extracao_escopo values (1,'a'),(2,'b');
  insert into public.titulo_presenca_importacao values (1,'d1'),(2,'d2');
  insert into public.pagamento_suspeita_duplicidade values (1,10),(2,20),(3,30);

  -- as cinco views, como em producao: security_invoker desligado, dono rodando a consulta
  create view public.vw_extracao_calibragem         as select * from public.extracao_escopo;
  create view public.vw_extracao_observabilidade    as select * from public.extracao_escopo;
  create view public.vw_extracao_validacao_trilha   as select * from public.extracao_escopo;
  create view public.vw_pagamento_suspeita_pendente as select * from public.pagamento_suspeita_duplicidade;
  create view public.vw_titulo_presenca_historico   as select * from public.titulo_presenca_importacao;
  grant select, insert, update, delete, truncate, references, trigger on
    public.vw_extracao_calibragem, public.vw_extracao_observabilidade, public.vw_extracao_validacao_trilha,
    public.vw_pagamento_suspeita_pendente, public.vw_titulo_presenca_historico to authenticated;

  -- _tmp_fila2: sem RLS, ALL para authenticated (como medido), linhas de pagamento
  create table public._tmp_fila2 (id int primary key, valor numeric);
  insert into public._tmp_fila2 select g, g*1.5 from generate_series(1,186) g;
  grant all on table public._tmp_fila2 to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select, insert, update, delete, truncate, references, trigger on
    public.extracao_escopo, public.titulo_presenca_importacao, public.pagamento_suspeita_duplicidade to authenticated;
`;

// Executa uma consulta COMO um usuario autenticado com um e-mail no JWT.
const como = async (db, email, sql) => {
  await db.exec(`set role authenticated; set request.jwt.claims = '${JSON.stringify({ email })}';`);
  try { return (await db.query(sql)).rows; }
  finally { await db.exec("reset role; reset request.jwt.claims;"); }
};
const contaComo = async (db, email, view) => (await como(db, email, `select count(*)::int n from public.${view}`))[0].n;

const novo = async () => new PGlite();

describe("bloqueios do gate: estado ANTES da migração (o defeito existe)", () => {
  it("operador lê linhas de pagamento pela view, contornando a RLS da tabela-base", async () => {
    const db = await novo(); await db.exec(ESTADO_DE_PRODUCAO);
    expect(await contaComo(db, OPERADOR, "vw_pagamento_suspeita_pendente")).toBe(3);
    await db.close();
  }, 60000);

  it("_tmp_fila2 é legível e gravável por authenticated", async () => {
    const db = await novo(); await db.exec(ESTADO_DE_PRODUCAO);
    const r = await db.query(`select has_table_privilege('authenticated','public._tmp_fila2','DELETE') p`);
    expect(r.rows[0].p).toBe(true);
    await db.close();
  }, 60000);
});

describe("bloqueios do gate: DEPOIS da migração", () => {
  let db;
  beforeAll(async () => {
    db = await novo(); await db.exec(ESTADO_DE_PRODUCAO); await db.exec(PENDENTE);
  }, 60000);

  it("as cinco views passam a security_invoker=true", async () => {
    for (const v of VIEWS) {
      const r = await db.query(`select coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off') v
                                  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=$1`, [v]);
      expect(r.rows[0].v, v).toBe("true");
    }
  });

  it("authenticated perde escrita nas views e mantém SELECT", async () => {
    for (const v of VIEWS) {
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const r = await db.query(`select has_table_privilege('authenticated', 'public.${v}', $1) ok`, [p]);
        expect(r.rows[0].ok, `${v} ${p}`).toBe(false);
      }
      const s = await db.query(`select has_table_privilege('authenticated', 'public.${v}', 'SELECT') ok`);
      expect(s.rows[0].ok, `${v} SELECT`).toBe(true);
    }
  });

  it("OPERADOR não lê nenhuma das cinco views", async () => {
    for (const v of VIEWS) expect(await contaComo(db, OPERADOR, v), v).toBe(0);
  });

  it("GESTÃO continua lendo o que lia: suspeita de duplicidade e extração", async () => {
    expect(await contaComo(db, GESTAO, "vw_pagamento_suspeita_pendente")).toBe(3);
    expect(await contaComo(db, GESTAO, "vw_titulo_presenca_historico")).toBe(2);
    expect(await contaComo(db, GESTAO, "vw_extracao_calibragem")).toBe(2);
  });

  it("_tmp_fila2: as 186 linhas continuam; anon, authenticated e PUBLIC sem privilégio", async () => {
    const n = await db.query("select count(*)::int n from public._tmp_fila2");
    expect(n.rows[0].n).toBe(186);
    for (const papel of ["anon", "authenticated", "public"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await db.query(`select has_table_privilege($1,'public._tmp_fila2',$2) ok`, [papel, p]);
        expect(r.rows[0].ok, `${papel} ${p}`).toBe(false);
      }
    }
  });

  it("_tmp_fila2: operador não lê nem apaga nada", async () => {
    await expect(como(db, OPERADOR, "select count(*) from public._tmp_fila2")).rejects.toThrow(/permission denied/);
  });
});

describe("bloqueios do gate: ROLLBACK volta ao estado de antes", () => {
  it("rollback restaura o defeito exatamente (operador volta a ler; grants voltam)", async () => {
    const db = await novo(); await db.exec(ESTADO_DE_PRODUCAO);
    await db.exec(PENDENTE); await db.exec(ROLLBACK);
    expect(await contaComo(db, OPERADOR, "vw_pagamento_suspeita_pendente")).toBe(3);
    const ins = await db.query(`select has_table_privilege('authenticated','public.vw_extracao_calibragem','INSERT') ok`);
    expect(ins.rows[0].ok).toBe(true);
    const t = await db.query(`select has_table_privilege('authenticated','public._tmp_fila2','TRUNCATE') ok`);
    expect(t.rows[0].ok).toBe(true);
    const pol = await db.query(`select count(*)::int n from pg_policies where tablename='pagamento_suspeita_duplicidade'`);
    expect(pol.rows[0].n).toBe(0);
    await db.close();
  }, 60000);
});
