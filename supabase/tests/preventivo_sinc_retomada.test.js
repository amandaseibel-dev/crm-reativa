// RETOMAR UM CICLO NÃO REPROCESSA QUEM JÁ FOI CONSULTADO.
//
// O botão "Continuar atualização" só é honesto se o banco garantir isso — e
// quem garante é `preventivo_sinc_alvos`, que entrega apenas fila com
// `coletado_em is null`. Este arquivo prova no PostgreSQL de verdade, porque é
// a afirmação que sustenta a economia das consultas à API da ULBRA.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const GESTAO = "amanda.seibel@aelbra.com.br";

const MIGRATIONS = [
  "supabase/migrations/20260928143743_preventivo_estrutura.sql",
  "supabase/migrations/20260928143843_preventivo_importacao.sql",
  "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
  "supabase/migrations/20260928201351_preventivo_remessa_como_unidade.sql",
  "supabase/migrations/20261005191400_preventivo_contexto_da_acao.sql",
].map(ler);

const TABELAS = [
  "prev_acao_destinatario", "prev_acao", "prev_evento", "prev_titulo_snapshot",
  "prev_sinc_fila", "prev_sinc", "prev_titulo_lote", "prev_titulo",
  "prev_lote_recusa", "prev_lote", "prev_carteira",
];

let bancoDoArquivo = null;

async function novoBanco() {
  if (bancoDoArquivo) {
    await bancoDoArquivo.exec(
      `truncate ${TABELAS.map((t) => "public." + t).join(", ")} restart identity cascade`);
    return bancoDoArquivo;
  }
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table public._jwt (email text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('email', (select email from public._jwt limit 1)) $$;
    create table public.usuarios (email text, ativo boolean default true);
    insert into public.usuarios values ('${GESTAO}', true);
    insert into public._jwt values ('${GESTAO}');
  `);
  for (const m of MIGRATIONS) await db.exec(m);
  bancoDoArquivo = db;
  return db;
}

beforeAll(async () => { await novoBanco(); });

const um = async (db, sql, p = []) => {
  const r = await db.query(sql, p);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
};

const t = (matricula) => ({
  matricula, aluno_nome: `Aluno ${matricula}`,
  vencimento: "2026-10-20", vencimento_origem: "2026-10-20",
  valor: "100", saldo: "100", saldo_atualizado: "100", situacao: "EM ABERTO",
  celular: `(51) 9${matricula.slice(-4)}-${matricula.slice(-4)}`,
  email: `a${matricula}@exemplo.com`,
});

describe("Preventivo — retomar ciclo não reprocessa quem já foi", () => {
  let db, carteira, sinc;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('C', null, '2026-01-01'::date, '2027-12-31'::date)`);
    await um(db,
      `select public.preventivo_lote_confirmar($1::uuid, 'R1', 'r.csv', '{}'::jsonb, null, $2::jsonb)`,
      [carteira, JSON.stringify([t("2026000001"), t("2026000002"), t("2026000003")])]);
    sinc = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
  });

  const alvos = async (limite = 500) => {
    const r = await db.query(
      `select * from public.preventivo_sinc_alvos($1::uuid, $2::int)`, [sinc, limite]);
    return r.rows.map((x) => Object.values(x)[0]).sort();
  };

  it("a fila nasce com todos os alunos da carteira", async () => {
    expect(await alvos()).toEqual(["2026000001", "2026000002", "2026000003"]);
    expect(await um(db, `select alvos from public.prev_sinc where id = $1::uuid`, [sinc])).toBe(3);
  });

  it("quem já foi coletado NÃO volta na retomada", async () => {
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', '[]'::jsonb)`, [sinc]);

    const restantes = await alvos();
    expect(restantes).toEqual(["2026000002", "2026000003"]);
    expect(restantes).not.toContain("2026000001");
  });

  it("retomar duas vezes seguidas continua andando, sem repetir ninguém", async () => {
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', '[]'::jsonb)`, [sinc]);
    expect(await alvos()).toEqual(["2026000002", "2026000003"]);

    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000002', '[]'::jsonb)`, [sinc]);
    expect(await alvos()).toEqual(["2026000003"]);

    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000003', '[]'::jsonb)`, [sinc]);
    expect(await alvos()).toEqual([]);
  });

  it("o ciclo só fecha como CONCLUIDA quando a fila zera", async () => {
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', '[]'::jsonb)`, [sinc]);
    const meio = await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [sinc]);
    expect(meio.status).toBe("FALHOU");
    expect(meio.pendentes).toBe(2);
  });

  it("com a fila zerada o ciclo fecha como CONCLUIDA", async () => {
    for (const m of ["2026000001", "2026000002", "2026000003"]) {
      await um(db, `select public.preventivo_sinc_gravar($1::uuid, $2, '[]'::jsonb)`, [sinc, m]);
    }
    const fim = await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [sinc]);
    expect(fim.status).toBe("CONCLUIDA");
    expect(fim.pendentes).toBe(0);
  });

  it("aluno que falhou 3 vezes sai da fila e não prende o ciclo para sempre", async () => {
    for (let i = 0; i < 3; i++) {
      await um(db, `select public.preventivo_sinc_falhou($1::uuid, '2026000001', 'prime 500')`, [sinc]);
    }
    expect(await alvos()).toEqual(["2026000002", "2026000003"]);
  });

  it("snapshot não duplica quando o mesmo ciclo é retomado", async () => {
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', '[]'::jsonb)`, [sinc]);
    const antes = await um(db, `select count(*)::int from public.prev_titulo_snapshot where sinc_id = $1::uuid`, [sinc]);
    // a retomada não devolve esse aluno, então nada é regravado
    expect(await alvos()).not.toContain("2026000001");
    const depois = await um(db, `select count(*)::int from public.prev_titulo_snapshot where sinc_id = $1::uuid`, [sinc]);
    expect(depois).toBe(antes);
  });
});
