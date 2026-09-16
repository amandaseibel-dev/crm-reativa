// BANCADA PGlite das Acoes Massivas -- apoio de teste, nao e teste.
//
// Monta um PostgreSQL real com as definicoes VIVAS de producao em 16/09/2026
// (os .sql ao lado, md5 conferido contra pg_get_functiondef), a mesma ACL e o
// mesmo comentario, dubles minimos do resto do banco e uma carteira inventada.
// Usada pelos testes de comportamento do filtro por operador e da separacao
// entre exportar e confirmar.
//
// NENHUM DADO REAL: todo nome, e-mail, CPF e valor aqui e inventado.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..", "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");
const md5 = (s) => createHash("md5").update(s).digest("hex");

const FIX = "supabase/tests/fixtures/acoes_massivas_prod_20260916";
const DEF_PREVIA = ler(`${FIX}/acoes_massivas_previa.sql`);
const DEF_REGISTRAR = ler(`${FIX}/registrar_acao_massiva.sql`);
const DEF_FILTROS = ler(`${FIX}/acoes_massivas_filtros.sql`);
const MIGRATION = ler("supabase/migrations/20260916200000_acoes_massivas_filtro_operador.sql");
const ROLLBACK = ler("supabase/rollbacks/20260916200000_acoes_massivas_filtro_operador.rollback.sql");
const MIGRATION_EXPORTAR = ler("supabase/migrations/20260916210000_acoes_massivas_exportar_sem_registrar.sql");
const ROLLBACK_EXPORTAR = ler("supabase/rollbacks/20260916210000_acoes_massivas_exportar_sem_registrar.rollback.sql");

// md5(pg_get_functiondef(oid)) lido em producao em 16/09/2026.
const MD5_PROD = {
  acoes_massivas_previa: "98749f293709fc917ec8d669a153033d",
  registrar_acao_massiva: "cc0a86d76f4a2838beb67dc629ffd478",
  acoes_massivas_filtros: "59c085b8a836178c3a4885eb907a47ad",
};
// Comentario vivo da funcao de registro em producao (16/09/2026).
const COMENTARIO_REGISTRAR =
  "Registra que uma acao de estimulo foi enviada POR FORA do CRM (planilha) e agenda o retorno de 10 dias. " +
  "NAO dispara nada: nao enfileira mensagem, nao chama o gateway. Disparar em massa pelo nosso numero segue " +
  "proibido no gateway, que e quem dispara -- aqui o canal WHATSAPP significa apenas que o contato usado foi telefone.";

const OP_A = "op.a@teste.local";
const OP_B = "op.b@teste.local";
const OP_INATIVO = "op.c@teste.local";
const GESTAO = "gestao@teste.local";
const IMP1 = "99999999-0000-4000-8000-000000000001";
const IMP2 = "99999999-0000-4000-8000-000000000002";

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = {
  A1: U(1), A2: U(2), A3: U(3), A4: U(4), A5: U(5), A6: U(6), A7: U(7), A8: U(8),
  A9: U(9), A10: U(10), A11: U(11), A12: U(12),
  B1: U(21), B2: U(22), B3: U(23),
  L1: U(31), L2: U(32), L3: U(33),
  G1: U(41), X1: U(51),
};
const NOME_POR_ID = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v, k]));

