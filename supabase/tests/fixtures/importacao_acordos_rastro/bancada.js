// BANCADA PGlite -- rastreabilidade da importacao de acordos (P1/P2/P3).
//
// PostgreSQL real. O ponto de partida e o corpo de PRODUCAO de
// `importar_acordos` colhido em 23/10/2026 (funcoes_producao.json, md5
// conferido na montagem): se producao mudar, o teste falha na montagem e esta
// fixture precisa ser recolhida -- em vez de passar verde contra um corpo que
// nao existe mais.
//
// `internal.patch_funcao_ancorada` NAO e duble: e o patcher real, lido do
// arquivo de migration que o criou. Storage e duble minimo (buckets/objects),
// o suficiente para provar que o bucket nasce privado e que as policies ficam
// no lugar.
//
// NENHUM DADO REAL: todo CPF, nome e documento abaixo e inventado.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..", "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

export const MIGRATION = ler("supabase/migrations/20261023190000_importacao_acordos_rastreabilidade.sql");
export const ROLLBACK = ler("supabase/rollbacks/20261023190000_importacao_acordos_rastreabilidade.rollback.sql");

const PROD = JSON.parse(ler("supabase/tests/fixtures/importacao_acordos_rastro/funcoes_producao.json"));

// o patcher real, tirado do arquivo da migration que o criou
const trecho = (sql, nome) => {
  const m = sql.match(new RegExp("create or replace function " + nome + "\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$;"));
  if (!m) throw new Error("nao achei " + nome);
  return m[0];
};
const PATCHER = "create schema if not exists internal;\n" +
  trecho(ler("supabase/migrations/20260925181823_carteira_geral_blindar_automacoes.sql"),
         "internal\\.patch_funcao_ancorada");

export const IMPORTADOR = "importador@teste.local";   // passa em app_pode_borderos_importacoes
export const GESTAO = "gestao@teste.local";           // passa em usuario_e_gestao
export const OPERADOR = "op@teste.local";             // nao passa em nenhum dos dois

export const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ESQUEMA = `
  create role anon; create role authenticated; create role service_role;
  -- reproduz o default privilege do schema public de producao, que e a origem
  -- da heranca de TRUNCATE para authenticated em toda tabela nova
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;

  create table public.usuarios (email text, nome text, perfil text, ativo boolean);
  create table public.alunos (
    id uuid primary key default gen_random_uuid(), nome text, cpf text, unidade text,
    situacao_academica text, status_jornada text, tipo_base text, origem text, observacao text,
    saldo_total numeric);
  create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid, quitado_em timestamptz);
  create table public.acordos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid, cpf text, tipo text,
    forma_pagamento text, valor_total numeric, qtd_parcelas int, status text, unidade text,
    saldo numeric, observacao text, criado_por_email text, criado_por_nome text,
    numero_ulbra text, duplicado_de uuid, criado_em timestamptz, atualizado_em timestamptz);
  create table public.acordos_titulos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid, cpf text, documento text,
    vencimento date, valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
    situacao text, status text, tipo_boleto text, importacao_id uuid, acordo_id uuid, motivo_ajuste text);
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(), acordo_id uuid, numero int, boleto text, valor numeric);
  create table public.fila_acordos_confirmar (
    id bigserial primary key, aluno_id uuid, cpf text, nome text, acordo_base text,
    qtd_parcelas int, valor_total numeric, unidade text, situacao_aluno text, importacao_id uuid,
    unique (cpf, acordo_base));
  create table public.importacoes (
    id uuid primary key, tipo text, referencia text, arquivo_nome text, usuario text,
    status text, retroativo boolean, qtd_registros int, created_at timestamptz default now());
  create table public.importacoes_acordos (
    importacao_id uuid primary key, arquivo_nome text, importado_por text, importado_em timestamptz,
    parcelas int, acordos int, cpfs int, alunos_novos int, titulos_inseridos int, total numeric);
  create table public.auditoria (
    id uuid primary key default gen_random_uuid(), usuario text, acao text, tabela_afetada text,
    registro_id uuid, detalhes jsonb, criado_em timestamptz default now());

  -- Storage: duble minimo, com as colunas que as policies usam.
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(),
    bucket_id text, name text, owner uuid, created_at timestamptz default now());
  alter table storage.objects enable row level security;

  -- Os dois portoes, com a MESMA forma de producao (allowlist por e-mail).
  create function public.app_pode_borderos_importacoes() returns boolean
    language sql stable security definer set search_path to 'public' as
    $$ select lower(coalesce(auth.jwt()->>'email','')) = '${IMPORTADOR}' $$;
  create function public.usuario_e_gestao() returns boolean
    language sql stable security definer set search_path to 'public' as
    $$ select lower(coalesce(auth.jwt()->>'email','')) in ('${GESTAO}', '${IMPORTADOR}') $$;

  -- Dubles do que importar_acordos chama e que nao e objeto deste teste.
  create function public.completar_parcelas_acordo(
    p_limite int default 0, p_dry_run boolean default true,
    p_lote text default null, p_executado_por text default null)
  returns table (acordo_id uuid) language sql as $$ select null::uuid where false $$;
  create function public.parcela_paga_antes_apos_importar_acordos(p_importacao_id uuid)
  returns void language plpgsql as $$ begin return; end; $$;

  -- registrar_importacao_acordo na FORMA de producao (portao da gestao +
  -- upsert por importacao_id). Esta aqui para uma coisa so: provar que a
  -- funcao nova do arquivo nao e apagada quando esta roda depois. O texto e
  -- transcrito, nao ancorado por md5 -- o que o teste afirma e o
  -- comportamento do upsert, nao o literal do corpo.
  create function public.registrar_importacao_acordo(
    p_importacao_id uuid, p_arquivo_nome text, p_parcelas integer, p_acordos integer,
    p_cpfs integer, p_alunos_novos integer, p_titulos_inseridos integer, p_total numeric)
  returns void language plpgsql security definer set search_path to 'public' as $ria$
  begin
    if not public.usuario_e_gestao() then
      raise exception 'Apenas a gestao pode registrar importacoes.';
    end if;
    insert into public.importacoes_acordos as i
      (importacao_id, arquivo_nome, importado_por, importado_em,
       parcelas, acordos, cpfs, alunos_novos, titulos_inseridos, total)
    values
      (p_importacao_id, p_arquivo_nome, auth.jwt() ->> 'email', now(),
       p_parcelas, p_acordos, p_cpfs, p_alunos_novos, p_titulos_inseridos, p_total)
    on conflict (importacao_id) do update set
      arquivo_nome      = coalesce(excluded.arquivo_nome, i.arquivo_nome),
      importado_por     = coalesce(excluded.importado_por, i.importado_por),
      parcelas          = excluded.parcelas,
      acordos           = excluded.acordos,
      cpfs              = excluded.cpfs,
      alunos_novos      = excluded.alunos_novos,
      titulos_inseridos = excluded.titulos_inseridos,
      total             = excluded.total;
  end;
  $ria$;
`;

