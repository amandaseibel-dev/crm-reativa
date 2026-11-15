// PERFIS E GRANTS DO PREVENTIVO NUM POSTGRES DESCARTÁVEL COM A FORMA DO SUPABASE.
//
// Diferença para os outros testes do Preventivo: aqui a chamada muda de PAPEL de
// verdade (`SET ROLE anon | authenticated | service_role`, como o PostgREST faz)
// e os claims vão em `request.jwt.claims`. Os testes antigos chamavam a função
// como superusuário, sem trocar de papel, e por isso não exercitavam GRANT,
// EXECUTE nem RLS.
//
// O QUE É REPRODUZIDO (e a fonte):
//   - papéis anon / authenticated / service_role (BYPASSRLS) / authenticator,
//     com authenticator podendo assumir os três — forma padrão do Supabase;
//   - ALTER DEFAULT PRIVILEGES do dono `postgres` em `public`: tabelas e
//     sequências nascem com ALL para anon, authenticated e service_role (a
//     armadilha do projeto: objeto novo nasce aberto); funções nascem com
//     EXECUTE de PUBLIC (padrão do Postgres) + authenticated + service_role,
//     sem anon explícito — como a ACL medida em produção em 28/09 e 12/11;
//   - auth.jwt() com o corpo do Supabase (lê request.jwt.claim(s));
//   - RLS + FORCE nas 11 tabelas prev_ (vem das migrations do repositório);
//   - ACL final da função do portão em produção: {postgres, authenticated,
//     service_role}, SECURITY DEFINER, dono postgres (lido em 12/11/2026).
//
// O QUE NÃO É (limites, também em docs/preventivo/README.md):
//   - não é o Supabase: não há PostgREST, GoTrue nem a role `authenticator`
//     trocando de papel por requisição — o SET ROLE é feito pelo teste;
//   - não lê nem copia nada de produção; usuarios é uma tabela mínima de teste;
//   - login anônimo (se está ligado) é configuração do painel: aqui só se prova
//     que, SE existir um JWT authenticated sem e-mail, ele não passa.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GESTAO = "amanda.seibel@aelbra.com.br";
const DIRETORIA = ["angela.ferreira@aelbra.com.br", "gustavo.ene@aelbra.com.br"];
const ADM = "cobranca07@aelbra.com.br";

const todas = readdirSync(resolve(RAIZ, "supabase/migrations"))
  .filter((f) => /preventivo/.test(f) && f.endsWith(".sql")).sort();
const lerMig = (f) => readFileSync(resolve(RAIZ, "supabase/migrations", f), "utf8");
const FIX = todas.find((f) => f.includes("gestao_exige_papel_no_jwt_sem_email"));

const AMBIENTE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role authenticator noinherit login;
  grant anon, authenticated, service_role to authenticator;
  create schema auth;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
  -- FUNÇÕES: a ACL medida em produção logo após a migration de 28/09 era
  -- '=X/postgres postgres=X authenticated=X service_role=X' (sem anon explícito):
  -- o EXECUTE de PUBLIC é o padrão do Postgres, e authenticated/service_role
  -- vêm do default privilege. Reproduzido assim (e NÃO com anon explícito).
  alter default privileges for role postgres in schema public grant all on functions to authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                    nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
  create table public.usuarios (email text, ativo boolean default true);
  insert into public.usuarios values ('${GESTAO}', true), ('${ADM}', true),
    ('${DIRETORIA[0]}', true), ('${DIRETORIA[1]}', true);
  grant select on public.usuarios to authenticated, service_role;
`;

async function montar(arquivos) {
  const db = new PGlite();
  await db.exec(AMBIENTE);
  for (const f of arquivos) await db.exec(lerMig(f));
  return db;
}

// Executa `fn` como o papel dado, com os claims dados. Sempre volta a superusuário.
async function como(db, papel, claims, fn) {
  const json = claims === null ? "" : JSON.stringify(claims).replace(/'/g, "''");
  await db.exec(`reset role; select set_config('request.jwt.claims', '${json}', false)`);
  if (papel) await db.exec(`set role ${papel}`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const porta = (db, papel, claims) =>
  como(db, papel, claims, async () => (await db.query("select public.preventivo_e_gestao() as ok")).rows[0].ok);
const erro = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };

const FUNCOES_NOVAS = [
  "preventivo_periodo_academico(date)", "preventivo_visao_geral(text)",
  "preventivo_remessa_mudancas(uuid)", "preventivo_aluno_historico(text)",
];
const TABELAS = [
  "prev_acao_destinatario", "prev_acao", "prev_evento", "prev_titulo_snapshot",
  "prev_sinc_fila", "prev_sinc", "prev_titulo_lote", "prev_titulo",
  "prev_lote_recusa", "prev_lote", "prev_carteira",
];

let db;
beforeAll(async () => {
  db = await montar(todas);
  // dados mínimos, gravados como processo interno (superusuário, sem papel)
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ role: "authenticated", email: GESTAO })}', false)`);
  const c = (await db.query(`select public.preventivo_carteira_criar('Carteira', null, '2026-01-01'::date, '2027-12-31'::date) as id`)).rows[0].id;
  const linha = (m, d, v) => ({
    matricula: m, documento: d, cpf: "12345678901", aluno_nome: `Aluno ${m}`,
    vencimento: "2026-12-10", vencimento_origem: "2026-09-05", valor: String(v), saldo: String(v),
    saldo_atualizado: String(v), situacao: "EM ABERTO", celular: "(51) 90000-0000", email: `a${m}@exemplo.com`,
  });
  await db.query(
    `select public.preventivo_lote_confirmar($1::uuid, 'Semana 1', 'rel.csv', '{}'::jsonb, null, $2::jsonb)`,
    [c, JSON.stringify([linha("2026000001", "900001", 100), linha("2026000002", "900002", 200)])]);
  await db.exec("reset role; select set_config('request.jwt.claims', '', false)");
}, 120000);

