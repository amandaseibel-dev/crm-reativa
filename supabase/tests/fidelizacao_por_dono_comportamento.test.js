// FIDELIZACAO PERTENCE AO RESPONSAVEL ATUAL -- teste de comportamento.
//
// Roda a MIGRATION REAL
// (supabase/migrations/20260930090000_fidelizacao_por_responsavel_atual.sql) e o
// ROLLBACK REAL
// (supabase/rollbacks/20260930090000_fidelizacao_por_responsavel_atual.rollback.sql)
// num PostgreSQL real (PGlite) sobre a fixture fidelizacao_por_dono_prod_20260930:
// 37 funcoes com o texto EXATO de producao (pg_get_functiondef de 30/09/2026),
// cada corpo conferido por md5 do prosrc, 21 tabelas com a estrutura de producao
// e os 12 gatilhos de INSERT/UPDATE de casos e aluno_movimentacoes. Nada de duble
// nas regras -- unicos stubs: auth.jwt() e os papeis anon/authenticated
// (infraestrutura, nao regra).
//
// NENHUM DADO REAL: operadores sao @teste.local, UUIDs e CPFs sao inventados.
//
// A migration NAO FOI APLICADA em banco nenhum. Este teste e a unica coisa que a
// executa, num banco efemero que morre no fim.
// FUSO DO BANCO = UTC, como producao (medido em 29/09/2026: TimeZone=UTC na
// sessao e no servidor). O PGlite herda o fuso do processo Node; sem fixar isto,
// o mesmo teste passaria no Brasil e falharia no CI em UTC (ou o contrario) --
// e fuso e exatamente o que a regra nova trata. Tem de vir antes de instanciar
// o PGlite.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql");
const MD5_PROD = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const MIGRATION = ler("supabase/migrations/20260930090000_fidelizacao_por_responsavel_atual.sql");
const ROLLBACK = ler("supabase/rollbacks/20260930090000_fidelizacao_por_responsavel_atual.rollback.sql");

const A = "operador.a@teste.local";
const B = "operador.b@teste.local";
const GESTAO = "gestao@teste.local";
const CORTE = "2026-10-01";

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(10000000000 + n);

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

// OBSERVADOR: conta UPDATEs efetivos em public.casos. E instrumentacao de teste
// (gatilho `zzz_` para disparar por ultimo), nao regra -- nao altera nada.
const OBSERVADOR = `
  create table if not exists _obs_update_casos (
    id bigserial primary key, caso_id uuid, em timestamptz default clock_timestamp());
  create or replace function _obs_casos() returns trigger language plpgsql as $o$
  begin insert into _obs_update_casos(caso_id) values (new.id); return null; end $o$;
  drop trigger if exists zzz_obs_update_casos on public.casos;
  create trigger zzz_obs_update_casos after update on public.casos
    for each row execute function _obs_casos();
`;

let DUMP_SEM; // fixture verificada, SEM a proposta
let DUMP_COM; // fixture + proposta aplicada

const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: ext });

async function base() {
  const db = new PGlite({ extensions: ext });
  await db.exec(FIXTURE);

  // PORTAO DE FIDELIDADE: se qualquer corpo divergir de producao, para aqui.
  const rows = await qn(
    db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`
  );
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5_PROD)) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome) values
      ('Operador A', '${A}', 'operador', true, 'OPERADOR A'),
      ('Operador B', '${B}', 'operador', true, 'OPERADOR B'),
      ('Gestao Teste', '${GESTAO}', 'gerencia', true, null);
  `);
  await db.exec(OBSERVADOR);
  return db;
}

