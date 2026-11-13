// LIBERAÇÃO DO GIRO EM TRÊS LOTES — backup, controle por lote e restauração.
//
// Roda os TRÊS scripts de operação REAIS (supabase/recovery/20261112_giro_
// fidelizacao_0{0,1,2}_*.sql) sobre a bancada FIEL: a cadeia de funções e
// gatilhos que a liberação dispara em produção (corpos de 12/11/2026 conferidos
// por md5), inclusive `set_resp_aluno` com o dono de produção e o guard
// `_guard_resp_aluno`. A migration 20261112210000 está aplicada na bancada.
//
// NADA disto foi executado em produção. NENHUM DADO REAL.
//
// O que se prova aqui:
//   1. o backup guarda o universo certo, em 3 lotes fixos, sem dado pessoal;
//   2. cada lote libera SÓ os seus ids -- os outros elegíveis continuam com o
//      operador (e o cron, se estivesse ativo, soltaria todos: por isso a trava);
//   3. as 4 travas abortam sem soltar nada;
//   4. retorno do operador, acordo, giro vigente, hold, congelado, Carteira
//      Geral e quem ganhou proteção depois do backup NUNCA são liberados;
//   5. a restauração devolve o estado campo a campo, não sobrescreve quem já
//      tem dono e se desfaz inteira se qualquer campo divergir.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const FX = "supabase/tests/fixtures/";

const CADEIA = [
  ler(`${FX}fidelizacao_por_dono_prod_20260930.sql`),
  ler(`${FX}nivelamento_m3_prod_20261021.sql`),
  ler(`${FX}assumir_caso_livre_prod_20261020.sql`),
  ler("supabase/migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql"),
  ler(`${FX}onda1_executor_prod_20261021.sql`),
  ler(`${FX}fidelizacao_giro_prod_20261112.sql`),
  ler(`${FX}fidelizacao_giro_lotes_prod_20261112.sql`),
];
const MD5_PROD = {
  ...JSON.parse(ler(`${FX}fidelizacao_giro_prod_20261112.md5.json`)),
  ...JSON.parse(ler(`${FX}fidelizacao_giro_lotes_prod_20261112.md5.json`)),
};
const PASTA = "supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias";
const MIGRATION = ler(`${PASTA}.sql.pendente`);
const BACKUP = ler("supabase/recovery/20261112_giro_fidelizacao_00_backup.sql");
const LOTE = ler("supabase/recovery/20261112_giro_fidelizacao_01_liberar_lote.sql");
const RESTAURAR = ler("supabase/recovery/20261112_giro_fidelizacao_02_restaurar.sql");

const comLote = (n) => {
  const t = LOTE.replace(/v_lote int := 1; --/, `v_lote int := ${n}; --`);
  if (t === LOTE && n !== 1) throw new Error("linha v_lote nao encontrada no script de lote");
  return t;
};
// Por padrao os testes de MECANICA da restauracao rodam com a regra nova no ar
// (v_exigir_regra_antiga := false, a excecao que o script preve). A ordem real
// de reversao -- rollback da migration ANTES -- tem teste proprio, com o script
// intocado.
const comRestauro = (n, { exigirRegraAntiga = false } = {}) => {
  let t = RESTAURAR.replace(/v_lote int := 0; --/, `v_lote int := ${n}; --`);
  if (t === RESTAURAR && n !== 0) throw new Error("linha v_lote nao encontrada no script de restauracao");
  if (!exigirRegraAntiga) {
    const t2 = t.replace(/v_exigir_regra_antiga boolean := true; --/, "v_exigir_regra_antiga boolean := false; --");
    if (t2 === t) throw new Error("linha v_exigir_regra_antiga nao encontrada");
    t = t2;
  }
  return t;
};

const GESTAO = "amanda.seibel@aelbra.com.br";
const OPS = {
  13: { email: "cobranca13@aelbra.com.br", nome: "DIEGO" },
  6: { email: "cobranca06@aelbra.com.br", nome: "MAURICIO" },
  5: { email: "cobranca05@aelbra.com.br", nome: "LUANA" },
  12: { email: "cobranca12@aelbra.com.br", nome: "RAFAELLA" },
};

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(50000000000 + n);
const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [email ? JSON.stringify({ email }) : ""]);

async function construir() {
  const db = new PGlite({ extensions: ext });
  for (const sql of CADEIA) await db.exec(sql);
  const noBanco = Object.fromEntries((await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','internal')`))
    .map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5_PROD)) {
    if (noBanco[nome] !== md5) throw new Error(`bancada diverge de producao: ${nome}`);
  }
  await db.exec(`
    create or replace function auth.jwt() returns jsonb language sql stable as $stub$
      select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    $stub$;
    -- stub do pg_cron: so o necessario para a trava 1 ler.
    create schema if not exists cron;
    create table cron.job (jobid int primary key, jobname text, active boolean);
    insert into cron.job values (8, 'fidelizacao_liberar_vencidos', false),
                                (43, 'reposicao_carteira_minuto', false);
    -- privilegios padrao do Supabase em producao (medido em 12/11): tabela nova
    -- em public nasce com TUDO para anon/authenticated/service_role. Sem isto o
    -- teste de grants do backup passaria mesmo com o revoke apagado.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ${Object.values(OPS).map((o) => `('${o.nome}', '${o.email}', 'operador', true, '${o.nome}', true)`).join(",")},
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null, false);
    insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '3000'::jsonb)
      on conflict (chave) do update set valor = excluded.valor;
  `);
  await db.exec(MIGRATION);
  await como(db, GESTAO);
  return db;
}

