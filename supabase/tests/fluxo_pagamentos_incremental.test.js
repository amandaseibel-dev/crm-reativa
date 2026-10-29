// FLUXO DE PAGAMENTOS · RODADA INCREMENTAL — num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (supabase/migrations/20261021195950_*.sql) e o ROLLBACK
// REAL.
//
// ESCOPO DECLARADO, para não haver dúvida sobre o que está provado:
//
//   O que se testa aqui é o ENVELOPE DE SEGURANÇA da rodada. A DECISÃO
//   FINANCEIRA é toda de `pagamento_conciliar_um` (24.824 caracteres em
//   produção), que nesta bancada é DUBLADO de forma controlada. O contrato
//   testado é "a rodada chama o motor uma vez por pagamento, lê `status` e
//   `baixou`, e sobrevive ao erro dele". NENHUM teste daqui afirma que a regra
//   de baixa está correta -- essa regra não foi tocada por esta frente.
//
//   `sistema_sob_carga` e `calibragem_e_gestao` entram com o corpo EXATO de
//   produção, conferido por md5(prosrc).
//
// LIMITE CONHECIDO DA BANCADA, dito em vez de escondido: a trava
// `pg_try_advisory_xact_lock` NÃO é coberta. PGlite é uma sessão só, e um
// advisory lock é reentrante dentro da mesma transação -- então não há como
// simular "a rodada anterior ainda corre". É o mesmo mecanismo já em produção
// nos executores do giro e do nivelamento.
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
const MD5 = JSON.parse(ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.md5.json"));
const MIGRATION = ler("supabase/migrations/20261021195950_fluxo_pagamentos_incremental.sql");
const ROLLBACK = ler("supabase/rollbacks/20261021195950_fluxo_pagamentos_incremental.rollback.sql");
const MIG_PERM = ler("supabase/migrations/20261021210208_vw_fluxo_monitor_fecha_escrita.sql");
const RB_PERM = ler("supabase/rollbacks/20261021210208_vw_fluxo_monitor_fecha_escrita.rollback.sql");
const MIG_PREVIA = ler("supabase/migrations/20261021210416_fluxo_incremental_previa_sem_escrita.sql");
const MIG_ESPERA = ler("supabase/migrations/20261021223117_fluxo_incremental_espera_nao_exclui.sql");
const MIG_CRON = ler("supabase/migrations/20261021225805_fluxo_pagamentos_agendar_brasilia.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OPERADOR = "cobranca05@aelbra.com.br";

const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);
const semLogin = (db) => db.query("select set_config('request.jwt.claims', '', false)");

const rodar = async (db, o = {}) => {
  const { lote = 40, seg = 20, tent = 8, espera = 24, aplicar = true } = o;
  return (await q1(db,
    "select public.fluxo_pagamentos_incremental($1,$2,$3,$4,$5) j",
    [lote, seg, tent, espera, aplicar])).j;
};

// Cria um pagamento pendente e, opcionalmente, sua linha na fila da gestão.
async function pag(db, n, o = {}) {
  const {
    status = "AGUARDANDO_ACORDO", naFila = true, decisao = null,
    tentativas = 0, ultimaTentativaHorasAtras = null,
    motorStatus = "AGUARDANDO_ACORDO", baixou = false, levanta = null, dormeMs = 0,
    dataPagamento = "2026-10-01",
  } = o;
  await db.query(
    `insert into public.pagamentos (id, aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao)
     values ($1,$2,$3,$4::date,100,$5)`,
    [U(n), U(900 + n), String(50000000000 + n), dataPagamento, status]);
  await db.query(`insert into public.alunos (id, nome, saldo_total) values ($1,$2,100)
                  on conflict (id) do nothing`, [U(900 + n), `Aluno ${n}`]);
  if (naFila) {
    await db.query(
      `insert into public.fila_pagamento_sem_vinculo
         (pagamento_id, decisao, quantidade_tentativas, ultima_tentativa_em, primeira_tentativa_em)
       values ($1,$2,$3,
               case when $4::int is null then null else now() - make_interval(hours => $4::int) end,
               now() - interval '30 days')`,
      [U(n), decisao, tentativas, ultimaTentativaHorasAtras]);
  }
  await db.query(
    `insert into public._dub_motor (pagamento_id, status, baixou, levanta, dorme_ms)
     values ($1,$2,$3,$4,$5)`,
    [U(n), motorStatus, baixou, levanta, dormeMs]);
}

async function construir(estagio = "base") {
  const db = new PGlite();
  await db.exec(BANCADA);

  // PORTAO DE FIDELIDADE: corpo de producao divergente para aqui.
  const rows = await qn(db,
    `select 'public.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5)) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await como(db, GESTAO);
  if (estagio !== "sem") await db.exec(MIGRATION);
  if (estagio === "final" || estagio === "espera") {
    await db.exec(MIG_PERM);
    await db.exec(MIG_PREVIA);
  }
  if (estagio === "espera") await db.exec(MIG_ESPERA);
  return db;
}

let COM, SEM, FINAL, ESPERA;
beforeAll(async () => {
  const a = await construir("base");
  COM = await a.dumpDataDir();
  await a.close();
  const b = await construir("sem");
  SEM = await b.dumpDataDir();
  await b.close();
  const c = await construir("final");
  FINAL = await c.dumpDataDir();
  await c.close();
  const d = await construir("espera");
  ESPERA = await d.dumpDataDir();
  await d.close();
});
const DADOS = { base: () => COM, sem: () => SEM, final: () => FINAL, espera: () => ESPERA };
const abrir = async (estagio = "base") => {
  const e = typeof estagio === "boolean" ? (estagio ? "base" : "sem") : estagio;
  const db = new PGlite({ loadDataDir: DADOS[e]() });
  await como(db, GESTAO);
  return db;
};

// ===========================================================================
describe("a bancada reproduz produção no que importa", () => {
  it("sistema_sob_carga e calibragem_e_gestao conferem por md5", async () => {
    const db = await abrir();
    const r = await qn(db,
      `select 'public.'||p.proname nome, md5(p.prosrc) md5 from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
    const m = Object.fromEntries(r.map((x) => [x.nome, x.md5]));
    for (const [nome, md5] of Object.entries(MD5)) expect(m[nome]).toBe(md5);
    await db.close();
  });
});

