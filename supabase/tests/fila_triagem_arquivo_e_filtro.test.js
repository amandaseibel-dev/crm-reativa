// FILTRO POR ARQUIVO NA FILA DA TRIAGEM — num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (20261023190000) e o ROLLBACK REAL sobre a mesma
// cadeia do teste da #746: bancada da rodada incremental (21/10) + o cenário
// da conferência por arquivo + a migration da triagem da #737 (20261023000700).
//
// POR QUE ESTE ARQUIVO EXISTE. A mudança tem três afirmações que só um banco
// de verdade prova, e que a gestão pediu confirmadas:
//
//   1. as chamadas que já existem continuam funcionando SEM informar
//      `p_importacao_id` -- inclusive as posicionais de 2 argumentos que o
//      teste da #737 usa;
//   2. o filtro combina arquivo E categoria, em vez de um anular o outro;
//   3. as permissões e a decisão manual na fila seguem como estavam.
//
// A terceira é a que mais importa: a migration faz `drop` antes do `create`
// (a assinatura muda), e `drop` LEVA OS GRANTS. Se a reposição falhasse, a
// tela pararia de carregar para quem não é dono do banco -- e nenhum teste de
// texto pegaria isso.
//
// ESCOPO DECLARADO. NÃO se prova número de produção: a base é sintética. As
// medições de 23/10/2026 estão no cabeçalho da migration, com as consultas.
// NÃO há regra financeira nova: a função LÊ, e o teste de ausência de escrita
// abaixo é o que fixa isso.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que
// a executa, num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const BANCADA = ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.sql");
const CENARIO = ler("supabase/tests/fixtures/importacao_conferencia_cenario.sql");
const TRIAGEM = ler("supabase/migrations/20261023000700_fila_pagamento_triagem.sql");
const MIGRATION = ler("supabase/migrations/20261023190000_fila_triagem_arquivo_e_filtro.sql");
const ROLLBACK = ler("supabase/rollbacks/20261023190000_fila_triagem_arquivo_e_filtro.rollback.sql");

const semTransacao = (sql) => sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

const ARQ_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const ARQ_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const GESTAO = "amanda.seibel@aelbra.com.br";

let db;
const q1 = async (sql) => (await db.query(sql)).rows[0];
const comoGestao = () =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"${GESTAO}"}', false)`);
const comoOperador = () =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"cobranca05@aelbra.com.br"}', false)`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  // O CENARIO vem ANTES da triagem, pelo mesmo motivo do teste da #746: ele
  // acrescenta as colunas que a view da #737 le e que a bancada base nao tem.
  await db.exec(CENARIO);
  await db.exec(semTransacao(TRIAGEM));
  await db.exec(semTransacao(MIGRATION));
  await comoGestao();
});

describe("1. as chamadas que já existem continuam funcionando", () => {
  it("a chamada POSICIONAL de 2 argumentos ainda resolve", async () => {
    // E a forma que o teste da #737 usa: `fila_pagamento_triagem_ler(null, 1000)`.
    const r = await q1("select count(*)::int as n from public.fila_pagamento_triagem_ler(null, 1000)");
    expect(r.n).toBeGreaterThan(0);
  });

  it("a chamada por NOME só com categoria e limite resolve", async () => {
    // E a forma que a tela usa hoje, antes de qualquer deploy novo.
    const r = await q1(
      "select count(*)::int as n from public.fila_pagamento_triagem_ler(p_categoria => null, p_limite => 1000)",
    );
    expect(r.n).toBeGreaterThan(0);
  });

  it("existe UMA só função -- sem overload, logo sem ambiguidade", async () => {
    // Se a migration usasse `create or replace` sem o `drop`, haveria DUAS, e
    // a chamada por nome acima ficaria ambigua entre elas.
    const r = await q1(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fila_pagamento_triagem_ler'`,
    );
    expect(r.n).toBe(1);
  });

  it("a assinatura de 2 argumentos não existe mais; a de 3 existe", async () => {
    const r = await q1(
      `select to_regprocedure('public.fila_pagamento_triagem_ler(text,integer)') is null as antiga_sumiu,
              to_regprocedure('public.fila_pagamento_triagem_ler(text,integer,uuid)') is not null as nova_existe`,
    );
    expect(r.antiga_sumiu).toBe(true);
    expect(r.nova_existe).toBe(true);
  });

  it("devolve as duas colunas novas, com o arquivo preenchido", async () => {
    const r = await q1(
      `select count(*)::int as n,
              count(arquivo_nome)::int as com_arquivo,
              count(distinct importacao_id)::int as arquivos
         from public.fila_pagamento_triagem_ler(null, 1000)`,
    );
    expect(r.n).toBeGreaterThan(0);
    expect(r.com_arquivo).toBeGreaterThan(0);
    expect(r.arquivos).toBeGreaterThan(0);
  });

  it("o join é 1:1 -- não multiplica linha", async () => {
    // `fila_pag_sem_vinculo_unico UNIQUE (pagamento_id)` e o que garante isso.
    const r = await q1(
      `select (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000)) as com_join,
              (select count(*)::int from public.vw_fila_pagamento_triagem) as na_view`,
    );
    expect(r.com_join).toBe(r.na_view);
  });
});

