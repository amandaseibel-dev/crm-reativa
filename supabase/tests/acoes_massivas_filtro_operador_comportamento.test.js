// ACOES MASSIVAS: FILTRO "OPERADOR RESPONSAVEL" -- COMPORTAMENTO, nao estrutura.
//
// Roda num PostgreSQL real (PGlite) as definicoes VIVAS de producao em
// 16/09/2026 (fixtures com md5 conferido contra pg_get_functiondef), aplica a
// migration 20260916200000 por cima e observa o resultado. E o unico jeito de
// provar "sem operador nada muda": a previa de producao tem 13 parametros e
// nao existe na main como arquivo.
//
// O QUE ESTE TESTE PROVA
//   * sem operador (ausente, NULL, vazio): previa e registro devolvem EXATAMENTE
//     o que devolviam antes, numa matriz de filtros;
//   * operador A: zero alunos de B, zero livres; todas as travas seguem;
//   * operador + nunca acionados / bordero / unidade / curso;
//   * o valor vem do caso do proprio operador;
//   * previa e registro tem o mesmo recorte; quem troca de dono no meio e pulado;
//   * nada troca responsavel (aluno nem caso);
//   * gate de gestao, ACL, comentario, idempotencia, falha alta e rollback.
//
// NENHUM DADO REAL: todo nome, e-mail, CPF e valor aqui e inventado.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");
const md5 = (s) => createHash("md5").update(s).digest("hex");

const FIX = "supabase/tests/fixtures/acoes_massivas_prod_20260916";
const DEF_PREVIA = ler(`${FIX}/acoes_massivas_previa.sql`);
const DEF_REGISTRAR = ler(`${FIX}/registrar_acao_massiva.sql`);
const DEF_FILTROS = ler(`${FIX}/acoes_massivas_filtros.sql`);
const MIGRATION = ler("supabase/migrations/20260916200000_acoes_massivas_filtro_operador.sql");
const ROLLBACK = ler("supabase/rollbacks/20260916200000_acoes_massivas_filtro_operador.rollback.sql");

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

async function novoBanco({ migrar = false } = {}) {
  const db = await PGlite.create();
  await db.exec(ESQUEMA);
  await db.exec(INSTALA_PROD);
  await semear(db);
  if (migrar) await db.exec(MIGRATION);
  await comoGestao(db);
  return db;
}