const ESQUEMA = `
  create role anon; create role authenticated; create role service_role;
  -- Pior caso do Supabase: objeto novo no schema public nasce acessivel a anon
  -- e authenticated. Sem isto, um revoke esquecido passaria despercebido aqui.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
  create function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;

  create table public.usuarios (email text, nome text, perfil text, ativo boolean);
  create table public.alunos (
    id uuid primary key, nome text, telefone text, email text, cpf text,
    data_ultimo_acionamento timestamptz, situacao_academica text, curso text, unidade text,
    situacao_operacional text, responsavel_atual_email text, data_retorno date,
    status_jornada text, status_atual text, status_acionamento text, retorno_origem text);
  create table public.casos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid, operador_email text,
    total_em_aberto numeric);
  create table public.solicitacoes_confirmacao_pagamento (aluno_id text, status text);
  create table public.prime_contratos (cpf text, valid_from date, status text);
  create table public.prime_extrato (coletado_em timestamptz);
  create table public.acordos (aluno_id uuid, status text);
  create table public.acordos_titulos (aluno_id uuid, situacao text, vencimento date, importacao_id uuid);
  create table public.aluno_movimentacoes (
    aluno_id text, tipo text, descricao text, registrado_por_nome text,
    registrado_por_email text, registrado_em timestamptz);
  create table public._liq_stub (aluno_id uuid);

  create function public.usuario_e_gestao() returns boolean language sql stable as
    $$ select lower(coalesce(auth.jwt()->>'email','')) = '${GESTAO}' $$;
  -- producao usa unaccent; os dados de teste nao tem acento nos status.
  create function public.normalizar_status_acionamento(p_status text) returns text
    language sql immutable as
    $$ select trim(regexp_replace(upper(coalesce(p_status, '')), '[_\\-]+', ' ', 'g')) $$;
  create function public.saldo_titulos_aberto(p_cpf text) returns numeric language sql stable as $$ select 1::numeric $$;
  create function public.semestre_corrente_inicio() returns date language sql immutable as
    $$ select case when extract(month from current_date) <= 6
                   then make_date(extract(year from current_date)::int, 1, 1)
                   else make_date(extract(year from current_date)::int, 7, 1) end $$;
  -- corpo de producao (16/09), com o saldo dublado acima
  create function public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
   returns boolean language plpgsql stable as $$
  declare
    bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
    quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
    nat text := public.normalizar_status_acionamento(p_status_atual);
    nac text := public.normalizar_status_acionamento(p_status_acionamento);
    nfi text := public.normalizar_status_acionamento(p_status_financeiro);
    njo text := public.normalizar_status_acionamento(p_status_jornada);
  begin
    if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
    if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
    if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
    if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
    return false;
  end $$;
  create function public.acoes_massivas_liquidados_prime(p_aluno_ids uuid[] default null)
   returns table(aluno_id uuid, titulos integer, valor_crm numeric, pago_prime numeric, ultima_liquidacao date)
   language sql stable as
    $$ select s.aluno_id, 1, 0::numeric, 0::numeric, current_date from public._liq_stub s
        where p_aluno_ids is null or s.aluno_id = any(p_aluno_ids) $$;
`;

// Instala as tres funcoes como estao em producao, com a mesma ACL e comentario.
const INSTALA_PROD = `
  ${DEF_PREVIA};
  ${DEF_REGISTRAR};
  ${DEF_FILTROS};
  revoke all on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric) from public, anon;
  grant execute on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric) to authenticated, service_role;
  revoke all on function public.registrar_acao_massiva(text[],text,text,text,text) from public, anon;
  grant execute on function public.registrar_acao_massiva(text[],text,text,text,text) to authenticated, service_role;
  revoke all on function public.acoes_massivas_filtros() from public, anon;
  grant execute on function public.acoes_massivas_filtros() to authenticated, service_role;
  comment on function public.registrar_acao_massiva(text[],text,text,text,text) is '${COMENTARIO_REGISTRAR}';
`;

function dias(n) {
  return `now() - interval '${n} days'`;
}