// Um caso completo (aluno + titulo + caso). Padrao: caso de giro com a data
// vencida ha 17 dias, parado ha 15, do cobranca13, elegivel por tudo.
async function cenario(db, n, o = {}) {
  const {
    op = 13, dono = null, dua = 15, giro = -17, acordoAtivo = false, statusAcion = null,
    retorno = null, retornoOrigem = null, proxima = null, hora = null, confirmado = false,
    respEmDias = 30, congelado = false, valor = 500, livre = false,
  } = o;
  const email = livre ? null : (dono ?? OPS[op].email);
  const nome = livre ? null : (dono ? "DONO CRU" : OPS[op].nome);
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em,
        status_acionamento, data_ultimo_acionamento, proxima_acao, data_retorno, hora_retorno, retorno_origem,
        retorno_confirmado_em, nivel_criticidade, status_atual, status_jornada)
     values ($1,$2,$3,$4,$5,$6, now() - ($7::int || ' days')::interval,
        $8, case when $9::int is null then null else (current_date - $9::int)::timestamptz + interval '15 hours' end, $10,
        case when $11::int is null then null else current_date + $11::int end, $12, $13,
        case when $14 then now() - interval '1 day' else null end, 'PERDENDO', 'EM COBRANCA', 'EM COBRANCA')`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, email, nome, respEmDias, statusAcion, dua, proxima, retorno, hora,
     retornoOrigem, confirmado]);
  await db.query(
    `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status)
     values ($1,$2,$3, current_date - 90, $4,$4,'ABERTO','em_aberto')`,
    [U(n), cpf, `DOC${n}`, valor]);
  if (acordoAtivo) {
    await db.query(
      `insert into public.acordos (aluno_id, cpf, status, numero_acordo, valor_total) values ($1,$2,'ATIVO',$3,100)`,
      [U(n), cpf, 70000 + n]);
  }
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome, operador,
        status_acionamento, data_ultimo_acionamento, giro_fidelizacao_ate, ultima_tabulacao_em, total_em_aberto,
        caso_codigo, caso_atualizado_em, nao_acionar)
     values ($1,$1,$2,$2,$3,$2,$4,$5,$5,$6,
        case when $7::int is null then null else current_date - $7::int end,
        case when $8::int is null then null else current_date + $8::int end,
        now() - interval '20 days', $9, $10, now() - interval '30 days', false)`,
    [U(n), cpf, `Aluno Sintetico ${n}`, email, nome, statusAcion, dua, giro, valor, n]);
  if (congelado) {
    await db.query("insert into public.caso_encerramento_sem_saldo (caso_id) values ($1)", [U(n)]);
  }
  // Retorno de OPERADOR nasce de um atendimento real do responsavel (regra de 13/11).
  // `semAtendimento` monta o retorno "solto" (envio em lote, digitado sem atender).
  if (retorno !== null && String(retornoOrigem || "").toUpperCase().startsWith("OPERADOR") && !o.semAtendimento && email) {
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_por_nome, registrado_em, data_retorno)
       values ($1, 'FINALIZACAO_ATENDIMENTO', 'atendimento sintetico', $2, 'DONO',
               (current_date - $3::int)::timestamp + interval '15 hours', (current_date + $4::int)::timestamp)`,
      [U(n), String(o.atendidoPor || email).toLowerCase(), o.atendidoHa ?? dua ?? 0, retorno]);
  }
}

// Segundo caso para um aluno que ja existe (ficha antiga). Em producao isso e
// legado: a trava "um aluno, um caso" so barra ficha NOVA aberta, e as antigas
// ficam com a coluna encerrado_operacional = true. Para montar o cenario a
// bancada insere com os gatilhos desligados -- e so o INSERT; tudo o que vem
// depois roda com os gatilhos de producao ligados.
async function irmao(db, n, alunoN, o = {}) {
  const { op = 13, dua = 15, giro = -17, statusAtual = null, colEnc = true } = o;
  await db.exec("alter table public.casos disable trigger user");
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome, operador,
        status_atual, data_ultimo_acionamento, giro_fidelizacao_ate, ultima_tabulacao_em, total_em_aberto,
        caso_codigo, caso_atualizado_em, nao_acionar, encerrado_operacional)
     values ($1,$2,$3,$3,$4,$3,$5,$6,$6,$7,
        case when $8::int is null then null else current_date - $8::int end,
        case when $9::int is null then null else current_date + $9::int end,
        now() - interval '20 days', 100, $10, now() - interval '30 days', false, $11)`,
    [U(n), U(alunoN), CPF(alunoN), `Aluno Sintetico ${alunoN}`, OPS[op].email, OPS[op].nome, statusAtual, dua, giro, n, colEnc]);
  await db.exec("alter table public.casos enable trigger user");
}

// O mundo padrao: 7 casos no universo (3 lotes) e 8 que NUNCA podem sair.
async function mundo(db) {
  await cenario(db, 1, { op: 13 });
  await cenario(db, 2, { op: 13, dua: 20, retorno: 5, retornoOrigem: "AUTOMATICO", proxima: "LIGAR", hora: "10:00", confirmado: true });
  await cenario(db, 3, { op: 6, dua: 12 });
  await cenario(db, 4, { op: 6, retorno: 4, retornoOrigem: "AUTOMATICO", proxima: "RETORNAR" });
  await cenario(db, 5, { op: 5, dua: 30 });
  await cenario(db, 6, { op: 12, dua: null });
  await cenario(db, 7, { op: 13, giro: null });          // sem marca de giro, mesmo assim elegivel
  // NUNCA saem:
  await cenario(db, 10, { op: 13, giro: 5 });            // giro ainda vigente
  await cenario(db, 11, { op: 13, dua: 4 });             // acionado ha 4 dias
  await cenario(db, 12, { op: 6, acordoAtivo: true });   // acordo ativo
  await cenario(db, 13, { op: 6, retorno: 0, retornoOrigem: "OPERADOR", proxima: "RETORNAR HOJE" }); // compromisso
  await cenario(db, 14, { dono: "carteira.geral@reativa.local" }); // Carteira Geral
  await cenario(db, 15, { op: 5, congelado: true });     // congelado
  await cenario(db, 16, { op: 12, respEmDias: 0 });      // assumido ha menos de 24h
  await cenario(db, 17, { op: 5, statusAcion: "EM NEGOCIACAO" }); // tratativa
}
const tipoDe = async (db, n) =>
  q1(db, "select tipo, lote, pulado_motivo, liberado_por from public._backup_fidelizacao_giro_20261112 where caso_id=$1", [U(n)]);
const UNIVERSO = [1, 2, 3, 4, 5, 6, 7];
const LOTES = { 1: [1, 2, 7], 2: [3, 4], 3: [5, 6] };
const PROTEGIDOS = [10, 11, 12, 13, 14, 15, 16, 17];

const snap = (db, ns) =>
  qn(db, `select c.id, c.operador_email, c.operador_nome, c.operador, c.giro_fidelizacao_ate::text giro,
                 c.status_atual sa_c, c.status_acionamento st_c, c.data_ultimo_acionamento::text dua_c,
                 a.responsavel_atual_email r_email, a.responsavel_atual_nome r_nome, a.responsavel_atual_em::text r_em,
                 a.status_atual sa_a, a.status_jornada sj, a.status_acionamento st_a, a.data_ultimo_acionamento::text dua_a,
                 a.proxima_acao, a.data_retorno::text ret, a.hora_retorno, a.retorno_origem, a.retorno_confirmado_em::text conf
            from public.casos c join public.alunos a on a.id = c.aluno_id
           where c.id = any($1::uuid[]) order by c.id`, [ns.map(U)]);
const donoDe = async (db, n) => (await q1(db, "select operador_email d from public.casos where id=$1", [U(n)])).d;
const semDono = async (db) => Number((await q1(db, "select count(*) n from public.casos where operador_email is null")).n);
const noBackup = async (db, where = "true") =>
  qn(db, `select caso_id, lote, liberado_em, pulado_motivo, restaurado_motivo from public._backup_fidelizacao_giro_20261112 where ${where} order by caso_id`);
const idsDe = (rows) => rows.map((r) => Number(String(r.caso_id).slice(-12))).sort((a, b) => a - b);
const tenta = async (db, sql) => {
  try { await db.exec(sql); return null; }
  catch (e) { await db.exec("rollback").catch(() => {}); return String(e.message); }
};

let BASE;
beforeAll(async () => {
  const db = await construir();
  BASE = await db.dumpDataDir();
  await db.close();
});
// CONTEXTO DE EXECUCAO: os scripts de operacao rodam em producao pelo SQL
// direto (papel postgres, SEM JWT de usuario) -- nao pela tela. A bancada abre
// nesse mesmo contexto; auth.jwt() devolve NULL, como no cron.
// A sessao do banco fica no fuso de Sao Paulo: os scripts comparam a data do
// banco com a de Sao Paulo, e isso faz o teste passar em qualquer horario do
// relogio (antes quebrava das 21h as 24h BRT, que e UTC do dia seguinte).
// O teste de data divergente (M4) troca o fuso explicitamente.
const abrir = async () => {
  const db = new PGlite({ loadDataDir: BASE, extensions: ext });
  await db.exec("set timezone to 'America/Sao_Paulo'");
  await como(db, null);
  return db;
};