// ===========================================================================
describe("o portão e as permissões", () => {
  it("nasce FECHADA para PUBLIC e anon", async () => {
    const db = await abrir();
    const f = await q1(db,
      `select coalesce(array_to_string(p.proacl,'|'),'(default)') acl
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`);
    expect(f.acl.split("|").some((e) => e.startsWith("=X"))).toBe(false);
    expect(f.acl).toContain("authenticated=X");
    expect(f.acl).toContain("service_role=X");
    await db.close();
  });

  it("operador logado é recusado com 42501", async () => {
    const db = await abrir();
    await como(db, OPERADOR);
    await expect(db.query("select public.fluxo_pagamentos_incremental()"))
      .rejects.toThrow(/Sem permiss/);
    await db.close();
  });

  it("chamada de máquina sem JWT passa (é por onde o cron roda)", async () => {
    const db = await abrir();
    await db.exec(`create or replace function auth.jwt() returns jsonb
                   language sql stable as $$
                     select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
                   $$;`);
    await semLogin(db);
    const r = await rodar(db);
    expect(r.modo).toBe("aplicado");
    await db.close();
  });
});

// ===========================================================================
describe("NÃO CHAMA A VARREDURA QUE DERRUBOU O BANCO", () => {
  it("o canário parcelas_amarrar_boleto não dispara", async () => {
    const db = await abrir();
    for (let n = 1; n <= 5; n++) await pag(db, n);
    const r = await rodar(db);
    // Se a rodada tivesse chamado o canário, ele levantaria e isto falharia.
    expect(r.processados).toBe(5);
    expect(r.erros).toBe(0);
    await db.close();
  });
});

// ===========================================================================
describe("LOTE PEQUENO E ORÇAMENTO DE TEMPO", () => {
  it("nunca processa mais que o lote", async () => {
    const db = await abrir();
    for (let n = 1; n <= 12; n++) await pag(db, n);
    const r = await rodar(db, { lote: 5 });
    expect(r.processados).toBe(5);
    expect((await q1(db, `select count(*)::int n from public._dub_chamadas`)).n).toBe(5);
    await db.close();
  });

  it("para no meio quando o tempo acaba, e marca esgotou_tempo", async () => {
    const db = await abrir();
    for (let n = 1; n <= 10; n++) await pag(db, n, { dormeMs: 400 });
    const r = await rodar(db, { lote: 10, seg: 1 });
    expect(r.processados).toBeGreaterThan(0);
    expect(r.processados).toBeLessThan(10);
    expect(r.esgotou_tempo).toBe(true);
    await db.close();
  });

  it("a rodada seguinte continua de onde parou, sem repetir nem perder", async () => {
    const db = await abrir();
    for (let n = 1; n <= 6; n++) await pag(db, n, { motorStatus: "BAIXADO", baixou: true });
    const r1 = await rodar(db, { lote: 3 });
    const r2 = await rodar(db, { lote: 3 });
    expect(r1.processados).toBe(3);
    expect(r2.processados).toBe(3);
    // 6 chamadas, 6 pagamentos distintos: ninguém repetido, ninguém esquecido.
    const c = await q1(db, `select count(*)::int total, count(distinct pagamento_id)::int unicos
                              from public._dub_chamadas`);
    expect(c.total).toBe(6);
    expect(c.unicos).toBe(6);
    expect(r2.pendentes).toBe(0);
    await db.close();
  });

  it("o orçamento tem teto duro de 120s e o lote de 500", async () => {
    const db = await abrir();
    const r = await rodar(db, { lote: 9999, seg: 9999 });
    expect(r.orcamento_s).toBe(120);
    expect(r.lote).toBe(500);
    await db.close();
  });
});