async function semear(db) {
  await db.exec(`
    insert into public.usuarios values
      ('${OP_A}', 'Ana Operadora', 'operador', true),
      ('${OP_B}', 'Bruno Operador', 'operador', true),
      ('${OP_INATIVO}', 'Carla Inativa', 'operador', false),
      ('${GESTAO}', 'Gestao', 'gerencia', true);
    insert into public.prime_extrato values ('2026-09-05 10:00:00+00');
  `);
  // [chave, dono, acionado há (dias|null), valor, extras]
  const alunos = [
    ["A1", OP_A, null, 500, { unidade: "U1", curso: "EAD", situacao_academica: "Matriculado", imp: IMP1 }],
    ["A2", OP_A, 20, 800, { unidade: "U2", curso: "PRESENCIAL", situacao_academica: "Trancado" }],
    ["A3", OP_A, 2, 300, { unidade: "U1", curso: "EAD" }],
    ["A4", OP_A, null, 400, { conf: true }],
    ["A5", OP_A, null, 400, { status_jornada: "QUITADO" }],
    ["A6", OP_A, null, 400, { acordo: "ATIVO" }],
    ["A7", OP_A, null, 400, { retorno_futuro: true }],
    ["A8", OP_A, null, 400, { status_atual: "JURIDICO" }],
    ["A9", OP_A, null, 400, { liquidado: true }],
    ["A10", OP_A, 30, 250, { caso_orfao_de: OP_B, valor_orfao: 9000, unidade: "U1" }],
    ["A11", OP_A, null, 700, { sem_telefone: true, imp: IMP2 }],
    ["A12", OP_A, 40, 50, {}],
    ["B1", OP_B, null, 600, { unidade: "U1", curso: "EAD", situacao_academica: "Matriculado", imp: IMP1 }],
    ["B2", OP_B, 30, 900, { unidade: "U1", curso: "EAD" }],
    ["B3", OP_B, 1, 350, { unidade: "U2" }],
    ["L1", null, null, 450, { unidade: "U1", curso: "EAD", imp: IMP1, ano: 2025 }],
    ["L2", null, 5, 350, { unidade: "U2", ano: 2024 }],
    ["L3", null, null, 380, { situacao_operacional: "AGUARDANDO_CONFIRMACAO" }],
    ["G1", GESTAO, null, 500, { unidade: "U1" }],
    ["X1", OP_INATIVO, 40, 700, { unidade: "U2" }],
  ];
  let n = 0;
  for (const [k, dono, acion, valor, x] of alunos) {
    n += 1;
    const id = ID[k];
    await db.query(
      `insert into public.alunos (id, nome, telefone, email, cpf, data_ultimo_acionamento,
         situacao_academica, curso, unidade, situacao_operacional, responsavel_atual_email,
         data_retorno, status_jornada, status_atual, status_acionamento)
       values ($1, $2, $3, $4, $5, ${acion == null ? "null" : dias(acion)}, $6, $7, $8, $9, $10,
         ${x.retorno_futuro ? "current_date + 5" : "null"}, $11, $12, null)`,
      [id, `${k} Sobrenome`, x.sem_telefone ? null : `(51) 9${String(n).padStart(4, "0")}-0000`,
       `${k.toLowerCase()}@aluno.local`, String(n).padStart(11, "0"),
       x.situacao_academica ?? null, x.curso ?? null, x.unidade ?? null,
       x.situacao_operacional ?? null, dono, x.status_jornada ?? null, x.status_atual ?? null]);
    await db.query(`insert into public.casos (aluno_id, operador_email, total_em_aberto) values ($1,$2,$3)`,
      [id, dono, valor]);
    if (x.caso_orfao_de) {
      await db.query(`insert into public.casos (aluno_id, operador_email, total_em_aberto) values ($1,$2,$3)`,
        [id, x.caso_orfao_de, x.valor_orfao]);
    }
    if (x.conf) {
      await db.query(`insert into public.solicitacoes_confirmacao_pagamento values ($1, 'AGUARDANDO_CONFIRMACAO')`, [id]);
    }
    if (x.acordo) await db.query(`insert into public.acordos values ($1, $2)`, [id, x.acordo]);
    if (x.liquidado) await db.query(`insert into public._liq_stub values ($1)`, [id]);
    await db.query(`insert into public.acordos_titulos values ($1, 'ABERTO', $2, $3)`,
      [id, `${x.ano ?? 2026}-03-10`, x.imp ?? null]);
  }
}

const TIPOS = {
  p_ano_vencimento: "text", p_limite: "integer", p_dias_minimo_sem_contato: "integer",
  p_apenas_nunca_acionado: "boolean", p_unidade: "text", p_curso: "text",
  p_apenas_ja_acionado: "boolean", p_situacao_academica: "text", p_importacao_ids: "uuid[]",
  p_matricula: "text", p_canal: "text", p_valor_min: "numeric", p_valor_max: "numeric",
  p_operador_email: "text",
};
const TIPOS_REG = {
  p_aluno_ids: "text[]", p_canal: "text", p_arquivo: "text", p_registrado_por_nome: "text",
  p_registrado_por_email: "text", p_operador_email: "text",
};

function chamada(fn, tipos, args) {
  const chaves = Object.keys(args);
  const sql = `select public.${fn}(${chaves.map((k, i) => `${k} => $${i + 1}::${tipos[k]}`).join(", ")}) as r`;
  const valores = chaves.map((k) => {
    const v = args[k];
    return Array.isArray(v) ? `{${v.join(",")}}` : v;
  });
  return { sql, valores };
}

async function comoGestao(db) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ email: GESTAO, role: "authenticated", name: "Gestao" })]);
}
async function comoOperador(db, email) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ email, role: "authenticated" })]);
}
async function comoSistema(db) {
  await db.query(`select set_config('request.jwt.claims', '', false)`);
}