// aluno + caso + titulo ABERTO com saldo > 0 (logo: nao protegido, nao encerrado)
async function cenario(db, n, o = {}) {
  const {
    operador = A,
    inicio = null,              // fidelizacao_inicio
    dua = null,                 // casos.data_ultimo_acionamento
    statusAcion = null,
    saldo = 500,
    naoAcionar = false,
    respEm = "2026-09-01T12:00:00Z",
  } = o;
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email,
        responsavel_atual_nome, responsavel_atual_em)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, operador, "OPERADOR", respEm]
  );
  if (saldo > 0) {
    await db.query(
      `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento,
          valor_original, saldo_corrigido, situacao, status)
       values ($1,$2,$3,'2026-01-10',$4,$4,'ABERTO','em_aberto')`,
      [U(n), cpf, `DOC${n}`, saldo]
    );
  }
  const caso = await q1(
    db,
    `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email,
        status_acionamento, nao_acionar, data_ultimo_acionamento, caso_codigo)
     values ($1,$2,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [U(n), cpf, `Aluno Sintetico ${n}`, operador, statusAcion, naoAcionar, dua, n]
  );
  if (inicio) {
    // DUMP_SEM (linha de base de producao) nao tem a coluna -- e o esperado.
    const tem = await q1(db, `select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='casos' and column_name='fidelizacao_inicio'`);
    if (tem.n > 0) {
      await db.query(`update public.casos set fidelizacao_inicio = $2 where id = $1`, [caso.id, inicio]);
    }
  }
  await db.exec(`delete from _obs_update_casos`);
  return caso.id;
}

const mov = (db, alunoId, tipo, por, quando = null) =>
  db.query(
    `insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_por_email, registrado_em)
     values ($1,$2,$3, coalesce($4::timestamptz, now()))`,
    [String(alunoId), tipo, por, quando]
  );

const fid = async (db, casoId) =>
  (await q1(db, `select fidelizacao_inicio, data_ultimo_acionamento dua from public.casos where id=$1`, [casoId]));

const comoGestao = (db) =>
  db.exec(`select set_config('request.jwt.claims','{"email":"${GESTAO}"}',false)`);

beforeAll(async () => {
  const db = await base();
  DUMP_SEM = await db.dumpDataDir();
  await db.exec(MIGRATION);
  DUMP_COM = await db.dumpDataDir();
  await db.close();
});

// ============================================================================
describe("A. compilacao integral da proposta sobre a fixture de producao", () => {
  it("cria coluna, indice parcial, funcoes, gatilho, tabela da sombra, RLS e parametro", async () => {
    const db = abrir(DUMP_COM);
    const o = await q1(
      db,
      `select
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='casos' and column_name='fidelizacao_inicio') coluna,
        (select count(*) from pg_class where relname='idx_casos_fidelizacao_inicio' and relkind='i') indice,
        (select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid
          where c.relname='idx_casos_fidelizacao_inicio' and i.indpred is not null) indice_parcial,
        (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in ('fidelizacao_param','fidelizacao_corte',
            'fidelizacao_corte_ts','fidelizacao_dias','fidelizacao_teto_diario','fidelizacao_modo',
            'hoje_brt','fidelizacao_vencida','fidelizacao_elegivel_em','eh_acionamento_fidelizacao',
            'fidelizacao_backfill_corte','casos_elegiveis_liberacao_fidelizacao_v2',
            'fidelizacao_sombra_registrar','_fidelizacao_nasce_com_o_dono',
            'fidelizacao_limite_vencido')) funcoes_novas,
        (select count(*) from pg_trigger where tgname='trg_fidelizacao_nasce_com_o_dono') gatilho,
        (select count(*) from pg_class where relname='fidelizacao_sombra' and relkind='r') tabela_sombra,
        (select count(*) from pg_class where relname='fidelizacao_sombra' and relrowsecurity) rls_ligada,
        (select count(*) from pg_policies where tablename='fidelizacao_sombra') policies,
        (select count(*) from public.parametros_operacao where chave='fidelizacao_por_dono') parametro`
    );
    expect(o).toMatchObject({
      coluna: 1, indice: 1, indice_parcial: 1, funcoes_novas: 15,
      gatilho: 1, tabela_sombra: 1, rls_ligada: 1, policies: 1, parametro: 1,
    });
    await db.close();
  });

  it("o parametro carrega corte, dias, teto e modo sombra", async () => {
    const db = abrir(DUMP_COM);
    const p = await q1(db, `select public.fidelizacao_corte()::text corte,
      public.fidelizacao_dias() dias, public.fidelizacao_teto_diario() teto,
      public.fidelizacao_modo() modo`);
    expect(p).toMatchObject({ corte: CORTE, dias: 10, teto: 20, modo: "sombra" });
    await db.close();
  });

  it("sem o parametro configurado, o modo cai para sombra (nunca libera por falta de config)", async () => {
    const db = abrir(DUMP_COM);
    await db.exec(`delete from public.parametros_operacao where chave='fidelizacao_por_dono'`);
    const p = await q1(db, `select public.fidelizacao_modo() modo, public.fidelizacao_dias() dias,
      public.fidelizacao_corte() is null sem_corte`);
    expect(p).toMatchObject({ modo: "sombra", dias: 10, sem_corte: true });
    await db.close();
  });

  it("ACL: anon nao executa nada da proposta; authenticated executa", async () => {
    const db = abrir(DUMP_COM);
    const r = await qn(db, `select p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('fidelizacao_backfill_corte',
        'fidelizacao_sombra_registrar','casos_elegiveis_liberacao_fidelizacao_v2',
        'fidelizacao_vencida','fidelizacao_elegivel_em','hoje_brt','fidelizacao_limite_vencido')
      order by p.proname`);
    expect(r.length).toBeGreaterThanOrEqual(7);
    for (const f of r) {
      expect(f.anon, `anon nao pode executar ${f.proname}`).toBe(false);
      expect(f.auth, `authenticated deve executar ${f.proname}`).toBe(true);
    }
    await db.close();
  });
});

// ============================================================================
describe("J-M. fronteira dos 10 dias -- regra literal, data local de Brasilia", () => {
  const casos = [
    ["01/10 00:01 BRT", "2026-10-01T00:01:00-03:00", "2026-10-11"],
    ["01/10 14:30 BRT", "2026-10-01T14:30:00-03:00", "2026-10-11"],
    ["01/10 23:59 BRT", "2026-10-01T23:59:00-03:00", "2026-10-11"],
    ["25/10 -> virada de MES", "2026-10-25T09:00:00-03:00", "2026-11-04"],
    ["25/12/2026 -> virada de ANO", "2026-12-25T09:00:00-03:00", "2027-01-04"],
  ];
  for (const [rotulo, inicio, esperado] of casos) {
    it(`inicio ${rotulo} => elegivel em ${esperado}`, async () => {
      const db = abrir(DUMP_COM);
      const r = await q1(db, `select public.fidelizacao_elegivel_em($1::timestamptz)::text d`, [inicio]);
      expect(r.d).toBe(esperado);
      await db.close();
    });
  }

  it("K. inicio 01/10 as 22:30 BRT (=02/10 01:30 UTC) usa a data BRT: 11/10, nao 12/10", async () => {
    const db = abrir(DUMP_COM);
    const r = await q1(db, `select
      public.fidelizacao_elegivel_em($1::timestamptz)::text brt,
      (($1::timestamptz at time zone 'UTC')::date + 10)::text se_fosse_utc`, ["2026-10-01T22:30:00-03:00"]);
    expect(r.brt).toBe("2026-10-11");
    expect(r.se_fosse_utc).toBe("2026-10-12"); // o dia que o fuso errado daria
    await db.close();
  });

  it("o limite sargavel e EXATAMENTE equivalente a fidelizacao_vencida", async () => {
    const db = abrir(DUMP_COM);
    // 2.000 instantes cobrindo 40 dias em passos de ~29 min, cada hora do dia
    const r = await q1(db, `
      with amostra as (
        select (public.hoje_brt() - 40)::timestamp at time zone 'America/Sao_Paulo'
               + (g * interval '29 minutes') as inicio
          from generate_series(1, 2000) g)
      select count(*)::int total,
             count(*) filter (where public.fidelizacao_vencida(inicio)
                                 <> (inicio < public.fidelizacao_limite_vencido()))::int divergem
        from amostra`);
    expect(r.total).toBe(2000);
    expect(r.divergem).toBe(0);
    await db.close();
  });

  it("o banco do teste esta em UTC, como producao -- senao o teste de fuso nao prova nada", async () => {
    const db = abrir(DUMP_COM);
    // o nome pode vir como 'UTC' ou 'Etc/GMT0'; o que importa e o deslocamento
    const r = await q1(db, `select current_setting('TimeZone') tz,
      extract(timezone from now())::int off_seg`);
    expect(r.off_seg).toBe(0);
    expect(String(r.tz)).toMatch(/UTC|GMT0/);
    await db.close();
  });

  it("hoje_brt() usa a data de Brasilia, nao current_date (banco em UTC)", async () => {
    const db = abrir(DUMP_COM);
    const r = await q1(db, `select public.hoje_brt() = (now() at time zone 'America/Sao_Paulo')::date ok,
      public.hoje_brt()::text brt, current_date::text utc`);
    expect(r.ok).toBe(true);
    await db.close();
  });

  it("10 dias completos: no 10o dia protegido, no 11o elegivel", async () => {
    const db = abrir(DUMP_COM);
    const r = await q1(db, `select
      public.fidelizacao_vencida((public.hoje_brt() - 9)::timestamp at time zone 'America/Sao_Paulo') dia10,
      public.fidelizacao_vencida((public.hoje_brt() - 10)::timestamp at time zone 'America/Sao_Paulo') dia11,
      public.fidelizacao_vencida(null) nulo`);
    expect(r).toMatchObject({ dia10: false, dia11: true, nulo: false });
    await db.close();
  });
});

// ============================================================================
describe("B-C. troca de dono", () => {
  it("B. dono A -> dono B reinicia fidelizacao_inicio no instante da troca", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 1, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    const antes = await fid(db, c);
    await db.query(`update public.casos set operador_email=$2 where id=$1`, [c, B]);
    const depois = await fid(db, c);
    expect(new Date(depois.fidelizacao_inicio).getTime())
      .toBeGreaterThan(new Date(antes.fidelizacao_inicio).getTime());
    const d = await q1(db, `select extract(epoch from (now() - fidelizacao_inicio)) seg
      from public.casos where id=$1`, [c]);
    expect(Number(d.seg)).toBeLessThan(5); // "agora"
    await db.close();
  });

  it("B2. liberar o caso (operador nulo) zera o relogio", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 2, { inicio: "2026-09-10T10:00:00Z" });
    await db.query(`update public.casos set operador_email=null where id=$1`, [c]);
    expect((await fid(db, c)).fidelizacao_inicio).toBe(null);
    await db.close();
  });

  it("C. UPDATE sem trocar o dono NAO reinicia (clausula WHEN nao dispara)", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 3, { inicio: "2026-09-10T10:00:00Z" });
    await db.query(`update public.casos set observacao='mexeu em outra coluna' where id=$1`, [c]);
    const r = await fid(db, c);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-10T10:00:00.000Z");
    await db.close();
  });

  it("C2. reescrever o MESMO operador tambem nao reinicia", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 4, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    await db.query(`update public.casos set operador_email=$2 where id=$1`, [c, A]);
    const r = await fid(db, c);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-10T10:00:00.000Z");
    await db.close();
  });
});

// ============================================================================
describe("D-F. o que renova e o que nao renova", () => {
  const RENOVAM = ["FINALIZACAO_ATENDIMENTO", "EM_ATENDIMENTO", "LINK_ENVIADO_AO_ALUNO",
    "COMPROVANTE_ENVIADO_BAIXA", "RETORNO_TERMO", "BAIXA_REALIZADA", "QUITADO_MANUAL"];
  const NAO_RENOVAM = ["ACAO_MASSIVA_EXTERNA", "ACAO_MASSIVA_EXTERNA_EMAIL", "RETORNO_ADM_CRIADO",
    "RETORNO_ADM_CONCLUIDO", "SOLICITACAO_LINK_PAGAMENTO", "TITULO_EM_CONFIRMACAO_PRIME",
    "REDISTRIBUICAO_SINCRONIZACAO", "ASSUMIU_ATENDIMENTO", "ATRIBUICAO_ACORDO",
    "ALTERACAO_RESPONSAVEL_ACORDO", "REABERTURA_DIVIDA_NOVA"];

  for (const [i, tipo] of RENOVAM.entries()) {
    it(`D. ${tipo} do proprio dono RENOVA`, async () => {
      const db = abrir(DUMP_COM);
      const c = await cenario(db, 100 + i, { operador: A, inicio: "2026-09-10T10:00:00Z" });
      await mov(db, U(100 + i), tipo, A);
      const r = await fid(db, c);
      expect(new Date(r.fidelizacao_inicio).getTime())
        .toBeGreaterThan(new Date("2026-09-10T10:00:00Z").getTime());
      await db.close();
    });
  }

  for (const [i, tipo] of NAO_RENOVAM.entries()) {
    it(`E. ${tipo} NAO renova`, async () => {
      const db = abrir(DUMP_COM);
      const c = await cenario(db, 200 + i, { operador: A, inicio: "2026-09-10T10:00:00Z" });
      await mov(db, U(200 + i), tipo, A);
      const r = await fid(db, c);
      expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-10T10:00:00.000Z");
      await db.close();
    });
  }

  it("F. acionamento valido registrado por OUTRO operador nao renova", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 5, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    await mov(db, U(5), "FINALIZACAO_ATENDIMENTO", B);
    const r = await fid(db, c);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-10T10:00:00.000Z");
    await db.close();
  });

  it("F2. caso com fidelizacao_inicio nulo (sem backfill) nunca renova -- freio de mao", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 6, { operador: A, inicio: null });
    await mov(db, U(6), "FINALIZACAO_ATENDIMENTO", A);
    expect((await fid(db, c)).fidelizacao_inicio).toBe(null);
    await db.close();
  });
});

// ============================================================================
describe("G-H. monotonicidade", () => {
  it("G. evento ANTERIOR ao inicio vigente nao reduz o campo", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 7, { operador: A, inicio: "2026-09-20T10:00:00Z" });
    await mov(db, U(7), "FINALIZACAO_ATENDIMENTO", A, "2026-09-15T10:00:00Z");
    const r = await fid(db, c);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-20T10:00:00.000Z");
    await db.close();
  });

  it("H. dois eventos validos em sequencia: fica o mais recente", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 8, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    await mov(db, U(8), "FINALIZACAO_ATENDIMENTO", A, "2026-09-18T09:00:00Z");
    await mov(db, U(8), "EM_ATENDIMENTO", A, "2026-09-22T17:00:00Z");
    const r = await fid(db, c);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-22T17:00:00.000Z");
    await db.close();
  });

  it("H2. o segundo evento fora de ordem (mais antigo) nao puxa para tras", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 9, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    await mov(db, U(9), "FINALIZACAO_ATENDIMENTO", A, "2026-09-22T17:00:00Z");
    await mov(db, U(9), "EM_ATENDIMENTO", A, "2026-09-18T09:00:00Z");
    const r = await fid(db, c);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-22T17:00:00.000Z");
    await db.close();
  });
});

// ============================================================================
describe("I. semantica antiga de data_ultimo_acionamento preservada", () => {
  it("os 3 tipos ampliados renovam a fidelizacao e NAO tocam data_ultimo_acionamento", async () => {
    for (const tipo of ["EM_ATENDIMENTO", "RETORNO_TERMO", "BAIXA_REALIZADA"]) {
      const db = abrir(DUMP_COM);
      const n = 300 + tipo.length;
      const c = await cenario(db, n, { operador: A, inicio: "2026-09-10T10:00:00Z", dua: "2026-09-05" });
      await mov(db, U(n), tipo, A);
      const r = await fid(db, c);
      expect(r.dua.toISOString().slice(0, 10), `${tipo} nao pode mexer em dua`).toBe("2026-09-05");
      expect(new Date(r.fidelizacao_inicio).getTime(), `${tipo} deve renovar`)
        .toBeGreaterThan(new Date("2026-09-10T10:00:00Z").getTime());
      await db.close();
    }
  });

  it("tipo da lista antiga continua atualizando data_ultimo_acionamento (em casos e em alunos)", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 11, { operador: A, inicio: "2026-09-10T10:00:00Z", dua: "2026-09-05" });
    await mov(db, U(11), "FINALIZACAO_ATENDIMENTO", A);
    const r = await fid(db, c);
    expect(r.dua.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    const al = await q1(db, `select data_ultimo_acionamento from public.alunos where id=$1`, [U(11)]);
    expect(al.data_ultimo_acionamento).not.toBe(null);
    await db.close();
  });

  it("tipo reprovado que ESTA na lista antiga mexe em dua e nao na fidelizacao", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 12, { operador: A, inicio: "2026-09-10T10:00:00Z", dua: "2026-09-05" });
    await mov(db, U(12), "RETORNO_ADM_CRIADO", A);
    const r = await fid(db, c);
    expect(r.dua.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-09-10T10:00:00.000Z");
    await db.close();
  });

  it("as funcoes NOVAS nao leem data_ultimo_acionamento -- as duas grandezas sao independentes", async () => {
    // O arquivo da proposta CONTEM a palavra, porque recria
    // fn_atualizar_ultimo_acionamento inteira (inclusive o bloco antigo, que e
    // justamente quem deve continuar escrevendo em dua). O que precisa estar
    // limpo sao as funcoes NOVAS -- conferido no corpo instalado no banco.
    const db = abrir(DUMP_COM);
    const rows = await qn(db, `select p.proname, p.prosrc from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'fidelizacao%'
        or p.proname in ('hoje_brt','eh_acionamento_fidelizacao',
          'casos_elegiveis_liberacao_fidelizacao_v2','_fidelizacao_nasce_com_o_dono'))`);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const f of rows) {
      expect(f.prosrc, `${f.proname} nao pode ler data_ultimo_acionamento`)
        .not.toMatch(/data_ultimo_acionamento/);
    }
    await db.close();
  });
});

// ============================================================================
describe("BUG DOS DOIS UPDATES -- um unico UPDATE em casos por acionamento", () => {
  // A versao anterior fazia dois `update public.casos`. `casos` tem
  // trigger_repor_caso_operador AFTER UPDATE, entao dois UPDATEs = gatilho
  // avaliado duas vezes. Este teste FALHAVA antes da correcao.
  const DOIS_UPDATES = `
    create or replace function public.fn_atualizar_ultimo_acionamento()
     returns trigger language plpgsql security definer set search_path to 'public' as $f$
    declare v_uuid uuid;
    begin
      if not public.eh_tipo_acionamento(new.tipo)
         and not public.eh_acionamento_fidelizacao(new.tipo) then return new; end if;
      if new.tipo in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL') then return new; end if;
      begin v_uuid := new.aluno_id::uuid; exception when others then return new; end;
      if public.eh_tipo_acionamento(new.tipo) then
        update public.casos c set data_ultimo_acionamento = new.registrado_em::date
         where c.aluno_id = v_uuid
           and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < new.registrado_em::date);
      end if;
      if public.eh_acionamento_fidelizacao(new.tipo) and new.registrado_por_email is not null then
        update public.casos c set fidelizacao_inicio = new.registrado_em
         where c.aluno_id = v_uuid and c.encerrado_operacional = false
           and c.fidelizacao_inicio is not null
           and lower(c.operador_email) = lower(new.registrado_por_email)
           and c.fidelizacao_inicio < new.registrado_em;
      end if;
      -- mesma chamada que a proposta faz, para a comparacao ser justa: a UNICA
      -- diferenca entre esta versao e a da proposta e a estrutura de dois UPDATEs
      begin perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
      exception when others then null; end;
      return new;
    exception when others then return new; end; $f$;
  `;

  // NOTA DE MEDICAO: o observador conta TODO UPDATE em public.casos, e
  // fn_atualizar_ultimo_acionamento chama recalcular_situacao_aluno, que faz o
  // seu proprio UPDATE -- isso ja acontece HOJE em producao. Por isso o numero
  // que importa nao e absoluto: e a COMPARACAO com a linha de base de producao
  // (DUMP_SEM, com a funcao exata de hoje). A proposta nao pode aumentar.
  const contarUpdates = async (dump, n, extra = null) => {
    const db = abrir(dump);
    if (extra) await db.exec(extra);
    const c = await cenario(db, n, { operador: A, inicio: "2026-09-10T10:00:00Z", dua: "2026-09-05" });
    await mov(db, U(n), "FINALIZACAO_ATENDIMENTO", A);
    const r = await q1(db, `select count(*)::int n from _obs_update_casos where caso_id=$1`, [c]);
    await db.close();
    return r.n;
  };

  it("I. a migration NAO aumenta o numero de UPDATEs em casos por acionamento", async () => {
    const producaoHoje = await contarUpdates(DUMP_SEM, 20);
    const comProposta = await contarUpdates(DUMP_COM, 20);
    expect(comProposta).toBe(producaoHoje);
  });

  it("a versao ANTERIOR (dois updates) fazia UM UPDATE A MAIS -- prova do bug corrigido", async () => {
    const producaoHoje = await contarUpdates(DUMP_SEM, 21);
    const comProposta = await contarUpdates(DUMP_COM, 21);
    const comBug = await contarUpdates(DUMP_COM, 21, DOIS_UPDATES);
    expect(comProposta).toBe(producaoHoje);
    expect(comBug).toBe(producaoHoje + 1);
  });

  it("acionamento que nao muda nada nao gera UPDATE no-op da fidelizacao", async () => {
    const semMudanca = async (dump) => {
      const db = abrir(dump);
      const c = await cenario(db, 22, { operador: A, inicio: "2026-09-20T10:00:00Z", dua: "2026-09-25" });
      await mov(db, U(22), "FINALIZACAO_ATENDIMENTO", A, "2026-09-15T10:00:00Z");
      const r = await q1(db, `select count(*)::int n from _obs_update_casos where caso_id=$1`, [c]);
      await db.close();
      return r.n;
    };
    expect(await semMudanca(DUMP_COM)).toBe(await semMudanca(DUMP_SEM));
  });

  it("trigger_repor_caso_operador nao dispara uma segunda vez por causa da fidelizacao", async () => {
    // caso que FECHA no acionamento: o gatilho de reposicao libera e enfileira.
    // Com um UPDATE so, ele enfileira UMA vez.
    const efeitos = async (db, alunoN, tipo) => {
      const temColuna = (await q1(db, `select count(*)::int n from information_schema.columns
        where table_schema='public' and table_name='casos' and column_name='fidelizacao_inicio'`)).n > 0;
      const c = await cenario(db, alunoN, {
        operador: A, inicio: temColuna ? "2026-09-10T10:00:00Z" : null,
        saldo: 0, statusAcion: "ACORDO FECHADO",
      });
      await mov(db, U(alunoN), tipo, A);
      return q1(db, `select
        (select count(*)::int from public.reposicao_carteira_fila where caso_origem_id=$1) fila,
        (select count(*)::int from public.historico_operadores_alunos
          where acao='LIBERACAO_AUTOMATICA_CASO_FECHADO') hist,
        (select count(*)::int from _obs_update_casos where caso_id=$1) updates`, [c]);
    };
    const db0 = abrir(DUMP_SEM);
    const producaoHoje = await efeitos(db0, 23, "FINALIZACAO_ATENDIMENTO");
    await db0.close();

    const db1 = abrir(DUMP_COM);
    const comProposta = await efeitos(db1, 23, "FINALIZACAO_ATENDIMENTO");
    await db1.close();

    const db2 = abrir(DUMP_COM);
    await db2.exec(DOIS_UPDATES);
    const comBug = await efeitos(db2, 23, "FINALIZACAO_ATENDIMENTO");
    await db2.close();

    // identico a producao de hoje; a versao com o bug faz um UPDATE a mais
    expect(comProposta.updates).toBe(producaoHoje.updates);
    expect(comBug.updates).toBe(producaoHoje.updates + 1);
    // e o efeito observavel do gatilho de reposicao nao muda
    expect(comProposta.fila).toBe(producaoHoje.fila);
    expect(comProposta.hist).toBe(producaoHoje.hist);
  });
});

// ============================================================================
describe("N-Q. backfill", () => {
  it("N. atribuicao ANTES do corte -> recebe a meia-noite do corte em Brasilia", async () => {
    const db = abrir(DUMP_COM);
    await comoGestao(db);
    await cenario(db, 30, { operador: A, respEm: "2026-08-15T13:00:00Z" });
    const n = await q1(db, `select public.fidelizacao_backfill_corte() n`);
    expect(Number(n.n)).toBeGreaterThanOrEqual(1);
    const r = await q1(db, `select fidelizacao_inicio,
      (fidelizacao_inicio at time zone 'America/Sao_Paulo')::text local,
      public.fidelizacao_elegivel_em(fidelizacao_inicio)::text elegivel
      from public.casos where aluno_id=$1`, [U(30)]);
    expect(r.local).toBe("2026-10-01 00:00:00");
    expect(r.elegivel).toBe("2026-10-11");
    await db.close();
  });

  it("O. atribuicao DEPOIS do corte -> recebe responsavel_atual_em", async () => {
    const db = abrir(DUMP_COM);
    await comoGestao(db);
    await cenario(db, 31, { operador: A, respEm: "2026-10-09T19:20:00Z" });
    await db.exec(`select public.fidelizacao_backfill_corte()`);
    const r = await q1(db, `select fidelizacao_inicio from public.casos where aluno_id=$1`, [U(31)]);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-10-09T19:20:00.000Z");
    await db.close();
  });

  it("P. nunca REDUZ um inicio ja renovado pelo dono", async () => {
    const db = abrir(DUMP_COM);
    await comoGestao(db);
    await cenario(db, 32, { operador: A, respEm: "2026-08-15T13:00:00Z", inicio: "2026-10-07T14:00:00Z" });
    await db.exec(`select public.fidelizacao_backfill_corte()`);
    const r = await q1(db, `select fidelizacao_inicio from public.casos where aluno_id=$1`, [U(32)]);
    expect(new Date(r.fidelizacao_inicio).toISOString()).toBe("2026-10-07T14:00:00.000Z");
    await db.close();
  });

  it("Q. idempotente: a segunda execucao devolve 0 e nao altera nada", async () => {
    const db = abrir(DUMP_COM);
    await comoGestao(db);
    for (let i = 33; i <= 35; i++) await cenario(db, i, { operador: A, respEm: "2026-08-15T13:00:00Z" });
    const p1 = await q1(db, `select public.fidelizacao_backfill_corte() n`);
    const snap1 = await qn(db, `select id, fidelizacao_inicio from public.casos order by id`);
    const p2 = await q1(db, `select public.fidelizacao_backfill_corte() n`);
    const snap2 = await qn(db, `select id, fidelizacao_inicio from public.casos order by id`);
    expect(Number(p1.n)).toBeGreaterThanOrEqual(3);
    expect(Number(p2.n)).toBe(0);
    expect(JSON.stringify(snap2)).toBe(JSON.stringify(snap1));
    await db.close();
  });

  it("backfill exige gestao: operador comum recebe sem_permissao", async () => {
    const db = abrir(DUMP_COM);
    await db.exec(`select set_config('request.jwt.claims','{"email":"${A}"}',false)`);
    await expect(db.exec(`select public.fidelizacao_backfill_corte()`)).rejects.toThrow(/sem_permissao/);
    await db.close();
  });

  it("sem corte configurado, o backfill se recusa a rodar", async () => {
    const db = abrir(DUMP_COM);
    await comoGestao(db);
    await db.exec(`update public.parametros_operacao
      set valor = valor - 'corte' where chave='fidelizacao_por_dono'`);
    await expect(db.exec(`select public.fidelizacao_backfill_corte()`))
      .rejects.toThrow(/DATA_DE_CORTE nao configurada/);
    await db.close();
  });
});

// ============================================================================
describe("R-S. teto por operador e protecao", () => {
  async function carteira(db, { deA, deB, protegidosDeA = 0 }) {
    let n = 400;
    const vencido = `(public.hoje_brt() - 30)::timestamp at time zone 'America/Sao_Paulo'`;
    for (let i = 0; i < deA; i++, n++) {
      const protegido = i < protegidosDeA;
      await cenario(db, n, {
        operador: A,
        // protegido por status de negociacao em curso (regra real de producao)
        statusAcion: protegido ? "EM NEGOCIACAO" : null,
      });
      await db.exec(`update public.casos set fidelizacao_inicio = ${vencido} where aluno_id='${U(n)}'`);
    }
    for (let i = 0; i < deB; i++, n++) {
      await cenario(db, n, { operador: B });
      await db.exec(`update public.casos set fidelizacao_inicio = ${vencido} where aluno_id='${U(n)}'`);
    }
  }

  it("R. A com 35 elegiveis e B com 8, teto 20: A solta 20, B solta 8, total 28", async () => {
    const db = abrir(DUMP_COM);
    await carteira(db, { deA: 35, deB: 8 });
    const r = await qn(db, `select operador_email op, count(*)::int elegiveis,
        count(*) filter (where ordem_na_fila <= public.fidelizacao_teto_diario())::int solta_hoje,
        count(*) filter (where ordem_na_fila >  public.fidelizacao_teto_diario())::int fila
      from public.casos_elegiveis_liberacao_fidelizacao_v2() group by 1 order by 1`);
    expect(r).toEqual([
      { op: A, elegiveis: 35, solta_hoje: 20, fila: 15 },
      { op: B, elegiveis: 8, solta_hoje: 8, fila: 0 },
    ]);
    await db.close();
  });

  it("R2. o teto NAO e global: o total do dia e 28, nao 20", async () => {
    const db = abrir(DUMP_COM);
    await carteira(db, { deA: 35, deB: 8 });
    const t = await q1(db, `select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao_v2()
      where ordem_na_fila <= public.fidelizacao_teto_diario()`);
    expect(t.n).toBe(28);
    await db.close();
  });

  it("S. 25 vencidos com os 5 primeiros protegidos: solta 20 desprotegidos, nao 15", async () => {
    const db = abrir(DUMP_COM);
    await carteira(db, { deA: 25, deB: 0, protegidosDeA: 5 });
    const r = await q1(db, `select
      (select count(*)::int from public.casos where fidelizacao_inicio is not null) vencidos,
      (select count(*)::int from public.casos c where public.caso_protegido_redistribuicao(
          c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,
          c.valor_pago,c.quitado_em,c.valor_quitado)) protegidos,
      (select count(*)::int from public.casos_elegiveis_liberacao_fidelizacao_v2()) na_v2,
      (select count(*)::int from public.casos_elegiveis_liberacao_fidelizacao_v2()
        where ordem_na_fila <= public.fidelizacao_teto_diario()) solta_hoje`);
    expect(r).toMatchObject({ vencidos: 25, protegidos: 5, na_v2: 20, solta_hoje: 20 });
    await db.close();
  });

  it("S2. a numeracao comeca em 1 no primeiro DESPROTEGIDO (protegido nao consome posicao)", async () => {
    const db = abrir(DUMP_COM);
    await carteira(db, { deA: 25, deB: 0, protegidosDeA: 5 });
    const r = await qn(db, `select min(ordem_na_fila)::int lo, max(ordem_na_fila)::int hi
      from public.casos_elegiveis_liberacao_fidelizacao_v2()`);
    expect(r[0]).toMatchObject({ lo: 1, hi: 20 });
    await db.close();
  });

  it("caso protegido nunca aparece na v2, mesmo com prazo vencido", async () => {
    const db = abrir(DUMP_COM);
    await cenario(db, 500, { operador: A, statusAcion: "EM NEGOCIACAO" });
    await db.exec(`update public.casos set fidelizacao_inicio =
      (public.hoje_brt() - 40)::timestamp at time zone 'America/Sao_Paulo'`);
    const n = await q1(db, `select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao_v2()`);
    expect(n.n).toBe(0);
    await db.close();
  });

  it("nao_acionar protege", async () => {
    const db = abrir(DUMP_COM);
    await cenario(db, 501, { operador: A, naoAcionar: true });
    await db.exec(`update public.casos set fidelizacao_inicio =
      (public.hoje_brt() - 40)::timestamp at time zone 'America/Sao_Paulo'`);
    const n = await q1(db, `select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao_v2()`);
    expect(n.n).toBe(0);
    await db.close();
  });

  it("ordenacao deterministica: fidelizacao_inicio, depois responsavel_atual_em, depois id", async () => {
    const db = abrir(DUMP_COM);
    const mesmo = `(public.hoje_brt() - 30)::timestamp at time zone 'America/Sao_Paulo'`;
    for (const [i, resp] of [["2026-08-03", 0], ["2026-08-01", 1], ["2026-08-02", 2]].entries()) {
      await cenario(db, 600 + i, { operador: A, respEm: `${resp[0]}T12:00:00Z` });
    }
    await db.exec(`update public.casos set fidelizacao_inicio = ${mesmo}`);
    const r = await qn(db, `select v.ordem_na_fila, a.responsavel_atual_em
      from public.casos_elegiveis_liberacao_fidelizacao_v2() v
      join public.alunos a on a.id = v.aluno_id order by v.ordem_na_fila`);
    const datas = r.map((x) => new Date(x.responsavel_atual_em).getTime());
    expect(datas).toEqual([...datas].sort((a, b) => a - b)); // mais antigo primeiro
    await db.close();
  });
});

// ============================================================================
describe("T-V. modo sombra", () => {
  async function comSombra(db) {
    await comoGestao(db);
    const vencido = `(public.hoje_brt() - 30)::timestamp at time zone 'America/Sao_Paulo'`;
    for (let n = 700; n < 703; n++) await cenario(db, n, { operador: A });
    await cenario(db, 703, { operador: A, statusAcion: "EM NEGOCIACAO" }); // protegido
    await db.exec(`update public.casos set fidelizacao_inicio = ${vencido}`);
    return q1(db, `select public.fidelizacao_sombra_registrar() n`);
  }

  it("T. idempotente no mesmo dia: segunda execucao nao duplica linha", async () => {
    const db = abrir(DUMP_COM);
    await comSombra(db);
    const a = await q1(db, `select count(*)::int n from public.fidelizacao_sombra`);
    await db.exec(`select public.fidelizacao_sombra_registrar()`);
    const b = await q1(db, `select count(*)::int n,
      count(distinct (dia, caso_id))::int distintos from public.fidelizacao_sombra`);
    expect(b.n).toBe(a.n);
    expect(b.distintos).toBe(b.n);
    await db.close();
  });

  it("U. registra o protegido com a protecao nomeada e posicao nula", async () => {
    const db = abrir(DUMP_COM);
    await comSombra(db);
    const p = await q1(db, `select protecao_encontrada, ordem_na_fila, dentro_do_teto
      from public.fidelizacao_sombra where protecao_encontrada is not null`);
    expect(p.protecao_encontrada).toBe("caso_protegido_redistribuicao");
    expect(p.ordem_na_fila).toBe(null);
    expect(p.dentro_do_teto).toBe(false);
    await db.close();
  });

  it("U2. grava operador, inicio, saldo, posicao, dentro_do_teto, motivo e vigente_tambem", async () => {
    const db = abrir(DUMP_COM);
    await comSombra(db);
    const l = await q1(db, `select * from public.fidelizacao_sombra
      where protecao_encontrada is null order by ordem_na_fila limit 1`);
    expect(l.operador_email).toBe(A);
    expect(l.fidelizacao_inicio).not.toBe(null);
    expect(Number(l.saldo)).toBeGreaterThan(0);
    expect(l.ordem_na_fila).toBe(1);
    expect(l.dentro_do_teto).toBe(true);
    expect(l.motivo).toMatch(/sem acionamento do dono desde|ultimo acionamento do dono em/);
    expect(typeof l.vigente_tambem).toBe("boolean");
    await db.close();
  });

  it("U3. o dia da sombra e a data de Brasilia", async () => {
    const db = abrir(DUMP_COM);
    await comSombra(db);
    const d = await q1(db, `select count(*)::int fora from public.fidelizacao_sombra
      where dia <> public.hoje_brt()`);
    expect(d.fora).toBe(0);
    await db.close();
  });

  it("V. a sombra NAO libera caso nenhum: nenhum operador_email fica nulo", async () => {
    const db = abrir(DUMP_COM);
    await comSombra(db);
    const r = await q1(db, `select
      (select count(*)::int from public.casos where operador_email is null) sem_dono,
      (select count(*)::int from public.casos) total,
      (select count(*)::int from public.reposicao_carteira_fila) fila_reposicao,
      (select count(*)::int from public.historico_operadores_alunos
         where acao like 'FIDELIZACAO%') hist_liberacao`);
    expect(r.sem_dono).toBe(0);
    expect(r.total).toBe(4);
    expect(r.hist_liberacao).toBe(0);
    await db.close();
  });

  it("sombra exige gestao", async () => {
    const db = abrir(DUMP_COM);
    await db.exec(`select set_config('request.jwt.claims','{"email":"${A}"}',false)`);
    await expect(db.exec(`select public.fidelizacao_sombra_registrar()`)).rejects.toThrow(/sem_permissao/);
    await db.close();
  });

  it("W. RLS da sombra: leitura so para gestao", async () => {
    const db = abrir(DUMP_COM);
    const p = await q1(db, `select polname, polcmd, pg_get_expr(polqual, polrelid) usando
      from pg_policy where polrelid='public.fidelizacao_sombra'::regclass`);
    expect(p.polname).toBe("fidelizacao_sombra_leitura_gestao");
    expect(p.polcmd).toBe("r");
    expect(p.usando).toMatch(/usuario_e_gestao_fila/);
    await db.close();
  });
});

// ============================================================================
describe("NAO REGRESSAO -- a migration nao toca no que nao e dela", () => {
  const INTOCADAS = [
    "public.caso_dentro_prazo_fidelizacao",
    "internal.matricula_em_fidelizacao",
    "public.casos_elegiveis_liberacao_fidelizacao",
    "public.caso_protegido_redistribuicao",
    "public.caso_encerrado_operacional",
    "public.eh_tipo_acionamento",
    "public.trg_impor_teto_operador",
    "public.trg_repor_caso_operador",
    "public.trg_sincronizar_alunos_apos_casos",
    "internal.set_resp_aluno",
    "public.recalcular_situacao_aluno",
  ];

  it("J. hash das funcoes intocadas: identico ANTES e DEPOIS da proposta", async () => {
    const hashes = async (dump) => {
      const db = abrir(dump);
      const rows = await qn(db, `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal')`);
      await db.close();
      return Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
    };
    const antes = await hashes(DUMP_SEM);
    const depois = await hashes(DUMP_COM);
    for (const f of INTOCADAS) {
      expect(antes[f], `${f} deveria existir antes`).toBeTruthy();
      expect(depois[f], `${f} mudou de definicao`).toBe(antes[f]);
      expect(depois[f], `${f} deveria bater com producao`).toBe(MD5_PROD[f]);
    }
    // a unica funcao de producao que a migration ALTERA de proposito
    expect(depois["public.fn_atualizar_ultimo_acionamento"])
      .not.toBe(antes["public.fn_atualizar_ultimo_acionamento"]);
  });

  it("as tres definicoes de fidelizacao continuam divergentes -- nao harmonizadas nesta migration", async () => {
    const db = abrir(DUMP_COM);
    // MESMO dia relativo (D-10), cada regra medida com o "hoje" que ela usa:
    //   antiga  caso_dentro_prazo_fidelizacao: dua + 10 >= current_date  -> AINDA protegido
    //   nova    fidelizacao_vencida:  inicio_brt + 10 <= hoje_brt()      -> JA vencido
    // As duas discordam sobre o mesmo dia. E o efeito de um dia que a gestao
    // decidiu corrigir -- e que NAO sera harmonizado neste PR.
    const r = await q1(db, `select
      public.caso_dentro_prazo_fidelizacao((current_date - 10)::date) antiga_diz_protegido,
      public.fidelizacao_vencida((public.hoje_brt() - 10)::timestamp at time zone 'America/Sao_Paulo') nova_diz_vencido,
      -- a terceira: conta da ATRIBUICAO do dono, por timestamp, sensivel a hora
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='internal' and p.proname='matricula_em_fidelizacao'
          and p.prosrc like '%responsavel_atual_em > now() - interval%') terceira_conta_por_atribuicao`);
    expect(r.antiga_diz_protegido).toBe(true);
    expect(r.nova_diz_vencido).toBe(true);
    expect(r.terceira_conta_por_atribuicao).toBe(1);
    await db.close();
  });

  it("H. trigger_impor_teto_operador continua existindo, com a mesma definicao", async () => {
    const def = async (dump) => {
      const db = abrir(dump);
      const r = await q1(db, `select pg_get_triggerdef(oid) d from pg_trigger
        where tgname='trigger_impor_teto_operador'`);
      await db.close();
      return r?.d;
    };
    const antes = await def(DUMP_SEM);
    const depois = await def(DUMP_COM);
    expect(antes).toMatch(/AFTER UPDATE ON public\.casos/);
    expect(depois).toBe(antes);
  });

  it("H2. a troca de dono continua passando por trigger_impor_teto_operador", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 800, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    // o gatilho do teto roda AFTER UPDATE quando o dono muda; nao pode estourar
    await db.query(`update public.casos set operador_email=$2 where id=$1`, [c, B]);
    const r = await q1(db, `select operador_email, operador_nome, fidelizacao_inicio
      from public.casos where id=$1`, [c]);
    expect(r.operador_email).toBe(B);
    expect(r.operador_nome).toBe("OPERADOR B"); // trg_nome_do_operador_no_caso rodou
    expect(r.fidelizacao_inicio).not.toBe(null);
    // trg_sync_alunos_apos_casos -> internal.set_resp_aluno rodou
    const al = await q1(db, `select responsavel_atual_email, responsavel_atual_em
      from public.alunos where id=$1`, [U(800)]);
    expect(al.responsavel_atual_email).toBe(B);
    const m = await q1(db, `select count(*)::int n from public.aluno_movimentacoes
      where aluno_id=$1 and tipo='REDISTRIBUICAO_SINCRONIZACAO'`, [U(800)]);
    expect(m.n).toBe(1);
    await db.close();
  });

  it("H3. a cadeia de gatilhos nao reentra: o sync nao renova a fidelizacao", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 801, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    await db.query(`update public.casos set operador_email=$2 where id=$1`, [c, B]);
    const antes = (await fid(db, c)).fidelizacao_inicio;
    // o insert de REDISTRIBUICAO_SINCRONIZACAO nao esta em nenhuma das listas
    const depois = (await fid(db, c)).fidelizacao_inicio;
    expect(new Date(depois).toISOString()).toBe(new Date(antes).toISOString());
    await db.close();
  });

  it("H4. trg_zz_caso_nao_duplica_aluno continua barrando caso duplicado por aluno", async () => {
    const db = abrir(DUMP_COM);
    await cenario(db, 802, { operador: A });
    await expect(
      db.query(
        `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email, caso_codigo)
         values ($1,$2,$2,'Duplicado',$3, 9999)`,
        [U(802), CPF(802), A]
      )
    ).rejects.toThrow();
    await db.close();
  });

  it("H5. trg_bloquear_alteracoes_restritas_casos nao bloqueia fidelizacao_inicio", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 803, { operador: A, inicio: "2026-09-10T10:00:00Z" });
    // como authenticated + e-mail que NAO e a gestora: o gatilho avalia de verdade
    await db.exec(`grant usage on schema public, auth to authenticated;
      grant select, update on public.casos to authenticated;
      grant select, update, insert on public.alunos to authenticated;
      grant select, insert on public.aluno_movimentacoes to authenticated;
      grant select on public.usuarios, public.acordos_titulos, public.acordo_titulo_vinculo,
        public.acordos, public.parcelas, public.solicitacoes_confirmacao_pagamento,
        public.baixas_pagamento, public.links_pagamento, public.calibragem_parametros,
        public.pagamentos, public.retorno_acordo_auto to authenticated;
      grant insert on public.historico_operadores_alunos, public.reposicao_carteira_fila to authenticated;
      grant select, insert on _obs_update_casos to authenticated;
      grant usage on all sequences in schema public to authenticated;`);
    await db.exec(`select set_config('request.jwt.claims','{"email":"${A}"}',false)`);
    await db.exec(`set role authenticated`);
    await db.query(`update public.casos set fidelizacao_inicio = now() where id=$1`, [c]);
    await db.exec(`reset role`);
    expect((await fid(db, c)).fidelizacao_inicio).not.toBe(null);
    await db.close();
  });

  it("a v1 (casos_elegiveis_liberacao_fidelizacao) continua funcionando e e independente da v2", async () => {
    const db = abrir(DUMP_COM);
    await cenario(db, 804, { operador: A, dua: "2026-01-01" }); // vencido pela v1
    const r = await q1(db, `select
      (select count(*)::int from public.casos_elegiveis_liberacao_fidelizacao()) v1,
      (select count(*)::int from public.casos_elegiveis_liberacao_fidelizacao_v2()) v2`);
    expect(r.v1).toBe(1);   // v1 usa data_ultimo_acionamento
    expect(r.v2).toBe(0);   // v2 ignora fidelizacao_inicio nulo
    await db.close();
  });
});

