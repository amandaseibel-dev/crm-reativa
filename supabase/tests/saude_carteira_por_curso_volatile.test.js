// "POR CURSO" VOLTA A ABRIR.
//
// A tela Saude Completa da Carteira mostrava, no lugar do painel por curso:
//   "DROP TABLE is not allowed in a non-volatile function"
//
// `saude_carteira_por_curso` foi criada STABLE e o corpo faz `drop table` +
// `create temporary table`. O PostgreSQL executa corpo nao-VOLATILE em modo
// somente leitura e recusa. A funcao nunca funcionou.
//
// Este teste roda a migration REAL e o rollback REAL sobre PGlite (PostgreSQL
// de verdade, entao a restricao de volatilidade e a mesma de producao) e prova
// as duas pontas:
//   * com STABLE  -> erro, exatamente o que a tela mostra;
//   * com VOLATILE -> executa e devolve o calculo certo.
//
// E prova que a correcao e SO a volatilidade: o corpo das duas versoes tem o
// mesmo md5 do corpo em producao (3808bbe6d797dcd5494b3e708ede4269).
//
// DADOS FICTICIOS: CPFs, nomes e cursos inventados.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const V = "20261001183000_saude_carteira_por_curso_volatile";
const ler = (d, p) => readFileSync(resolve(AQUI, "..", d, p), "utf8");
const MIGRATION = ler("migrations", `${V}.sql`);
const ROLLBACK = ler("rollbacks", `${V}.rollback.sql`);

const MD5_PRODUCAO = "3808bbe6d797dcd5494b3e708ede4269";
const corpoDe = (sql) => sql.split("as $function$")[1].split("$function$;")[0];

// Esquema minimo que a funcao toca, mais dubles para os dois portoes.
// Os portoes nao sao o objeto deste teste -- a volatilidade e.
const ESQUEMA = `
  create table public.alunos (id uuid primary key, cpf text);
  create table public.mv_saude_carteira (
    aluno_id uuid, saldo_total numeric, encerrado boolean default false,
    estabelecimento text, operador_email text
  );
  create table public.prime_contratos (cpf text, curso text, valid_from date);

  create function public.saude_carteira_escopo(p jsonb) returns jsonb
    language sql stable as $$ select jsonb_build_object('filtros', coalesce(p, '{}'::jsonb)) $$;
  create function public.exigir_capacidade(p text) returns void
    language plpgsql as $$ begin return; end $$;
`;

const AL = (n) => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function banco(versao) {
  const db = await PGlite.create();
  await db.exec(ESQUEMA);
  await db.exec(versao);
  // 3 alunos: dois em Medicina, um em Direito, um sem curso no Prime.
  for (const [i, cpf, curso, saldo] of [
    [1, "11111111111", "Medicina", 10000],
    [2, "22222222222", "Medicina", 6000],
    [3, "33333333333", "Direito", 4000],
    [4, "44444444444", null, 2000],
  ]) {
    await db.query("insert into public.alunos(id,cpf) values ($1,$2)", [AL(i), cpf]);
    await db.query(
      "insert into public.mv_saude_carteira(aluno_id,saldo_total,encerrado) values ($1,$2,false)",
      [AL(i), saldo]
    );
    if (curso) {
      await db.query("insert into public.prime_contratos(cpf,curso,valid_from) values ($1,$2,'2026-01-01')", [cpf, curso]);
    }
  }
  return db;
}

describe("Saúde da Carteira — Por curso só falta a volatilidade", () => {
  let db;
  beforeEach(() => { db = null; });

  it("a correção é SÓ a volatilidade: o corpo é o de produção, byte a byte", () => {
    const mig = corpoDe(MIGRATION);
    const rb = corpoDe(ROLLBACK);
    expect(createHash("md5").update(mig).digest("hex")).toBe(MD5_PRODUCAO);
    expect(createHash("md5").update(rb).digest("hex")).toBe(MD5_PRODUCAO);
    expect(mig).toBe(rb);
    // a unica diferenca entre os dois arquivos esta na declaracao
    expect(MIGRATION).toMatch(/\n volatile security definer\n/);
    expect(ROLLBACK).toMatch(/\n stable security definer\n/);
  });

  it("ANTES (STABLE): falha com o erro exato que aparece na tela", async () => {
    db = await banco(ROLLBACK);
    await expect(db.query("select public.saude_carteira_por_curso('{}'::jsonb)"))
      .rejects.toThrow(/DROP TABLE is not allowed in a non-volatile function/);
  });

  it("DEPOIS (VOLATILE): executa sem erro", async () => {
    db = await banco(MIGRATION);
    const r = await db.query("select public.saude_carteira_por_curso('{}'::jsonb) as j");
    expect(r.rows[0].j).toBeTruthy();
  });

  it("DEPOIS: o retorno traz o cálculo certo, com a mesma lógica", async () => {
    db = await banco(MIGRATION);
    const r = await db.query("select public.saude_carteira_por_curso('{}'::jsonb) as j");
    const j = r.rows[0].j;

    expect(Number(j.total)).toBe(22000);
    const porCurso = Object.fromEntries(j.por_curso.map((x) => [x.curso, x]));

    // Medicina soma os dois alunos; ticket medio = saldo/casos.
    expect(Number(porCurso["Medicina"].casos)).toBe(2);
    expect(Number(porCurso["Medicina"].saldo)).toBe(16000);
    expect(Number(porCurso["Medicina"].ticket_medio)).toBe(8000);
    expect(Number(porCurso["Medicina"].pct_valor)).toBeCloseTo(72.7, 1);

    expect(Number(porCurso["Direito"].saldo)).toBe(4000);
    // quem nao tem contrato no Prime cai no balde nomeado, nao some
    expect(Number(porCurso["Sem curso no Prime"].saldo)).toBe(2000);

    // a soma das linhas reconstroi o total: nenhuma linha se perde
    const soma = j.por_curso.reduce((s, x) => s + Number(x.saldo), 0);
    expect(soma).toBe(Number(j.total));

    expect(j.calculado_em).toBeTruthy();
  });

  it("DEPOIS: os filtros continuam valendo (encerrado fica de fora por padrão)", async () => {
    db = await banco(MIGRATION);
    await db.query("update public.mv_saude_carteira set encerrado = true where aluno_id = $1", [AL(3)]);

    const padrao = (await db.query("select public.saude_carteira_por_curso('{}'::jsonb) as j")).rows[0].j;
    expect(Number(padrao.total)).toBe(18000); // 22000 - Direito

    const comEncerrados = (await db.query(
      `select public.saude_carteira_por_curso('{"incluir_encerrados":true}'::jsonb) as j`
    )).rows[0].j;
    expect(Number(comEncerrados.total)).toBe(22000);
  });

  it("DEPOIS: chamar duas vezes na mesma sessão não quebra na tabela temporária", async () => {
    db = await banco(MIGRATION);
    const a = (await db.query("select public.saude_carteira_por_curso('{}'::jsonb) as j")).rows[0].j;
    const b = (await db.query("select public.saude_carteira_por_curso('{}'::jsonb) as j")).rows[0].j;
    expect(Number(a.total)).toBe(Number(b.total));
    expect(a.por_curso).toEqual(b.por_curso);
  });
});
