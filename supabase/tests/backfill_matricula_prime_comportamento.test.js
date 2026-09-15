// MOTOR DE BACKFILL DA MATRICULA PRIME -- COMPORTAMENTO, nao estrutura.
//
// O arquivo irmao prova o TEXTO da migration. Este EXECUTA a migration num
// Postgres de verdade e observa o que ela faz. A separacao existe porque a
// camada estrutural ja deixou passar falha real: remover `and p.matricula is
// null` do UPDATE nao quebrava teste nenhum.
//
// PGLITE E POSTGRES DE VERDADE -- E NAO SUBSTITUI O SUPABASE.
// PGlite e o proprio PostgreSQL compilado para WebAssembly: mesmo planejador,
// mesmo plpgsql, mesmo `md5`, mesma semantica de transacao e de lock. Mas NAO e
// producao: nao tem os papeis do Supabase com suas herancas, nem PostgREST, nem
// `auto_explain`, nem VARIAS CONEXOES -- o que limita o teste de concorrencia,
// dito onde ele aparece. Isto e teste COMPORTAMENTAL, nao equivalencia de
// infraestrutura. A validacao final continua sendo a aplicacao no Supabase.
//
// NENHUM DADO REAL. Todo UUID, matricula, boleto, nome e arquivo aqui e
// inventado. O plano real e o hash do lote nunca entram no repositorio.
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
// numero -- o artefato nunca entra no Git. Serve de PISO para a escala.
const TAMANHO_ARTEFATO_REAL = 611283;
// Tamanho de bloco que a Edge usa para carregar a stage. Conservador de
// proposito: o teste de escala mede o tempo por bloco.
const BLOCO = 100;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOL = (n) => String(590000000000 + n);
const MAT = (n) => String(900000000 + n);
const ARQ = "arquivo sintetico com espaco.xlsx";

const canonizar = (plano) =>
  plano.map((r) => [r.pagamento_id, r.numero_parcela_completo, r.matricula,
                    r.arquivo_origem, r.linha_no_arquivo].join("|"))
       .sort().join("\n");
const md5 = (s) => createHash("md5").update(s).digest("hex");
const linha = (n) => ({
  pagamento_id: U(n), numero_parcela_completo: BOL(n), matricula: MAT(n),
  arquivo_origem: ARQ, linha_no_arquivo: n });

async function novaBancada() {
  const db = await PGlite.create();
  // ambiente minimo: so os papeis do Supabase. Nao ha stub de `auth`: o gate e
  // postgres-only e nao consulta `auth.role()`.
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
    for (const n of [1, 2, 3, 4, 5])
      await insere(U(n), BOL(n), null, "SANTANDER", `FULANO ${n}`, "2026-07-10");
    await insere(U(6), BOL(6), MAT(6), "SANTANDER", "FULANO 6", "2026-07-10");
    await insere(U(7), BOL(7), null, "SANTANDER", "FULANO 7", "2026-07-10");
    await insere(U(8), BOL(7), null, "SANTANDER", "FULANO 7", "2026-07-11");
    await insere(U(9), BOL(9), null, "PIX", "FULANO 9", "2026-07-10");
    await insere(U(10), BOL(999), null, "SANTANDER", "FULANO 10", "2026-07-10");
  };
  // TEMPO 1: e isto que a Edge faz -- INSERT em blocos, e nada mais.
  db.carregarStage = async (lote, plano, bloco = BLOCO) => {
    const tempos = [];
    for (let i = 0; i < plano.length; i += bloco) {
      const parte = plano.slice(i, i + bloco);
      const vals = parte.map((r, k) => {
        const b = k * 5;
        return `($1,$${b + 2}::uuid,$${b + 3},$${b + 4},$${b + 5},$${b + 6}::int)`;
      }).join(",");
      const args = [lote];
      for (const r of parte) args.push(r.pagamento_id, r.numero_parcela_completo,
        r.matricula, r.arquivo_origem, r.linha_no_arquivo);
      const t0 = performance.now();
      await db.query(`insert into public.backfill_matricula_stage
        (lote,pagamento_id,numero_parcela_completo,matricula,arquivo_origem,linha_no_arquivo)
        values ${vals} on conflict (lote, pagamento_id) do nothing`, args);
      tempos.push(performance.now() - t0);
    }
    return tempos;
  };
  // TEMPO 2: so lote, hash e contagem. Nenhum dado como parametro.
  db.aplicar = async (lote, hash, esperado) => {
    try {
      const r = await db.query(
        `select public.backfill_matricula_aplicar($1,$2,$3) r`, [lote, hash, esperado]);
      return { ok: true, valor: r.rows[0].r };
    } catch (e) { return { ok: false, erro: e.message }; }
  };
  db.conta = async (tabela, onde = "true") =>
    Number((await db.query(`select count(*) c from ${tabela} where ${onde}`)).rows[0].c);
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
const HASH_OK = md5(canonizar(PLANO_OK));