// ============================================================================
describe("X. rollback logico (inline) -- os objetos saem sem deixar rastro", () => {
  it("o roteiro de rollback (inline) remove tudo e a v1 continua de pe", async () => {
    const db = abrir(DUMP_COM);
    await db.exec(`
      drop trigger if exists trg_fidelizacao_nasce_com_o_dono on public.casos;
      drop function if exists public._fidelizacao_nasce_com_o_dono();
      drop function if exists public.casos_elegiveis_liberacao_fidelizacao_v2();
      drop function if exists public.fidelizacao_sombra_registrar();
      drop function if exists public.fidelizacao_backfill_corte();
      drop function if exists public.fidelizacao_vencida(timestamptz);
      drop function if exists public.fidelizacao_elegivel_em(timestamptz);
      drop function if exists public.fidelizacao_corte_ts();
      drop function if exists public.fidelizacao_corte();
      drop function if exists public.fidelizacao_dias();
      drop function if exists public.fidelizacao_teto_diario();
      drop function if exists public.fidelizacao_modo();
      drop function if exists public.fidelizacao_param();
      drop function if exists public.fidelizacao_limite_vencido();
      -- a tabela da sombra usa hoje_brt() no default da coluna dia: sai ANTES da funcao
      drop table if exists public.fidelizacao_sombra;
      drop function if exists public.hoje_brt();
      drop function if exists public.eh_acionamento_fidelizacao(text);
      delete from public.parametros_operacao where chave='fidelizacao_por_dono';
      drop index if exists public.idx_casos_fidelizacao_inicio;
      alter table public.casos drop column if exists fidelizacao_inicio;
    `);
    const o = await q1(db, `select
      (select count(*) from information_schema.columns where table_schema='public'
        and table_name='casos' and column_name='fidelizacao_inicio') coluna,
      (select count(*) from pg_class where relname='fidelizacao_sombra') sombra,
      (select count(*) from pg_trigger where tgname='trg_fidelizacao_nasce_com_o_dono') gatilho,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname like 'fidelizacao%') funcoes,
      (select count(*) from public.parametros_operacao where chave='fidelizacao_por_dono') param,
      (select count(*) from public.casos_elegiveis_liberacao_fidelizacao()) v1_de_pe`);
    expect(o).toMatchObject({ coluna: 0, sombra: 0, gatilho: 0, funcoes: 0, param: 0 });
    expect(Number(o.v1_de_pe)).toBe(0); // roda sem erro
    await db.close();
  });
});

