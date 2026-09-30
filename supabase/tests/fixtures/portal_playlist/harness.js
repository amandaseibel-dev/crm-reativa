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
export const A2 = "20260930164843_portal_curtidas_e_musica_da_semana";

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

// Devolve o banco ao estado logo apos a migration: as 3 linhas reais como sao em
// producao e nada mais. Roda como postgres (sem RLS) e custa um delete e um
// update numa tabela minuscula -- muito mais barato que instanciar outro PGlite.
// A suite completa roda no CI com timeout de 15 minutos, entao o numero de
// instancias de banco importa.
export async function resetar(db) {
  await db.query("delete from public.portal_playlist where id <> all($1::uuid[])",
    [REAIS.map((l) => l.id)]);
  for (const l of REAIS) {
    await db.query(
      `update public.portal_playlist
          set titulo=$2, artista=$3, youtube_id=$4, adicionado_por=$5,
              adicionado_por_email=$6, semana_chave=$7, ativo=true
        where id=$1`,
      [l.id, l.titulo, l.artista, l.youtube_id, l.adicionado_por, l.adicionado_por_email, l.semana_chave],
    );
  }
  if ((await db.query("select to_regclass('public.portal_curtidas') t")).rows[0].t) {
    await db.query("delete from public.portal_curtidas");
  }
}

// A2 em diante ja estao em producao: as quatro sairam de aguardando_aprovacao/
// para migrations/ com a versao que producao registrou.
export async function aplicarA2(db) {
  await db.exec(MIG(A2));
  await db.exec("grant select, insert, delete on public.portal_curtidas to authenticated;");
}

// Curtir como a propria pessoa, com RLS ligada.
export async function curtir(db, email, alvoId, quando = null, alvoTipo = "playlist") {
  return comoUsuario(db, email, async () => {
    try {
      if (quando) {
        await db.query(
          `insert into public.portal_curtidas (alvo_tipo, alvo_id, usuario_email, criado_em) values ($1,$2,$3,$4)`,
          [alvoTipo, alvoId, email, quando],
        );
      } else {
        await db.query(
          `insert into public.portal_curtidas (alvo_tipo, alvo_id, usuario_email) values ($1,$2,$3)`,
          [alvoTipo, alvoId, email],
        );
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code ?? null, message: String(e.message ?? e) };
    }
  });
}

export async function descurtir(db, email, alvoId, alvoTipo = "playlist") {
  return comoUsuario(db, email, async () => {
    const r = await db.query(
      `delete from public.portal_curtidas where alvo_tipo=$1 and alvo_id=$2 and lower(usuario_email)=lower($3)`,
      [alvoTipo, alvoId, email],
    );
    return { ok: true, apagadas: r.affectedRows ?? 0 };
  });
}

export const musicaDaSemana = async (db, email, semana = null) =>
  comoUsuario(db, email, async () =>
    (await db.query("select * from public.portal_musica_da_semana($1)", [semana])).rows[0] ?? null);

export const curtidasDaSemana = async (db, email, semana = null) =>
  comoUsuario(db, email, async () =>
    (await db.query("select * from public.portal_curtidas_da_semana('playlist', $1) order by alvo_id", [semana])).rows);

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

// ---------------------------------------------------------------------------
// B -- Mural de elogios. O fixture reproduz a estrutura e as policies REAIS de
// producao (colunas de `elogios_atendimento` conforme information_schema, e as
// funcoes app_usuario_ativo / pode_gerir_elogios_tv conforme pg_get_functiondef),
// para que o teste possa provar que o mural NAO vaza print, observacao interna,
// motivo de rejeicao nem e-mail. Os elogios em si sao FICTICIOS.
// ---------------------------------------------------------------------------
export const B = "20260930164939_portal_mural_elogios";

