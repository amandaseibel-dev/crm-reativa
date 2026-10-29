// UMA UNICA BAIXA VIVA POR PARCELA -- COMPORTAMENTO.
//
// Roda a migration REAL num PostgreSQL real (PGlite), sobre a bancada minima
// que baixar_parcela_acordo / quitar_acordo_cartao e o gatilho precisam.
//
// LIMITE CONHECIDO DESTA BANCADA: PGlite e uma unica conexao. Nao da para abrir
// duas transacoes simultaneas de verdade, entao o teste C nao consegue EXECUTAR
// a corrida. O que ele faz e provar, no corpo JA COMPILADO dentro do banco, que
// a serializacao existe e vem ANTES da leitura -- que e exatamente o que separa
// esta trava de um `if exists` ingenuo. A mutacao K derruba esse teste quando o
// `for update` sai.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20260922290000_baixa_viva_unica_por_parcela.sql");
const ROLLBACK = ler("supabase/rollbacks/20260922290000_baixa_viva_unica_por_parcela.rollback.sql");

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

    create table public.alunos (id uuid primary key default gen_random_uuid(), nome text, cpf text);

    create sequence public.acordos_numero_seq;
    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric,
      numero_acordo bigint default nextval('public.acordos_numero_seq'),
      operador_responsavel_email text, criado_por_email text,
      criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      numero int, status text default 'A_VENCER', valor numeric, honorarios numeric,
      pago_em timestamptz, confirmado_por_email text, atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(),
      aluno_id text, aluno_nome text, aluno_cpf text,
      parcela_id uuid references public.parcelas(id),
      acordo_id uuid references public.acordos(id),
      valor_pago numeric, honorarios_recebidos numeric, data_pagamento date,
      comprovante_url text, status_baixa text,
      responsavel_baixa_email text, responsavel_baixa_nome text,
      baixado_por_email text, baixado_por_nome text,
      recebido_em timestamptz, atualizado_em timestamptz, baixado_em timestamptz,
      devolvido_em timestamptz, devolvido_por_email text, motivo_devolucao text);

    create function public.crm_usuario_pode_quitar_baixar() returns boolean
      language sql stable as $$ select true $$;
  `);
  await db.exec(MIGRATION);
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ email: "amanda.seibel@aelbra.com.br", role: "authenticated" })]);
  return db;
}

async function cenario(db, { parcelas = [500], statusAcordo = "ATIVO" } = {}) {
  const aluno = await um(db, `insert into public.alunos (nome, cpf) values ('Fulano de Teste','00000000000') returning id`);
  const acordo = await um(db, `insert into public.acordos (aluno_id, status, valor_total, operador_responsavel_email)
      values ($1,$2,$3,'cobranca01@aelbra.com.br') returning id`,
    [aluno, statusAcordo, parcelas.reduce((a, b) => a + b, 0)]);
  const ids = [];
  for (let i = 0; i < parcelas.length; i++) {
    ids.push(await um(db, `insert into public.parcelas (acordo_id, numero, status, valor, honorarios)
        values ($1,$2,'VENCIDA',$3,0) returning id`, [acordo, i + 1, parcelas[i]]));
  }
  return { aluno, acordo, parcelas: ids };
}

const baixar = (db, parcelaId, valor = null) =>
  um(db, `select public.baixar_parcela_acordo($1, current_date, $2, 0)`, [parcelaId, valor]);
const quitarCartao = (db, acordoId) =>
  um(db, `select public.quitar_acordo_cartao($1, current_date, null)`, [acordoId]);
const contarVivas = (db, parcelaId) =>
  um(db, `select count(*)::int from public.baixas_pagamento where parcela_id=$1 and devolvido_em is null`, [parcelaId]);

// INSERT direto, como faz src/utils/lancarAcordo.js pela RLS -- nao passa por RPC
async function inserirDireto(db, { parcelaId, acordoId, alunoId, valor = 500, devolvidoEm = null }) {
  return db.query(`insert into public.baixas_pagamento
      (aluno_id, parcela_id, acordo_id, valor_pago, status_baixa, baixado_por_email,
       baixado_em, recebido_em, atualizado_em, data_pagamento, devolvido_em)
     values ($1,$2,$3,$4,'REALIZADA','amanda.seibel@aelbra.com.br', now(), now(), now(), current_date, $5)`,
    [String(alunoId), parcelaId, acordoId, valor, devolvidoEm]);
}

describe("baixa viva unica por parcela", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("A. primeira baixa numa parcela limpa: permitida", async () => {
    const c = await cenario(db, { parcelas: [500] });
    const r = await baixar(db, c.parcelas[0]);
    expect(r.ok).toBe(true);
    expect(await contarVivas(db, c.parcelas[0])).toBe(1);
    expect(await um(db, `select status from public.parcelas where id=$1`, [c.parcelas[0]])).toBe("PAGO");
  });

  it("B. segunda baixa viva na mesma parcela: recusada, e nada e escrito", async () => {
    const c = await cenario(db, { parcelas: [500] });
    await baixar(db, c.parcelas[0]);
    // pelo caminho direto, que e o unico capaz de tentar de novo depois que a
    // parcela ja esta PAGO (a RPC para antes, na guarda de status)
    await expect(inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno }))
      .rejects.toThrow(/ja tem baixa registrada/i);
    expect(await contarVivas(db, c.parcelas[0])).toBe(1);
  });

  it("C. a checagem e SERIALIZADA: trava a parcela antes de olhar, nao e um `if exists` solto", async () => {
    // PGlite e conexao unica: a corrida nao pode ser executada aqui. Prova-se
    // sobre o corpo ja compilado no banco, sem comentarios -- duas transacoes
    // so se enfileiram se o lock vier ANTES da leitura.
    const src = await um(db, `select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                               where n.nspname='public' and p.proname='_baixa_viva_unica_por_parcela'`);
    const semComentario = src.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    const posLock = semComentario.search(/from\s+public\.parcelas\s+where\s+id\s*=\s*new\.parcela_id\s+for\s+update/i);
    const posLeitura = semComentario.search(/from\s+public\.baixas_pagamento/i);
    expect(posLock).toBeGreaterThan(-1);
    expect(posLeitura).toBeGreaterThan(-1);
    expect(posLock).toBeLessThan(posLeitura);
  });

  it("D. estorno e depois nova baixa: permitido", async () => {
    const c = await cenario(db, { parcelas: [500] });
    await baixar(db, c.parcelas[0]);
    await db.query(`update public.baixas_pagamento set devolvido_em = now(), status_baixa='DEVOLVIDA'
                     where parcela_id=$1`, [c.parcelas[0]]);
    await db.query(`update public.parcelas set status='VENCIDA', pago_em=null where id=$1`, [c.parcelas[0]]);

    const r = await baixar(db, c.parcelas[0]);
    expect(r.ok).toBe(true);
    expect(await contarVivas(db, c.parcelas[0])).toBe(1);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where parcela_id=$1`, [c.parcelas[0]])).toBe(2);
  });

  it("E. parcelas diferentes do mesmo acordo: permitido", async () => {
    const c = await cenario(db, { parcelas: [300, 300, 300] });
    for (const p of c.parcelas) expect((await baixar(db, p)).ok).toBe(true);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento
                          where acordo_id=$1 and devolvido_em is null`, [c.acordo])).toBe(3);
  });

  it("F. baixa com parcela_id nulo: permitida, e pode repetir (fluxo do comprovante)", async () => {
    const c = await cenario(db, { parcelas: [500] });
    for (let i = 0; i < 2; i++) {
      await db.query(`insert into public.baixas_pagamento
          (aluno_id, parcela_id, acordo_id, valor_pago, status_baixa, baixado_por_email, baixado_em)
         values ($1, null, $2, 100, 'REALIZADA', 'operador@aelbra.com.br', now())`, [String(c.aluno), c.acordo]);
    }
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where parcela_id is null`)).toBe(2);
  });

  it("G. quitar_acordo_cartao com uma parcela que ja tem baixa viva: recusa TUDO, sem baixar o restante", async () => {
    // O RISCO REAL e a parcela com baixa viva que NAO esta PAGO -- a forma
    // exata do caso medido em producao (Maiara, 10/09): existe caminho que
    // grava a baixa sem marcar a parcela. Parcela ja PAGO sai sozinha do
    // conjunto-alvo da quitacao e por isso nao e o caso perigoso (ver o teste
    // logo abaixo, que garante que ela nao atrapalha as outras).
    const c = await cenario(db, { parcelas: [300, 300, 300] });
    await inserirDireto(db, { parcelaId: c.parcelas[1], acordoId: c.acordo, alunoId: c.aluno, valor: 300 });
    expect(await um(db, `select status from public.parcelas where id=$1`, [c.parcelas[1]])).toBe("VENCIDA");
    const antes = await um(db, `select count(*)::int from public.baixas_pagamento`);

    // A mensagem tem de ser a da GUARDA AMIGAVEL da RPC, nao a do gatilho: as
    // duas barram, mas so a da RPC explica que a operacao inteira foi recusada.
    // Sem esta distincao o teste passaria mesmo com a guarda removida, porque o
    // gatilho aborta a transacao de qualquer jeito.
    let msg = "";
    try { await quitarCartao(db, c.acordo); } catch (e) { msg = String(e.message || e); }
    expect(msg).toMatch(/Nao da para quitar/i);
    expect(msg).toMatch(/1 parcela\(s\)/);
    expect(msg).toMatch(/recusada inteira/i);

    // tudo ou nada: nenhuma baixa nova e NENHUMA parcela virou PAGO
    expect(await um(db, `select count(*)::int from public.baixas_pagamento`)).toBe(antes);
    expect(await um(db, `select count(*)::int from public.parcelas
                          where acordo_id=$1 and status='PAGO'`, [c.acordo])).toBe(0);
  });

  it("G2. parcela ja PAGO com baixa viva nao impede a quitacao das outras", async () => {
    const c = await cenario(db, { parcelas: [300, 300, 300] });
    await baixar(db, c.parcelas[0]);   // fica PAGO, sai do conjunto-alvo
    const r = await quitarCartao(db, c.acordo);
    expect(r.ok).toBe(true);
    expect(r.parcelas_quitadas).toBe(2);
    for (const p of c.parcelas) expect(await contarVivas(db, p)).toBe(1);
  });

  it("H. INSERT direto na tabela (caminho do cliente pela RLS): a trava tambem atua", async () => {
    const c = await cenario(db, { parcelas: [500] });
    await inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno });
    await expect(inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno }))
      .rejects.toThrow(/ja tem baixa registrada/i);
    expect(await contarVivas(db, c.parcelas[0])).toBe(1);
  });

  it("I. repetir a mesma RPC: nao cria segunda baixa nem mexe de novo na parcela", async () => {
    const c = await cenario(db, { parcelas: [500] });
    await baixar(db, c.parcelas[0]);
    const marca = await um(db, `select atualizado_em from public.parcelas where id=$1`, [c.parcelas[0]]);

    await expect(baixar(db, c.parcelas[0])).rejects.toThrow();
    expect(await contarVivas(db, c.parcelas[0])).toBe(1);
    expect(await um(db, `select atualizado_em from public.parcelas where id=$1`, [c.parcelas[0]])).toEqual(marca);
  });

  it("J. a mensagem traz data, responsavel e valor da baixa que ja existe", async () => {
    const c = await cenario(db, { parcelas: [1234.56] });
    await baixar(db, c.parcelas[0], 1234.56);
    let msg = "";
    try {
      await inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno });
    } catch (e) { msg = String(e.message || e); }
    expect(msg).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);        // data e hora
    expect(msg).toContain("cobranca01@aelbra.com.br");              // responsavel
    expect(msg).toContain("1.234,56");                              // valor
    expect(msg).toMatch(/estorne/i);                                // o que fazer
  });

  it("linha que ja nasce DEVOLVIDA nao conta como viva: nao bloqueia nem e bloqueada", async () => {
    const c = await cenario(db, { parcelas: [500] });
    await inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno, devolvidoEm: new Date().toISOString() });
    await inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno });
    expect(await contarVivas(db, c.parcelas[0])).toBe(1);
  });

  it("quitar_acordo_cartao sem nenhuma parcela baixada: quita todas normalmente", async () => {
    const c = await cenario(db, { parcelas: [200, 200] });
    const r = await quitarCartao(db, c.acordo);
    expect(r.ok).toBe(true);
    expect(r.parcelas_quitadas).toBe(2);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where acordo_id=$1`, [c.acordo])).toBe(2);
  });
});

describe("rollback de 20260922290000: codigo volta, dado fica", () => {
  it("1. tira o gatilho e a funcao, e a duplicidade volta a passar", async () => {
    const db = await novoBanco();
    const c = await cenario(db, { parcelas: [500] });
    await baixar(db, c.parcelas[0]);

    await db.exec(ROLLBACK);
    expect(await um(db, `select count(*)::int from pg_trigger
        where tgrelid='public.baixas_pagamento'::regclass and tgname='trg_baixa_viva_unica_por_parcela'`)).toBe(0);
    expect(await um(db, `select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='_baixa_viva_unica_por_parcela'`)).toBe(0);

    // sem a trava, o caminho direto duplica de novo -- e isso que o rollback reabre
    await inserirDireto(db, { parcelaId: c.parcelas[0], acordoId: c.acordo, alunoId: c.aluno });
    expect(await contarVivas(db, c.parcelas[0])).toBe(2);
    await db.close();
  });

  it("2. nao devolve, nao apaga e nao altera nenhuma baixa existente", async () => {
    const db = await novoBanco();
    const c = await cenario(db, { parcelas: [400, 400] });
    await baixar(db, c.parcelas[0]);
    await baixar(db, c.parcelas[1]);
    const antes = await um(db, `select jsonb_agg(to_jsonb(b) order by b.id) from public.baixas_pagamento b`);

    await db.exec(ROLLBACK);
    expect(await um(db, `select jsonb_agg(to_jsonb(b) order by b.id) from public.baixas_pagamento b`)).toEqual(antes);
    await db.close();
  });

  it("3. as RPCs restauradas nao referenciam mais a trava", async () => {
    const db = await novoBanco();
    await db.exec(ROLLBACK);
    for (const fn of ["baixar_parcela_acordo", "quitar_acordo_cartao"]) {
      const src = await um(db, `select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                 where n.nspname='public' and p.proname=$1`, [fn]);
      expect(src).not.toMatch(/_baixa_viva_unica_por_parcela/i);
      expect(src).not.toMatch(/ja tem baixa registrada/i);
    }
    await db.close();
  });

  it("4. o arquivo de rollback nao contem DML de nivel superior", () => {
    const semCorpos = ROLLBACK.replace(/\$(function|fn)\$[\s\S]*?\$\1\$/g, " ").replace(/--[^\n]*/g, " ");
    expect(semCorpos).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
  });
});