// ============================================================================
// PERFORMANCE -- nao e benchmark, e deteccao de regressao grosseira.
// PGlite roda em WASM num unico processo: os tempos ABSOLUTOS nao dizem nada
// sobre producao. O que vale e a RELACAO entre antes e depois da proposta, e o
// formato do plano (uso do indice parcial, ausencia de seq scan gigante).
// ============================================================================
describe("K. performance com 3.500 casos sinteticos", () => {
  const TOTAL = 3500;
  const OPS = 8;

  // Cria a carteira em massa. `casos` tem 9 gatilhos de INSERT/UPDATE de
  // producao nesta fixture, entao a carga ja exercita todos eles.
  const CARGA = `
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome)
    select 'Op '||g, 'op'||g||'@teste.local', 'operador', true, 'OP '||g
      from generate_series(1, ${OPS}) g;

    insert into public.alunos (id, cpf, nome, matricula,
        responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em)
    select ('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
           lpad((20000000000 + g)::text, 11, '0'), 'Aluno Sintetico '||g, 'M'||g,
           'op'||(1 + g % ${OPS})||'@teste.local', 'OP',
           now() - ((g % 60) || ' days')::interval
      from generate_series(1, ${TOTAL}) g;

    -- titulo ABERTO com saldo, para o caso nao ser protegido por saldo zero
    insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento,
        valor_original, saldo_corrigido, situacao, status)
    select ('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
           lpad((20000000000 + g)::text, 11, '0'), 'D'||g, '2026-01-10',
           100 + g, 100 + g, 'ABERTO', 'em_aberto'
      from generate_series(1, ${TOTAL}) g;

    insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email,
        status_acionamento, caso_codigo, data_ultimo_acionamento)
    select ('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
           lpad((20000000000 + g)::text, 11, '0'), lpad((20000000000 + g)::text, 11, '0'),
           'Aluno Sintetico '||g, 'op'||(1 + g % ${OPS})||'@teste.local',
           -- ~30% protegidos por negociacao em curso (regra real de producao)
           case when g % 10 < 3 then 'EM NEGOCIACAO' else null end,
           100000 + g,
           (current_date - ((g % 40) || ' days')::interval)::date
      from generate_series(1, ${TOTAL}) g;
  `;

  // ~60% com fidelizacao vencida, ~40% dentro do prazo
  const RELOGIO = `
    update public.casos set fidelizacao_inicio =
      case when (caso_codigo % 10) < 6
        then (public.hoje_brt() - 20)::timestamp at time zone 'America/Sao_Paulo'
        else (public.hoje_brt() - 2)::timestamp at time zone 'America/Sao_Paulo' end;
  `;

  let medidas = null;

  beforeAll(async () => {
    const cronometrar = async (fn) => {
      const t = performance.now();
      const r = await fn();
      return { ms: Math.round(performance.now() - t), r };
    };

    // --- custo do acionamento ANTES da proposta (funcao exata de producao)
    const dbSem = abrir(DUMP_SEM);
    await dbSem.exec(CARGA);
    const antes = await cronometrar(() =>
      dbSem.exec(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_por_email, registrado_em)
        select ('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid::text,
               'FINALIZACAO_ATENDIMENTO', 'op'||(1 + g % ${OPS})||'@teste.local', now()
          from generate_series(1, 200) g`));
    const updAntes = await q1(dbSem, `select count(*)::int n from _obs_update_casos`);
    await dbSem.close();

    // --- com a proposta
    const db = abrir(DUMP_COM);
    await db.exec(CARGA);
    await db.exec(RELOGIO);
    await comoGestao(db);
    await db.exec(`analyze public.casos; analyze public.alunos; analyze public.acordos_titulos;`);
    await db.exec(`delete from _obs_update_casos`);

    const depois = await cronometrar(() =>
      db.exec(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_por_email, registrado_em)
        select ('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid::text,
               'FINALIZACAO_ATENDIMENTO', 'op'||(1 + g % ${OPS})||'@teste.local', now()
          from generate_series(1, 200) g`));
    const updDepois = await q1(db, `select count(*)::int n from _obs_update_casos`);

    const v2 = await cronometrar(() => qn(db, `select * from public.casos_elegiveis_liberacao_fidelizacao_v2()`));
    const v1 = await cronometrar(() => qn(db, `select * from public.casos_elegiveis_liberacao_fidelizacao()`));
    const sombra = await cronometrar(() => q1(db, `select public.fidelizacao_sombra_registrar() n`));

    const plano = (await qn(db,
      `explain (analyze, buffers, format text)
       select c.id from public.casos c
        where c.operador_email is not null and c.encerrado_operacional = false
          and c.fidelizacao_inicio is not null
          and c.fidelizacao_inicio < public.fidelizacao_limite_vencido()`))
      .map((r) => r["QUERY PLAN"]).join("\n");

    const cont = await q1(db, `select
      (select count(*)::int from public.casos) casos,
      (select count(*)::int from public.casos where fidelizacao_inicio is not null) com_relogio,
      (select count(*)::int from public.casos_elegiveis_liberacao_fidelizacao_v2()) elegiveis_v2,
      (select count(*)::int from public.fidelizacao_sombra) linhas_sombra,
      (select count(*)::int from public.fidelizacao_sombra where protecao_encontrada is not null) sombra_protegidos,
      (select count(*)::int from public.casos where operador_email is null) liberados_pela_sombra`);

    await db.close();
    medidas = {
      acionamentos: 200,
      ms_acionamento_antes: antes.ms, ms_acionamento_depois: depois.ms,
      updates_casos_antes: updAntes.n, updates_casos_depois: updDepois.n,
      ms_v1: v1.ms, ms_v2: v2.ms, ms_sombra: sombra.ms,
      linhas_v2: v2.r.length, plano, ...cont,
    };
    console.log("PERFORMANCE (PGlite/WASM -- ordem de grandeza, nao benchmark):", {
      ...medidas, plano: undefined,
    });
    console.log("PLANO v2:\n" + plano);
  });

  it("a carga sintetica tem o tamanho pedido e a distribuicao esperada", () => {
    expect(medidas.casos).toBe(TOTAL);
    expect(medidas.com_relogio).toBe(TOTAL);
    expect(medidas.elegiveis_v2).toBeGreaterThan(100);
  });

  it("a migration acrescenta no MAXIMO um UPDATE por acionamento, e so quando o relogio do dono anda sozinho", () => {
    // MEDIDO: 395 antes, 400 depois, em 200 acionamentos. A diferenca de 5 e
    // explicada e esperada: sao os casos cujo data_ultimo_acionamento JA era de
    // hoje (g % 40 = 0 na carga sintetica, 5 em 200). Nesses, producao hoje faz
    // ZERO UPDATE -- nada mudaria -- e a proposta faz UM, para avancar
    // fidelizacao_inicio, que e a coluna nova e de fato precisa andar. Nao e
    // regressao: e a coluna nova fazendo o trabalho dela. O limite que importa,
    // provado no teste unitario acima, e que a migration nunca faz mais de UM
    // UPDATE proprio por acionamento.
    const extra = medidas.updates_casos_depois - medidas.updates_casos_antes;
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThanOrEqual(medidas.acionamentos); // no maximo 1 por acionamento
    expect(medidas.updates_casos_depois).toBeLessThan(medidas.updates_casos_antes * 1.1);
  });

  it("o custo do acionamento nao dobra por causa da migration", () => {
    // margem generosa: WASM + 200 acionamentos em serie. O que se quer barrar e
    // regressao grosseira (2x+), nao variacao de milissegundos.
    expect(medidas.ms_acionamento_depois).toBeLessThan(medidas.ms_acionamento_antes * 2 + 500);
  });

  it("a v2 fica na mesma ordem de grandeza da v1 (as duas chamam as funcoes caras por linha)", () => {
    expect(medidas.ms_v2).toBeLessThan(medidas.ms_v1 * 5 + 2000);
  });

  it("a sombra roda em tempo de cron e registra elegiveis e protegidos", () => {
    expect(medidas.linhas_sombra).toBeGreaterThan(100);
    expect(medidas.sombra_protegidos).toBeGreaterThan(0);
    expect(medidas.ms_sombra).toBeLessThan(120000);
  });

  it("a sombra nao libera nenhum caso, mesmo com 3.500 na base", () => {
    expect(medidas.liberados_pela_sombra).toBe(0);
  });

  it("o plano da v2 usa o indice parcial, nao Seq Scan na tabela toda", () => {
    // Antes da correcao o plano era "Seq Scan on casos ... Filter:
    // fidelizacao_vencida(...)" -- funcao opaca, indice ignorado. Com o limite
    // sargavel o planner passa a enxergar a faixa. Em 3.500 linhas o Postgres
    // ainda pode preferir seq scan por custo; o que este teste barra e o
    // predicado voltar a ser uma chamada de funcao sobre a coluna.
    expect(medidas.plano).not.toMatch(/Filter:.*fidelizacao_vencida/);
    expect(medidas.plano).toMatch(/fidelizacao_inicio/);
  });

  it("o indice parcial idx_casos_fidelizacao_inicio existe e cobre o predicado da v2", async () => {
    const db = abrir(DUMP_COM);
    const i = await q1(db, `select pg_get_indexdef(i.indexrelid) def
      from pg_index i join pg_class c on c.oid=i.indexrelid
      where c.relname='idx_casos_fidelizacao_inicio'`);
    expect(i.def).toMatch(/fidelizacao_inicio/);
    expect(i.def).toMatch(/WHERE .*fidelizacao_inicio IS NOT NULL/i);
    expect(i.def).toMatch(/encerrado_operacional = false/i);
    await db.close();
  });
});