// Matriz de filtros da tela, SEM operador. Tudo o que existia antes.
const MATRIZ = [
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

describe("fixtures = producao em 16/09/2026", () => {
  it("o texto das tres funcoes bate com o md5 lido em producao", () => {
    expect(md5(DEF_PREVIA)).toBe(MD5_PROD.acoes_massivas_previa);
    expect(md5(DEF_REGISTRAR)).toBe(MD5_PROD.registrar_acao_massiva);
    expect(md5(DEF_FILTROS)).toBe(MD5_PROD.acoes_massivas_filtros);
  });

  it("o rollback carrega exatamente os mesmos trechos da migration", () => {
    const trechos = (sql) => [...sql.matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
    expect(trechos(MIGRATION).length).toBe(22);
    expect(trechos(ROLLBACK)).toEqual(trechos(MIGRATION));
  });
});

describe("sem operador: nada muda", () => {
  let antes;
  let depois;
  let db;
  beforeAll(async () => {
    db = await novoBanco();
    antes = [];
    for (const args of MATRIZ) antes.push(await previa(db, args));
    antes.filtros = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    await db.exec(MIGRATION);
    await comoGestao(db);
    depois = [];
    for (const args of MATRIZ) depois.push(await previa(db, args));
  });

  it("a matriz de dados de teste nao e trivial (cada filtro recorta algo)", () => {
    // sem filtro: so os livres (L3 esta em confirmacao)
    expect(chaves(antes[0]).sort()).toEqual(["L1", "L2"]);
    // so nunca acionados: livres e quem tem dono mas nunca foi acionado
    expect(chaves(antes[1]).sort()).toEqual(["A1", "A11", "B1", "G1", "L1"]);
    expect(chaves(antes[3])).toContain("A2");   // fora do prazo com dono entra
    expect(chaves(antes[3])).toContain("B2");
    expect(new Set(antes.map((r) => JSON.stringify(chaves(r)))).size).toBeGreaterThan(8);
  });

  it("previa sem p_operador_email devolve o mesmo JSON de antes, filtro a filtro", () => {
    MATRIZ.forEach((_, i) => {
      const { operador_email, ...resto } = depois[i];
      expect(operador_email).toBeNull();
      expect(normal(resto)).toEqual(normal(antes[i]));
    });
  });

  it("p_operador_email NULL, vazio ou so espacos = base livre / regra atual", async () => {
    for (const vazio of [null, "", "   "]) {
      for (let i = 0; i < MATRIZ.length; i += 1) {
        const { operador_email, ...resto } = await previa(db, { ...MATRIZ[i], p_operador_email: vazio });
        expect(operador_email).toBeNull();
        expect(normal(resto)).toEqual(normal(antes[i]));
      }
    }
  });

  it("filtros: unidades, cursos e status academicos iguais aos de antes", async () => {
    const { operadores, ...resto } = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    expect(resto).toEqual(antes.filtros);
    expect(Array.isArray(operadores)).toBe(true);
  });

  it("registro sem operador: mesmo retorno e mesma escrita de antes", async () => {
    const velho = await novoBanco();
    const novo = await novoBanco({ migrar: true });
    const ids = [ID.L1, ID.L2, ID.A1, ID.A2, ID.B2, ID.L3, ID.A9, ID.X1];
    const rv = await registrar(velho, ids);
    const { excluidos_outro_operador, operador_email, ...rn } = await registrar(novo, ids);
    expect(excluidos_outro_operador).toBe(0);
    expect(operador_email).toBeNull();
    const ord = (r) => ({ ...r, contatos: [...r.contatos].sort((a, b) => a.aluno_id.localeCompare(b.aluno_id)) });
    expect(ord(rn)).toEqual(ord(rv));
    // hoje: so livre ou dono-nunca-acionado grava; o resto e pulado
    expect(rv.ids_registrados.map((i) => NOME_POR_ID[i]).sort()).toEqual(["A1", "L1", "L2"]);
    const foto = async (d) => JSON.stringify((await d.query(
      `select id, data_retorno, retorno_origem, status_acionamento, responsavel_atual_email,
              data_ultimo_acionamento is not null acionado from public.alunos order by id`)).rows);
    expect(await foto(novo)).toBe(await foto(velho));
    const movs = async (d) => JSON.stringify((await d.query(
      `select aluno_id, tipo, descricao from public.aluno_movimentacoes order by aluno_id`)).rows);
    expect(await movs(novo)).toBe(await movs(velho));
  });
});

describe("com operador escolhido", () => {
  let db;
  beforeAll(async () => { db = await novoBanco({ migrar: true }); });

  it("operador A: so a carteira atual de A, com todas as travas", async () => {
    const r = await previa(db, { p_operador_email: OP_A });
    expect(r.operador_email).toBe(OP_A);
    expect(chaves(r).sort()).toEqual(["A1", "A10", "A11", "A12", "A2", "A3"].sort());
    // A4 confirmacao, A5 quitado, A6 acordo ativo, A7 retorno futuro,
    // A8 encerrado, A9 liquidado no Prime: nenhum entra
    for (const k of ["A4", "A5", "A6", "A7", "A8", "A9"]) expect(chaves(r)).not.toContain(k);
    // confirmacao aparece so na lista mascarada de excluidos, e so a de A
    expect(r.excluidos_confirmacao).toEqual([{ aluno: "A4 ***", motivo: "Aguardando confirmação financeira" }]);
    expect(r.total_elegivel_filtros).toBe(6);
  });

  it("operador A: zero alunos de B, zero livres, zero da gestao, em toda a matriz", async () => {
    const donoDe = async () => Object.fromEntries((await db.query(
      "select id, responsavel_atual_email d from public.alunos")).rows.map((x) => [x.id, x.d]));
    const dono = await donoDe();
    for (const [op, outro] of [[OP_A, OP_B], [OP_B, OP_A]]) {
      for (const args of MATRIZ) {
        const r = await previa(db, { ...args, p_operador_email: op });
        for (const e of r.elegiveis) expect(dono[e.id]).toBe(op);
        expect(r.elegiveis.some((e) => dono[e.id] === outro)).toBe(false);
      }
    }
  });

  it("e-mail com caixa e espacos casa com o mesmo operador (chave normalizada)", async () => {
    const a = await previa(db, { p_operador_email: OP_A });
    const b = await previa(db, { p_operador_email: `  ${OP_A.toUpperCase()} ` });
    expect(normal(b)).toEqual(normal(a));
  });

  it("operador inexistente ou sem carteira: lista vazia, nunca a base livre", async () => {
    const r = await previa(db, { p_operador_email: "ninguem@teste.local" });
    expect(r.elegiveis).toEqual([]);
    expect(r.total_elegivel_filtros).toBe(0);
    expect(r.operador_email).toBe("ninguem@teste.local");
  });

  it("operador + so nunca acionados", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_apenas_nunca_acionado: true })).sort())
      .toEqual(["A1", "A11"]);
    expect(chaves(await previa(db, { p_operador_email: OP_B, p_apenas_nunca_acionado: true })))
      .toEqual(["B1"]);
  });

  it("operador + bordero", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_importacao_ids: [IMP1] }))).toEqual(["A1"]);
    expect(chaves(await previa(db, { p_operador_email: OP_B, p_importacao_ids: [IMP1] }))).toEqual(["B1"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_importacao_ids: [IMP2] }))).toEqual(["A11"]);
  });

  it("operador + unidade / curso", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_unidade: "U1" })).sort()).toEqual(["A1", "A10", "A3"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_unidade: "U2" }))).toEqual(["A2"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_curso: "EAD" })).sort()).toEqual(["A1", "A3"]);
    expect(chaves(await previa(db, { p_operador_email: OP_B, p_unidade: "U1", p_curso: "EAD" })).sort()).toEqual(["B1", "B2"]);
  });

  it("operador + prazo sem acionamento e canal/valor", async () => {
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_dias_minimo_sem_contato: 15 })).sort())
      .toEqual(["A1", "A10", "A11", "A12", "A2"]);
    expect(chaves(await previa(db, { p_operador_email: OP_A, p_canal: "WHATSAPP", p_valor_min: 100 })).sort())
      .toEqual(["A1", "A10", "A2", "A3"]);
  });

  it("o valor vem do caso do proprio operador; sem operador segue o de sempre", async () => {
    const valorDe = (r, k) => Number(r.elegiveis.find((e) => e.id === ID[k]).valor);
    expect(valorDe(await previa(db, { p_operador_email: OP_A }), "A10")).toBe(250);
    expect(valorDe(await previa(db, { p_dias_minimo_sem_contato: 15 }), "A10")).toBe(9000);
    // nenhum aluno com dono vira valor zero
    const r = await previa(db, { p_operador_email: OP_A });
    for (const e of r.elegiveis) expect(Number(e.valor)).toBeGreaterThan(0);
  });

  it("previa com operador nao troca responsavel de aluno nem de caso", async () => {
    const antes = await titularidade(db);
    for (const op of [OP_A, OP_B, OP_A, "ninguem@teste.local"]) await previa(db, { p_operador_email: op });
    expect(await titularidade(db)).toBe(antes);
  });

  it("gate de gestao continua: operador comum recebe 42501, com ou sem filtro", async () => {
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: OP_A, role: "authenticated" })]);
    await expect(previa(db, { p_operador_email: OP_A })).rejects.toThrow(/restrita a gestao/);
    await expect(previa(db, {})).rejects.toThrow(/restrita a gestao/);
    await expect(registrar(db, [ID.A1], { p_operador_email: OP_A })).rejects.toThrow(/restrito a gestao/);
    await comoGestao(db);
  });

  it("executor tecnico (sem JWT) segue passando no gate, com o mesmo recorte", async () => {
    const comGestao = await previa(db, { p_operador_email: OP_B });
    await comoSistema(db);
    try {
      expect(normal(await previa(db, { p_operador_email: OP_B }))).toEqual(normal(comGestao));
      // a lista de operadores nao sai para quem nao e gestao, nem para o executor
      expect((await db.query("select public.acoes_massivas_filtros() r")).rows[0].r.operadores).toEqual([]);
    } finally {
      await comoGestao(db);
    }
  });

  it("mascaramento continua: nome, telefone e e-mail seguem mascarados", async () => {
    const r = await previa(db, { p_operador_email: OP_A });
    for (const e of r.elegiveis) {
      expect(e.nome).toMatch(/^\S+ \*\*\*$/);
      expect(e.telefone ?? null).toBeNull();
      if (e.telefone_mascarado) expect(e.telefone_mascarado).toMatch(/^••••\d{4}$/);
      if (e.email_mascarado) expect(e.email_mascarado).toMatch(/^.•••@/);
    }
  });
});

