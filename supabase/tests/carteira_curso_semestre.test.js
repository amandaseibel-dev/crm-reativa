// MINHA CARTEIRA: CURSO E SEMESTRE — num PostgreSQL real (PGlite).
//
// ESTE ARQUIVO EXISTE POR CAUSA DE UM ERRO QUE CHEGOU A PRODUCAO.
//
// A migration 20261023183000 foi aplicada em 2026-10-23 e a funcao falhava em
// TODA chamada com `42702: column reference "aluno_id" is ambiguous`. Os 26
// testes da #741 sao JavaScript puro sobre os helpers e nunca executam o SQL,
// entao nada pegou. A disciplina de rodar a migration em PGlite foi adotada na
// #748 e nao tinha sido aplicada aqui.
//
// O teste roda a MIGRATION ORIGINAL, prova que ela quebra, roda a CORRECAO e
// prova que passa a funcionar. A ordem importa: sem o primeiro passo, este
// arquivo nao demonstraria que teria pego o defeito.
//
// ESCOPO DECLARADO. Os numeros sao da bancada sintetica
// (fixtures/carteira_curso_semestre_cenario.sql), ESCOLHIDOS para que cada
// total seja conferivel a mao -- nao sao medicoes de producao. Nenhuma regra
// financeira nova: a funcao LE, e o teste de ausencia de escrita fixa isso.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const CENARIO = ler("supabase/tests/fixtures/carteira_curso_semestre_cenario.sql");
const ORIGINAL = ler("supabase/migrations/20261023183000_carteira_filtro_curso_semestre.sql");
const CORRECAO = ler("supabase/migrations/20261023213000_carteira_curso_semestre_corrige_ambiguidade.sql");
const ROLLBACK = ler("supabase/rollbacks/20261023213000_carteira_curso_semestre_corrige_ambiguidade.rollback.sql");

const semTransacao = (sql) => sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

const GERENTE = "gerente@aelbra.com.br";
const OP1 = "op1@aelbra.com.br";
const OP2 = "op2@aelbra.com.br";

let db;
const q1 = async (sql) => (await db.query(sql)).rows[0];
const todas = async (sql) => (await db.query(sql)).rows;
const como = (email) =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"${email}"}', false)`);
const semIdentidade = () => db.exec(`select set_config('request.jwt.claims', '{}', false)`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(CENARIO);
  await db.exec(semTransacao(ORIGINAL));
});

describe("0. a migration original quebra -- e por isso este teste existe", () => {
  it("a funcao recem-criada falha com 42702 em toda chamada", async () => {
    await como(OP1);
    await expect(
      db.query("select * from public.carteira_curso_semestre_do_operador()"),
    ).rejects.toThrow(/ambiguous/i);
  });

  it("mas `curso_cobranca_alvo` funciona desde a original", async () => {
    const r = await q1(`select public.curso_cobranca_alvo('MEDICINA') m,
                               public.curso_cobranca_alvo('BIOMEDICINA') b`);
    expect(r.m).toBe("Medicina");
    expect(r.b).toBeNull();
  });
});

describe("1. depois da correcao, a funcao INTEIRA roda", () => {
  beforeAll(async () => {
    await db.exec(semTransacao(CORRECAO));
    await como(OP1);
  });

  it("executa e devolve as 6 fichas do operador", async () => {
    const r = await q1("select count(*)::int n from public.carteira_curso_semestre_do_operador()");
    expect(r.n).toBe(6);
  });

  it("`curso_cobranca_alvo` continua intacta -- a correcao nao a tocou", async () => {
    const r = await q1(`select public.curso_cobranca_alvo('MEDICINA VETERINÁRIA  INT/NOT') v,
                               public.curso_cobranca_alvo('ODONTOLOGIA.') o,
                               public.curso_cobranca_alvo('BIOMEDICINA') b,
                               public.curso_cobranca_alvo('DIREITO') d`);
    expect(r.v).toBe("Medicina Veterinária");
    expect(r.o).toBe("Odontologia");
    expect(r.b).toBeNull();
    expect(r.d).toBeNull();
  });
});