// ===========================================================================
describe("passo 0 — backup por id", () => {
  it("grava exatamente o universo da regra nova, em 3 lotes fixos", async () => {
    const db = await abrir();
    await mundo(db);
    expect(await tenta(db, BACKUP)).toBeNull();
    const rows = await noBackup(db);
    expect(idsDe(rows)).toEqual(UNIVERSO);
    for (const [lote, ids] of Object.entries(LOTES)) {
      expect(idsDe(rows.filter((r) => r.lote === Number(lote)))).toEqual(ids);
    }
    await db.close();
  });

  it("não inclui giro vigente, acionado há ≤10 dias, acordo, retorno do operador, Carteira Geral, congelado, hold 24h nem tratativa", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const ids = idsDe(await noBackup(db));
    for (const p of PROTEGIDOS) expect(ids).not.toContain(p);
    await db.close();
  });

  it("guarda o estado anterior: dono, retorno, próxima ação, origem, confirmação, marca e saldo", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const b = await q1(db, "select * from public._backup_fidelizacao_giro_20261112 where caso_id=$1", [U(2)]);
    expect(b.operador_email).toBe(OPS[13].email);
    expect(b.resp_email).toBe(OPS[13].email);
    expect(b.aluno_proxima_acao).toBe("LIGAR");
    expect(b.aluno_hora_retorno).toBe("10:00");
    expect(b.aluno_retorno_origem).toBe("AUTOMATICO");
    expect(b.aluno_data_retorno).not.toBeNull();
    expect(b.aluno_retorno_confirmado_em).not.toBeNull();
    expect(b.caso_giro_fidelizacao_ate).not.toBeNull();
    expect(b.aluno_data_ultimo_acionamento).not.toBeNull();
    expect(Number(b.saldo_aberto)).toBe(500);
    await db.close();
  });

  it("não escreve em casos, alunos nem histórico", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, [...UNIVERSO, ...PROTEGIDOS]);
    const hist = (await q1(db, "select count(*) n from public.historico_operadores_alunos")).n;
    await db.exec(BACKUP);
    expect(await snap(db, [...UNIVERSO, ...PROTEGIDOS])).toEqual(antes);
    expect((await q1(db, "select count(*) n from public.historico_operadores_alunos")).n).toBe(hist);
    await db.close();
  });

  it("sem dado pessoal; RLS ligada; sem grant para PUBLIC/anon/authenticated (nem TRUNCATE)", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const cols = (await qn(db, `select column_name c from information_schema.columns
                                 where table_name='_backup_fidelizacao_giro_20261112'`)).map((r) => r.c);
    expect(cols.filter((c) => /cpf|nome_aluno|^nome$|telefone|email_aluno/.test(c))).toEqual([]);
    const t = await q1(db, `select relrowsecurity rls from pg_class where relname='_backup_fidelizacao_giro_20261112'`);
    expect(t.rls).toBe(true);
    for (const papel of ["anon", "authenticated", "public"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await q1(db, `select has_table_privilege($1, 'public._backup_fidelizacao_giro_20261112', $2) ok`, [papel, priv]);
        expect(r.ok, `${papel} ${priv}`).toBe(false);
      }
    }
    await db.close();
  });

  it("aborta se rodar duas vezes (não sobrescreve backup)", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const err = await tenta(db, BACKUP);
    expect(err).toMatch(/ja existe/);
    expect((await noBackup(db)).length).toBe(UNIVERSO.length);
    await db.close();
  });

  it("aborta se a migration não estiver aplicada", async () => {
    const db = await abrir();
    await db.exec(`create or replace function public.liberar_fidelizacao_caso(p_caso_id uuid, p_motivo text default 'X', p_autor text default 'Y')
                   returns boolean language sql as $f$ select false $f$;`);
    const err = await tenta(db, BACKUP);
    expect(err).toMatch(/NAO esta aplicada/);
    await db.close();
  });
});

// ===========================================================================
describe("passo 1 — cada lote libera só os seus ids", () => {
  it("lote 1: solta só o lote 1; lotes 2 e 3 e todos os protegidos seguem com o operador", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const antes = await semDono(db);
    expect(await tenta(db, comLote(1))).toBeNull();
    for (const n of LOTES[1]) expect(await donoDe(db, n)).toBeNull();
    for (const n of [...LOTES[2], ...LOTES[3], ...PROTEGIDOS]) expect(await donoDe(db, n)).not.toBeNull();
    expect((await semDono(db)) - antes).toBe(LOTES[1].length);
    const b = await noBackup(db);
    expect(idsDe(b.filter((r) => r.liberado_em))).toEqual(LOTES[1]);
    await db.close();
  });

  it("os três lotes em ordem soltam exatamente o universo e mais nada", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const antes = await semDono(db);
    for (const l of [1, 2, 3]) {
      expect(await tenta(db, comLote(l))).toBeNull();
      expect((await semDono(db)) - antes).toBe(Object.entries(LOTES).filter(([k]) => Number(k) <= l).flatMap(([, v]) => v).length);
    }
    for (const n of UNIVERSO) expect(await donoDe(db, n)).toBeNull();
    for (const n of PROTEGIDOS) expect(await donoDe(db, n)).not.toBeNull();
    await db.close();
  });

  it("caso elegível que NÃO está no backup (nasceu depois) não é tocado pelo lote", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await cenario(db, 30, { op: 13, dua: 25 });   // elegivel, mas posterior ao backup
    expect(await tenta(db, comLote(1))).toBeNull();
    expect(await donoDe(db, 30)).toBe(OPS[13].email);
    await db.close();
  });

  it("PROVA DA PAUSA: o cron, se estivesse ativo, soltaria os lotes seguintes de uma vez", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await como(db, null);   // o cron roda sem JWT
    const soltos = Number((await q1(db, "select public.liberar_casos_fidelizacao_vencida() n")).n);
    expect(soltos).toBe(LOTES[2].length + LOTES[3].length);   // lotes 2 e 3 inteiros
    await db.close();
  });
});