describe("grants reais após as duas migrations (papel de verdade)", () => {
  it("anon e PUBLIC sem EXECUTE no portão e nas 4 RPCs novas; authenticated e service_role com", async () => {
    for (const f of ["preventivo_e_gestao()", ...FUNCOES_NOVAS]) {
      const r = (await db.query(
        `select has_function_privilege('anon', 'public.${f}', 'execute') anon,
                has_function_privilege('authenticated', 'public.${f}', 'execute') auth,
                has_function_privilege('service_role', 'public.${f}', 'execute') srv,
                (select coalesce(proacl::text,'') from pg_proc where oid = 'public.${f}'::regprocedure) acl,
                (select prosecdef from pg_proc where oid = 'public.${f}'::regprocedure) secdef`)).rows[0];
      expect({ f, anon: r.anon, auth: r.auth, srv: r.srv, secdef: r.secdef }).toEqual(
        { f, anon: false, auth: true, srv: true,
          // periodo_academico é calculadora pura (não lê tabela): sem SECURITY DEFINER
          secdef: f !== "preventivo_periodo_academico(date)" });
      expect(r.acl).not.toMatch(/(^|[{,])=X/); // nada de PUBLIC (grantee vazio)
    }
  });
  it("NENHUMA função preventivo_* fica executável por anon", async () => {
    const r = await db.query(
      `select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'preventivo\\_%'
          and has_function_privilege('anon', p.oid, 'execute')`);
    expect(r.rows).toEqual([]);
  });
  it("as 11 tabelas prev_ têm RLS e FORCE; anon não lê nem escreve", async () => {
    for (const t of TABELAS) {
      const r = (await db.query(
        `select relrowsecurity rls, relforcerowsecurity frc from pg_class where oid = 'public.${t}'::regclass`)).rows[0];
      expect({ t, ...r }).toEqual({ t, rls: true, frc: true });
    }
    // o default privilege dá ALL ao anon, mas a migration de 28/09 revoga: o
    // anon recebe permission denied (e, se tivesse o privilégio, a RLS negaria)
    expect(await erro(como(db, "anon", { role: "anon" },
      () => db.query("select count(*)::int n from public.prev_titulo"))))
      .toMatch(/permission denied for table prev_titulo/i);
  });
});

describe("o portão com SET ROLE real", () => {
  it("anon: sem EXECUTE (nem chega a avaliar)", async () => {
    expect(String(await erro(porta(db, "anon", { role: "anon" })))).toMatch(/permission denied for function/i);
  });
  it("authenticated SEM e-mail (login anônimo, JWT incompleto, vazio ou ausente) é barrado", async () => {
    for (const claims of [
      { role: "authenticated" }, { role: "authenticated", is_anonymous: true },
      { role: "authenticated", email: "" }, {}, null,
    ]) expect(await porta(db, "authenticated", claims)).toBe(false);
  });
  it("authenticated com claim role=service_role FORJADO é barrado", async () => {
    expect(await porta(db, "authenticated", { role: "service_role" })).toBe(false);
    expect(await porta(db, "authenticated", { role: "service_role", email: "" })).toBe(false);
  });
  it("perfis com e-mail: gestão e diretoria passam; Amanda ADM e desconhecido não", async () => {
    expect(await porta(db, "authenticated", { role: "authenticated", email: GESTAO })).toBe(true);
    for (const email of DIRETORIA) expect(await porta(db, "authenticated", { role: "authenticated", email })).toBe(true);
    expect(await porta(db, "authenticated", { role: "authenticated", email: ADM })).toBe(false);
    expect(await porta(db, "authenticated", { role: "authenticated", email: "x@y.com" })).toBe(false);
  });
  it("e-mail em caixa diferente continua casando; usuário desativado é barrado", async () => {
    expect(await porta(db, "authenticated", { role: "authenticated", email: GESTAO.toUpperCase() })).toBe(true);
    await db.exec(`update public.usuarios set ativo = false where email = '${DIRETORIA[0]}'`);
    expect(await porta(db, "authenticated", { role: "authenticated", email: DIRETORIA[0] })).toBe(false);
    await db.exec(`update public.usuarios set ativo = true where email = '${DIRETORIA[0]}'`);
  });
  it("processos internos continuam: service_role real e sessão de sistema/cron (sem papel, sem JWT)", async () => {
    expect(await porta(db, "service_role", { role: "service_role" })).toBe(true);
    expect(await porta(db, "service_role", null)).toBe(true);
    expect(await porta(db, null, null)).toBe(true);
    expect(await porta(db, null, {})).toBe(true);
  });
  it("a exceção interna NÃO alcança usuário comum: nenhum authenticated/anon sem e-mail passa", async () => {
    for (const papel of ["authenticated"]) {
      for (const claims of [{ role: "service_role" }, { role: "" }, { role: "authenticated" }, {}, null]) {
        expect({ papel, claims, ok: await porta(db, papel, claims) }).toEqual({ papel, claims, ok: false });
      }
    }
  });
});

describe("RPCs e tabelas com o papel real", () => {
  const rpcs = [
    ["preventivo_visao_geral", "$1::text", [null]],
    ["preventivo_aluno_historico", "$1::text", ["2026000001"]],
  ];
  it("gestão lê; authenticated sem e-mail e Amanda ADM recebem 42501; anon sem EXECUTE", async () => {
    for (const [nome, ph, args] of rpcs) {
      const chamar = () => db.query(`select public.${nome}(${ph}) as r`, args);
      const g = await como(db, "authenticated", { role: "authenticated", email: GESTAO }, chamar);
      expect(g.rows[0].r).toBeTruthy();
      for (const claims of [{ role: "authenticated" }, { role: "authenticated", email: ADM }, null]) {
        expect(await erro(como(db, "authenticated", claims, chamar))).toMatch(/acesso restrito à gestão/);
      }
      expect(await erro(como(db, "anon", { role: "anon" }, chamar))).toMatch(/permission denied/i);
    }
  });
  it("histórico não devolve CPF nem carteira_id; a visão devolve dados à gestão", async () => {
    const h = await como(db, "authenticated", { role: "authenticated", email: GESTAO },
      async () => (await db.query(`select public.preventivo_aluno_historico('2026000001') r`)).rows[0].r);
    const txt = JSON.stringify(h);
    expect(txt).not.toMatch(/12345678901/);
    expect(txt).not.toMatch(/carteira_id/);
    expect((h.titulos || []).length).toBeGreaterThan(0);
    const v = await como(db, "authenticated", { role: "authenticated", email: GESTAO },
      async () => (await db.query(`select public.preventivo_visao_geral(null) r`)).rows[0].r);
    expect(Number(v.matriculados)).toBe(2);
  });
  it("leitura direta das tabelas prev_: só a gestão enxerga linhas (RLS força para authenticated)", async () => {
    const n = (claims) => como(db, "authenticated", claims,
      async () => (await db.query("select count(*)::int n from public.prev_titulo")).rows[0].n);
    expect(await n({ role: "authenticated", email: GESTAO })).toBe(2);
    expect(await n({ role: "authenticated" })).toBe(0);
    expect(await n({ role: "authenticated", email: ADM })).toBe(0);
  });
  it("escrita direta por authenticated sem e-mail e por ADM é recusada pela RLS", async () => {
    for (const claims of [{ role: "authenticated" }, { role: "authenticated", email: ADM }]) {
      const e = await erro(como(db, "authenticated", claims,
        () => db.exec("update public.prev_titulo set status = status")));
      // update sem linha visível não erra: o ponto é que nada muda
      expect(e === null || /row-level security|permission denied/i.test(e)).toBe(true);
    }
    const n = (await db.query("select count(*)::int n from public.prev_titulo")).rows[0].n;
    expect(n).toBe(2);
  });
});

describe("o ambiente reproduz a FALHA original (prova de que o teste detecta o problema)", () => {
  it("sem a migration de correção, authenticated sem e-mail PASSAVA no portão", async () => {
    const antes = await montar(todas.filter((f) => f !== FIX));
    expect(await porta(antes, "authenticated", { role: "authenticated", is_anonymous: true })).toBe(true);
    // e com a correção aplicada por cima, deixa de passar
    await antes.exec(lerMig(FIX));
    expect(await porta(antes, "authenticated", { role: "authenticated", is_anonymous: true })).toBe(false);
    // o acesso vivo (gestão + diretoria) sobrevive à correção
    expect(await porta(antes, "authenticated", { role: "authenticated", email: GESTAO })).toBe(true);
    for (const email of DIRETORIA) expect(await porta(antes, "authenticated", { role: "authenticated", email })).toBe(true);
  }, 120000);
});
