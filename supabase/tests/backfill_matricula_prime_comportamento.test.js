// MOTOR DE BACKFILL DA MATRICULA PRIME -- COMPORTAMENTO, nao estrutura.
//
// O arquivo irmao (`backfill_matricula_prime_motor.test.js`) prova o TEXTO da
// migration. Este aqui EXECUTA a migration num Postgres de verdade e observa o
// que ela faz. A separacao existe porque a camada estrutural deixou passar uma
// falha real: remover `and p.matricula is null` do UPDATE nao quebrava nenhum
// teste, e e justamente essa guarda que sustenta a idempotencia.
//
// PGLITE E POSTGRES DE VERDADE -- E NAO SUBSTITUI O SUPABASE.
// PGlite e o proprio PostgreSQL compilado para WebAssembly: mesmo planejador,
// mesmo plpgsql, mesmo `md5`, mesma semantica de transacao. Mas NAO e o
// ambiente de producao: nao tem o schema `auth` (aqui ele e um stub), nao tem
// os papeis reais do Supabase com suas heranças, nao tem PostgREST, RLS de
// producao, extensoes nem concorrencia real. Isto e teste COMPORTAMENTAL, nao
// equivalencia de infraestrutura. A validacao final continua sendo a aplicacao
// no Supabase, sob os olhos de quem autoriza.
//
// NENHUM DADO REAL. Todo UUID, matricula, boleto, nome de pessoa, nome de
// arquivo e hash aqui e inventado. O plano real e o hash do lote nunca entram
// no repositorio -- ver a migration para o porque.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(AQUI, "..", "..",
  "supabase/migrations/20260915140000_backfill_matricula_prime_motor.sql");
const sqlMigration = readFileSync(MIG, "utf8");

// Tamanho do artefato canonico REAL da carga jul+ago/2026, em bytes. E so um
// numero: o artefato em si nunca entra no Git. Serve de PISO para o teste de
// capacidade -- o payload sintetico tem de ser pelo menos deste tamanho.
const TAMANHO_ARTEFATO_REAL = 611283;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOL = (n) => String(590000000000 + n);
const MAT = (n) => String(900000000 + n);
const ARQ = "arquivo sintetico com espaco.xlsx";

const canonizar = (plano) =>
  plano
    .map((r) => [r.pagamento_id, r.numero_parcela_completo, r.matricula,
                 r.arquivo_origem, r.linha_no_arquivo].join("|"))
    .sort()
    .join("\n");
const md5 = (s) => createHash("md5").update(s).digest("hex");

const linha = (n) => ({
  pagamento_id: U(n), numero_parcela_completo: BOL(n), matricula: MAT(n),
  arquivo_origem: ARQ, linha_no_arquivo: n,
});