describe("tempo 2: aplicacao valida", () => {
  let db, antes, r;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    await db.carregarStage("LOTE_A", PLANO_OK);
    antes = await db.fotoOutrosCampos();
    r = await db.aplicar("LOTE_A", HASH_OK, 5);
  }, 60000);

  it("retorna APLICADO com a contagem certa", () => {
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.resultado).toBe("APLICADO");
    expect(r.valor.alteracoes).toBe(5);
  });
  it("grava exatamente as 5 matriculas do plano", async () => {
    for (const p of PLANO_OK) {
      const v = await db.query(`select matricula from public.pagamentos where id=$1`,
        [p.pagamento_id]);
      expect(v.rows[0].matricula).toBe(p.matricula);
    }
    expect(await db.conta("public.pagamentos",
      `matricula is not null and id <> '${U(6)}'`)).toBe(5);
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
    expect(l.lote).toBe("LOTE_A");
    expect(l.artefato_hash).toBe(HASH_OK);
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
  });
  it("A STAGE FOI LIMPA, e so a do lote aplicado", async () => {
    expect(await db.conta("public.backfill_matricula_stage", `lote='LOTE_A'`)).toBe(0);
  });
  it("nao toca em quem ja tinha matricula", async () => {
    const v = await db.query(`select matricula from public.pagamentos where id=$1`, [U(6)]);
    expect(v.rows[0].matricula).toBe(MAT(6));
  });
});

describe("a stage so e limpa no SUCESSO", () => {
  let db;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    await db.carregarStage("LOTE_FALHA", [linha(6)]);   // 6 ja tem matricula
  }, 60000);

  it("a aplicacao falha", async () => {
    const r = await db.aplicar("LOTE_FALHA", md5(canonizar([linha(6)])), 1);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/matricula ja preenchida/);
  });
  it("as linhas da stage PERMANECEM, para diagnostico e reexecucao", async () => {
    expect(await db.conta("public.backfill_matricula_stage", `lote='LOTE_FALHA'`)).toBe(1);
  });
  it("e nada foi gravado na trilha", async () => {
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(0);
    expect(await db.conta("public.backfill_matricula_origem")).toBe(0);
  });
});