const ELOGIOS_DDL = `
create table if not exists public.usuarios (
  id uuid primary key default gen_random_uuid(),
  nome text, email text not null, perfil text, ativo boolean not null default true
);

create or replace function public.app_usuario_ativo() returns boolean
language sql stable security definer as $fn$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
      and u.ativo is true
  );
$fn$;

create or replace function public.pode_gerir_elogios_tv() returns boolean
language sql stable security definer as $fn$
  SELECT lower(coalesce(auth.email(), '')) IN (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br'
  );
$fn$;

create table if not exists public.elogios_atendimento (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid,
  movimentacao_id bigint,
  operador_email text not null,
  operador_nome text not null,
  print_path text,
  print_nome_arquivo text,
  observacao_operador text,
  texto_final_tv text,
  status text not null default 'PENDENTE_ANALISE',
  motivo_rejeicao text,
  analisado_por_email text,
  analisado_por_nome text,
  analisado_em timestamptz,
  exibir_de date,
  exibir_ate date,
  publicado_por_email text,
  publicado_em timestamptz,
  arquivado_por_email text,
  arquivado_em timestamptz,
  registrado_por_email text not null,
  registrado_por_nome text,
  registrado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table public.elogios_atendimento enable row level security;

-- Policy REAL de producao: a equipe NAO le elogio de terceiro.
drop policy if exists elogios_select on public.elogios_atendimento;
create policy elogios_select on public.elogios_atendimento
for select to authenticated using (
  pode_gerir_elogios_tv()
  or lower(registrado_por_email) = lower(coalesce((select auth.email()), ''))
  or lower(operador_email) = lower(coalesce((select auth.email()), ''))
);

grant select on public.elogios_atendimento to authenticated;
grant select on public.usuarios to authenticated;
`;

// Usuarios do app: todos ativos, menos DESATIVADA.
export const DESATIVADA = "cobranca09@aelbra.com.br";

export async function prepararElogios(db) {
  await db.exec(ELOGIOS_DDL);
  await db.query(
    `insert into public.usuarios (nome, email, perfil, ativo) values
       ('Amanda', $1, 'gestao', true), ('Fernanda', $2, 'gestao', true),
       ('Mauricio', $3, 'operador', true), ('Luana', $4, 'operador', true),
       ('Desativada', $5, 'operador', false)
     on conflict do nothing`,
    [AMANDA, FERNANDA, MAURICIO, LUANA, DESATIVADA],
  );
}

export async function aplicarB(db) {
  await db.exec(MIG(B));
}

// Elogio de teste. `publicado` controla status/publicado_em.
export async function criarElogio(db, {
  operador = "Mauricio", operadorEmail = MAURICIO, texto = null,
  status = "PUBLICADO_TV", publicadoEm = "2026-09-20T12:00:00Z",
  print = "prints/elogio-teste.png", observacao = "observacao interna do operador",
  motivoRejeicao = null, registradoPor = LUANA,
} = {}) {
  const r = await db.query(
    `insert into public.elogios_atendimento
       (operador_email, operador_nome, print_path, observacao_operador, texto_final_tv,
        status, motivo_rejeicao, publicado_em, registrado_por_email)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id::text`,
    [operadorEmail, operador, print, observacao, texto, status, motivoRejeicao, publicadoEm, registradoPor],
  );
  return r.rows[0].id;
}

export const mural = async (db, email, limite = null) =>
  comoUsuario(db, email, async () =>
    (await db.query("select * from public.portal_mural_elogios($1)", [limite])).rows);

export const curtidasTotais = async (db, email, alvoTipo) =>
  comoUsuario(db, email, async () =>
    (await db.query("select * from public.portal_curtidas_totais($1) order by alvo_id", [alvoTipo])).rows);

// ---------------------------------------------------------------------------
// C1 / C2 -- desafio da semana e ideias da equipe. O fixture reproduz a estrutura
// e as policies REAIS de producao para `sugestoes` e a funcao usuario_e_gestao()
// conforme pg_get_functiondef. As sugestoes em si sao FICTICIAS.
// ---------------------------------------------------------------------------
export const C1 = "20260930165120_portal_desafio_semana";
export const C2 = "20260930165209_portal_ideias_equipe";