describe("registro com operador: mesmo recorte da previa", () => {
  it("todo aluno da previa do operador e registrado -- inclusive os ja acionados", async () => {
    const db = await novoBanco({ migrar: true });
    const antes = await titularidade(db);
    const p = await previa(db, { p_operador_email: OP_A });
    const ids = p.elegiveis.map((e) => e.id);
    const r = await registrar(db, ids, { p_operador_email: OP_A });
    expect([...r.ids_registrados].sort()).toEqual([...ids].sort());
    expect(r.registrados).toBe(ids.length);
    expect(r.excluidos_outro_operador).toBe(0);
    expect(r.operador_email).toBe(OP_A);
    expect(r.contatos.map((c) => NOME_POR_ID[c.aluno_id]).sort()).toEqual(chaves(p).sort());
    // sem o parametro, o registro de hoje descartaria os ja acionados
    const semParam = await novoBanco({ migrar: true });
    const r0 = await registrar(semParam, ids);
    expect(r0.ids_registrados.map((i) => NOME_POR_ID[i]).sort()).toEqual(["A1", "A11"]);
    // titularidade intacta; so os campos de acionamento mudam
    expect(await titularidade(db)).toBe(antes);
    const movs = await db.query(`select count(*)::int n from public.aluno_movimentacoes`);
    expect(movs.rows[0].n).toBe(ids.length);
  });

  it("aluno de outro operador nunca e gravado com o filtro de A", async () => {
    const db = await novoBanco({ migrar: true });
    const antesB1 = (await db.query(`select * from public.alunos where id = $1`, [ID.B1])).rows[0];
    const r = await registrar(db, [ID.A1, ID.B1, ID.L1], { p_operador_email: OP_A });
    expect(r.ids_registrados).toEqual([ID.A1]);
    expect(r.excluidos_outro_operador).toBe(2);
    expect(r.ids_excluidos.map((x) => x.motivo)).toEqual([
      "Não está mais na carteira do operador selecionado, ou inexistente",
      "Não está mais na carteira do operador selecionado, ou inexistente",
    ]);
    expect((await db.query(`select * from public.alunos where id = $1`, [ID.B1])).rows[0]).toEqual(antesB1);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where aluno_id <> $1`, [ID.A1])).rows[0].n).toBe(0);
  });

  it("quem mudou de dono entre a previa e o registro e pulado e contado", async () => {
    const db = await novoBanco({ migrar: true });
    const ids = (await previa(db, { p_operador_email: OP_A })).elegiveis.map((e) => e.id);
    await db.query(`update public.alunos set responsavel_atual_email = $1 where id = $2`, [OP_B, ID.A2]);
    const r = await registrar(db, ids, { p_operador_email: OP_A });
    expect(r.ids_registrados).not.toContain(ID.A2);
    expect(r.excluidos_outro_operador).toBe(1);
    expect(r.registrados).toBe(ids.length - 1);
    const a2 = (await db.query(`select status_acionamento, responsavel_atual_email from public.alunos where id = $1`, [ID.A2])).rows[0];
    expect(a2).toEqual({ status_acionamento: null, responsavel_atual_email: OP_B });
  });

  it("confirmacao e liquidado no Prime seguem barrados no registro com operador", async () => {
    const db = await novoBanco({ migrar: true });
    const r = await registrar(db, [ID.A4, ID.A9, ID.A1], { p_operador_email: OP_A });
    expect(r.ids_registrados).toEqual([ID.A1]);
    expect(r.excluidos_confirmacao).toBe(1);
    expect(r.excluidos_liquidados_prime).toBe(1);
    expect(r.excluidos_outro_operador).toBe(0);
  });
});

describe("filtros: lista de operadores", () => {
  it("gestao recebe os operadores ativos do cadastro, com e-mail e nome, em ordem", async () => {
    const db = await novoBanco({ migrar: true });
    const { operadores } = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    expect(operadores).toEqual([
      { email: OP_A, nome: "Ana Operadora" },
      { email: OP_B, nome: "Bruno Operador" },
    ]);
  });

  it("quem nao e gestao recebe a lista vazia", async () => {
    const db = await novoBanco({ migrar: true });
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: OP_A, role: "authenticated" })]);
    const { operadores } = (await db.query("select public.acoes_massivas_filtros() r")).rows[0].r;
    expect(operadores).toEqual([]);
  });
});

describe("instalacao: ACL, comentario, idempotencia, falha alta e rollback", () => {
  const PREVIA_NOVA = "public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text)";
  const REG_NOVO = "public.registrar_acao_massiva(text[],text,text,text,text,text)";

  it("uma sobrecarga so por funcao, sem anon/PUBLIC, comentario preservado", async () => {
    const db = await novoBanco({ migrar: true });
    const d = await defs(db);
    expect(d.map((x) => x.proname)).toEqual(["acoes_massivas_filtros", "acoes_massivas_previa", "registrar_acao_massiva"]);
    for (const fn of [PREVIA_NOVA, REG_NOVO, "public.acoes_massivas_filtros()"]) {
      const q = async (papel) => (await db.query(
        `select has_function_privilege($1, $2, 'EXECUTE') ok`, [papel, fn])).rows[0].ok;
      expect(await q("anon")).toBe(false);
      expect(await q("authenticated")).toBe(true);
      expect(await q("service_role")).toBe(true);
      const acl = (await db.query(`select array_to_string(proacl, ',') a from pg_proc where oid = $1::regprocedure`, [fn])).rows[0].a;
      expect(acl.split(",").some((e) => e.startsWith("="))).toBe(false); // PUBLIC
    }
    expect(d.find((x) => x.proname === "registrar_acao_massiva").comentario).toBe(COMENTARIO_REGISTRAR);
    // nada alem do parametro novo mudou nas propriedades da funcao
    const prev = d.find((x) => x.proname === "acoes_massivas_previa").def;
    expect(prev).toMatch(/STABLE SECURITY DEFINER/);
    expect(prev).toMatch(/SET statement_timeout TO '60s'/);
    expect(d.find((x) => x.proname === "registrar_acao_massiva").def).toMatch(/SET statement_timeout TO '60s'/);
  });

  it("rodar a migration de novo nao muda nada", async () => {
    const db = await novoBanco({ migrar: true });
    const uma = await defs(db);
    await db.exec(MIGRATION);
    expect(await defs(db)).toEqual(uma);
  });

  it("ancora ausente: falha alto e nao instala nenhuma das tres", async () => {
    const db = await novoBanco();
    // simula producao ter mudado o registro: a ancora do gate some
    const alterado = DEF_REGISTRAR.replace(
      "AND (responsavel_atual_email IS NULL OR data_ultimo_acionamento IS NULL);",
      "AND (responsavel_atual_email IS NULL);");
    expect(alterado).not.toBe(DEF_REGISTRAR);
    await db.exec(alterado);
    const antes = await defs(db);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/registrar_acao_massiva: ancora nao encontrada/);
    expect(await defs(db)).toEqual(antes);
  });

  it("migration + rollback devolvem as tres funcoes identicas as de producao", async () => {
    const db = await novoBanco();
    const antes = await defs(db);
    const acl = async () => (await db.query(
      `select proname, array_to_string(proacl, ',') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname in ('acoes_massivas_previa','registrar_acao_massiva','acoes_massivas_filtros')
        order by proname`)).rows;
    const aclAntes = await acl();
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    const depois = await defs(db);
    expect(depois.map(({ def, args, comentario, proname }) => ({ def: md5(def), args, comentario, proname })))
      .toEqual(antes.map(({ def, args, comentario, proname }) => ({ def: md5(def), args, comentario, proname })));
    expect(await acl()).toEqual(aclAntes);
    // e o md5 bate com o de producao
    expect(md5(depois.find((x) => x.proname === "acoes_massivas_previa").def)).toBe(MD5_PROD.acoes_massivas_previa);
    // rollback repetido e inocuo
    await db.exec(ROLLBACK);
    expect(await defs(db)).toEqual(depois);
  });
});