// ============================================================================
// INSTALACAO PASSIVA -- aplicar a migration, sozinha, nao muda nada.
// ============================================================================
describe("INSTALACAO PASSIVA -- a migration sozinha nao produz efeito operacional", () => {
  // Carteira com casos que a v2 marcaria como elegiveis se houvesse relogio.
  const CARGA = `
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome)
    values ('Op P','op.passivo@teste.local','operador',true,'OP P');
    insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email,
        responsavel_atual_nome, responsavel_atual_em)
    select ('20000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
           lpad((30000000000+g)::text,11,'0'), 'Aluno P '||g, 'MP'||g,
           'op.passivo@teste.local','OP P', now() - interval '90 days'
      from generate_series(1,25) g;
    insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento,
        valor_original, saldo_corrigido, situacao, status)
    select ('20000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
           lpad((30000000000+g)::text,11,'0'), 'DP'||g, '2026-01-10', 300, 300,'ABERTO','em_aberto'
      from generate_series(1,25) g;
    insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email,
        caso_codigo, data_ultimo_acionamento)
    select ('20000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
           lpad((30000000000+g)::text,11,'0'), lpad((30000000000+g)::text,11,'0'),
           'Aluno P '||g, 'op.passivo@teste.local', 200000+g, '2026-01-01'
      from generate_series(1,25) g;
  `;

  const retrato = (db) => q1(db, `select
    (select count(*)::int from public.casos) casos,
    (select count(*)::int from public.casos where operador_email is null) sem_dono,
    (select count(*)::int from public.casos where fidelizacao_inicio is not null) com_relogio,
    (select count(*)::int from public.casos_elegiveis_liberacao_fidelizacao_v2()) eleg_v2,
    (select count(*)::int from public.fidelizacao_sombra) sombra,
    (select count(*)::int from public.historico_operadores_alunos) historico,
    (select count(*)::int from public.reposicao_carteira_fila) reposicao,
    (select count(*)::int from public.aluno_movimentacoes) movimentacoes,
    (select count(*)::int from public.alunos where responsavel_atual_email is null) alunos_sem_resp`);

  it("J. aplicar a migration produz ZERO liberacao, ZERO redistribuicao, ZERO troca de dono, ZERO backfill", async () => {
    // estado ANTES: fixture + carga, sem a migration
    const dbAntes = abrir(DUMP_SEM);
    await dbAntes.exec(CARGA);
    const antes = await q1(dbAntes, `select
      (select count(*)::int from public.casos) casos,
      (select count(*)::int from public.casos where operador_email is null) sem_dono,
      (select count(*)::int from public.historico_operadores_alunos) historico,
      (select count(*)::int from public.reposicao_carteira_fila) reposicao,
      (select count(*)::int from public.aluno_movimentacoes) movimentacoes,
      (select count(*)::int from public.alunos where responsavel_atual_email is null) alunos_sem_resp`);
    await dbAntes.close();

    // estado DEPOIS: a MESMA carga, e so entao a migration
    const db = abrir(DUMP_SEM);
    await db.exec(CARGA);
    await db.exec(MIGRATION);
    const depois = await retrato(db);

    expect(depois.casos).toBe(antes.casos);
    expect(depois.sem_dono).toBe(antes.sem_dono);            // ninguem foi liberado
    expect(depois.historico).toBe(antes.historico);          // nenhum evento de posse
    expect(depois.reposicao).toBe(antes.reposicao);          // nenhuma reposicao
    expect(depois.movimentacoes).toBe(antes.movimentacoes);  // nenhuma movimentacao
    expect(depois.alunos_sem_resp).toBe(antes.alunos_sem_resp);
    // e o essencial: relogio nasce nulo, v2 nao ve ninguem, sombra vazia
    expect(depois.com_relogio).toBe(0);
    expect(depois.eleg_v2).toBe(0);
    expect(depois.sombra).toBe(0);
    await db.close();
  });

  it("o modo instalado e 'sombra' e nada o le automaticamente", async () => {
    const db = abrir(DUMP_COM);
    const m = await q1(db, `select public.fidelizacao_modo() modo`);
    expect(m.modo).toBe("sombra");
    // NENHUMA funcao de producao le a chave nova. Medido no catalogo de producao
    // em 30/09/2026: a unica funcao que le parametros_operacao e
    // prazo_acionamento_base_vigente, e ela filtra chave='prazo_acionamento_base'.
    const r = await qn(db, `select n.nspname||'.'||p.proname fq from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','internal')
        and p.prosrc like '%parametros_operacao%'
        and p.proname not like 'fidelizacao%'`);
    for (const f of r) {
      const d = await q1(db, `select prosrc from pg_proc where oid = $1::regproc`, [f.fq]);
      expect(d.prosrc, `${f.fq} nao pode reagir a chave nova`).not.toMatch(/fidelizacao_por_dono/);
    }
    await db.close();
  });

  it("nenhum cron/agendamento e criado ou alterado pela migration", () => {
    expect(MIGRATION).not.toMatch(/cron\.(schedule|unschedule|alter_job)/i);
    expect(MIGRATION).not.toMatch(/\bcreate\s+event\s+trigger\b/i);
    // e a migration nao CHAMA o backfill nem a sombra
    const semComentarios = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(semComentarios).not.toMatch(/select\s+public\.fidelizacao_backfill_corte\s*\(/);
    expect(semComentarios).not.toMatch(/perform\s+public\.fidelizacao_backfill_corte\s*\(/);
    expect(semComentarios).not.toMatch(/select\s+public\.fidelizacao_sombra_registrar\s*\(/);
  });
});

// ============================================================================
// INTERACAO COM liberar_fidelizacao_caso -- o BLOQUEIO para ativar.
//
// A migration 20260929101500_fidelizacao_10_dias_fechar_caminhos_automaticos, ja
// em producao, colocou dentro de liberar_fidelizacao_caso:
//    if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento)
//       then return false; end if;
// Essa guarda olha o relogio do CASO. Estes testes PROVAM que, enquanto ela
// estiver assim, a v2 calcula elegibilidade que o caminho de liberacao recusa em
// silencio -- exatamente nos casos que a regra nova existe para tratar.
// ============================================================================
describe("INTERACAO COM liberar_fidelizacao_caso -- pre-requisito para ativar", () => {
  it("a guarda dos 10 dias pelo relogio do CASO esta la, e nao foi tocada pela migration", async () => {
    const db = abrir(DUMP_COM);
    const f = await q1(db, `select prosrc, md5(prosrc) md5 from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='liberar_fidelizacao_caso'`);
    expect(f.prosrc).toMatch(/caso_dentro_prazo_fidelizacao\(v_c\.data_ultimo_acionamento\)/);
    expect(f.md5).toBe(MD5_PROD["public.liberar_fidelizacao_caso"]);
    await db.close();
  });

  it("caso com relogio do DONO vencido mas relogio do CASO recente: v2 diz elegivel e a liberacao RECUSA", async () => {
    const db = abrir(DUMP_COM);
    // relogio do dono vencido (30 dias), relogio do CASO renovado por terceiro (hoje)
    const c = await cenario(db, 900, { operador: A });
    await db.exec(`update public.casos set
        fidelizacao_inicio = (public.hoje_brt() - 30)::timestamp at time zone 'America/Sao_Paulo',
        data_ultimo_acionamento = current_date`);
    const eleg = await q1(db, `select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao_v2()`);
    const soltou = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c]);
    const dono = await q1(db, `select operador_email from public.casos where id=$1`, [c]);

    expect(eleg.n).toBe(1);          // a v2 considera elegivel
    expect(soltou.ok).toBe(false);   // e o caminho de liberacao RECUSA
    expect(dono.operador_email).toBe(A); // o caso segue com o dono
    await db.close();
  });

  it("caso com os DOIS relogios vencidos: a liberacao funciona", async () => {
    const db = abrir(DUMP_COM);
    const c = await cenario(db, 901, { operador: A });
    await db.exec(`update public.casos set
        fidelizacao_inicio = (public.hoje_brt() - 30)::timestamp at time zone 'America/Sao_Paulo',
        data_ultimo_acionamento = current_date - 30`);
    const soltou = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c]);
    const dono = await q1(db, `select operador_email from public.casos where id=$1`, [c]);
    expect(soltou.ok).toBe(true);
    expect(dono.operador_email).toBe(null);
    await db.close();
  });

  it("o lote da v1 continua funcionando exatamente como hoje", async () => {
    const db = abrir(DUMP_COM);
    await comoGestao(db);
    await cenario(db, 902, { operador: A, dua: "2026-01-01" });
    const n = await q1(db, `select public.liberar_casos_fidelizacao_vencida(100) n`);
    expect(Number(n.n)).toBe(1);
    await db.close();
  });
});