describe("integridade da stage", () => {
  let db;
  beforeAll(async () => { db = await novaBancada(); await db.semearPadrao(); }, 60000);

  it("carga duplicada nao cria linha repetida", async () => {
    await db.carregarStage("LOTE_DUP", PLANO_OK);
    await db.carregarStage("LOTE_DUP", PLANO_OK);   // a Edge reenviou o bloco
    await db.carregarStage("LOTE_DUP", PLANO_OK);
    expect(await db.conta("public.backfill_matricula_stage", `lote='LOTE_DUP'`)).toBe(5);
    const r = await db.aplicar("LOTE_DUP", HASH_OK, 5);
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.alteracoes).toBe(5);
  });
  it("stage com DOIS lotes: aplicar um nao encosta no outro", async () => {
    // Estado normal do desenho: um lote que falhou fica na stage para
    // diagnostico. Se o UPDATE nao filtrasse por lote, aplicar LOTE_X
    // gravaria tambem as matriculas do lote vizinho.
    const db2 = await novaBancada(); await db2.semearPadrao();
    const loteX = [linha(1), linha(2)];
    const loteY = [linha(3), linha(4), linha(5)];
    await db2.carregarStage("LOTE_X", loteX);
    await db2.carregarStage("LOTE_Y", loteY);
    const r = await db2.aplicar("LOTE_X", md5(canonizar(loteX)), 2);
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.alteracoes).toBe(2);
    // os do LOTE_Y continuam intocados
    for (const p of loteY) {
      const v = await db2.query(`select matricula from public.pagamentos where id=$1`,
        [p.pagamento_id]);
      expect(v.rows[0].matricula, `${p.pagamento_id} nao devia ter sido tocado`).toBeNull();
    }
    // e a stage do LOTE_Y continua inteira
    expect(await db2.conta("public.backfill_matricula_stage", `lote='LOTE_Y'`)).toBe(3);
    expect(await db2.conta("public.backfill_matricula_stage", `lote='LOTE_X'`)).toBe(0);
    expect(await db2.conta("public.backfill_matricula_origem")).toBe(2);
  });
  it("stage incompleta aborta e diz quantas achou", async () => {
    const db2 = await novaBancada(); await db2.semearPadrao();
    await db2.carregarStage("LOTE_CURTO", PLANO_OK.slice(0, 3));
    const r = await db2.aplicar("LOTE_CURTO", HASH_OK, 5);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/tem 3 linhas, esperado 5/);
    expect(await db2.conta("public.backfill_matricula_lotes")).toBe(0);
  });
  it("stage vazia aborta", async () => {
    const db2 = await novaBancada(); await db2.semearPadrao();
    const r = await db2.aplicar("LOTE_VAZIO", HASH_OK, 5);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/tem 0 linhas, esperado 5/);
  });
  it("UMA matricula adulterada na stage quebra o hash", async () => {
    const db2 = await novaBancada(); await db2.semearPadrao();
    const adulterado = PLANO_OK.map((r, i) =>
      i === 2 ? { ...r, matricula: "999999999" } : r);
    await db2.carregarStage("LOTE_MAT", adulterado);
    const r = await db2.aplicar("LOTE_MAT", HASH_OK, 5);   // hash do plano ORIGINAL
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/nao confere com o artefato auditado/);
    expect(await db2.conta("public.pagamentos", "matricula is not null")).toBe(1); // so o U(6)
  });
  it("UM boleto adulterado na stage quebra o hash", async () => {
    const db2 = await novaBancada(); await db2.semearPadrao();
    const adulterado = PLANO_OK.map((r, i) =>
      i === 1 ? { ...r, numero_parcela_completo: BOL(555) } : r);
    await db2.carregarStage("LOTE_BOL", adulterado);
    const r = await db2.aplicar("LOTE_BOL", HASH_OK, 5);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/nao confere com o artefato auditado/);
  });
  it("boleto adulterado COM hash coerente ainda bate no boleto do banco", async () => {
    // o adversario recalcula o hash: o hash fecha, mas o boleto do pagamento
    // no banco nao e o da stage -- e ai a checagem contra `pagamentos` pega.
    const db2 = await novaBancada(); await db2.semearPadrao();
    const adulterado = PLANO_OK.map((r, i) =>
      i === 1 ? { ...r, numero_parcela_completo: BOL(555) } : r);
    await db2.carregarStage("LOTE_BOL2", adulterado);
    const r = await db2.aplicar("LOTE_BOL2", md5(canonizar(adulterado)), 5);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/boleto do pagamento mudou desde o dry-run/);
  });
});

describe("idempotencia e concorrencia", () => {
  let db;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    await db.carregarStage("LOTE_A", PLANO_OK);
    await db.aplicar("LOTE_A", HASH_OK, 5);
  }, 60000);

  it("mesmo lote + mesmo hash: JA_APLICADO, zero mutacao, sem excecao", async () => {
    const fm = await db.fotoMatriculas(), fo = await db.fotoOutrosCampos();
    const r = await db.aplicar("LOTE_A", HASH_OK, 5);
    expect(r.ok).toBe(true);
    expect(r.valor.resultado).toBe("JA_APLICADO");
    expect(r.valor.alteracoes).toBe(0);
    expect(await db.fotoMatriculas()).toBe(fm);
    expect(await db.fotoOutrosCampos()).toBe(fo);
  });
  it("nao duplica trilha nem lote", async () => {
    await db.aplicar("LOTE_A", HASH_OK, 5);
    expect(await db.conta("public.backfill_matricula_origem")).toBe(5);
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(1);
  });
  it("mesmo lote + hash diferente: aborta sem mutar", async () => {
    const fm = await db.fotoMatriculas();
    const r = await db.aplicar("LOTE_A", md5("outro artefato"), 5);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/outro artefato/);
    expect(await db.fotoMatriculas()).toBe(fm);
  });
  it("o MESMO plano sob OUTRO lote aborta -- nao regrava", async () => {
    await db.carregarStage("LOTE_B", PLANO_OK);
    const fm = await db.fotoMatriculas();
    const r = await db.aplicar("LOTE_B", HASH_OK, 5);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/matricula ja preenchida/);
    expect(await db.fotoMatriculas()).toBe(fm);
  });
  it("duas aplicacoes do mesmo lote produzem UMA carga e um JA_APLICADO", async () => {
    // LIMITE DECLARADO: PGlite tem uma conexao so, entao nao da para disparar
    // duas transacoes simultaneas aqui. O que se prova e o RESULTADO que a
    // serializacao pelo lock produz: a segunda passagem nao regrava nada. Que o
    // lock exista e venha antes de qualquer leitura, o teste estrutural cobre,
    // e o bloco DO $prova$ da migration aborta a aplicacao se ele sumir.
    const db2 = await novaBancada(); await db2.semearPadrao();
    await db2.carregarStage("LOTE_C", PLANO_OK);
    const a = await db2.aplicar("LOTE_C", HASH_OK, 5);
    const b = await db2.aplicar("LOTE_C", HASH_OK, 5);
    expect(a.valor.resultado).toBe("APLICADO");
    expect(b.valor.resultado).toBe("JA_APLICADO");
    expect(await db2.conta("public.backfill_matricula_origem")).toBe(5);
  });
  it("o lock do lote e de transacao: nao fica preso depois da chamada", async () => {
    const v = await db.query(
      `select count(*) c from pg_locks where locktype='advisory'`);
    expect(Number(v.rows[0].c)).toBe(0);
  });
});

