// GIRO DAS CARTEIRAS 2026/1 e 2026/2 -- fidelizacao excepcional: comportamento.
//
// Postgres real (PGlite) com os objetos NOVOS da migration lidos do proprio
// arquivo -- nao copias. Se alguem mexer no corpo da funcao ou na condicao do
// gatilho, estes testes passam a rodar o texto novo e quebram.
//
// O que esta coberto aqui e so o que a migration CRIA. As guardas que ela
// enxerta em funcoes de producao (liberar_fidelizacao_caso, trg_impor_teto_operador,
// acoes_massivas_universo, assumir_caso_livre) sao patches ancorados: a
// verificacao delas esta no teste estrutural e na conferencia das ancoras
// contra producao, feita em 16/10 (1 ocorrencia de cada, nenhuma ja patchada).
//
// NENHUM DADO REAL: tudo inventado.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIG = readFileSync(
  resolve(RAIZ, "supabase/migrations/20261016190000_giro_carteiras_2026_1_2026_2.sql"),
  "utf8",
);

const trecho = (re, nome) => {
  const m = MIG.match(re);
  if (!m) throw new Error(`trecho nao encontrado na migration: ${nome}`);
  return m[0];
};

const FN_PREDICADO = trecho(
  /create or replace function public\.caso_em_giro_fidelizacao[\s\S]*?\$\$;/,
  "caso_em_giro_fidelizacao",
);
const FN_GATILHO = trecho(
  /create or replace function public\.giro_limpar_marca_ao_trocar_dono[\s\S]*?\$\$;/,
  "giro_limpar_marca_ao_trocar_dono",
);
const DDL_GATILHO = trecho(
  /drop trigger if exists trg_giro_limpar_marca[\s\S]*?giro_limpar_marca_ao_trocar_dono\(\);/,
  "trg_giro_limpar_marca",
);

async function bancada() {
  const db = new PGlite();
  // Duble minimo de public.casos: so as colunas que estas regras tocam.
  await db.exec(`
    create table public.casos (
      id uuid primary key default gen_random_uuid(),
      operador_email text,
      operador_nome text,
      data_ultimo_acionamento date,
      giro_fidelizacao_ate date
    );
  `);
  await db.exec(FN_PREDICADO);
  await db.exec(FN_GATILHO);
  await db.exec(DDL_GATILHO);
  return db;
}

const hojeBrt = async (db) =>
  (await db.query(`select (now() at time zone 'America/Sao_Paulo')::date as d`)).rows[0].d;

const predicado = async (db, valor) =>
  (await db.query(`select public.caso_em_giro_fidelizacao($1::date) as v`, [valor])).rows[0].v;

const criarCaso = async (db, dono, ate) =>
  (
    await db.query(
      `insert into public.casos (operador_email, giro_fidelizacao_ate)
       values ($1, $2::date) returning id`,
      [dono, ate],
    )
  ).rows[0].id;

// Como TEXTO, do lado do banco: o driver devolve Date e qualquer comparacao em
// JS passaria pelo fuso local, trocando 31/12 por 30/12 as 21:00.
const marca = async (db, id) =>
  (
    await db.query(
      `select to_char(giro_fidelizacao_ate, 'YYYY-MM-DD') as ate from public.casos where id = $1`,
      [id],
    )
  ).rows[0].ate;

describe("a protecao do giro encerra sozinha no dia seguinte a data marcada", () => {
  it("vale no proprio dia da data e deixa de valer no dia seguinte", async () => {
    const db = await bancada();
    const hoje = await hojeBrt(db);

    // A data de hoje ainda protege: a fronteira e inclusiva, como pedido
    // ("fidelizados ate 26/10/2026, inclusive").
    expect(await predicado(db, hoje)).toBe(true);

    // Ontem ja nao protege -- e exatamente o que acontece com 2026-10-26 no
    // dia 27: nenhuma rotina precisa rodar para a protecao cair.
    const ontem = new Date(hoje);
    ontem.setDate(ontem.getDate() - 1);
    expect(await predicado(db, ontem.toISOString().slice(0, 10))).toBe(false);

    // Amanha protege.
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);
    expect(await predicado(db, amanha.toISOString().slice(0, 10))).toBe(true);
  });

  it("caso sem marca nunca esta protegido", async () => {
    const db = await bancada();
    expect(await predicado(db, null)).toBe(false);
  });

  it("usa a data de Brasilia, nao a do banco em UTC", async () => {
    const db = await bancada();
    // O banco roda em UTC e current_date vira o dia seguinte as 21:00 BRT. Se a
    // funcao usasse current_date, no fim da tarde ela encerraria a protecao um
    // dia antes. Aqui a prova e direta: o limite e a data de Sao Paulo.
    const { rows } = await db.query(`
      select (now() at time zone 'America/Sao_Paulo')::date as brt, current_date as utc
    `);
    expect(await predicado(db, rows[0].brt)).toBe(true);
    // Em qualquer instante, a data de Brasilia e a de UTC ou a anterior; a
    // funcao segue a de Brasilia nos dois casos.
    const def = (await db.query(
      `select pg_get_functiondef('public.caso_em_giro_fidelizacao(date)'::regprocedure) as d`,
    )).rows[0].d;
    expect(def).toContain("America/Sao_Paulo");
    expect(def).not.toMatch(/>=\s*current_date/);
  });
});

describe("quem assume um caso do giro devolve ele a regra normal", () => {
  it("trocar de dono limpa a marca", async () => {
    const db = await bancada();
    const id = await criarCaso(db, "a@x.com", "2026-10-26");

    await db.query(`update public.casos set operador_email = $1 where id = $2`, ["b@x.com", id]);

    expect(await marca(db, id)).toBeNull();
  });

  it("manter o mesmo dono nao limpa a marca", async () => {
    const db = await bancada();
    const id = await criarCaso(db, "a@x.com", "2026-10-26");

    await db.query(`update public.casos set operador_nome = 'A' where id = $1`, [id]);

    expect(await marca(db, id)).not.toBeNull();
  });

  it("soltar o caso (dono para null) nao limpa a marca", async () => {
    const db = await bancada();
    const id = await criarCaso(db, "a@x.com", "2026-10-26");

    // Nao deveria acontecer -- a guarda em liberar_fidelizacao_caso recusa --,
    // mas se acontecer por outro caminho a marca tem de sobreviver, senao o
    // caso perderia a protecao justamente ao ser solto.
    await db.query(`update public.casos set operador_email = null where id = $1`, [id]);

    expect(await marca(db, id)).not.toBeNull();
  });

  it("um giro novo que troca o dono E grava a marca nao se auto-apaga", async () => {
    const db = await bancada();
    const id = await criarCaso(db, "a@x.com", "2026-10-26");

    // E o caso de um segundo giro: o mesmo UPDATE troca o dono e poe a marca
    // nova. Sem a guarda, o gatilho apagaria a marca que o giro acabou de por.
    await db.query(
      `update public.casos set operador_email = $1, giro_fidelizacao_ate = $2::date where id = $3`,
      ["b@x.com", "2026-12-31", id],
    );

    expect(await marca(db, id)).toBe("2026-12-31");
  });
});