describe("2. o filtro combina arquivo e categoria", () => {
  // A BANCADA DA #746 TEM TODAS AS LINHAS DE FILA NUM ARQUIVO SO (arquivo-A).
  // Com um arquivo unico, filtrar por ele devolve tudo -- e um teste que
  // "passa" sem provar nada, porque o resultado seria o mesmo se o filtro
  // fosse ignorado. Entao este bloco CONSTROI a condicao que quer provar:
  // move exatamente UMA pendencia para um segundo arquivo que ja existe em
  // `importacoes` (arquivo-B). Dai em diante, filtro que nao discrimina falha.
  let idMovido;
  let totalComArquivo;
  beforeAll(async () => {
    const alvo = await q1(
      `select t.pagamento_id, f.id
         from public.vw_fila_pagamento_triagem t
         join public.fila_pagamento_sem_vinculo f on f.pagamento_id = t.pagamento_id
        where f.importacao_id = '${ARQ_A}'::uuid and f.id <> 2
        order by f.id desc limit 1`,
    );
    idMovido = alvo.id;
    await db.query(
      `update public.fila_pagamento_sem_vinculo
          set importacao_id = '${ARQ_B}'::uuid, arquivo_nome = 'arquivo-B.xlsx'
        where id = ${idMovido}`,
    );
    const t = await q1(
      `select count(*)::int as n from public.fila_pagamento_triagem_ler(null, 5000)
        where importacao_id is not null`,
    );
    totalComArquivo = t.n;
  });

  it("filtrar por arquivo ENCOLHE o resultado", async () => {
    const r = await q1(
      `select (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000)) as todos,
              (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_A}')) as do_a,
              (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_B}')) as do_b`,
    );
    expect(r.do_a).toBeGreaterThan(0);
    expect(r.do_b).toBe(1);
    expect(r.do_a).toBeLessThan(r.todos);
    expect(r.do_b).toBeLessThan(r.todos);
    // Os dois arquivos particionam o universo que TEM arquivo: nada se perde
    // nem se conta duas vezes no recorte.
    expect(r.do_a + r.do_b).toBe(totalComArquivo);
  });

  it("toda linha do recorte é daquele arquivo -- nenhuma estranha entra", async () => {
    const r = await q1(
      `select count(*)::int as fora
         from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_A}')
        where importacao_id is distinct from '${ARQ_A}'::uuid`,
    );
    expect(r.fora).toBe(0);
  });

  it("OS PARÊNTESES: com categoria nula o filtro de arquivo NÃO é ignorado", async () => {
    // Esta e a armadilha. Sem os parenteses, `A or B and C` liga como
    // `A or (B and C)`: com `p_categoria` nulo a condicao inteira viraria TRUE
    // e o recorte devolveria a fila inteira, em silencio.
    const r = await q1(
      `select (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000)) as todos,
              (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_B}')) as recorte`,
    );
    expect(r.recorte).toBe(1);
    expect(r.recorte).not.toBe(r.todos);
  });

  it("arquivo E categoria juntos recortam MAIS que arquivo só", async () => {
    const cat = await q1(
      `select categoria from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_A}')
        group by categoria order by count(*) desc limit 1`,
    );
    const r = await q1(
      `select (select count(*)::int from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_A}')) as so_arquivo,
              (select count(*)::int from public.fila_pagamento_triagem_ler('${cat.categoria}', 5000, '${ARQ_A}')) as arquivo_e_cat`,
    );
    expect(r.arquivo_e_cat).toBeGreaterThan(0);
    expect(r.arquivo_e_cat).toBeLessThanOrEqual(r.so_arquivo);
    const soCat = await q1(
      `select count(*)::int as n from public.fila_pagamento_triagem_ler('${cat.categoria}', 5000)`,
    );
    // A interseccao nunca e maior que nenhum dos dois lados.
    expect(r.arquivo_e_cat).toBeLessThanOrEqual(soCat.n);
  });

  it("arquivo inexistente devolve zero, não a fila inteira", async () => {
    const r = await q1(
      `select count(*)::int as n
         from public.fila_pagamento_triagem_ler(null, 5000, '00000000-0000-0000-0000-000000000000')`,
    );
    expect(r.n).toBe(0);
  });
});