describe("cada invariante contra pagamentos aborta, e desfaz tudo", () => {
  let db;
  beforeAll(async () => { db = await novaBancada(); await db.semearPadrao(); }, 60000);

  const casos = [
    ["matricula ja preenchida", [linha(6)], /matricula ja preenchida/],
    ["boleto divergente", [{ ...linha(10), numero_parcela_completo: BOL(10) }],
      /boleto do pagamento mudou/],
    ["boleto multiplo no banco", [linha(7)], /boleto multiplo no banco/],
    ["tipo diferente de SANTANDER", [linha(9)], /fora de tipo_pagamento SANTANDER/],
    ["pagamento inexistente", [linha(777)], /pagamento inexistente/],
  ];
  for (const [nome, plano, motivo] of casos) {
    it(nome, async () => {
      const lote = `LOTE_${nome.replace(/\W+/g, "_")}`;
      await db.carregarStage(lote, plano);
      const fm = await db.fotoMatriculas(), fo = await db.fotoOutrosCampos();
      const nO = await db.conta("public.backfill_matricula_origem");
      const nL = await db.conta("public.backfill_matricula_lotes");
      const r = await db.aplicar(lote, md5(canonizar(plano)), plano.length);
      expect(r.ok, `${nome} deveria abortar`).toBe(false);
      expect(r.erro).toMatch(motivo);
      expect(await db.fotoMatriculas()).toBe(fm);
      expect(await db.fotoOutrosCampos()).toBe(fo);
      expect(await db.conta("public.backfill_matricula_origem")).toBe(nO);
      expect(await db.conta("public.backfill_matricula_lotes")).toBe(nL);
      expect(await db.conta("public.backfill_matricula_stage", `lote='${lote}'`))
        .toBe(plano.length);   // stage preservada
    });
  }
  it("contagem diferente aborta", async () => {
    await db.carregarStage("LOTE_QTD", [linha(1), linha(2)]);
    const r = await db.aplicar("LOTE_QTD", md5(canonizar([linha(1), linha(2)])), 99);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/tem 2 linhas, esperado 99/);
  });
});

describe("atomicidade: UPDATE que afeta menos linhas desfaz ate a trilha", () => {
  let db, r;
  beforeAll(async () => {
    db = await novaBancada(); await db.semearPadrao();
    await db.carregarStage("LOTE_SABOTADO", PLANO_OK);
    await db.exec(`
      create function sabota() returns trigger language plpgsql as $$
        begin if new.id = '${U(3)}'::uuid then return null; end if; return new; end $$;
      create trigger tg_sabota before update on public.pagamentos
        for each row execute function sabota();`);
    r = await db.aplicar("LOTE_SABOTADO", HASH_OK, 5);
  }, 60000);

  it("levanta excecao citando rollback total", () => {
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/rollback total/);
  });
  it("zero linha na trilha e zero lote", async () => {
    expect(await db.conta("public.backfill_matricula_origem")).toBe(0);
    expect(await db.conta("public.backfill_matricula_lotes")).toBe(0);
  });
  it("zero matricula gravada", async () => {
    expect(await db.conta("public.pagamentos",
      `matricula is not null and id <> '${U(6)}'`)).toBe(0);
  });
  it("a stage NAO foi limpa -- o delete tambem foi desfeito", async () => {
    expect(await db.conta("public.backfill_matricula_stage", `lote='LOTE_SABOTADO'`)).toBe(5);
  });
});