// ===========================================================================
describe("NÃO REPROCESSA O HISTÓRICO", () => {
  it("a fronteira de 14/09 é respeitada: status_conciliacao NULL nunca é tocado", async () => {
    const db = await abrir();
    // legado: sem status, como os 8.955 reais de 01/07 a 11/09
    for (let n = 50; n < 55; n++) {
      await db.query(
        `insert into public.pagamentos (id, cpf, data_pagamento, valor_pago, status_conciliacao)
         values ($1,$2,'2026-08-01',100,null)`, [U(n), String(n)]);
    }
    await pag(db, 1);
    const r = await rodar(db);
    expect(r.processados).toBe(1);
    const tocados = await qn(db, `select pagamento_id from public._dub_chamadas`);
    expect(tocados).toHaveLength(1);
    expect(tocados[0].pagamento_id).toBe(U(1));
    // e os legados seguem com status nulo
    expect((await q1(db, `select count(*)::int n from public.pagamentos
                           where status_conciliacao is null`)).n).toBe(5);
    await db.close();
  });

  it("BAIXADO não volta para a fila", async () => {
    const db = await abrir();
    await pag(db, 1, { status: "BAIXADO" });
    await pag(db, 2);
    const r = await rodar(db);
    expect(r.processados).toBe(1);
    expect((await q1(db, `select pagamento_id from public._dub_chamadas`)).pagamento_id).toBe(U(2));
    await db.close();
  });

  it("o que a gestão já decidiu não volta sozinho", async () => {
    const db = await abrir();
    await pag(db, 1, { decisao: "IGNORAR" });
    await pag(db, 2);
    const r = await rodar(db);
    expect(r.processados).toBe(1);
    expect((await q1(db, `select pagamento_id from public._dub_chamadas`)).pagamento_id).toBe(U(2));
    await db.close();
  });
});

// ===========================================================================
describe("ESPERA: para de girar em falso nos casos sem saída", () => {
  it("muitas tentativas + tentado agora = fica de fora desta rodada", async () => {
    const db = await abrir();
    await pag(db, 1, { tentativas: 241, ultimaTentativaHorasAtras: 1 });
    await pag(db, 2, { tentativas: 0 });
    const r = await rodar(db, { tent: 8, espera: 24 });
    expect(r.processados).toBe(1);
    expect((await q1(db, `select pagamento_id from public._dub_chamadas`)).pagamento_id).toBe(U(2));
    await db.close();
  });

  it("muitas tentativas + espera vencida = volta a ser tentado", async () => {
    const db = await abrir();
    await pag(db, 1, { tentativas: 241, ultimaTentativaHorasAtras: 30 });
    const r = await rodar(db, { tent: 8, espera: 24 });
    expect(r.processados).toBe(1);
    await db.close();
  });

  it("quem nunca foi tentado vai PRIMEIRO", async () => {
    const db = await abrir();
    await pag(db, 1, { tentativas: 5, ultimaTentativaHorasAtras: 48 });
    await pag(db, 2, { tentativas: 3, ultimaTentativaHorasAtras: 48 });
    await pag(db, 3, { naFila: false }); // nunca entrou na fila: zero tentativa
    const r = await rodar(db, { lote: 1 });
    expect(r.processados).toBe(1);
    expect((await q1(db, `select pagamento_id from public._dub_chamadas`)).pagamento_id).toBe(U(3));
    await db.close();
  });
});

// ===========================================================================
describe("UM PAGAMENTO RUIM NÃO DERRUBA A RODADA", () => {
  it("conta o erro, guarda o primeiro e segue com os outros", async () => {
    const db = await abrir();
    await pag(db, 1, { levanta: "boom no motor" });
    for (let n = 2; n <= 5; n++) await pag(db, n, { motorStatus: "BAIXADO", baixou: true });
    const r = await rodar(db);
    expect(r.erros).toBe(1);
    expect(r.primeiro_erro).toMatch(/boom no motor/);
    expect(r.processados).toBe(4);
    expect(r.baixados).toBe(4);
    await db.close();
  });
});

// ===========================================================================
describe("INDICADORES só depois de processamento confirmado", () => {
  it("baixou > 0 no modo aplicado: atualiza", async () => {
    const db = await abrir();
    await pag(db, 1, { motorStatus: "BAIXADO", baixou: true });
    const r = await rodar(db);
    expect(r.baixados).toBe(1);
    expect(r.indicadores).toBe("atualizado");
    expect((await q1(db, `select count(*)::int n from public._dub_indicadores`)).n).toBe(1);
    await db.close();
  });

  it("nada baixou: não gasta banco recalculando", async () => {
    const db = await abrir();
    await pag(db, 1, { motorStatus: "AGUARDANDO_ACORDO", baixou: false });
    const r = await rodar(db);
    expect(r.baixados).toBe(0);
    expect(r.indicadores).toBe("nao_precisou");
    expect((await q1(db, `select count(*)::int n from public._dub_indicadores`)).n).toBe(0);
    await db.close();
  });

  it("prévia nunca mexe em indicador nem em pagamento", async () => {
    const db = await abrir();
    await pag(db, 1, { motorStatus: "BAIXADO", baixou: true });
    const r = await rodar(db, { aplicar: false });
    expect(r.modo).toBe("previa");
    expect(r.indicadores).toBe("nao_precisou");
    expect((await q1(db, `select status_conciliacao s from public.pagamentos where id=$1`, [U(1)])).s)
      .toBe("AGUARDANDO_ACORDO");
    await db.close();
  });

  it("indicador que falha NÃO desfaz a baixa legítima", async () => {
    const db = await abrir();
    await db.query(`insert into public._dub_indicadores_falha (falhar) values (true)`);
    await pag(db, 1, { motorStatus: "BAIXADO", baixou: true });
    const r = await rodar(db);
    expect(r.baixados).toBe(1);
    expect(r.indicadores).toMatch(/^falhou:/);
    expect((await q1(db, `select status_conciliacao s from public.pagamentos where id=$1`, [U(1)])).s)
      .toBe("BAIXADO");
    await db.close();
  });
});