describe("2. o filtro de CURSO, por janela de semestre", () => {
  beforeAll(() => como(OP1));

  it("Medicina em 2026/1 pega as tres fichas certas", async () => {
    const r = await todas(`select aluno_id from public.carteira_curso_semestre_do_operador()
                            where curso_2026_1 = 'Medicina' order by aluno_id`);
    expect(r.length).toBe(3); // A1, A3, A6
  });

  it("quem TROCOU de curso aparece com o curso de cada janela", async () => {
    const r = await q1(`select curso_2026_1, curso_2026_2
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a3333333-0000-0000-0000-000000000003'`);
    expect(r.curso_2026_1).toBe("Medicina");
    expect(r.curso_2026_2).toBe("Odontologia");
  });

  it("BIOMEDICINA nao e Medicina -- a ficha fica sem curso-alvo nas duas janelas", async () => {
    const r = await q1(`select curso_2026_1, curso_2026_2
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a4444444-0000-0000-0000-000000000004'`);
    expect(r.curso_2026_1).toBeNull();
    expect(r.curso_2026_2).toBeNull();
  });

  it("contrato FORA das duas janelas nao vira curso de 2026", async () => {
    // A1 tem um contrato de Odontologia com valid_from em 2025.
    const r = await q1(`select curso_2026_1, curso_2026_2
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a1111111-0000-0000-0000-000000000001'`);
    expect(r.curso_2026_1).toBe("Medicina");
    expect(r.curso_2026_2).toBe("Medicina");
  });
});

describe("3. o SEMESTRE sai da competencia do titulo", () => {
  beforeAll(() => como(OP1));

  it("ficha com mensalidade nos DOIS semestres traz os dois valores", async () => {
    const r = await q1(`select titulos_2026_1, saldo_2026_1, titulos_2026_2, saldo_2026_2
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a3333333-0000-0000-0000-000000000003'`);
    expect(r.titulos_2026_1).toBe(1);
    expect(Number(r.saldo_2026_1)).toBe(300);
    expect(r.titulos_2026_2).toBe(1);
    expect(Number(r.saldo_2026_2)).toBe(200);
  });

  it("titulo preso em acordo CANCELADO continua sendo mensalidade", async () => {
    // A1: 1000001 (1.000) + 1000008 (400), este com vinculo a acordo cancelado.
    const r = await q1(`select titulos_2026_1, saldo_2026_1
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a1111111-0000-0000-0000-000000000001'`);
    expect(r.titulos_2026_1).toBe(2);
    expect(Number(r.saldo_2026_1)).toBe(1400);
  });

  it("titulo que virou acordo VIVO sai da mensalidade e vira parcela", async () => {
    const r = await q1(`select saldo_2026_1, acordo_saldo_2026_1
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a4444444-0000-0000-0000-000000000004'`);
    expect(Number(r.saldo_2026_1)).toBe(0);
    expect(Number(r.acordo_saldo_2026_1)).toBe(2500);
  });

  it("parcela de acordo SEM titulo vai para indeterminado, nunca para um semestre", async () => {
    const r = await q1(`select acordo_saldo_2026_1, acordo_saldo_2026_2,
                               acordo_outros_semestres, acordo_indeterminado
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a5555555-0000-0000-0000-000000000005'`);
    expect(Number(r.acordo_saldo_2026_1)).toBe(0);
    expect(Number(r.acordo_saldo_2026_2)).toBe(0);
    expect(Number(r.acordo_outros_semestres)).toBe(0);
    expect(Number(r.acordo_indeterminado)).toBe(7000);
  });

  it("2025 e titulo sem serie ficam nos baldes proprios, fora de 2026", async () => {
    const r = await q1(`select saldo_2026_1, saldo_2026_2, saldo_outros_semestres,
                               saldo_sem_serie, acordo_outros_semestres
                          from public.carteira_curso_semestre_do_operador()
                         where aluno_id = 'a6666666-0000-0000-0000-000000000006'`);
    expect(Number(r.saldo_2026_1)).toBe(0);
    expect(Number(r.saldo_2026_2)).toBe(0);
    expect(Number(r.saldo_outros_semestres)).toBe(3100);
    expect(Number(r.saldo_sem_serie)).toBe(250);
    expect(Number(r.acordo_outros_semestres)).toBe(1800);
  });

  it("parcela PAGA e parcela de acordo cancelado nao entram em conta nenhuma", async () => {
    const r = await q1(`select round(sum(acordo_saldo_2026_1 + acordo_saldo_2026_2
                                       + acordo_outros_semestres + acordo_indeterminado),2) total
                          from public.carteira_curso_semestre_do_operador()`);
    // 2.500 (A4) + 7.000 (A5) + 1.800 (A6). A paga de 900 e a de acordo
    // cancelado de 50 ficam de fora.
    expect(Number(r.total)).toBe(11300);
  });
});