describe("escala real: carga em blocos e aplicacao", () => {
  const N = 7401;
  let db, plano, canonico, tempos, r, msAplicar;
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
    tempos = await db.carregarStage("LOTE_GRANDE", plano, BLOCO);
    const t0 = performance.now();
    r = await db.aplicar("LOTE_GRANDE", md5(canonico), N);
    msAplicar = performance.now() - t0;
  }, 180000);

  it("o plano sintetico e pelo menos do tamanho do artefato real", () => {
    expect(canonico.length).toBeGreaterThanOrEqual(TAMANHO_ARTEFATO_REAL);
  });
  it(`a carga usa blocos de ${BLOCO} e cada INSERT fica MUITO abaixo de 10 s`, () => {
    expect(tempos.length).toBe(Math.ceil(N / BLOCO));
    const pior = Math.max(...tempos);
    // 10.000 ms e o limiar do auto_explain em producao. Exijo duas ordens de
    // grandeza de folga: se um bloco de 100 chegar a 100 ms, algo esta errado.
    expect(pior).toBeLessThan(100);
  });
  it("a aplicacao inteira conclui bem abaixo do statement_timeout", () => {
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.alteracoes).toBe(N);
    expect(msAplicar).toBeLessThan(30000);   // producao: statement_timeout 120 s
  });
  it("a trilha recebe todas as linhas e a stage e limpa", async () => {
    expect(await db.conta("public.backfill_matricula_origem")).toBe(N);
    expect(await db.conta("public.backfill_matricula_stage")).toBe(0);
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
  it("a assinatura NAO recebe o plano", async () => {
    const v = await db.query(`select pg_get_function_identity_arguments(p.oid) a
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='backfill_matricula_aplicar'`);
    expect(v.rows[0].a).toBe("p_lote text, p_hash text, p_esperado integer");
    expect(v.rows[0].a).not.toMatch(/jsonb/);
  });
  it.each(["public", "anon", "authenticated", "service_role"])(
    "%s nao executa a funcao", async (papel) => {
      const v = await db.query(`select has_function_privilege($1,
        'public.backfill_matricula_aplicar(text, text, integer)','EXECUTE') x`, [papel]);
      expect(v.rows[0].x).toBe(false);
    });
  it("service_role INSERE na stage", async () => {
    const v = await db.query(
      `select has_table_privilege('service_role','public.backfill_matricula_stage','INSERT') x`);
    expect(v.rows[0].x).toBe(true);
  });
  it.each(["SELECT", "UPDATE", "DELETE"])(
    "service_role NAO tem %s na stage", async (priv) => {
      const v = await db.query(
        `select has_table_privilege('service_role','public.backfill_matricula_stage',$1) x`, [priv]);
      expect(v.rows[0].x).toBe(false);
    });
  it.each(["anon", "authenticated"])("%s nao alcanca a stage", async (papel) => {
    for (const p of ["SELECT", "INSERT"]) {
      const v = await db.query(
        `select has_table_privilege($1,'public.backfill_matricula_stage',$2) x`, [papel, p]);
      expect(v.rows[0].x).toBe(false);
    }
  });
  it.each(["anon", "authenticated", "service_role"])(
    "%s nao le a trilha", async (papel) => {
      for (const t of ["backfill_matricula_origem", "backfill_matricula_lotes"]) {
        const v = await db.query(`select has_table_privilege($1,$2,'SELECT') x`,
          [papel, `public.${t}`]);
        expect(v.rows[0].x).toBe(false);
      }
    });
  it("o gate recusa quem NAO e o dono, mesmo com EXECUTE concedido", async () => {
    await db.exec(`create role papel_de_teste;
      grant execute on function public.backfill_matricula_aplicar(text, text, integer)
        to papel_de_teste;`);
    let erro = null;
    try {
      await db.exec(`set role papel_de_teste;
        select public.backfill_matricula_aplicar('L','x',1);`);
    } catch (e) { erro = e.message; } finally { await db.exec(`reset role;`); }
    expect(erro).toMatch(/exclusiva do dono \(postgres\)/);
  });
});