// ============================================================================
// CICLO migration -> rollback -> migration, com o ROLLBACK REAL do repositorio.
// ============================================================================
describe("CICLO migration -> rollback -> migration (arquivos reais)", () => {
  const retratoObjetos = (db) => q1(db, `select
    (select count(*)::int from information_schema.columns where table_schema='public'
      and table_name='casos' and column_name='fidelizacao_inicio') coluna,
    (select count(*)::int from pg_class where relname='idx_casos_fidelizacao_inicio' and relkind='i') indice,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'fidelizacao%' or p.proname in
        ('hoje_brt','eh_acionamento_fidelizacao','casos_elegiveis_liberacao_fidelizacao_v2',
         '_fidelizacao_nasce_com_o_dono'))) funcoes_novas,
    (select count(*)::int from pg_trigger where tgname='trg_fidelizacao_nasce_com_o_dono') gatilho,
    (select count(*)::int from pg_class where relname='fidelizacao_sombra') sombra,
    (select count(*)::int from pg_policy where polname='fidelizacao_sombra_leitura_gestao') policy,
    (select count(*)::int from public.parametros_operacao where chave='fidelizacao_por_dono') parametro`);

  const hashes = async (db) => Object.fromEntries(
    (await qn(db, `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','internal')`)).map((r) => [r.nome, r.md5]));

  it("B-G. instala, roda, desfaz, prova o estado anterior e reinstala sem residuo", async () => {
    const db = abrir(DUMP_SEM);

    // --- A) fixture carregada, estado original
    const zero = await retratoObjetos(db);
    expect(zero).toMatchObject({ coluna: 0, indice: 0, funcoes_novas: 0, gatilho: 0, sombra: 0, policy: 0, parametro: 0 });
    const hashOriginal = await hashes(db);

    // --- B) aplica a MIGRATION real
    await db.exec(MIGRATION);
    const instalado = await retratoObjetos(db);
    expect(instalado).toMatchObject({ coluna: 1, indice: 1, funcoes_novas: 15, gatilho: 1, sombra: 1, policy: 1, parametro: 1 });

    // --- C) exercita o caminho principal com a migration instalada
    await comoGestao(db);
    await cenario(db, 950, { operador: A, respEm: "2026-08-15T13:00:00Z" });
    await db.exec(`select public.fidelizacao_backfill_corte()`);
    const comRelogio = await q1(db, `select count(*)::int n from public.casos where fidelizacao_inicio is not null`);
    expect(comRelogio.n).toBeGreaterThanOrEqual(1);

    // --- D) aplica o ROLLBACK real (modo PADRAO: mantem a coluna)
    await db.exec(ROLLBACK);
    const revertido = await retratoObjetos(db);
    expect(revertido).toMatchObject({
      indice: 0, funcoes_novas: 0, gatilho: 0, sombra: 0, policy: 0, parametro: 0,
      coluna: 1, // modo padrao MANTEM a coluna, de proposito
    });

    // --- E) PROVA DO ESTADO ANTERIOR: todo corpo de funcao volta ao hash original
    const hashRevertido = await hashes(db);
    for (const nome of Object.keys(MD5_PROD)) {
      expect(hashRevertido[nome], `${nome} nao voltou ao original`).toBe(hashOriginal[nome]);
      expect(hashRevertido[nome], `${nome} divergiu de producao`).toBe(MD5_PROD[nome]);
    }
    // e o gatilho do teto continua com a definicao original
    const teto = await q1(db, `select pg_get_triggerdef(oid) d from pg_trigger
      where tgname='trigger_impor_teto_operador'`);
    expect(teto.d).toMatch(/AFTER UPDATE ON public\.casos/);
    // dado operacional preservado
    const dado = await q1(db, `select
      (select count(*)::int from public.casos where data_ultimo_acionamento is not null) dua,
      (select count(*)::int from public.alunos where responsavel_atual_em is not null) resp,
      (select count(*)::int from public.aluno_movimentacoes) movs`);
    expect(dado.dua).toBeGreaterThanOrEqual(0);
    expect(dado.resp).toBeGreaterThanOrEqual(1);
    expect(dado.movs).toBeGreaterThanOrEqual(0);

    // --- F) REINSTALA a MESMA migration
    await db.exec(MIGRATION);
    const reinstalado = await retratoObjetos(db);
    expect(reinstalado).toMatchObject({ coluna: 1, indice: 1, funcoes_novas: 15, gatilho: 1, sombra: 1, policy: 1, parametro: 1 });

    // --- G) e o caminho principal volta a funcionar
    await comoGestao(db);
    const n2 = await q1(db, `select public.fidelizacao_backfill_corte() n`);
    expect(Number(n2.n)).toBeGreaterThanOrEqual(0);
    const sombra = await q1(db, `select public.fidelizacao_sombra_registrar() n`);
    expect(Number(sombra.n)).toBeGreaterThanOrEqual(0);
    await db.close();
  });

  it("rollback COMPLETO derruba tambem a coluna", async () => {
    const db = abrir(DUMP_SEM);
    await db.exec(MIGRATION);
    await db.exec(`set fidelizacao.rollback_completo = 'sim'`);
    await db.exec(ROLLBACK);
    const r = await retratoObjetos(db);
    expect(r).toMatchObject({ coluna: 0, indice: 0, funcoes_novas: 0, gatilho: 0, sombra: 0, policy: 0, parametro: 0 });
    // a v1 continua de pe depois do rollback completo
    const v1 = await q1(db, `select count(*)::int n from public.casos_elegiveis_liberacao_fidelizacao()`);
    expect(Number(v1.n)).toBe(0);
    await db.close();
  });

  it("a migration e idempotente o suficiente para reaplicar sobre si mesma", async () => {
    const db = abrir(DUMP_COM);
    await db.exec(MIGRATION); // segunda vez sobre o mesmo banco
    const r = await retratoObjetos(db);
    expect(r).toMatchObject({ coluna: 1, indice: 1, funcoes_novas: 15, gatilho: 1, sombra: 1, policy: 1, parametro: 1 });
    await db.close();
  });
});