async function previa(db, args = {}) {
  const { sql, valores } = chamada("acoes_massivas_previa", TIPOS, args);
  return (await db.query(sql, valores)).rows[0].r;
}
async function registrar(db, ids, extra = {}) {
  const { sql, valores } = chamada("registrar_acao_massiva", TIPOS_REG, {
    p_aluno_ids: ids, p_canal: "WHATSAPP", p_arquivo: "teste.xlsx",
    p_registrado_por_nome: "x", p_registrado_por_email: "x", ...extra,
  });
  return (await db.query(sql, valores)).rows[0].r;
}
const chaves = (r) => r.elegiveis.map((e) => NOME_POR_ID[e.id]);
// Empate na ordem (varios "nunca acionado" = mesma chave NULL) nao tem ordem
// garantida no Postgres, nem em producao. Desempata por id para comparar;
// a ordem por data_ultimo_acionamento continua sendo conferida.
const normal = (r) => ({
  ...r,
  elegiveis: [...r.elegiveis].sort((a, b) =>
    (a.data_ultimo_acionamento ?? "").localeCompare(b.data_ultimo_acionamento ?? "") || a.id.localeCompare(b.id)),
  excluidos_confirmacao: [...r.excluidos_confirmacao].sort((a, b) => a.aluno.localeCompare(b.aluno)),
});

async function defs(db) {
  const r = await db.query(`
    select p.proname, pg_get_functiondef(p.oid) def, pg_get_function_identity_arguments(p.oid) args,
           obj_description(p.oid, 'pg_proc') comentario
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('acoes_massivas_previa','registrar_acao_massiva','acoes_massivas_filtros')
     order by p.proname, p.oid`);
  return r.rows;
}
async function titularidade(db) {
  const a = await db.query(`select id, responsavel_atual_email from public.alunos order by id`);
  const c = await db.query(`select aluno_id, operador_email, total_em_aberto from public.casos order by aluno_id, total_em_aberto`);
  return JSON.stringify([a.rows, c.rows]);
}

async function novoBanco({ migrar = false, exportar = false } = {}) {
  const db = await PGlite.create();
  await db.exec(ESQUEMA);
  await db.exec(INSTALA_PROD);
  await semear(db);
  if (migrar || exportar) await db.exec(MIGRATION);
  if (exportar) await db.exec(MIGRATION_EXPORTAR);
  await comoGestao(db);
  return db;
}

// Matriz de filtros da tela, SEM operador. Tudo o que existia antes.
export const MATRIZ = [
  {},
  { p_apenas_nunca_acionado: true },
  { p_apenas_ja_acionado: true },
  { p_dias_minimo_sem_contato: 15 },
  { p_dias_minimo_sem_contato: 15, p_apenas_nunca_acionado: true },
  { p_unidade: "U1" },
  { p_unidade: "U1|U2", p_dias_minimo_sem_contato: 7 },
  { p_curso: "EAD", p_apenas_nunca_acionado: true },
  { p_importacao_ids: [IMP1] },
  { p_importacao_ids: [IMP1], p_apenas_nunca_acionado: true },
  { p_situacao_academica: "Matriculado|Trancado", p_dias_minimo_sem_contato: 15 },
  { p_canal: "WHATSAPP", p_valor_min: 100, p_dias_minimo_sem_contato: 15 },
  { p_valor_max: 400, p_apenas_nunca_acionado: true },
  { p_limite: 2, p_apenas_ja_acionado: true, p_dias_minimo_sem_contato: 15 },
  { p_ano_vencimento: "2025" },
  { p_matricula: "NAO_CONFIRMADA", p_apenas_nunca_acionado: true },
];

export {
  md5, DEF_PREVIA, DEF_REGISTRAR, DEF_FILTROS, MIGRATION, ROLLBACK, MIGRATION_EXPORTAR, ROLLBACK_EXPORTAR,
  MD5_PROD, COMENTARIO_REGISTRAR, OP_A, OP_B, OP_INATIVO, GESTAO, IMP1, IMP2, ID, NOME_POR_ID,
  TIPOS, TIPOS_REG, chamada, comoGestao, comoOperador, comoSistema, previa, registrar, chaves, normal,
  defs, titularidade, novoBanco,
};