describe("4. a linha FECHA -- nada sai da RPC em silencio", () => {
  beforeAll(() => como(OP1));

  it("mensalidade: as quatro colunas somam o total da carteira", async () => {
    const r = await q1(`select round(sum(saldo_2026_1 + saldo_2026_2
                                       + saldo_outros_semestres + saldo_sem_serie),2) soma
                          from public.carteira_curso_semestre_do_operador()`);
    // 1.400 + 300 (2026/1) + 500 + 200 (2026/2) + 3.100 (2025/2) + 250 (sem serie)
    expect(Number(r.soma)).toBe(5750);
  });

  it("fecha linha a linha, nao so no agregado", async () => {
    const linhas = await todas(`
      select aluno_id,
             round(saldo_2026_1 + saldo_2026_2 + saldo_outros_semestres + saldo_sem_serie, 2) mens,
             round(acordo_saldo_2026_1 + acordo_saldo_2026_2
                 + acordo_outros_semestres + acordo_indeterminado, 2) acordo
        from public.carteira_curso_semestre_do_operador()`);
    expect(linhas.length).toBe(6);
    for (const l of linhas) {
      expect(Number(l.mens)).toBeGreaterThanOrEqual(0);
      expect(Number(l.acordo)).toBeGreaterThanOrEqual(0);
    }
    const esperado = { a1111111: 1400, a2222222: 500, a3333333: 500, a4444444: 0, a5555555: 0, a6666666: 3350 };
    for (const l of linhas) {
      expect(Number(l.mens)).toBe(esperado[String(l.aluno_id).split("-")[0]]);
    }
  });

  it("nenhum valor negativo", async () => {
    const r = await q1(`select count(*)::int n from public.carteira_curso_semestre_do_operador()
                         where saldo_2026_1 < 0 or saldo_2026_2 < 0
                            or acordo_saldo_2026_1 < 0 or acordo_saldo_2026_2 < 0
                            or acordo_indeterminado < 0`);
    expect(r.n).toBe(0);
  });
});

describe("5. isolamento da carteira por operador", () => {
  it("OP1 ve as suas 6 e NAO ve a ficha do OP2", async () => {
    await como(OP1);
    const r = await todas("select aluno_id from public.carteira_curso_semestre_do_operador()");
    expect(r.length).toBe(6);
    expect(r.map((x) => String(x.aluno_id))).not.toContain("b1111111-0000-0000-0000-00000000000b");
  });

  it("OP2 ve so a sua", async () => {
    await como(OP2);
    const r = await todas("select aluno_id, saldo_2026_1 from public.carteira_curso_semestre_do_operador()");
    expect(r.length).toBe(1);
    expect(String(r[0].aluno_id)).toBe("b1111111-0000-0000-0000-00000000000b");
    expect(Number(r[0].saldo_2026_1)).toBe(9999);
  });

  it("ficha SEM responsavel nao aparece para ninguem", async () => {
    for (const quem of [OP1, OP2, GERENTE]) {
      await como(quem);
      const r = await q1(`select count(*)::int n from public.carteira_curso_semestre_do_operador()
                           where aluno_id = 'c1111111-0000-0000-0000-00000000000c'`);
      expect(r.n).toBe(0);
    }
  });
});