const SUGESTOES_DDL = `
create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer as $fn$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$fn$;

create or replace function public.usuario_e_gestao_fila() returns boolean
language sql stable security definer as $fn$
  SELECT public.usuario_e_gestao()
  OR EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE lower(u.email) = lower(coalesce(auth.jwt()->>'email',''))
      AND u.perfil IN ('gerencia','supervisor','administrativo')
  );
$fn$;

create or replace function public.app_email() returns text
language sql stable as $fn$ select lower(coalesce((auth.jwt() ->> 'email'), '')) $fn$;

create or replace function public.eh_painel() returns boolean
language sql stable security definer as $fn$ select false $fn$;

create table if not exists public.sugestoes (
  id uuid primary key default gen_random_uuid(),
  nome text,
  autor_email text,
  area text not null,
  tipo text not null,
  prioridade text,
  tela text,
  descricao text not null,
  status text default 'NOVA',
  criado_em timestamptz default now(),
  motivo_impacto text,
  anexo_path text,
  anexo_nome text,
  status_em timestamptz,
  status_por text,
  observacao_tratativa text,
  visivel_equipe boolean not null default false,
  retorno_operador text,
  validado_em timestamptz
);

alter table public.sugestoes enable row level security;

-- Policies REAIS de producao: a equipe NAO le sugestao (nem a propria).
drop policy if exists sugestoes_select on public.sugestoes;
create policy sugestoes_select on public.sugestoes
for select to authenticated using (usuario_e_gestao_fila());

drop policy if exists sugestoes_insert on public.sugestoes;
create policy sugestoes_insert on public.sugestoes
for insert to authenticated
with check (app_usuario_ativo() and (usuario_e_gestao() or lower(coalesce(autor_email,'')) = app_email()));

drop policy if exists sugestoes_update on public.sugestoes;
create policy sugestoes_update on public.sugestoes
for update to authenticated
using (usuario_e_gestao_fila()) with check (usuario_e_gestao_fila());

-- RESTRICTIVE, como em producao (conferido em pg_policies.permissive). Se fosse
-- PERMISSIVE ela seria OR com sugestoes_select e liberaria leitura para todos --
-- o oposto do que o nome diz.
drop policy if exists painel_negado on public.sugestoes;
create policy painel_negado on public.sugestoes
as restrictive for all to authenticated using (not eh_painel());

grant select, insert, update on public.sugestoes to authenticated;
`;

export async function prepararSugestoes(db) {
  await db.exec(SUGESTOES_DDL);
}

// O grant de tabela para `authenticated` o Supabase concede por padrao no projeto;
// no PGlite e explicito, como nas outras tabelas deste harness.
export async function aplicarC1(db) {
  await db.exec(MIG(C1));
  await db.exec("grant select, insert, update, delete on public.portal_desafios to authenticated;");
}
export const aplicarC2 = (db) => db.exec(MIG(C2));

export async function criarSugestao(db, {
  descricao = "Ideia de teste", autor = "Luana", autorEmail = LUANA,
  area = "CRM", tipo = "MELHORIA", status = "NOVA", visivel = true,
  criadoEm = "2026-09-25T12:00:00Z", tratativa = "tratativa interna da gestao",
  prioridade = "ALTA", tela = "Painel", anexo = "anexos/print.png",
} = {}) {
  const r = await db.query(
    `insert into public.sugestoes
       (descricao, nome, autor_email, area, tipo, status, visivel_equipe, criado_em,
        observacao_tratativa, prioridade, tela, anexo_path)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id::text`,
    [descricao, autor, autorEmail, area, tipo, status, visivel, criadoEm, tratativa, prioridade, tela, anexo],
  );
  return r.rows[0].id;
}

export async function criarDesafio(db, {
  titulo = "Desafio de teste", descricao = "Descricao", objetivo = "Objetivo",
  indicador = "INFORMATIVO", meta = null,
  inicioEm = "2026-09-28", fimEm = "2026-10-04", ativo = true, email = AMANDA,
} = {}) {
  return comoUsuario(db, email, async () => {
    try {
      const r = await db.query(
        `insert into public.portal_desafios
           (titulo, descricao, objetivo, indicador, meta, inicio_em, fim_em, ativo, criado_por_email)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id::text`,
        [titulo, descricao, objetivo, indicador, meta, inicioEm, fimEm, ativo, email],
      );
      return { ok: true, id: r.rows[0].id };
    } catch (e) {
      return { ok: false, code: e.code ?? null, message: String(e.message ?? e) };
    }
  });
}

export const desafioVigente = async (db, email) =>
  comoUsuario(db, email, async () =>
    (await db.query("select * from public.portal_desafio_vigente()")).rows[0] ?? null);

export const ideias = async (db, email, ordem = null, limite = null) =>
  comoUsuario(db, email, async () =>
    (await db.query("select * from public.portal_ideias_equipe($1, $2)", [ordem, limite])).rows);