// ===========================================================================
describe("MONITORAMENTO", () => {
  it("cada rodada deixa uma linha com processados, baixados, pendentes, erros e duração", async () => {
    const db = await abrir();
    await pag(db, 1, { motorStatus: "BAIXADO", baixou: true });
    await pag(db, 2, { levanta: "erro x" });
    await pag(db, 3);
    await rodar(db);

    const m = await q1(db, `select * from public.vw_fluxo_pagamentos_monitor limit 1`);
    expect(m.origem).toBe("incremental");
    expect(m.situacao).toBe("aplicado");
    expect(m.processados).toBe(2);
    expect(m.baixados).toBe(1);
    expect(m.erros).toBe(1);
    expect(m.pendentes).toBe(2); // o que levantou e o que ficou AGUARDANDO
    expect(m.duracao_ms).toBeGreaterThanOrEqual(0);
    expect(m.minutos_atras).toBeLessThanOrEqual(1);
    expect(m.erro).toMatch(/erro x/);
    expect(m.carteira_antes).not.toBeNull();
    await db.close();
  });

  it("a view ordena da mais recente para a mais antiga", async () => {
    const db = await abrir();
    await pag(db, 1);
    await rodar(db, { lote: 1 });
    await pag(db, 2);
    await rodar(db, { lote: 1 });
    const r = await qn(db, `select rodou_em from public.vw_fluxo_pagamentos_monitor`);
    expect(r).toHaveLength(2);
    expect(new Date(r[0].rodou_em) >= new Date(r[1].rodou_em)).toBe(true);
    await db.close();
  });

  it("a view não é legível por anon", async () => {
    const db = await abrir();
    // Privilégio EFETIVO, que é o que vale: `anon` não alcança a view.
    // O excesso de privilégio de `authenticated` neste estágio é o defeito
    // tratado em "MONITOR: escrita fechada e leitura preservada".
    const r = await q1(db, `select
        has_table_privilege('anon','public.vw_fluxo_pagamentos_monitor','select') anon_le,
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','select') auth_le`);
    expect(r.anon_le).toBe(false);
    expect(r.auth_le).toBe(true);
    await db.close();
  });
});