describe("6. quem nao tem permissao nao le a carteira de outro", () => {
  it("operador pedindo a carteira de OUTRO e recusado com 42501", async () => {
    await como(OP1);
    await expect(
      db.query(`select * from public.carteira_curso_semestre_do_operador('${OP2}')`),
    ).rejects.toThrow(/Acesso negado/i);
  });

  it("operador pedindo a PROPRIA pelo nome e aceito", async () => {
    await como(OP1);
    const r = await q1(`select count(*)::int n from public.carteira_curso_semestre_do_operador('${OP1}')`);
    expect(r.n).toBe(6);
  });

  it("gestao de fila PODE abrir a carteira de um operador", async () => {
    await como(GERENTE);
    const r = await q1(`select count(*)::int n from public.carteira_curso_semestre_do_operador('${OP1}')`);
    expect(r.n).toBe(6);
  });

  it("gestao sem alvo ve a carteira inteira (as 7 com responsavel)", async () => {
    await como(GERENTE);
    const r = await q1("select count(*)::int n from public.carteira_curso_semestre_do_operador()");
    expect(r.n).toBe(7);
  });

  it("sem identidade no token, recusa com 42501 -- nao devolve lista vazia", async () => {
    // O furo classico: `NULL not in (...)` e NULL, nao TRUE, e a guarda passa
    // em silencio. O `coalesce(..., '')` no corpo e o que fecha isso.
    await semIdentidade();
    await expect(
      db.query("select * from public.carteira_curso_semestre_do_operador()"),
    ).rejects.toThrow(/Acesso negado/i);
    await como(OP1);
  });
});

describe("7. a funcao nao escreve", () => {
  it("nenhum DML no corpo", async () => {
    const r = await q1(`select p.prosrc ~* '\\m(insert|update|delete|truncate)\\M' tem_escrita
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname='public' and p.proname='carteira_curso_semestre_do_operador'`);
    expect(r.tem_escrita).toBe(false);
  });

  it("ler nao muda ficha, titulo, acordo nem parcela", async () => {
    const foto = `select (select count(*)::int from public.alunos) a,
                         (select count(*)::int from public.acordos_titulos) t,
                         (select count(*)::int from public.parcelas) p,
                         (select md5(coalesce(string_agg(id::text||coalesce(responsavel_atual_email,'-'),'|' order by id),''))
                            from public.alunos) resp,
                         (select round(coalesce(sum(valor),0),2) from public.parcelas) soma`;
    await como(GERENTE);
    const antes = await q1(foto);
    await db.query("select * from public.carteira_curso_semestre_do_operador()");
    await db.query(`select * from public.carteira_curso_semestre_do_operador('${OP1}')`);
    const depois = await q1(foto);
    expect(depois).toEqual(antes);
  });
});

describe("8. o rollback", () => {
  it("devolve o corpo anterior -- e com ele o 42702", async () => {
    await db.exec(semTransacao(ROLLBACK));
    await como(OP1);
    await expect(
      db.query("select * from public.carteira_curso_semestre_do_operador()"),
    ).rejects.toThrow(/ambiguous/i);
  });

  it("e nao derruba a funcao nem toca `curso_cobranca_alvo`", async () => {
    const r = await q1(`select
        (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='carteira_curso_semestre_do_operador') f1,
        (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='curso_cobranca_alvo') f2,
        public.curso_cobranca_alvo('MEDICINA') m`);
    expect(r.f1).toBe(1);
    expect(r.f2).toBe(1);
    expect(r.m).toBe("Medicina");
  });
});