async function novaBancada() {
  const db = await PGlite.create();
  // ambiente minimo: so os papeis do Supabase. Nao ha stub de `auth`: depois de
  // 15/09 o gate e postgres-only e nao consulta `auth.role()` -- se voltar a
  // consultar, a migration nem aplica aqui, e este teste quebra primeiro.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.pagamentos (
      id uuid primary key, numero_parcela_completo text, matricula text,
      tipo_pagamento text, titulo_numero text, valor_pago numeric,
      data_pagamento date, aluno_nome text, conciliacao_em timestamptz);
  `);
  await db.exec(sqlMigration);          // inclui o bloco DO $prova$

  db.semearPadrao = async () => {
    const insere = (id, bol, mat, tipo, nome, dia) => db.query(
      `insert into public.pagamentos (id,numero_parcela_completo,matricula,
       tipo_pagamento,titulo_numero,valor_pago,data_pagamento,aluno_nome)
       values ($1,$2,$3,$4,'99000',100,$5,$6)`, [id, bol, mat, tipo, dia, nome]);
    for (const n of [1, 2, 3, 4, 5])                    // elegiveis
      await insere(U(n), BOL(n), null, "SANTANDER", `FULANO ${n}`, "2026-07-10");
    await insere(U(6), BOL(6), MAT(6), "SANTANDER", "FULANO 6", "2026-07-10"); // ja tem matricula
    await insere(U(7), BOL(7), null, "SANTANDER", "FULANO 7", "2026-07-10");   // par de
    await insere(U(8), BOL(7), null, "SANTANDER", "FULANO 7", "2026-07-11");   // boleto multiplo
    await insere(U(9), BOL(9), null, "PIX", "FULANO 9", "2026-07-10");         // tipo diferente
    await insere(U(10), BOL(999), null, "SANTANDER", "FULANO 10", "2026-07-10"); // boleto outro
  };
  db.chamar = async (plano, hash, esperado, lote) => {
    try {
      const r = await db.query(
        `select public.backfill_matricula_aplicar($1::jsonb,$2,$3,$4) r`,
        [JSON.stringify(plano), hash, esperado, lote]);
      return { ok: true, valor: r.rows[0].r };
    } catch (e) { return { ok: false, erro: e.message }; }
  };
  db.aplicar = (plano, lote, esperado) =>
    db.chamar(plano, md5(canonizar(plano)), esperado ?? plano.length, lote);
  db.conta = async (tabela, onde = "true") =>
    Number((await db.query(`select count(*) c from ${tabela} where ${onde}`)).rows[0].c);
  // fotografia de TUDO menos matricula -- e assim que se prova que nada mais mudou
  db.fotoOutrosCampos = async () => (await db.query(
    `select md5(string_agg(id::text||'|'||coalesce(numero_parcela_completo,'')||'|'||
       coalesce(tipo_pagamento,'')||'|'||coalesce(titulo_numero,'')||'|'||valor_pago::text||'|'||
       data_pagamento::text||'|'||coalesce(aluno_nome,'')||'|'||coalesce(conciliacao_em::text,''),
       E'\n' order by id::text collate "C")) h from public.pagamentos`)).rows[0].h;
  db.fotoMatriculas = async () => (await db.query(
    `select coalesce(string_agg(id::text||'='||coalesce(matricula,'-'), ','
       order by id::text collate "C"),'') h from public.pagamentos`)).rows[0].h;
  return db;
}

const PLANO_OK = [1, 2, 3, 4, 5].map(linha);

describe("execucao valida", () => {
  let db, antes, r;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    antes = await db.fotoOutrosCampos();
    r = await db.aplicar(PLANO_OK, "LOTE_SINTETICO_A");
  }, 60000);

  it("retorna APLICADO com a contagem certa", () => {
    expect(r.ok).toBe(true);
    expect(r.valor.resultado).toBe("APLICADO");
    expect(r.valor.alteracoes).toBe(5);
  });
  it("grava exatamente 5 matriculas", async () => {
    expect(await db.conta("public.pagamentos",
      `matricula is not null and id <> '${U(6)}'`)).toBe(5);
  });
  it("cada matricula gravada e a do plano", async () => {
    for (const p of PLANO_OK) {
      const v = await db.query(`select matricula from public.pagamentos where id=$1`, [p.pagamento_id]);
      expect(v.rows[0].matricula).toBe(p.matricula);
    }
  });
  it("a trilha tem 5 linhas e 1 lote", async () => {
    expect(await db.conta("public.backfill_matricula_origem")).toBe(5);
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(1);
  });
  it("NENHUM outro campo de pagamentos mudou", async () => {
    expect(await db.fotoOutrosCampos()).toBe(antes);
  });
  it("lote, hash, quantidade e status preservados", async () => {
    const l = (await db.query(`select * from public.backfill_matricula_lotes`)).rows[0];
    expect(l.lote).toBe("LOTE_SINTETICO_A");
    expect(l.artefato_hash).toBe(md5(canonizar(PLANO_OK)));
    expect(l.quantidade_esperada).toBe(5);
    expect(l.quantidade_aplicada).toBe(5);
    expect(l.status).toBe("APLICADO");
  });
  it("procedencia por pagamento: arquivo, linha e boleto", async () => {
    const o = (await db.query(
      `select * from public.backfill_matricula_origem where pagamento_id=$1`, [U(3)])).rows[0];
    expect(o.arquivo_origem).toBe(ARQ);
    expect(o.linha_no_arquivo).toBe(3);
    expect(o.numero_parcela_completo).toBe(BOL(3));
    expect(o.matricula).toBe(MAT(3));
  });
  it("nao toca em quem ja tinha matricula", async () => {
    const v = await db.query(`select matricula from public.pagamentos where id=$1`, [U(6)]);
    expect(v.rows[0].matricula).toBe(MAT(6));
  });
});

describe("idempotencia", () => {
  let db;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    await db.aplicar(PLANO_OK, "LOTE_SINTETICO_A");
  }, 60000);

  it("mesmo lote + mesmo hash: JA_APLICADO, zero mutacao, sem excecao", async () => {
    const fm = await db.fotoMatriculas(), fo = await db.fotoOutrosCampos();
    const r = await db.aplicar(PLANO_OK, "LOTE_SINTETICO_A");
    expect(r.ok).toBe(true);
    expect(r.valor.resultado).toBe("JA_APLICADO");
    expect(r.valor.alteracoes).toBe(0);
    expect(await db.fotoMatriculas()).toBe(fm);
    expect(await db.fotoOutrosCampos()).toBe(fo);
  });
  it("nao duplica trilha nem lote", async () => {
    await db.aplicar(PLANO_OK, "LOTE_SINTETICO_A");
    expect(await db.conta("public.backfill_matricula_origem")).toBe(5);
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(1);
  });
  it("o MESMO plano sob OUTRO nome de lote aborta -- nao regrava", async () => {
    // Risco real: alguem repete a carga trocando so o nome do lote. A protecao
    // do lote nao alcanca esse caso; quem segura e a exigencia de matricula
    // nula, que ja nao vale para linhas gravadas na primeira carga.
    const fm = await db.fotoMatriculas();
    const r = await db.aplicar(PLANO_OK, "LOTE_SINTETICO_B");
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/matricula ja preenchida/);
    expect(await db.fotoMatriculas()).toBe(fm);
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(1);
    expect(await db.conta("public.backfill_matricula_origem")).toBe(5);
  });
  it("mesmo lote + hash diferente: aborta sem mutar", async () => {
    const fm = await db.fotoMatriculas();
    const r = await db.chamar(PLANO_OK, md5("outro artefato qualquer"), 5, "LOTE_SINTETICO_A");
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/outro artefato/);
    expect(await db.fotoMatriculas()).toBe(fm);
    expect(await db.conta("public.backfill_matricula_origem")).toBe(5);
  });
});

describe("cada invariante aborta, e desfaz tudo", () => {
  let db;
  beforeAll(async () => { db = await novaBancada(); await db.semearPadrao(); }, 60000);

  const casos = [
    ["matricula ja preenchida", () => [linha(6)], null, /matricula ja preenchida/],
    ["boleto divergente", () => [{ ...linha(10), numero_parcela_completo: BOL(10) }], null,
      /boleto do pagamento mudou/],
    ["boleto multiplo no banco", () => [linha(7)], null, /boleto multiplo no banco/],
    ["tipo diferente de SANTANDER", () => [linha(9)], null, /fora de tipo_pagamento SANTANDER/],
    ["contagem diferente", () => [linha(1), linha(2)], 99, /esperado 99/],
    ["pagamento inexistente", () => [linha(777)], null, /pagamento inexistente/],
    ["pagamento_id duplicado no plano", () => [linha(1), linha(1)], null, /pagamento_id repetido/],
    ["boleto duplicado no plano", () => [linha(1), { ...linha(2), numero_parcela_completo: BOL(1) }],
      null, /boleto repetido/],
    ["campo obrigatorio nulo", () => [{ ...linha(1), matricula: null }], null,
      /campo obrigatorio nulo/],
  ];

  for (const [nome, montar, esperado, motivo] of casos) {
    it(nome, async () => {
      const plano = montar();
      const fm = await db.fotoMatriculas();
      const fo = await db.fotoOutrosCampos();
      const nOrigem = await db.conta("public.backfill_matricula_origem");
      const nLote = await db.conta("public.backfill_matricula_lotes");

      const r = await db.aplicar(plano, `LOTE_${nome.replace(/\W+/g, "_")}`, esperado);
      expect(r.ok, `${nome} deveria abortar`).toBe(false);
      expect(r.erro).toMatch(motivo);
      expect(await db.fotoMatriculas(), "matriculas mudaram").toBe(fm);
      expect(await db.fotoOutrosCampos(), "outros campos mudaram").toBe(fo);
      expect(await db.conta("public.backfill_matricula_origem")).toBe(nOrigem);
      expect(await db.conta("public.backfill_matricula_lotes")).toBe(nLote);
    });
  }

  it("hash que nao corresponde ao plano", async () => {
    const r = await db.chamar([linha(1)], md5("isto nao e o canonico"), 1, "LOTE_HASH");
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/nao confere com o artefato auditado/);
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(0);
  });
});

describe("UPDATE que afeta menos linhas que o previsto desfaz ate a trilha", () => {
  // Os testes acima abortam ANTES do insert na trilha, entao nao provam nada
  // sobre o UPDATE falhando DEPOIS dela. Aqui um gatilho sabota uma linha: o
  // UPDATE atinge 4 de 5, ROW_COUNT quebra, e a trilha nao pode sobreviver.
  let db, r;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    await db.exec(`
      create function sabota() returns trigger language plpgsql as $$
        begin if new.id = '${U(3)}'::uuid then return null; end if; return new; end $$;
      create trigger tg_sabota before update on public.pagamentos
        for each row execute function sabota();`);
    r = await db.aplicar(PLANO_OK, "LOTE_SABOTADO");
  }, 60000);

  it("levanta excecao citando rollback total", () => {
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/rollback total/);
  });
  it("zero linha na trilha de origem", async () => {
    expect(await db.conta("public.backfill_matricula_origem")).toBe(0);
  });
  it("zero registro de lote", async () => {
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(0);
  });
  it("zero matricula gravada", async () => {
    expect(await db.conta("public.pagamentos", `matricula is not null and id <> '${U(6)}'`)).toBe(0);
  });
});

describe("capacidade e canonicalizacao em escala real", () => {
  const N = 7401;
  let db, plano, canonico, r;
  beforeAll(async () => {
    db = await novaBancada();
    plano = []; const valores = [];
    for (let i = 1; i <= N; i++) {
      plano.push(linha(i));
      valores.push(`('${U(i)}','${BOL(i)}',null,'SANTANDER','99000',100,'2026-07-10')`);
    }
    for (let i = 0; i < valores.length; i += 1000)
      await db.exec(`insert into public.pagamentos
        (id,numero_parcela_completo,matricula,tipo_pagamento,titulo_numero,valor_pago,data_pagamento)
        values ${valores.slice(i, i + 1000).join(",")};`);
    canonico = canonizar(plano);
    // Chaves do JSON EMBARALHADAS de proposito: jsonb reordena chaves, e a
    // canonicalizacao le por nome e reconstroi. Se dependesse da ordem do JSON,
    // o hash calculado no banco nao bateria com o local.
    const embaralhado = plano.map((x) => ({
      linha_no_arquivo: x.linha_no_arquivo, matricula: x.matricula,
      arquivo_origem: x.arquivo_origem,
      numero_parcela_completo: x.numero_parcela_completo, pagamento_id: x.pagamento_id }));
    r = await db.chamar(embaralhado, md5(canonico), N, "LOTE_GRANDE");
  }, 120000);

  it("o payload sintetico e pelo menos do tamanho do artefato real", () => {
    expect(canonico.length).toBeGreaterThanOrEqual(TAMANHO_ARTEFATO_REAL);
  });
  it("o motor aceita o payload inteiro, sem truncar", () => {
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.resultado).toBe("APLICADO");
    expect(r.valor.alteracoes).toBe(N);
  });
  it("a ordem das chaves do JSON nao altera a canonicalizacao", () => {
    expect(r.valor.artefato_hash).toBe(md5(canonico));
  });
  it("a trilha recebe todas as linhas", async () => {
    expect(await db.conta("public.backfill_matricula_origem")).toBe(N);
  });
  it("texto com espaco sobrevive ida e volta", async () => {
    const o = (await db.query(
      `select arquivo_origem, linha_no_arquivo from public.backfill_matricula_origem
        where pagamento_id=$1`, [U(4242)])).rows[0];
    expect(o.arquivo_origem).toBe(ARQ);
    expect(o.linha_no_arquivo).toBe(4242);
  });
});

describe("ACL medida no banco, nao no texto", () => {
  let db;
  beforeAll(async () => { db = await novaBancada(); }, 60000);

  it("a funcao e SECURITY INVOKER", async () => {
    const v = await db.query(`select prosecdef from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='backfill_matricula_aplicar'`);
    expect(v.rows[0].prosecdef).toBe(false);
  });
  it.each(["public", "anon", "authenticated", "service_role"])(
    "%s nao executa a funcao", async (papel) => {
      const v = await db.query(`select has_function_privilege($1,
        'public.backfill_matricula_aplicar(jsonb, text, integer, text)','EXECUTE') x`, [papel]);
      expect(v.rows[0].x).toBe(false);
    });
  it("o gate recusa quem NAO e o dono, mesmo com EXECUTE concedido", async () => {
    // Prova que o gate e uma segunda camada de verdade, e nao so decoracao
    // atras do revoke: concedo EXECUTE a um papel qualquer e mesmo assim a
    // funcao recusa, porque ele nao e postgres.
    await db.exec(`create role papel_de_teste;
      grant execute on function public.backfill_matricula_aplicar(jsonb, text, integer, text)
        to papel_de_teste;`);
    let erro = null;
    try {
      await db.exec(`set role papel_de_teste;
        select public.backfill_matricula_aplicar('[]'::jsonb,'x',1,'L');`);
    } catch (e) { erro = e.message; } finally { await db.exec(`reset role;`); }
    expect(erro).toMatch(/exclusiva do dono \(postgres\)/);
  });
  it.each(["anon", "authenticated"])("%s nao le a trilha", async (papel) => {
    for (const t of ["backfill_matricula_origem", "backfill_matricula_lotes"]) {
      const v = await db.query(`select has_table_privilege($1,$2,'SELECT') x`, [papel, `public.${t}`]);
      expect(v.rows[0].x).toBe(false);
    }
  });
});