// ===========================================================================
describe("a migration e o rollback", () => {
  it("antes da migration a função e a view não existem", async () => {
    const db = await abrir(false);
    expect((await q1(db, `select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`)).n).toBe(0);
    expect((await q1(db, `select count(*)::int n from pg_views
                           where schemaname='public' and viewname='vw_fluxo_pagamentos_monitor'`)).n).toBe(0);
    await db.close();
  });

  it("o rollback apaga as duas e PRESERVA a trilha de execuções", async () => {
    const db = await abrir();
    await pag(db, 1, { motorStatus: "BAIXADO", baixou: true });
    await rodar(db);
    const antes = (await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n;
    expect(antes).toBe(1);

    await db.exec(ROLLBACK);
    expect((await q1(db, `select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`)).n).toBe(0);
    expect((await q1(db, `select count(*)::int n from pg_views
                           where schemaname='public' and viewname='vw_fluxo_pagamentos_monitor'`)).n).toBe(0);
    // a trilha fica, e o pagamento baixado continua baixado
    expect((await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n).toBe(1);
    expect((await q1(db, `select status_conciliacao s from public.pagamentos where id=$1`, [U(1)])).s)
      .toBe("BAIXADO");
    await db.close();
  });

  it("a migration é idempotente: aplicar duas vezes não muda nada", async () => {
    const db = await abrir();
    await db.exec(MIGRATION);
    await pag(db, 1);
    expect((await rodar(db)).processados).toBe(1);
    await db.close();
  });
});

// ===========================================================================
// CORREÇÃO 1 — a view de monitoramento fecha a escrita.
// ===========================================================================
describe("MONITOR: escrita fechada e leitura preservada", () => {
  // Privilégio EFETIVO, não o que a migration pediu: é has_table_privilege
  // que diz a verdade depois da herança do schema.
  const efetivo = async (db, papel, obj) =>
    await q1(db, `select
        has_table_privilege($1,$2,'select') s,
        has_table_privilege($1,$2,'insert') i,
        has_table_privilege($1,$2,'update') u,
        has_table_privilege($1,$2,'delete') d,
        has_table_privilege($1,$2,'truncate') t`, [papel, obj]);

  it("ANTES da correção o defeito existe — a bancada reproduz o problema", async () => {
    const db = await abrir("base");
    const v = await efetivo(db, "authenticated", "public.vw_fluxo_pagamentos_monitor");
    // é isto que a correção precisa apagar
    expect(v.d).toBe(true);
    expect(v.u).toBe(true);
    expect((await q1(db, `select pg_relation_is_updatable('public.vw_fluxo_pagamentos_monitor'::regclass, true) b`)).b)
      .toBe(28);
    await db.close();
  });

  it("DEPOIS: authenticated só lê a view — nada de insert, update, delete, truncate", async () => {
    const db = await abrir("final");
    const v = await efetivo(db, "authenticated", "public.vw_fluxo_pagamentos_monitor");
    expect(v.s).toBe(true);
    expect([v.i, v.u, v.d, v.t]).toEqual([false, false, false, false]);
    await db.close();
  });

  it("DEPOIS: authenticated só lê a TABELA BASE — a porta direta também fecha", async () => {
    const db = await abrir("final");
    const t = await efetivo(db, "authenticated", "public.fluxo_pagamentos_execucoes");
    expect(t.s).toBe(true);
    expect([t.i, t.u, t.d, t.t]).toEqual([false, false, false, false]);
    await db.close();
  });

  it("DEPOIS: anon não alcança nem a view nem a tabela", async () => {
    const db = await abrir("final");
    const v = await efetivo(db, "anon", "public.vw_fluxo_pagamentos_monitor");
    const t = await efetivo(db, "anon", "public.fluxo_pagamentos_execucoes");
    expect([v.s, v.i, v.u, v.d, v.t]).toEqual([false, false, false, false, false]);
    expect([t.s, t.i, t.u, t.d, t.t]).toEqual([false, false, false, false, false]);
    await db.close();
  });

  it("DEPOIS: service_role continua lendo (ele bypassa RLS)", async () => {
    const db = await abrir("final");
    const v = await efetivo(db, "service_role", "public.vw_fluxo_pagamentos_monitor");
    expect(v.s).toBe(true);
    expect((await q1(db, `select rolbypassrls b from pg_roles where rolname='service_role'`)).b).toBe(true);
    await db.close();
  });

  it("DEPOIS: security_invoker está LIGADO na view", async () => {
    const db = await abrir("final");
    const r = await q1(db,
      `select coalesce(array_to_string(c.reloptions,','),'(sem)') op
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname='vw_fluxo_pagamentos_monitor'`);
    expect(r.op).toMatch(/security_invoker=(true|on)/);
    await db.close();
  });

  it("DELETE pela view é RECUSADO para authenticated", async () => {
    const db = await abrir("final");
    await pag(db, 1);
    await rodar(db, { lote: 1 });
    expect((await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n).toBe(1);

    await db.exec("set role authenticated");
    await expect(db.query(`delete from public.vw_fluxo_pagamentos_monitor`))
      .rejects.toThrow(/permission denied|permissão/i);
    await expect(db.query(`delete from public.fluxo_pagamentos_execucoes`))
      .rejects.toThrow(/permission denied|permissão/i);
    await db.exec("reset role");

    expect((await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n).toBe(1);
    await db.close();
  });

  it("a gestão logada LÊ pela view; operador logado vê ZERO linhas (é o RLS)", async () => {
    const db = await abrir("final");
    await pag(db, 1);
    await rodar(db, { lote: 1 });

    await db.exec("set role authenticated");
    await como(db, GESTAO);
    const daGestao = await qn(db, `select rodou_em from public.vw_fluxo_pagamentos_monitor`);
    await como(db, OPERADOR);
    const doOperador = await qn(db, `select rodou_em from public.vw_fluxo_pagamentos_monitor`);
    await db.exec("reset role");
    await como(db, GESTAO);

    expect(daGestao).toHaveLength(1);
    expect(doOperador).toHaveLength(0); // sem erro: RLS filtra, não recusa
    await db.close();
  });

  it("a rodada (SECURITY DEFINER) continua gravando o monitoramento com o RLS ligado", async () => {
    const db = await abrir("final");
    await pag(db, 1);
    const r = await rodar(db, { lote: 1 });
    expect(r.processados).toBe(1);
    expect((await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n).toBe(1);
    await db.close();
  });

  it("o rollback das permissões devolve o estado anterior", async () => {
    const db = await abrir("final");
    await db.exec(RB_PERM);
    const v = await q1(db, `select
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','delete') d,
        coalesce(array_to_string(c.reloptions,','),'(sem)') op
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='vw_fluxo_pagamentos_monitor'`);
    expect(v.d).toBe(true);
    expect(v.op).toMatch(/security_invoker=(false|off)|^\(sem\)$/);
    await db.close();
  });
});

// ===========================================================================
// CORREÇÃO 2 — a prévia não escreve, e isso é GARANTIA do banco.
// ===========================================================================
describe("PRÉVIA: subtransação sempre revertida", () => {
  // Digital de LINHA INTEIRA, não só de status_conciliacao. Qualquer coluna
  // que mude em qualquer das seis tabelas muda o hash.
  const digitalFinanceira = async (db) => await q1(db, `select
      md5(coalesce((select string_agg(p::text, '|' order by p.id) from public.pagamentos p),'')) pagamentos,
      md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.parcelas x),'')) parcelas,
      md5(coalesce((select string_agg(a::text, '|' order by a.id) from public.acordos a),'')) acordos,
      md5(coalesce((select string_agg(b::text, '|' order by b.id) from public.baixas_pagamento b),'')) baixas,
      md5(coalesce((select string_agg(u::text, '|' order by u.id) from public.auditoria u),'')) auditoria,
      md5(coalesce((select string_agg(f::text, '|' order by f.id) from public.fila_pagamento_sem_vinculo f),'')) fila,
      (select count(*)::int from public.pagamentos) n_pag,
      (select count(*)::int from public.parcelas) n_parc,
      (select count(*)::int from public.acordos) n_ac,
      (select count(*)::int from public.baixas_pagamento) n_baixas,
      (select count(*)::int from public.auditoria) n_aud,
      (select count(*)::int from public.fila_pagamento_sem_vinculo) n_fila,
      (select count(*)::int from public._efeito_indireto) n_gatilho`);

  // Monta um cenário com conteúdo nas seis tabelas e o dublê SUJO ligado.
  async function cenarioSujo(db) {
    for (let n = 1; n <= 3; n++) await pag(db, n, { motorStatus: "BAIXADO", baixou: true });
    await db.query(`insert into public.parcelas (id, acordo_id, numero, valor, vencimento, status)
                    values ($1,$2,1,500,'2026-10-10','A_VENCER')`, [U(7001), U(7101)]);
    await db.query(`insert into public.acordos (id, aluno_id, status, saldo)
                    values ($1,$2,'ATIVO',500)`, [U(7101), U(901)]);
    await db.query(`insert into public.baixas_pagamento (id, aluno_id, valor_pago, status_baixa)
                    values ($1,$2,500,'AGUARDANDO')`, [U(7201), U(901)]);
    await db.query(`insert into public.auditoria (usuario, acao) values ('setup','SETUP')`);
    await db.query(`insert into public._dub_sujo (ligado) values (true)`);
  }

  it("SENSIBILIDADE: com o dublê sujo, o modo APLICADO muda tudo — o teste detecta escrita", async () => {
    const db = await abrir("final");
    await cenarioSujo(db);
    const antes = await digitalFinanceira(db);
    await rodar(db, { lote: 3, aplicar: true });
    const depois = await digitalFinanceira(db);
    // Se o teste não detectasse escrita, o caso seguinte não valeria nada.
    expect(depois.pagamentos).not.toBe(antes.pagamentos);
    expect(depois.parcelas).not.toBe(antes.parcelas);
    expect(depois.acordos).not.toBe(antes.acordos);
    expect(depois.auditoria).not.toBe(antes.auditoria);
    expect(depois.fila).not.toBe(antes.fila);
    expect(depois.n_gatilho).toBeGreaterThan(antes.n_gatilho);
    await db.close();
  });

  it("A PROVA: na prévia, o MESMO dublê sujo não deixa UMA linha para trás", async () => {
    const db = await abrir("final");
    await cenarioSujo(db);
    const antes = await digitalFinanceira(db);

    const r = await rodar(db, { lote: 3, aplicar: false });
    const depois = await digitalFinanceira(db);

    // seis tabelas, linha inteira, e as contagens
    expect(depois.pagamentos).toBe(antes.pagamentos);
    expect(depois.parcelas).toBe(antes.parcelas);
    expect(depois.acordos).toBe(antes.acordos);
    expect(depois.baixas).toBe(antes.baixas);
    expect(depois.auditoria).toBe(antes.auditoria);
    expect(depois.fila).toBe(antes.fila);
    expect(depois.n_pag).toBe(antes.n_pag);
    expect(depois.n_parc).toBe(antes.n_parc);
    expect(depois.n_ac).toBe(antes.n_ac);
    expect(depois.n_baixas).toBe(antes.n_baixas);
    expect(depois.n_aud).toBe(antes.n_aud);
    expect(depois.n_fila).toBe(antes.n_fila);
    // EFEITO INDIRETO: o gatilho de `pagamentos` também foi desfeito
    expect(depois.n_gatilho).toBe(antes.n_gatilho);

    // e a prévia ainda informa o que teria acontecido
    expect(r.modo).toBe("previa");
    expect(r.previa_revertida).toBe(true);
    expect(r.processados).toBe(3);
    await db.close();
  });

  it("o RESULTADO do motor sobrevive à reversão (variável de PL/pgSQL não é transacional)", async () => {
    const db = await abrir("final");
    await cenarioSujo(db);
    const r = await rodar(db, { lote: 3, aplicar: false });
    // o dublê devolveu status BAIXADO e baixou=true; a contagem veio dele
    expect(r.por_status.BAIXADO).toBe(3);
    expect(r.baixados).toBe(3);
    // ...e nada disso virou escrita
    expect((await q1(db, `select count(*)::int n from public.pagamentos
                           where status_conciliacao='SUJO_ESCREVEU'`)).n).toBe(0);
    await db.close();
  });

  it("a ÚNICA escrita que sobra na prévia é o registro de monitoramento", async () => {
    const db = await abrir("final");
    await cenarioSujo(db);
    const execAntes = (await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n;
    await rodar(db, { lote: 3, aplicar: false });
    const m = await q1(db, `select * from public.vw_fluxo_pagamentos_monitor limit 1`);
    expect((await q1(db, `select count(*)::int n from public.fluxo_pagamentos_execucoes`)).n)
      .toBe(execAntes + 1);
    expect(m.situacao).toBe("previa");
    expect(m.processados).toBe(3);
    await db.close();
  });

  it("na prévia o indicador gerencial nunca é tocado, mesmo com baixados > 0", async () => {
    const db = await abrir("final");
    await cenarioSujo(db);
    const r = await rodar(db, { lote: 3, aplicar: false });
    expect(r.baixados).toBe(3);
    expect(r.indicadores).toBe("nao_precisou");
    expect((await q1(db, `select count(*)::int n from public._dub_indicadores`)).n).toBe(0);
    await db.close();
  });

  it("erro REAL do motor na prévia é contado como erro, não confundido com a reversão", async () => {
    const db = await abrir("final");
    await pag(db, 1, { levanta: "falha de verdade" });
    await pag(db, 2);
    const r = await rodar(db, { lote: 2, aplicar: false });
    expect(r.erros).toBe(1);
    expect(r.primeiro_erro).toMatch(/falha de verdade/);
    expect(r.processados).toBe(1);
    await db.close();
  });

  it("o modo aplicado segue funcionando igual depois da correção", async () => {
    const db = await abrir("final");
    for (let n = 1; n <= 4; n++) await pag(db, n, { motorStatus: "BAIXADO", baixou: true });
    const r = await rodar(db, { lote: 4, aplicar: true });
    expect(r.processados).toBe(4);
    expect(r.baixados).toBe(4);
    expect(r.previa_revertida).toBe(false);
    expect(r.indicadores).toBe("atualizado");
    expect((await q1(db, `select count(*)::int n from public.pagamentos
                           where status_conciliacao='BAIXADO'`)).n).toBe(4);
    await db.close();
  });
});

// ===========================================================================
// CORREÇÃO 3 — a espera DESPRIORIZA, nunca exclui.
// ===========================================================================
describe("ESPERA: ninguém fica invisível", () => {
  // Veterano: muitas tentativas E tentado agora. É o perfil dos 365 de
  // produção, cujo `ultima_tentativa_em` um lote de importação havia acabado
  // de reescrever.
  async function cenario(db) {
    await pag(db, 1, { tentativas: 241, ultimaTentativaHorasAtras: 1 });
    await pag(db, 2, { tentativas: 90, ultimaTentativaHorasAtras: 1 });
    await pag(db, 3, { tentativas: 2, ultimaTentativaHorasAtras: 1 });  // "novo"
  }

  // NOTA: estes casos rodam em modo APLICADO de propósito. Na prévia, a
  // escrita do próprio dublê (`_dub_chamadas`) é revertida junto com tudo o
  // mais -- é a correção da prévia funcionando -- então a ordem de chamada só é
  // observável com p_aplicar => true. O dublê devolve AGUARDANDO_ACORDO, logo
  // nada baixa e a composição da fila não muda.
  it("ANTES da correção o defeito existe: veterano recém-tentado é EXCLUÍDO", async () => {
    const db = await abrir("final");
    await cenario(db);
    const r = await rodar(db, { lote: 25, aplicar: true });
    // só o de 2 tentativas entra; os dois veteranos ficam invisíveis
    expect(r.processados).toBe(1);
    const vistos = (await qn(db, `select distinct pagamento_id from public._dub_chamadas`))
      .map((x) => x.pagamento_id);
    expect(vistos).toEqual([U(3)]);
    await db.close();
  });

  it("DEPOIS: os três entram, e o novo vem PRIMEIRO", async () => {
    const db = await abrir("espera");
    await cenario(db);
    const r = await rodar(db, { lote: 25, aplicar: true });
    expect(r.processados).toBe(3);
    const ordem = (await qn(db, `select pagamento_id from public._dub_chamadas order by n`))
      .map((x) => x.pagamento_id);
    expect(ordem[0]).toBe(U(3));          // menos tentativas primeiro
    expect(ordem.slice(1).sort()).toEqual([U(1), U(2)].sort());
    await db.close();
  });

  it("DEPOIS: com o lote cheio, o veterano vai para o FIM e não rouba a vaga do novo", async () => {
    const db = await abrir("espera");
    // 3 veteranos recém-tentados + 2 novos, lote 2: só os novos devem passar
    await pag(db, 1, { tentativas: 241, ultimaTentativaHorasAtras: 1 });
    await pag(db, 2, { tentativas: 150, ultimaTentativaHorasAtras: 1 });
    await pag(db, 3, { tentativas: 99, ultimaTentativaHorasAtras: 1 });
    await pag(db, 4, { tentativas: 1, ultimaTentativaHorasAtras: 2 });
    await pag(db, 5, { tentativas: 0 });
    const r = await rodar(db, { lote: 2, aplicar: true });
    expect(r.processados).toBe(2);
    const vistos = (await qn(db, `select pagamento_id from public._dub_chamadas order by n`))
      .map((x) => x.pagamento_id);
    expect(vistos).toEqual([U(5), U(4)]); // nunca tentado, depois 1 tentativa
    await db.close();
  });

  it("DEPOIS: nenhum elegível fica de fora -- 30 pendentes em rodadas de 25 cobrem os 30", async () => {
    const db = await abrir("espera");
    for (let n = 1; n <= 30; n++) {
      await pag(db, n, { tentativas: 50 + n, ultimaTentativaHorasAtras: 1,
                         motorStatus: "BAIXADO", baixou: true });
    }
    const r1 = await rodar(db, { lote: 25 });
    const r2 = await rodar(db, { lote: 25 });
    expect(r1.processados).toBe(25);
    expect(r2.processados).toBe(5);
    const c = await q1(db, `select count(*)::int total, count(distinct pagamento_id)::int unicos
                              from public._dub_chamadas`);
    expect(c.total).toBe(30);
    expect(c.unicos).toBe(30);   // nenhum repetido, nenhum esquecido
    expect(r2.pendentes).toBe(0);
    await db.close();
  });

  it("o gatilho de produção reproduz a causa: QUALQUER update renova ultima_tentativa_em", async () => {
    const db = await abrir("espera");
    await pag(db, 1, { tentativas: 5, ultimaTentativaHorasAtras: 48 });
    await db.exec(`alter table public.fila_pagamento_sem_vinculo
                   enable trigger trg_fila_pagamento_tentativa`);
    const antes = await q1(db, `select quantidade_tentativas t, ultima_tentativa_em u
                                  from public.fila_pagamento_sem_vinculo where pagamento_id=$1`, [U(1)]);
    // um update que NADA tem a ver com tentativa -- como o de um lote de importação
    await db.query(`update public.fila_pagamento_sem_vinculo set motivo = 'lote de importacao'
                     where pagamento_id=$1`, [U(1)]);
    const depois = await q1(db, `select quantidade_tentativas t, ultima_tentativa_em u
                                   from public.fila_pagamento_sem_vinculo where pagamento_id=$1`, [U(1)]);
    expect(depois.t).toBe(antes.t + 1);
    expect(new Date(depois.u) > new Date(antes.u)).toBe(true);
    await db.exec(`alter table public.fila_pagamento_sem_vinculo
                   disable trigger trg_fila_pagamento_tentativa`);
    await db.close();
  });
});

// ===========================================================================
// A JANELA DA NOITE: conferência sem baixa.
// ===========================================================================
describe("CONFERÊNCIA NOTURNA: p_aplicar => false é o modo da janela", () => {
  it("o job da noite usa p_aplicar => false e os outros dois true", async () => {
    // Lê a migration de agendamento como texto: é a configuração definitiva.
    const noite = MIG_CRON.match(/fluxo_pag_conferencia_noite_brt'[\s\S]*?\$\$([\s\S]*?)\$\$/);
    const consolidado = MIG_CRON.match(/fluxo_pag_consolidado_08h_brt'[\s\S]*?\$\$([\s\S]*?)\$\$/);
    const horario = MIG_CRON.match(/fluxo_pag_horario_09_20h_brt'[\s\S]*?\$\$([\s\S]*?)\$\$/);
    expect(noite[1]).toMatch(/,\s*false\)/);
    expect(consolidado[1]).toMatch(/,\s*true\)/);
    expect(horario[1]).toMatch(/,\s*true\)/);
    // lote 25 nos três, como a gestão fixou
    for (const m of [noite, consolidado, horario]) expect(m[1]).toMatch(/\(25,/);
  });

  it("as expressões de cron estão em UTC e cobrem as janelas de Brasília", () => {
    expect(MIG_CRON).toContain("'0 11 * * *'");        // 08:00 BRT
    expect(MIG_CRON).toContain("'0 12-23 * * *'");     // 09:00-20:00 BRT
    expect(MIG_CRON).toContain("'30 23,0,1,2 * * *'"); // 20:30-23:30 BRT
    // a madrugada de Brasília (UTC 03-10) não tem job
    expect(MIG_CRON).not.toMatch(/'[0-9,*/-]+ (3|4|5|6|7|8|9|10) \* \* \*'/);
  });

  it("a migration de agendamento RECUSA se o job 38 estiver ativo", () => {
    expect(MIG_CRON).toMatch(/jobid = 38 and active/);
    expect(MIG_CRON).toMatch(/RECUSADO/);
  });

  it("a conferência não avança o contador de tentativas (não empurra ninguém para o fim)", async () => {
    const db = await abrir("espera");
    await pag(db, 1, { tentativas: 3, ultimaTentativaHorasAtras: 5 });
    await db.exec(`alter table public.fila_pagamento_sem_vinculo
                   enable trigger trg_fila_pagamento_tentativa`);
    const antes = await q1(db, `select quantidade_tentativas t from public.fila_pagamento_sem_vinculo
                                 where pagamento_id=$1`, [U(1)]);
    await rodar(db, { lote: 25, aplicar: false });
    const depois = await q1(db, `select quantidade_tentativas t from public.fila_pagamento_sem_vinculo
                                  where pagamento_id=$1`, [U(1)]);
    expect(depois.t).toBe(antes.t);
    await db.exec(`alter table public.fila_pagamento_sem_vinculo
                   disable trigger trg_fila_pagamento_tentativa`);
    await db.close();
  });
});
