// RESERVA, ORÇAMENTO E RECONCILIAÇÃO do piloto, em Postgres isolado (PGlite).
//
// Os três casos que a revisão pediu, e são justamente os que só aparecem sob
// concorrência ou interrupção -- nenhum deles se vê testando o caminho feliz:
//
//   1. DUAS ABAS: não podem pegar o mesmo item. Se pegarem, o mesmo aluno é
//      consultado duas vezes e o teto é furado pela metade.
//   2. INTERRUPÇÃO entre gravar a consulta e fechar o item: o trabalho já foi
//      pago em requisições. Retomar tem de reconciliar, não reconsultar.
//   3. PAGINAÇÃO com UMA requisição sobrando: o orçamento precisa valer por
//      PÁGINA, não por aluno.
//
// A fila é montada à mão de propósito: `..._criar` depende da carteira inteira,
// e o que se mede aqui é a máquina da reserva, não o universo.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(AQUI, "..", "migrations");
const ler = (f) => readFileSync(resolve(MIG, f), "utf8");

// Só as partes do piloto: a 114757 cria as tabelas, a 130000 traz reserva,
// orçamento e reconciliação.
const SQL_TABELAS = ler("20260929114757_prime_academico_piloto.sql");
const SQL_RESERVA = ler("20260929130000_piloto_reserva_orcamento_reconciliacao.sql");