describe("3. permissões e decisão manual preservadas", () => {
  it("authenticated tem EXECUTE na assinatura NOVA -- o drop levou o grant e ele foi reposto", async () => {
    const r = await q1(
      `select has_function_privilege('authenticated',
         'public.fila_pagamento_triagem_ler(text,integer,uuid)','EXECUTE') as pode`,
    );
    expect(r.pode).toBe(true);
  });

  it("service_role tem EXECUTE", async () => {
    const r = await q1(
      `select has_function_privilege('service_role',
         'public.fila_pagamento_triagem_ler(text,integer,uuid)','EXECUTE') as pode`,
    );
    expect(r.pode).toBe(true);
  });

  it("o portão segue de pé: operador é recusado com 42501", async () => {
    await comoOperador();
    await expect(db.query("select * from public.fila_pagamento_triagem_ler(null, 10)")).rejects.toThrow(
      /gestao financeira/i,
    );
    await comoGestao();
  });

  it("a função não escreve -- nenhum DML no corpo", async () => {
    const r = await q1(
      `select p.prosrc ~* '\\m(insert|update|delete|truncate)\\M' as tem_escrita
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fila_pagamento_triagem_ler'`,
    );
    expect(r.tem_escrita).toBe(false);
  });

  it("ler a fila não altera decisão, conclusão nem contagem", async () => {
    // O snapshot e tirado AQUI, depois da mutacao de arquivo do bloco 2: o que
    // se prova e que LER nao muda nada, nao que o estado seja o inicial.
    const impressao = `select count(*)::int as linhas,
             md5(coalesce(string_agg(
               id::text || coalesce(decisao,'-') || coalesce(conclusao,'-') ||
               coalesce(decidido_por,'-') || coalesce(importacao_id::text,'-'),
               '|' order by id), '')) as digital
        from public.fila_pagamento_sem_vinculo`;
    const antes = await q1(impressao);
    await db.query("select * from public.fila_pagamento_triagem_ler(null, 5000)");
    await db.query(`select * from public.fila_pagamento_triagem_ler(null, 5000, '${ARQ_A}')`);
    const depois = await q1(impressao);
    expect(depois.linhas).toBe(antes.linhas);
    expect(depois.digital).toBe(antes.digital);
  });

  it("a linha JÁ DECIDIDA continua decidida e com a mesma conclusão", async () => {
    // P2 do cenario: fila resolvida, com `conclusao`. A migration nao pode
    // reabrir nem reescrever decisao de ninguem.
    const r = await q1(
      `select decisao, conclusao from public.fila_pagamento_sem_vinculo where id = 2`,
    );
    expect(r.conclusao).toBe("RESOLVIDO");
  });
});

describe("4. o rollback", () => {
  it("devolve a assinatura de 2 argumentos e deixa a fila intacta", async () => {
    const impressao = `select count(*)::int as linhas,
             md5(coalesce(string_agg(id::text || coalesce(decisao,'-') || coalesce(conclusao,'-'),
               '|' order by id), '')) as digital
        from public.fila_pagamento_sem_vinculo`;
    const antes = await q1(impressao);

    await db.exec(semTransacao(ROLLBACK));

    const assinaturas = await q1(
      `select to_regprocedure('public.fila_pagamento_triagem_ler(text,integer)') is not null as antiga,
              to_regprocedure('public.fila_pagamento_triagem_ler(text,integer,uuid)') is null as nova_sumiu,
              (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'fila_pagamento_triagem_ler') as quantas`,
    );
    expect(assinaturas.antiga).toBe(true);
    expect(assinaturas.nova_sumiu).toBe(true);
    expect(assinaturas.quantas).toBe(1);

    const depois = await q1(impressao);
    expect(depois.linhas).toBe(antes.linhas);
    expect(depois.digital).toBe(antes.digital);
  });

  it("depois do rollback a chamada antiga volta a funcionar, com os grants", async () => {
    await comoGestao();
    const r = await q1("select count(*)::int as n from public.fila_pagamento_triagem_ler(null, 1000)");
    expect(r.n).toBeGreaterThan(0);
    const g = await q1(
      `select has_function_privilege('authenticated',
         'public.fila_pagamento_triagem_ler(text,integer)','EXECUTE') as pode`,
    );
    expect(g.pode).toBe(true);
  });
});