export async function montarBase() {
  const db = new PGlite();
  await db.exec(ESQUEMA);
  await db.exec(PATCHER);

  const f = PROD.funcoes.importar_acordos;
  if (md5(f.corpo) !== f.md5) {
    throw new Error(`importar_acordos: a fixture foi alterada (md5 ${md5(f.corpo)} != ${f.md5})`);
  }
  await db.exec(`create function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
    returns json language plpgsql security definer set search_path to 'public'
    set statement_timeout to '180000' as $fnprod$${f.corpo}$fnprod$;`);

  await db.exec(`
    insert into public.usuarios (email, nome, perfil, ativo) values
      ('${IMPORTADOR}', 'Importador', 'gerencia', true),
      ('${GESTAO}',     'Gestao',     'gerencia', true),
      ('${OPERADOR}',   'Operador',   'operador', true);
  `);
  return db;
}

// `patch` = producao + a migration de 23/10. `false` = producao crua, para
// medir o ANTES sem nenhuma linha nova.
export async function novoBanco({ patch = true } = {}) {
  const db = await montarBase();
  if (patch) await db.exec(MIGRATION);
  return db;
}

export const como = (db, email) =>
  db.query(`select set_config('request.jwt.claims', $1, false)`,
           [JSON.stringify({ email, role: "authenticated" })]);
export const comoImportador = (db) => como(db, IMPORTADOR);
export const comoGestao = (db) => como(db, GESTAO);
export const comoOperador = (db) => como(db, OPERADOR);
export const semSessao = (db) =>
  db.query(`select set_config('request.jwt.claims', '', false)`);

export async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0];
}
export async function todos(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows;
}

// Uma linha do relatorio, como a tela monta antes de chamar importar_acordos.
//
// O documento padrao tem 12 digitos de proposito: e a forma do boleto de
// ACORDO (0 + 5 + acordo[6] + parcela[4]). Com 12 digitos, acordo_base fica
// com 10 (`left(doc, len-2)`), casa com `^\d{10}$` e o acordo nasce com
// numero_ulbra = substr(base,4,5). Com qualquer outro tamanho o acordo nao e
// criado, e metade dos cenarios deste teste nao existiria.
export const linha = (o = {}) => ({
  documento: o.documento ?? "050999990001",
  cpf: o.cpf ?? "03704201014",
  nome: o.nome ?? "Aluno Inventado",
  venc: o.venc ?? "2026-08-07",
  valor: o.valor ?? 1316.1,
  unidade: o.unidade ?? "Torres",
  situacao: o.situacao ?? "Ativo",
});

export const importar = (db, importacaoId, linhas) =>
  um(db, `select public.importar_acordos($1::jsonb, $2::uuid) as r`,
     [JSON.stringify(linhas), importacaoId]);

export const criticas = (db, importacaoId) =>
  todos(db, `select classe, motivo_codigo, origem, linha_numero, documento, acordo_ulbra,
                    cpf, vencimento, valor
               from public.importacao_acordo_critica
              where importacao_id = $1 order by motivo_codigo, documento nulls last, id`,
        [importacaoId]);

export const resumo = (db, importacaoId) =>
  todos(db, `select * from public.importacao_acordo_critica_resumo($1::uuid)`, [importacaoId]);