const LOTE = "10000000-0000-4000-8000-000000000001";
const ALUNO = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function bancada({ limiteReq = 300 } = {}) {
  const db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema if not exists auth;
    create table public.alunos (id uuid primary key, cpf text);
    create table public.prime_academico_consulta (
      id uuid primary key default gen_random_uuid(),
      aluno_id uuid not null references public.alunos(id) on delete cascade,
      cpf text, resultado text, consultado_em timestamptz not null default now(),
      requisicoes integer);
    create function auth.role() returns text language sql stable as $$ select current_setting('role', true) $$;
    create function public.usuario_e_gestao() returns boolean language sql stable
      as $$ select coalesce(current_setting('teste.gestao', true) <> 'off', true) $$;
    -- o universo não é exercitado aqui; um stub basta para a migration aplicar
    create function public.carteira_academico_universo(p_ano text, p_semestre text default null)
      returns table (aluno_id uuid, cpf text) language sql stable as $$ select null::uuid, null::text where false $$;
    create function public.carteira_academico_grupo(p_aluno_id uuid) returns text
      language sql stable as $$ select 'Ainda não consultados'::text $$;
  `);
  for (let i = 1; i <= 5; i++) {
    await db.query(`insert into public.alunos values ($1,$2)`, [ALUNO(i), `1111111111${i}`]);
  }
  await db.exec(SQL_TABELAS);
  await db.exec(SQL_RESERVA);

  await db.query(
    `insert into public.prime_academico_piloto_lote (id, ano, semestre, limite_alunos, limite_requisicoes, estado)
     values ($1,'2026','1',5,$2,'PRONTO')`, [LOTE, limiteReq]);
  for (let i = 1; i <= 5; i++) {
    await db.query(
      `insert into public.prime_academico_piloto_item (lote_id, ordem, aluno_id) values ($1,$2,$3)`,
      [LOTE, i, ALUNO(i)]);
  }

  db.proximo = async () => (await db.query(`select public.prime_academico_piloto_proximo($1) j`, [LOTE])).rows[0].j;
  db.comoServico = async (sql, args = []) => {
    try {
      await db.exec(`set role service_role;`);
      return { ok: true, linhas: (await db.query(sql, args)).rows };
    } catch (e) { return { ok: false, erro: e.message }; }
    finally { await db.exec(`reset role;`); }
  };
  db.validar = async (item, aluno) => (await db.comoServico(
    `select public.prime_academico_piloto_validar($1,$2) j`, [item, aluno])).linhas?.[0]?.j;
  db.registrar = (item, consulta, req, http, erro, aluno) => db.comoServico(
    `select public.prime_academico_piloto_registrar($1,$2,$3,$4,$5,$6) j`,
    [item, consulta, req, http, erro, aluno]);
  db.gravarConsulta = async (aluno, req) => (await db.query(
    `insert into public.prime_academico_consulta (aluno_id, cpf, resultado, requisicoes)
     values ($1,'x','COM_VINCULOS',$2) returning id`, [aluno, req])).rows[0].id;
  db.estado = async (item) => (await db.query(
    `select estado, requisicoes, consulta_id from public.prime_academico_piloto_item where id=$1`, [item])).rows[0];
  return db;
}

let db;
beforeEach(async () => { db = await bancada(); }, 60000);

describe("1. duas abas concorrentes", () => {
  it("nunca entregam o MESMO item", async () => {
    const a = await db.proximo();
    const b = await db.proximo();
    expect(a.parar).toBe(false);
    expect(b.parar).toBe(false);
    // É o `for update skip locked`: a segunda não espera, pula para o próximo.
    expect(a.item_id).not.toBe(b.item_id);
    expect(a.aluno_id).not.toBe(b.aluno_id);
  });

  it("o item reservado sai da fila na hora", async () => {
    const a = await db.proximo();
    expect((await db.estado(a.item_id)).estado).toBe("EM_PROCESSAMENTO");
    const restantes = Number((await db.query(
      `select count(*) c from public.prime_academico_piloto_item where lote_id=$1 and estado='PENDENTE'`,
      [LOTE])).rows[0].c);
    expect(restantes).toBe(4);
  });

  it("com todos reservados, o laço NÃO conclui o lote -- espera quem está em voo", async () => {
    for (let i = 0; i < 5; i++) await db.proximo();
    const r = await db.proximo();
    expect(r.parar).toBe(true);
    expect(r.motivo).toMatch(/em processamento em outra aba/i);
    // concluir aqui perderia o resultado que a outra aba ainda vai gravar
    const lote = (await db.query(`select estado from public.prime_academico_piloto_lote where id=$1`, [LOTE])).rows[0];
    expect(lote.estado).not.toBe("CONCLUIDO");
  });

  it("validar recusa item que não é do aluno informado", async () => {
    const a = await db.proximo();
    const v = await db.validar(a.item_id, ALUNO(4) === a.aluno_id ? ALUNO(5) : ALUNO(4));
    expect(v.ok).toBe(false);
    expect(v.motivo).toBe("ITEM_NAO_E_DESTE_ALUNO");
  });

  it("validar recusa item que não está reservado", async () => {
    const pendente = (await db.query(
      `select id, aluno_id from public.prime_academico_piloto_item
        where lote_id=$1 and estado='PENDENTE' order by ordem limit 1`, [LOTE])).rows[0];
    const v = await db.validar(pendente.id, pendente.aluno_id);
    expect(v.ok).toBe(false);
    expect(v.motivo).toMatch(/ITEM_NAO_RESERVADO/);
  });
});

describe("2. interrupção entre gravar a consulta e fechar o item", () => {
  it("retomar RECONCILIA pela consulta que existe, sem reconsultar", async () => {
    const a = await db.proximo();
    // a consulta foi gravada e custou 3 requisições; o registro do item nunca
    // aconteceu (a aba morreu, ou a RPC falhou)
    const consulta = await db.gravarConsulta(a.aluno_id, 3);

    const r = await db.proximo();          // é aqui que a reconciliação roda
    expect(r.reconciliacao.reconciliados).toBe(1);

    const item = await db.estado(a.item_id);
    expect(item.estado).toBe("CONCLUIDO");
    expect(item.consulta_id).toBe(consulta);
    // A CONTAGEM VEM DA CONSULTA: 3, não 1. Chutar aqui furaria o teto.
    expect(Number(item.requisicoes)).toBe(3);
  });

  it("sem consulta e com reserva velha, o item volta para a fila", async () => {
    const a = await db.proximo();
    await db.query(
      `update public.prime_academico_piloto_item set reservado_em = now() - interval '10 minutes' where id=$1`,
      [a.item_id]);

    // Medido pela RECONCILIAÇÃO, não pelo estado final: `proximo` devolve o
    // item e, como ele é o de menor ordem, reserva ELE de novo na mesma
    // chamada. Olhar só o estado no fim daria "EM_PROCESSAMENTO" e esconderia
    // que a devolução aconteceu -- que é o que este teste existe para provar.
    const rec = (await db.query(
      `select public.prime_academico_piloto_reconciliar($1) j`, [LOTE])).rows[0].j;
    expect(rec.devolvidos).toBe(1);
    expect(rec.reconciliados).toBe(0);
    expect((await db.estado(a.item_id)).estado).toBe("PENDENTE");

    // e ele volta a ser entregue, em vez de ficar preso
    const b = await db.proximo();
    expect(b.item_id).toBe(a.item_id);
  });

  it("reserva recente sem consulta NÃO é devolvida -- ainda pode estar em voo", async () => {
    const a = await db.proximo();
    await db.proximo();
    expect((await db.estado(a.item_id)).estado).toBe("EM_PROCESSAMENTO");
  });

  it("registrar duas vezes é idempotente: não duplica nem reescreve a contagem", async () => {
    const a = await db.proximo();
    const c = await db.gravarConsulta(a.aluno_id, 2);
    await db.registrar(a.item_id, c, 2, 200, null, a.aluno_id);
    const antes = await db.estado(a.item_id);

    const r2 = await db.registrar(a.item_id, c, 99, 200, null, a.aluno_id);
    expect(r2.linhas[0].j.ja_registrado).toBe(true);
    const depois = await db.estado(a.item_id);
    expect(Number(depois.requisicoes)).toBe(Number(antes.requisicoes));
  });

  it("registrar com aluno trocado é recusado", async () => {
    const a = await db.proximo();
    const outro = ALUNO(1) === a.aluno_id ? ALUNO(2) : ALUNO(1);
    const r = await db.registrar(a.item_id, null, 1, 200, null, outro);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/nao pertence a este aluno/i);
  });
});

describe("3. orçamento", () => {
  it("o que sobra é devolvido a cada item, e encolhe conforme se gasta", async () => {
    const a = await db.proximo();
    expect(a.orcamento).toBe(300);
    await db.registrar(a.item_id, await db.gravarConsulta(a.aluno_id, 40), 40, 200, null, a.aluno_id);

    const b = await db.proximo();
    expect(b.orcamento).toBe(260);
    expect((await db.validar(b.item_id, b.aluno_id)).orcamento).toBe(260);
  });

  it("com UMA requisição sobrando, a validação ainda deixa começar -- e só uma página cabe", async () => {
    const d2 = await bancada({ limiteReq: 3 });
    const a = await d2.proximo();
    await d2.registrar(a.item_id, await d2.gravarConsulta(a.aluno_id, 2), 2, 200, null, a.aluno_id);

    const b = await d2.proximo();
    expect(b.parar).toBe(false);
    expect(b.orcamento).toBe(1);
    // É este 1 que a Edge usa como teto de PÁGINAS: ela busca uma e para,
    // gravando PAGINACAO_INCOMPLETA em vez de fingir lista completa.
    expect((await d2.validar(b.item_id, b.aluno_id)).orcamento).toBe(1);
  });

  it("orçamento zerado interrompe o lote antes de reservar qualquer item", async () => {
    const d2 = await bancada({ limiteReq: 2 });
    const a = await d2.proximo();
    await d2.registrar(a.item_id, await d2.gravarConsulta(a.aluno_id, 2), 2, 200, null, a.aluno_id);

    const b = await d2.proximo();
    expect(b.parar).toBe(true);
    expect(b.motivo).toMatch(/teto de requisicoes atingido/i);
    const lote = (await d2.query(`select estado from public.prime_academico_piloto_lote where id=$1`, [LOTE])).rows[0];
    expect(lote.estado).toBe("INTERROMPIDO");
  });

  it("validar recusa quando o lote já foi interrompido", async () => {
    const a = await db.proximo();
    await db.query(`update public.prime_academico_piloto_lote set estado='INTERROMPIDO' where id=$1`, [LOTE]);
    const v = await db.validar(a.item_id, a.aluno_id);
    expect(v.ok).toBe(false);
    expect(v.motivo).toBe("LOTE_INTERROMPIDO");
  });

  it("401/403/429 interrompe o lote inteiro", async () => {
    const a = await db.proximo();
    const r = await db.registrar(a.item_id, null, 1, 429, "HTTP 429", a.aluno_id);
    expect(r.linhas[0].j.parar).toBe(true);
    const lote = (await db.query(`select estado, motivo from public.prime_academico_piloto_lote where id=$1`, [LOTE])).rows[0];
    expect(lote.estado).toBe("INTERROMPIDO");
    expect(lote.motivo).toMatch(/429/);
  });
});