// ===========================================================================
describe("as travas abortam sem soltar nada", () => {
  const nadaMudou = async (db, ns) => {
    for (const n of ns) expect(await donoDe(db, n)).not.toBeNull();
  };

  it("cron 8 ativo → aborta", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec("update cron.job set active = true where jobid = 8");
    const err = await tenta(db, comLote(1));
    expect(err).toMatch(/ATIVO ou ausente/);
    await nadaMudou(db, UNIVERSO);
    expect(idsDe(await noBackup(db, "liberado_em is not null"))).toEqual([]);
    await db.close();
  });

  it("cron 8 ausente → aborta", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec("delete from cron.job where jobid = 8");
    expect(await tenta(db, comLote(1))).toMatch(/ATIVO ou ausente/);
    await nadaMudou(db, UNIVERSO);
    await db.close();
  });

  it("fora de ordem → aborta (lote 2 antes do 1)", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    expect(await tenta(db, comLote(2))).toMatch(/nao concluido/);
    await nadaMudou(db, UNIVERSO);
    await db.close();
  });

  it("lote repetido → aborta", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    expect(await tenta(db, comLote(1))).toMatch(/ja foi executado/);
    await db.close();
  });

  it("sem backup → aborta; lote inválido → aborta", async () => {
    const db = await abrir();
    await mundo(db);
    expect(await tenta(db, comLote(1))).toMatch(/backup inexistente/);
    await db.exec(BACKUP);
    expect(await tenta(db, comLote(4))).toMatch(/1, 2 ou 3/);
    await db.close();
  });

  it("REVALIDAÇÃO: quem ganhou acordo ou acionamento depois do backup é PULADO, nunca solto", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    // depois do backup: o caso 1 ganha acordo ativo; o caso 2 e acionado hoje.
    await db.query(`insert into public.acordos (aluno_id, cpf, status, numero_acordo, valor_total) values ($1,$2,'ATIVO',98001,100)`, [U(1), CPF(1)]);
    await db.query("update public.casos set data_ultimo_acionamento = current_date where id = $1", [U(2)]);
    expect(await tenta(db, comLote(1))).toBeNull();
    expect(await donoDe(db, 1)).toBe(OPS[13].email);
    expect(await donoDe(db, 2)).toBe(OPS[13].email);
    expect(await donoDe(db, 7)).toBeNull();
    const b = await noBackup(db, "lote = 1");
    expect(b.filter((r) => r.pulado_motivo === "nao_elegivel_na_execucao").length).toBe(2);
    expect(idsDe(b.filter((r) => r.liberado_em))).toEqual([7]);
    await db.close();
  });

  it("REVALIDAÇÃO: retorno do operador marcado depois do backup protege o caso", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    // retorno VALIDO: marcado num atendimento real do responsavel (ha 12 dias, para nao reabrir os 10 dias)
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_por_nome, registrado_em, data_retorno)
       values ($1, 'FINALIZACAO_ATENDIMENTO', 'atendimento sintetico', $2, 'DIEGO',
               (current_date - 12)::timestamp + interval '15 hours', (current_date + 1)::timestamp)`, [U(1), OPS[13].email]);
    await db.query("update public.alunos set data_retorno = current_date + 1, retorno_origem = 'OPERADOR' where id = $1", [U(1)]);
    expect(await tenta(db, comLote(1))).toBeNull();
    expect(await donoDe(db, 1)).toBe(OPS[13].email);
    expect((await noBackup(db, "caso_id = '" + U(1) + "'"))[0].pulado_motivo).toBe("ganhou_protecao_desde_o_inicio");
    await db.close();
  });

  it("INVARIANTE: se outro caso for solto no caminho, o lote INTEIRO é desfeito", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    // efeito colateral hostil: ao soltar o caso 1, um gatilho solta tambem o caso 11.
    await db.exec(`
      create function public._hostil() returns trigger language plpgsql as $f$
      begin
        if old.id = '${U(1)}'::uuid and new.operador_email is null then
          update public.casos set operador_email = null where id = '${U(11)}'::uuid;
        end if;
        return new;
      end $f$;
      create trigger zz_hostil after update of operador_email on public.casos
        for each row execute function public._hostil();`);
    const err = await tenta(db, comLote(1));
    expect(err).toMatch(/INVARIANTE violada/);
    for (const n of [...UNIVERSO, 11]) expect(await donoDe(db, n)).not.toBeNull();
    expect(idsDe(await noBackup(db, "liberado_em is not null"))).toEqual([]);
    await db.close();
  });
});

// ===========================================================================
describe("preservação — retornos, acordos e demais proteções", () => {
  it("depois dos 3 lotes: protegidos intactos, inclusive retorno do operador e tudo que o aluno tinha", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, PROTEGIDOS);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) await db.exec(comLote(l));
    expect(await snap(db, PROTEGIDOS)).toEqual(antes);
    const op = (await snap(db, [13]))[0];
    expect(op.retorno_origem).toBe("OPERADOR");
    expect(op.proxima_acao).not.toBeNull();
    expect(op.ret).not.toBeNull();
    await db.close();
  });

  it("nos liberados: acionamento e tabulação são preservados e o responsável sai do caso e do aluno", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, UNIVERSO);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) await db.exec(comLote(l));
    const depois = await snap(db, UNIVERSO);
    for (let i = 0; i < UNIVERSO.length; i++) {
      expect(depois[i].dua_c, `caso ${UNIVERSO[i]} dua caso`).toBe(antes[i].dua_c);
      expect(depois[i].dua_a, `caso ${UNIVERSO[i]} dua aluno`).toBe(antes[i].dua_a);
      expect(depois[i].st_a).toBe(antes[i].st_a);
      expect(depois[i].operador_email).toBeNull();
      expect(depois[i].r_email).toBeNull();
    }
    await db.close();
  });

  it("MEDIDO: a liberação ZERA o retorno automático do aluno (por isso o backup o guarda)", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    const a = (await snap(db, [2]))[0];       // tinha retorno AUTOMATICO + proxima_acao + hora
    expect(a.ret).toBeNull();
    expect(a.proxima_acao).toBeNull();
    expect(a.hora_retorno).toBeNull();
    expect(a.retorno_origem).toBeNull();
    const b = await q1(db, "select aluno_data_retorno r, aluno_proxima_acao p from public._backup_fidelizacao_giro_20261112 where caso_id=$1", [U(2)]);
    expect(b.r).not.toBeNull();
    expect(b.p).toBe("LIGAR");
    await db.close();
  });

  it("histórico: só os liberados ganham FIDELIZACAO_EXPIRADA, com o responsável anterior", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    const h = await qn(db, `select cpf_referencia c, operador_anterior_email de from public.historico_operadores_alunos where acao='FIDELIZACAO_EXPIRADA'`);
    expect(h.map((x) => x.c).sort()).toEqual(LOTES[1].map(CPF).sort());
    expect(h.every((x) => x.de === OPS[13].email)).toBe(true);
    await db.close();
  });

  it("a liberação não entrega o caso a ninguém: nenhum caso ganha dono novo", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    const antes = Object.fromEntries((await qn(db, "select id, operador_email from public.casos")).map((r) => [r.id, r.operador_email]));
    for (const l of [1, 2, 3]) await db.exec(comLote(l));
    for (const r of await qn(db, "select id, operador_email from public.casos")) {
      if (r.operador_email !== antes[r.id]) expect(r.operador_email).toBeNull();
    }
    await db.close();
  });
});

// ===========================================================================
describe("restauração — validada campo a campo", () => {
  it("lote 1 liberado e restaurado: estado idêntico ao de antes, campo a campo", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, LOTES[1]);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    expect((await snap(db, LOTES[1]))[0].operador_email).toBeNull();
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(await snap(db, LOTES[1])).toEqual(antes);
    await db.close();
  });

  it("os três lotes liberados e restaurados de uma vez (v_lote=0): universo todo idêntico", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, UNIVERSO);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) await db.exec(comLote(l));
    expect(await tenta(db, comRestauro(0))).toBeNull();
    expect(await snap(db, UNIVERSO)).toEqual(antes);
    const b = await noBackup(db);
    expect(b.every((r) => r.restaurado_motivo === "restaurado")).toBe(true);
    await db.close();
  });

  it("restaurar só o lote 2 não mexe nos lotes 1 e 3", async () => {
    const db = await abrir();
    await mundo(db);
    const antes2 = await snap(db, LOTES[2]);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) await db.exec(comLote(l));
    await db.exec(comRestauro(2));
    expect(await snap(db, LOTES[2])).toEqual(antes2);
    for (const n of [...LOTES[1], ...LOTES[3]]) expect(await donoDe(db, n)).toBeNull();
    await db.close();
  });

  it("não sobrescreve quem já assumiu: o caso é PULADO e registrado", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, [2, 7]);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    // outro operador assume o caso 1 depois da liberacao.
    await db.query("update public.casos set operador_email = $1, operador_nome = 'LUANA' where id = $2", [OPS[5].email, U(1)]);
    expect(await donoDe(db, 1)).toBe(OPS[5].email);
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(await donoDe(db, 1)).toBe(OPS[5].email);                       // intacto
    expect(await snap(db, [2, 7])).toEqual(antes);                        // os demais voltaram
    const b = await noBackup(db, `caso_id = '${U(1)}'`);
    expect(b[0].restaurado_motivo).toBe("nao_restaurado_ja_tem_dono");
    await db.close();
  });

  it("conferência reprovada desfaz SÓ aquele aluno, registra a falha e não aborta os demais", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, [1, 7]);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    // adultera a escrita so do aluno 2: a conferencia dele tem de reprovar.
    await db.exec(`
      create function public._adultera() returns trigger language plpgsql as $f$
      begin
        if new.id = '${U(2)}'::uuid and new.responsavel_atual_email is not null then new.proxima_acao := 'ADULTERADO'; end if;
        return new;
      end $f$;
      create trigger zz_adultera before update on public.alunos
        for each row execute function public._adultera();`);
    expect(await tenta(db, comRestauro(1))).toBeNull();          // nao aborta
    expect(await snap(db, [1, 7])).toEqual(antes);               // os outros voltaram
    expect(await donoDe(db, 2)).toBeNull();                      // o adulterado ficou como estava
    const b = (await noBackup(db, `caso_id = '${U(2)}'`))[0];
    expect(b.restaurado_motivo).toMatch(/^falhou: conferencia/);
    await db.close();
  });

  it("aluno que falhou pode ser tentado de novo depois de sanada a causa", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, [2]);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.exec(`
      create function public._adultera() returns trigger language plpgsql as $f$
      begin
        if new.id = '${U(2)}'::uuid and new.responsavel_atual_email is not null then new.proxima_acao := 'ADULTERADO'; end if;
        return new;
      end $f$;
      create trigger zz_adultera before update on public.alunos
        for each row execute function public._adultera();`);
    await db.exec(comRestauro(1));
    await db.exec("drop trigger zz_adultera on public.alunos");
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(await snap(db, [2])).toEqual(antes);
    await db.close();
  });

  it("restauração é idempotente: rodar de novo não muda nada", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.exec(comRestauro(1));
    const depois = await snap(db, LOTES[1]);
    await db.exec(comRestauro(1));
    expect(await snap(db, LOTES[1])).toEqual(depois);
    await db.close();
  });

  it("registra a restauração no histórico", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.exec(comRestauro(1));
    const h = await qn(db, `select cpf_referencia c from public.historico_operadores_alunos where acao='RESTAURACAO_FIDELIZACAO_GIRO'`);
    expect(h.map((x) => x.c).sort()).toEqual(LOTES[1].map(CPF).sort());
    await db.close();
  });
});

// ===========================================================================
describe("a unidade é o aluno — a cascata do gatilho, medida e tratada", () => {

  it("MEDIDO: soltar um caso solta, por gatilho, o outro caso do mesmo aluno", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 40, 1);
    await db.query("select public.liberar_fidelizacao_caso($1)", [U(1)]);
    expect(await donoDe(db, 1)).toBeNull();
    expect(await donoDe(db, 40)).toBeNull();   // ninguem mandou soltar o 40
    await db.close();
  });

  it("aluno com 2 casos elegíveis: os dois entram como ALVO, saem juntos e a invariante fecha", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 40, 1);
    await db.exec(BACKUP);
    expect((await tipoDe(db, 1)).tipo).toBe("ALVO");
    expect((await tipoDe(db, 40)).tipo).toBe("ALVO");
    const antes = await semDono(db);
    expect(await tenta(db, comLote(1))).toBeNull();
    expect(await donoDe(db, 1)).toBeNull();
    expect(await donoDe(db, 40)).toBeNull();
    expect((await semDono(db)) - antes).toBe(LOTES[1].length + 1);
    expect((await tipoDe(db, 1)).liberado_por).toBe("giro_fidelizacao_lote_1");
    expect((await tipoDe(db, 40)).liberado_por).toBe("giro_fidelizacao_lote_1_arrasto");
    const h = await qn(db, "select count(*) n from public.historico_operadores_alunos where acao='FIDELIZACAO_EXPIRADA' and cpf_referencia=$1", [CPF(1)]);
    expect(Number(h[0].n)).toBe(2);   // uma linha por caso
    await db.close();
  });

  it("caso ENCERRADO do mesmo aluno e operador: entra como ARRASTO, sai junto e fica registrado", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 41, 3, { op: 6, statusAtual: "SEM SALDO EM ABERTO" });
    await db.exec(BACKUP);
    const t = await tipoDe(db, 41);
    expect(t.tipo).toBe("ARRASTO");
    expect(t.lote).toBe(2);
    await db.exec(comLote(1));
    expect(await donoDe(db, 41)).toBe(OPS[6].email);          // lote 1 nao toca o lote 2
    const antes = await semDono(db);
    expect(await tenta(db, comLote(2))).toBeNull();
    expect(await donoDe(db, 3)).toBeNull();
    expect(await donoDe(db, 41)).toBeNull();
    expect((await semDono(db)) - antes).toBe(LOTES[2].length + 1);
    await db.close();
  });

  it("aluno com outro caso que NÃO pode sair (acionado há 2 dias): RETIDO — o aluno inteiro fica fora dos lotes", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 42, 5, { op: 5, dua: 2 });
    await db.exec(BACKUP);
    const t = await tipoDe(db, 5);
    expect(t.tipo).toBe("RETIDO");
    expect(t.pulado_motivo).toBe("aluno_com_outro_caso_fora_da_regra");
    expect(await tipoDe(db, 42)).toBeUndefined();              // o caso protegido nem entra no backup
    for (const l of [1, 2, 3]) expect(await tenta(db, comLote(l))).toBeNull();
    expect(await donoDe(db, 5)).toBe(OPS[5].email);
    expect(await donoDe(db, 42)).toBe(OPS[5].email);
    expect(await donoDe(db, 6)).toBeNull();                    // o resto do lote 3 saiu
    await db.close();
  });

  it("com a regra nova, nem o cron solta o aluno que tem outro caso acionado há 2 dias", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 42, 5, { op: 5, dua: 2 });
    await db.query("select public.liberar_casos_fidelizacao_vencida()");
    expect(await donoDe(db, 5)).toBe(OPS[5].email);
    expect(await donoDe(db, 42)).toBe(OPS[5].email);
    await db.close();
  });

  it("irmão CONGELADO (regra de 26/10): aluno RETIDO; lote e cron não soltam nenhum dos dois", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 44, 3, { op: 6, statusAtual: "SEM SALDO EM ABERTO" });
    await db.query("insert into public.caso_encerramento_sem_saldo (caso_id) values ($1)", [U(44)]);
    await db.exec(BACKUP);
    const t = await tipoDe(db, 3);
    expect(t.tipo).toBe("RETIDO");
    expect(t.pulado_motivo).toBe("aluno_com_outro_caso_fora_da_regra");
    for (const l of [1, 2, 3]) expect(await tenta(db, comLote(l))).toBeNull();
    expect(await donoDe(db, 3)).toBe(OPS[6].email);
    expect(await donoDe(db, 44)).toBe(OPS[6].email);
    await db.exec("update cron.job set active = true where jobid = 8");
    await db.query("select public.liberar_casos_fidelizacao_vencida()");
    expect(await donoDe(db, 44)).toBe(OPS[6].email);              // o congelado nao sai nem pelo cron
    await db.close();
  });

  it("dois casos ABERTOS de verdade no mesmo aluno: o erro do gatilho pula só esse aluno", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 45, 1, { colEnc: false });
    for (let n = 20; n < 30; n++) await cenario(db, n, { op: 13, dua: 25 });   // lote 1 com 13 alunos: 1 falha = 7,7%
    await db.exec(BACKUP);
    expect(await tenta(db, comLote(1))).toBeNull();               // o lote nao aborta
    expect(await donoDe(db, 1)).toBe(OPS[13].email);
    expect(await donoDe(db, 45)).toBe(OPS[13].email);
    expect((await tipoDe(db, 1)).pulado_motivo).toMatch(/^erro: ALUNO_JA_TEM_CASO_ABERTO/);
    expect(await donoDe(db, 2)).toBeNull();
    expect(await donoDe(db, 7)).toBeNull();
    await db.close();
  });

  it("REVALIDAÇÃO: aluno que ganhou caso depois do backup é pulado inteiro", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await irmao(db, 43, 7, { dua: 1 });
    expect(await tenta(db, comLote(1))).toBeNull();
    expect(await donoDe(db, 7)).toBe(OPS[13].email);
    expect(await donoDe(db, 43)).toBe(OPS[13].email);
    expect((await tipoDe(db, 7)).pulado_motivo).toBe("aluno_ganhou_caso_fora_do_backup");
    expect(await donoDe(db, 1)).toBeNull();
    await db.close();
  });

  it("REVALIDAÇÃO: se o caso de arrasto deixou de estar encerrado, o aluno é pulado", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 41, 3, { op: 6, statusAtual: "SEM SALDO EM ABERTO" });
    await db.exec(BACKUP);
    await db.exec("alter table public.casos disable trigger user");
    await db.query("update public.casos set status_atual = 'EM COBRANCA', encerrado_operacional = false, data_ultimo_acionamento = current_date where id = $1", [U(41)]);
    await db.exec("alter table public.casos enable trigger user");
    await db.exec(comLote(1));
    expect(await tenta(db, comLote(2))).toBeNull();
    expect(await donoDe(db, 3)).toBe(OPS[6].email);
    expect(await donoDe(db, 41)).toBe(OPS[6].email);
    expect((await tipoDe(db, 3)).pulado_motivo).toBe("arrasto_mudou_desde_o_backup");
    expect(await donoDe(db, 4)).toBeNull();
    await db.close();
  });

  it("restauração devolve o aluno inteiro: ALVO, irmão e ARRASTO, com a marca do giro de cada um", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 40, 1);
    await irmao(db, 41, 3, { op: 6, statusAtual: "SEM SALDO EM ABERTO", giro: null });
    const ns = [...UNIVERSO, 40, 41];
    const antes = await snap(db, ns);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) expect(await tenta(db, comLote(l))).toBeNull();
    for (const n of ns) expect(await donoDe(db, n)).toBeNull();
    expect(await tenta(db, comRestauro(0))).toBeNull();
    const depois = await snap(db, ns);
    // o NOME do operador nos casos e reescrito pelo gatilho a partir do cadastro;
    // tudo o mais tem de ser identico.
    const semNome = (rows) => rows.map((row) => {
      const r = { ...row };
      delete r.operador_nome;
      delete r.operador;
      return r;
    });
    expect(semNome(depois)).toEqual(semNome(antes));
    await db.close();
  });

  it("restauração não sobrescreve: se o irmão já foi assumido por outro, o aluno inteiro é pulado", async () => {
    const db = await abrir();
    await mundo(db);
    await irmao(db, 40, 1);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.query("update public.casos set operador_email = $1, operador_nome = 'LUANA' where id = $2", [OPS[5].email, U(40)]);
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(await donoDe(db, 40)).toBe(OPS[5].email);
    expect((await tipoDe(db, 1)).tipo).toBe("ALVO");
    const b = await noBackup(db, `caso_id in ('${U(1)}','${U(40)}')`);
    expect(b.every((r) => r.restaurado_motivo === "nao_restaurado_ja_tem_dono")).toBe(true);
    await db.close();
  });
});

// ===========================================================================
describe("achados da auditoria — cada um com o teste que o reproduzia", () => {
  it("A1: aluno em que alguém trabalhou depois de solto é PULADO; os demais voltam", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, [1, 7]);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.query("update public.alunos set status_atual = 'EM NEGOCIACAO' where id = $1", [U(2)]);
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(await snap(db, [1, 7])).toEqual(antes);
    expect(await donoDe(db, 2)).toBeNull();
    expect((await noBackup(db, `caso_id = '${U(2)}'`))[0].restaurado_motivo).toBe("nao_restaurado_mudou_depois_da_liberacao");
    await db.close();
  });

  it("A1: retorno marcado por OPERADOR depois de solto também segura a restauração", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.query("update public.alunos set data_retorno = current_date + 2, retorno_origem = 'OPERADOR' where id = $1", [U(1)]);
    await db.exec(comRestauro(1));
    expect(await donoDe(db, 1)).toBeNull();
    expect((await noBackup(db, `caso_id = '${U(1)}'`))[0].restaurado_motivo).toBe("nao_restaurado_mudou_depois_da_liberacao");
    await db.close();
  });

  it("A1: próxima ação AUTOMÁTICA recalculada depois de solto NÃO segura (não é trabalho de pessoa)", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.query("update public.alunos set proxima_acao = 'RECALCULADA', data_retorno = current_date + 3, retorno_origem = 'AUTOMATICO' where id = $1", [U(1)]);
    await db.exec(comRestauro(1));
    expect(await donoDe(db, 1)).toBe(OPS[13].email);
    await db.close();
  });

  it("A2: status_acionamento vazio ('') vira nulo na liberação e NÃO impede a restauração", async () => {
    const db = await abrir();
    await mundo(db);
    await cenario(db, 60, { op: 13, statusAcion: "" });
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    expect((await q1(db, "select status_acionamento s from public.alunos where id=$1", [U(60)])).s).toBeNull();
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(await donoDe(db, 60)).toBe(OPS[13].email);
    expect((await noBackup(db, `caso_id = '${U(60)}'`))[0].restaurado_motivo).toBe("restaurado");
    await db.close();
  });

  it("A2: responsável do aluno ≠ operador do caso → RETIDO no backup, com motivo próprio", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec("alter table public.alunos disable trigger user");
    await db.query("update public.alunos set responsavel_atual_email = $1 where id = $2", [OPS[5].email, U(3)]);
    await db.exec("alter table public.alunos enable trigger user");
    await db.exec(BACKUP);
    const b = (await qn(db, "select tipo, pulado_motivo from public._backup_fidelizacao_giro_20261112 where caso_id=$1", [U(3)]))[0];
    expect(b.tipo).toBe("RETIDO");
    expect(b.pulado_motivo).toBe("responsavel_do_aluno_diverge_do_operador_do_caso");
    for (const l of [1, 2, 3]) expect(await tenta(db, comLote(l))).toBeNull();
    expect(await donoDe(db, 3)).toBe(OPS[6].email);
    await db.close();
  });

  it("A2: e-mail de operador com MAIÚSCULA entra no lote certo, sai e volta", async () => {
    const db = await abrir();
    await mundo(db);
    await cenario(db, 61, { dono: "Cobranca13@AELBRA.com.br" });
    await db.exec(BACKUP);
    expect((await qn(db, "select lote from public._backup_fidelizacao_giro_20261112 where caso_id=$1", [U(61)]))[0].lote).toBe(1);
    await db.exec(comLote(1));
    expect(await donoDe(db, 61)).toBeNull();
    expect(await tenta(db, comRestauro(1))).toBeNull();
    expect(String(await donoDe(db, 61)).toLowerCase()).toBe(OPS[13].email);
    expect((await noBackup(db, `caso_id = '${U(61)}'`))[0].restaurado_motivo).toBe("restaurado");
    await db.close();
  });

  it("A3: o que mudou ENTRE o backup e o lote volta no valor NOVO (retrato no instante da liberação)", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.query("update public.alunos set proxima_acao = 'COMBINADO NOVO', data_retorno = current_date + 6, retorno_origem = 'AUTOMATICO' where id = $1", [U(2)]);
    await db.exec(comLote(1));
    expect(await donoDe(db, 2)).toBeNull();
    await db.exec(comRestauro(1));
    const a = (await snap(db, [2]))[0];
    expect(a.operador_email).toBe(OPS[13].email);
    expect(a.proxima_acao).toBe("COMBINADO NOVO");
    await db.close();
  });

  it("A4: restauração ABORTA com o cron ativo", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    await db.exec("update cron.job set active = true where jobid = 8");
    expect(await tenta(db, comRestauro(1))).toMatch(/ATIVO ou ausente/);
    for (const n of LOTES[1]) expect(await donoDe(db, n)).toBeNull();
    await db.close();
  });

  it("A4: restauração ABORTA, por padrão, se a regra nova ainda está no ar", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await db.exec(comLote(1));
    expect(await tenta(db, comRestauro(1, { exigirRegraAntiga: true }))).toMatch(/regra nova ainda esta no ar/);
    for (const n of LOTES[1]) expect(await donoDe(db, n)).toBeNull();
    await db.close();
  });

  it("A4: backup ABORTA com o cron ativo; e a MIGRATION recusa ser aplicada com o cron ativo", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec("update cron.job set active = true where jobid = 8");
    expect(await tenta(db, BACKUP)).toMatch(/ATIVO ou ausente/);
    await db.exec(ler(`${PASTA}.rollback.sql`));
    expect(await tenta(db, MIGRATION)).toMatch(/esta ATIVO/);
    const src = (await q1(db, "select prosrc s from pg_proc where proname='liberar_fidelizacao_caso'")).s;
    expect(src).not.toMatch(/caso_em_giro_fidelizacao/);          // nada foi aplicado
    await db.close();
  });

  it("B4: cron de reposição de carteira ativo → backup e lote abortam", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec("update cron.job set active = true where jobid = 43");
    expect(await tenta(db, BACKUP)).toMatch(/reposicao de carteira esta ATIVO/);
    await db.exec("update cron.job set active = false where jobid = 43");
    await db.exec(BACKUP);
    await db.exec("update cron.job set active = true where jobid = 43");
    expect(await tenta(db, comLote(1))).toMatch(/reposicao de carteira esta ATIVO/);
    for (const n of UNIVERSO) expect(await donoDe(db, n)).not.toBeNull();
    await db.close();
  });

  it("M1: um caso solto fora da lista E um caso livre atribuído (conta que se compensa) → aborta", async () => {
    const db = await abrir();
    await mundo(db);
    await cenario(db, 50, { livre: true });
    await db.exec(BACKUP);
    await db.exec(`
      create function public._compensa() returns trigger language plpgsql as $f$
      begin
        if old.id = '${U(1)}'::uuid and new.operador_email is null then
          update public.casos set operador_email = null where id = '${U(11)}'::uuid;
          update public.casos set operador_email = '${OPS[12].email}', operador_nome = 'RAFAELLA' where id = '${U(50)}'::uuid;
        end if;
        return new;
      end $f$;
      create trigger zz_compensa after update of operador_email on public.casos
        for each row execute function public._compensa();`);
    const err = await tenta(db, comLote(1));
    expect(err).toMatch(/INVARIANTE violada/);
    expect(await donoDe(db, 11)).toBe(OPS[13].email);
    expect(await donoDe(db, 50)).toBeNull();
    for (const n of LOTES[1]) expect(await donoDe(db, n)).not.toBeNull();
    await db.close();
  });

  it("M2: proteção criada DURANTE a execução (acordo ativo) é vista na hora e o aluno é pulado", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    // ao soltar o caso 1 (primeiro do lote), nasce um acordo ativo para o aluno 2.
    await db.exec(`
      create function public._acordo_no_meio() returns trigger language plpgsql as $f$
      begin
        if old.id = '${U(1)}'::uuid and new.operador_email is null then
          insert into public.acordos (aluno_id, cpf, status, numero_acordo, valor_total)
          values ('${U(2)}'::uuid, '${CPF(2)}', 'ATIVO', 98002, 100);
        end if;
        return new;
      end $f$;
      create trigger zz_acordo_no_meio after update of operador_email on public.casos
        for each row execute function public._acordo_no_meio();`);
    expect(await tenta(db, comLote(1))).toBeNull();
    expect(await donoDe(db, 1)).toBeNull();
    expect(await donoDe(db, 2)).toBe(OPS[13].email);
    expect((await noBackup(db, `caso_id = '${U(2)}'`))[0].pulado_motivo).toBe("ganhou_protecao_desde_o_inicio");
    await db.close();
  });

  it("limite de erros: mais de 10% dos alunos com erro → o lote inteiro é desfeito", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    // 2 dos 3 alunos do lote 1 falham (gatilho que levanta erro para eles).
    await db.exec(`
      create function public._falha() returns trigger language plpgsql as $f$
      begin
        if new.id in ('${U(1)}'::uuid, '${U(2)}'::uuid) and new.operador_email is null then
          raise exception 'falha simulada';
        end if;
        return new;
      end $f$;
      create trigger zz_falha before update of operador_email on public.casos
        for each row execute function public._falha();`);
    expect(await tenta(db, comLote(1))).toMatch(/acima de 10%/);
    for (const n of LOTES[1]) expect(await donoDe(db, n)).not.toBeNull();   // nada foi solto
    await db.close();
  });

  it("limite de erros: uma falha isolada em 10 alunos NÃO aborta o lote; ela é pulada e registrada", async () => {
    const db = await abrir();
    await mundo(db);
    for (let n = 20; n < 30; n++) await cenario(db, n, { op: 13, dua: 25 });   // lote 1 com 13 alunos
    await db.exec(BACKUP);
    await db.exec(`
      create function public._falha() returns trigger language plpgsql as $f$
      begin
        if new.id = '${U(20)}'::uuid and new.operador_email is null then raise exception 'falha simulada'; end if;
        return new;
      end $f$;
      create trigger zz_falha before update of operador_email on public.casos
        for each row execute function public._falha();`);
    expect(await tenta(db, comLote(1))).toBeNull();
    expect((await tipoDe(db, 20)).pulado_motivo).toMatch(/^erro:/);
    expect(await donoDe(db, 21)).toBeNull();
    await db.close();
  });

  it("troca de dono X→Y fora da lista → a invariante aborta o lote", async () => {
    const db = await abrir();
    await mundo(db);
    await cenario(db, 70, { op: 6, dua: 30 });                   // dono cobranca06, NAO elegivel no backup
    await db.exec(BACKUP);
    await db.exec(`
      create function public._troca() returns trigger language plpgsql as $f$
      begin
        if old.id = '${U(1)}'::uuid and new.operador_email is null then
          update public.casos set operador_email = '${OPS[5].email}' where id = '${U(70)}'::uuid;
        end if;
        return new;
      end $f$;
      create trigger zz_troca after update of operador_email on public.casos
        for each row execute function public._troca();`);
    expect(await tenta(db, comLote(1))).toMatch(/trocas_de_dono_fora_da_lista=[1-9]/);
    expect(await donoDe(db, 70)).toBe(OPS[6].email);
    await db.close();
  });

  it("M4: data do banco diferente da de São Paulo → backup e lote abortam", async () => {
    const db = await abrir();
    await mundo(db);
    // escolhe um fuso de sessao cuja data difere da de Sao Paulo neste instante.
    const hora = Number((await q1(db, "select extract(hour from now() at time zone 'America/Sao_Paulo') h")).h);
    const fuso = hora < 8 ? "Etc/GMT+12" : "Pacific/Kiritimati";
    await db.exec(`set timezone to '${fuso}'`);
    expect((await q1(db, "select current_date <> (now() at time zone 'America/Sao_Paulo')::date d")).d).toBe(true);
    expect(await tenta(db, BACKUP)).toMatch(/nao e a de Sao Paulo/);
    await db.exec("set timezone to 'America/Sao_Paulo'");
    await db.exec(BACKUP);
    await db.exec(`set timezone to '${fuso}'`);
    expect(await tenta(db, comLote(1))).toMatch(/nao e a de Sao Paulo/);
    await db.exec("set timezone to 'America/Sao_Paulo'");
    for (const n of UNIVERSO) expect(await donoDe(db, n)).not.toBeNull();
    await db.close();
  });
});

// ===========================================================================
describe("fidelidade da bancada — o que é igual a produção e o que NÃO é", () => {
  // Gatilhos de producao em 12/11/2026 (pg_trigger, nao internos).
  const PROD = {
    casos: ["trg_audit_del", "trg_auditar_encerramento_operacional", "trg_auditar_nao_acionar",
      "trg_bloquear_alteracoes_restritas_casos", "trg_casos_set_encerrado_operacional",
      "trg_fechar_confirmacao_ao_quitar_caso", "trg_giro_limpar_marca", "trg_nome_do_operador_no_caso",
      "trg_sync_alunos_apos_casos", "trg_zz_caso_nao_duplica_aluno", "trg_zz_caso_nao_duplica_aluno_before",
      "trigger_impor_teto_operador", "trigger_repor_caso_operador"],
    alunos: ["trg_acionamento_nao_volta_para_nulo", "trg_aluno_concluir_retorno_adm_link",
      "trg_aluno_encerramento_propaga", "trg_aluno_estado_anterior", "trg_aluno_reset_retorno_confirmado",
      "trg_alunos_retorno_origem", "trg_atualizar_nome_normalizado", "trg_audit_del",
      "trg_audit_responsavel_aluno", "trg_encerramento_so_gestao", "trg_fechar_confirmacao_ao_quitar",
      "trg_guard_resp_aluno", "trg_nome_do_operador_no_aluno", "trg_sincronizar_alunos_unificados",
      "trg_sync_acionamento_alunos_para_casos", "trg_sync_casos_resp_aluno", "trg_tabulacao_efeito_financeiro",
      "trg_tabulacao_redireciona", "trg_tabulacao_so_gestao_insert"],
    aluno_movimentacoes: ["trg_atualizar_ultimo_acionamento", "trg_sincronizar_elogio_da_movimentacao",
      "trg_zz_desfazer_cartao_tabulacao"],
  };
  // DECLARADO: gatilhos de producao que a bancada NAO tem, e por que nao decidem a prova.
  const NAO_REPRODUZIDOS = {
    casos: ["trg_audit_del", "trg_auditar_encerramento_operacional", "trg_auditar_nao_acionar"], // auditoria: so registram
    alunos: ["trg_aluno_concluir_retorno_adm_link", "trg_aluno_encerramento_propaga", "trg_aluno_estado_anterior",
      "trg_fechar_confirmacao_ao_quitar", "trg_encerramento_so_gestao", "trg_tabulacao_so_gestao_insert",
      "trg_tabulacao_efeito_financeiro", "trg_tabulacao_redireciona", // todos disparam por STATUS, que a liberacao e a restauracao nao escrevem
      "trg_atualizar_nome_normalizado", "trg_audit_del",               // nome e exclusao
      "trg_sincronizar_alunos_unificados"],                            // espelho de leitura
    aluno_movimentacoes: [],
  };
  // DECLARADO: funcoes da cadeia cujo corpo na bancada e o de 30/09 e DIFERE do de producao em 12/11.
  const DIVERGENTES = {
    "public.caso_encerrado_operacional": "b65a36744bd71fe8837d59f378892944",          // prod delega a _caso_encerrado_operacional_regra (congelamento + saldo conferido)
    "public.caso_aguarda_confirmacao_financeira": "de84992ce76af33281ef09f8505bcfc3", // usada so pela protecao de confirmacao financeira
    "public.fn_atualizar_ultimo_acionamento": "e1bfc3930535104ec515f8c514e0b0d7",     // sai na 1a linha para REDISTRIBUICAO_SINCRONIZACAO nas duas versoes
  };

  it("os gatilhos da bancada são gatilhos de produção, e os que faltam são exatamente os declarados", async () => {
    const db = await abrir();
    for (const tabela of Object.keys(PROD)) {
      const tem = (await qn(db, `select tgname from pg_trigger where tgrelid = ('public.' || $1)::regclass and not tgisinternal`, [tabela]))
        .map((r) => r.tgname).sort();
      for (const t of tem) expect(PROD[tabela], `${tabela}.${t} nao existe em producao`).toContain(t);
      const faltam = PROD[tabela].filter((t) => !tem.includes(t)).sort();
      expect(faltam, tabela).toEqual([...NAO_REPRODUZIDOS[tabela]].sort());
    }
    await db.close();
  });

  it("as funções declaradas como divergentes continuam divergentes (se alguém alinhar, este teste avisa)", async () => {
    const db = await abrir();
    const m = Object.fromEntries((await qn(db,
      `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace`))
      .map((r) => [r.nome, r.md5]));
    for (const [nome, md5Prod] of Object.entries(DIVERGENTES)) expect(m[nome], nome).not.toBe(md5Prod);
    await db.close();
  });

  it("set_resp_aluno tem o dono de produção (é o que faz o guard deixar a troca passar)", async () => {
    const db = await abrir();
    const r = await q1(db, "select pg_get_userbyid(proowner) o from pg_proc where proname='set_resp_aluno'");
    expect(r.o).toBe("reativa_responsavel_executor");
    await db.close();
  });
});

// ===========================================================================
describe("contexto de execução", () => {
  it("os scripts rodam sem JWT (papel postgres), como rodariam em produção", async () => {
    const db = await abrir();
    expect((await q1(db, "select auth.jwt() j, current_user u")).j).toBeNull();
    await mundo(db);
    const antes = await snap(db, UNIVERSO);
    expect(await tenta(db, BACKUP)).toBeNull();
    for (const l of [1, 2, 3]) expect(await tenta(db, comLote(l))).toBeNull();
    expect(await tenta(db, comRestauro(0))).toBeNull();
    expect(await snap(db, UNIVERSO)).toEqual(antes);
    await db.close();
  });

  it("e também com a gestão logada (mesmo resultado)", async () => {
    const db = await abrir();
    await como(db, GESTAO);
    await mundo(db);
    const antes = await snap(db, UNIVERSO);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) expect(await tenta(db, comLote(l))).toBeNull();
    expect(await tenta(db, comRestauro(0))).toBeNull();
    expect(await snap(db, UNIVERSO)).toEqual(antes);
    await db.close();
  });

  it("operador logado NÃO consegue rodar o lote: o portão da função recusa e nada é solto", async () => {
    const db = await abrir();
    await mundo(db);
    await db.exec(BACKUP);
    await como(db, OPS[5].email);
    const err = await tenta(db, comLote(1));
    expect(err).toMatch(/sem_permissao/);
    await como(db, null);
    for (const n of UNIVERSO) expect(await donoDe(db, n)).not.toBeNull();
    await db.close();
  });
});

// ===========================================================================
describe("reversão completa — ordem: cron pausado, rollback da migration, restauração", () => {
  it("com a regra antiga de volta e os casos restaurados, o cron não solta os casos de giro", async () => {
    const db = await abrir();
    await mundo(db);
    const antes = await snap(db, UNIVERSO);
    await db.exec(BACKUP);
    for (const l of [1, 2, 3]) await db.exec(comLote(l));
    // 2) rollback da migration; 3) restauracao.
    await db.exec(ler(`${PASTA}.rollback.sql`));
    await db.exec(RESTAURAR);
    expect(await snap(db, UNIVERSO)).toEqual(antes);
    // 4) cron volta: com a regra antiga, a marca do giro (reposta) segura os casos de giro.
    await como(db, null);
    await db.query("select public.liberar_casos_fidelizacao_vencida()");
    for (const n of [1, 2, 3, 4, 5, 6]) expect(await donoDe(db, n)).not.toBeNull();
    await db.close();
  });
});
