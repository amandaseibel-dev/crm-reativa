// Harness do A1 (Playlist ReATIVA) -- PGlite, que e PostgreSQL real em processo.
//
// O estado "antes" NAO e escrito a mao: e a propria migration que criou as
// tabelas em producao (20260929152500_portal_visao_geral_interativa.sql), lida
// do repositorio. Assim o teste exercita a tabela, a RLS, as policies e o
// unique semanal exatamente como estao hoje, e o A1 e aplicado em cima disso.
//
// As 3 linhas de `portal_playlist` sao as REAIS de producao, copiadas de
// `select to_jsonb(p) from public.portal_playlist p` em 30/09/2026 (project ref
// ahattpqrjmhkzsmnbdzs). Sao dados de equipe interna -- musica, artista, nome e
// e-mail corporativo -- e existem aqui para provar que a migration nao as perde.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
export const lerRepo = (p) => readFileSync(resolve(AQUI, "..", "..", "..", "..", p), "utf8");
export const MIG = (n) => lerRepo(`supabase/migrations/${n}.sql`);
export const ROLL = (n) => lerRepo(`supabase/rollbacks/${n}.rollback.sql`);

export const CRIACAO = "20260929152500_portal_visao_geral_interativa";
export const A1 = "20260930143806_portal_playlist_limite_tres_musicas";

export const AMANDA = "amanda.seibel@aelbra.com.br";   // gestao
export const FERNANDA = "cobranca04@aelbra.com.br";    // gestao
export const MAURICIO = "cobranca06@aelbra.com.br";    // operador
export const LUANA = "cobranca05@aelbra.com.br";       // operador sem musica

// Copia fiel de producao em 30/09/2026.
export const REAIS = [
  { id: "4d3b481e-3634-42a8-9523-4c7a2f26a264", titulo: "Bellyache", artista: "Billie Eilish", youtube_id: "gBRi6aZJGj4", adicionado_por: "Amanda", adicionado_por_email: AMANDA, semana_chave: "2026-09-28", ativo: true, criado_em: "2026-09-30T13:10:48.70089+00:00" },
  { id: "4abdde8e-210f-44c8-b0d2-e0ea8d0d6d08", titulo: "Vou pra Santa Catarina", artista: "Terceira Dimensão", youtube_id: "AVSYcRdHpOA", adicionado_por: "Mauricio", adicionado_por_email: MAURICIO, semana_chave: "2026-09-28", ativo: true, criado_em: "2026-09-30T13:16:23.277108+00:00" },
  { id: "94203612-7ebc-406d-bece-477a7c822929", titulo: "Oceans", artista: "Hillsong United", youtube_id: "1m_sWJQm2fs", adicionado_por: "Fernanda", adicionado_por_email: FERNANDA, semana_chave: "2026-09-28", ativo: true, criado_em: "2026-09-30T13:29:49.31015+00:00" },
];

export const jwt = (email, role = "authenticated") =>
  JSON.stringify({ email, role, sub: "52b292e4-e43e-4200-a684-b63d889d273a" });

// Identidade vista pela RLS. Espelha auth.jwt() do Supabase.
export const como = (db, email, role = "authenticated") =>
  db.query("select set_config('test.jwt', $1, false)", [email ? jwt(email, role) : ""]);

// Roda um trecho como `authenticated` (RLS ligada) e sempre volta para postgres.
export async function comoUsuario(db, email, fn) {
  await como(db, email);
  await db.exec("set role authenticated");
  try { return await fn(); }
  finally { await db.exec("reset role"); }
}

const AUTH = `
create schema if not exists auth;
create or replace function auth.jwt()   returns jsonb language sql stable as $fn$ select nullif(current_setting('test.jwt', true), '')::jsonb $fn$;
create or replace function auth.role()  returns text  language sql stable as $fn$ select coalesce(auth.jwt()->>'role','') $fn$;
create or replace function auth.email() returns text  language sql stable as $fn$ select auth.jwt()->>'email' $fn$;
create or replace function auth.uid()   returns uuid  language sql stable as $fn$ select nullif(auth.jwt()->>'sub','')::uuid $fn$;
do $do$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')           then create role anon nologin;           end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')  then create role authenticated nologin;  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')   then create role service_role nologin;   end if;
end $do$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

// Producao ANTES do A1: migration real de criacao + as 3 linhas reais.
export async function montarAntesDoA1() {
  const db = new PGlite();
  await db.exec("set timezone = 'UTC';");
  await db.exec(AUTH);
  await db.exec(MIG(CRIACAO));
  // Supabase concede isso por padrao as roles do projeto; aqui e explicito.
  await db.exec("grant select, insert, update, delete on public.portal_playlist, public.portal_eventos, public.portal_aniversarios to authenticated;");
  for (const l of REAIS) {
    await db.query(
      `insert into public.portal_playlist select * from jsonb_populate_record(null::public.portal_playlist, $1::jsonb)`,
      [JSON.stringify(l)],
    );
  }
  return db;
}

export async function aplicarA1(db) {
  await db.exec(MIG(A1));
}

export const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
export const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

// Retrato das linhas, para comparar antes/depois sem depender de ordem.
export const retrato = (db) => qn(db,
  `select id::text, titulo, artista, youtube_id, adicionado_por, adicionado_por_email,
          semana_chave::text, ativo, criado_em::text
     from public.portal_playlist order by criado_em`);

export const ativasDe = async (db, email) =>
  Number((await q1(db, `select count(*) n from public.portal_playlist where lower(adicionado_por_email) = lower($1) and ativo`, [email])).n);

// Insere uma musica como a propria pessoa (RLS ligada), devolvendo o erro se houver.
export async function inserir(db, email, titulo, extra = {}) {
  return comoUsuario(db, email, async () => {
    try {
      const r = await db.query(
        `insert into public.portal_playlist (titulo, artista, youtube_id, adicionado_por, adicionado_por_email, ativo)
         values ($1, $2, $3, $4, $5, coalesce($6, true)) returning id::text`,
        [titulo, extra.artista ?? "Artista Teste", extra.youtube_id ?? "aaaaaaaaaaa", extra.nome ?? "Pessoa Teste", extra.comoEmail ?? email, extra.ativo ?? null],
      );
      return { ok: true, id: r.rows[0].id };
    } catch (e) {
      return { ok: false, code: e.code ?? null, message: String(e.message ?? e) };
    }
  });
}

export async function atualizar(db, email, id, sets, params) {
  return comoUsuario(db, email, async () => {
    try {
      await db.query(`update public.portal_playlist set ${sets} where id = $1`, [id, ...params]);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code ?? null, message: String(e.message ?? e) };
    }
  });
}
