// M3 · O NIVELAMENTO AUTOMÁTICO RESPEITA A MARCA DE GIRO — regressão.
//
// Roda a MIGRATION REAL
// (supabase/migrations/20261021130000_m3_nivelamento_respeita_giro.sql) e o
// ROLLBACK REAL num PostgreSQL real (PGlite), sobre os corpos EXATOS de
// produção de 21/10/2026, cada um conferido por md5(prosrc).
//
// A bancada é a base `fidelizacao_por_dono_prod_20260930` mais o complemento
// `nivelamento_m3_prod_20261021`, que traz a coluna do giro, a função da marca
// e a própria `nivelamento_automatico_gestao`. Bancada existente, estendida —
// nenhuma auditoria refeita.
//
// NENHUM DADO REAL: CPF, nome e e-mail de operador são sintéticos, com exceção
// dos e-mails que a própria função de produção cita como gestão.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que a
// executa, num banco efêmero que morre no fim.
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
const MD5_BASE = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const COMPLEMENTO = ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.sql");
const MD5_COMPL = JSON.parse(ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.md5.json"));
const MIGRATION = ler("supabase/migrations/20261021130000_m3_nivelamento_respeita_giro.sql");
const ROLLBACK = ler("supabase/rollbacks/20261021130000_m3_nivelamento_respeita_giro.rollback.sql");

const MD5_PROD_ALVO = "f058f92912052301694ae481681e3975";

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const OP2 = "cobranca06@aelbra.com.br";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(30000000000 + n);

// A fixture resolve auth.jwt() lendo `request.jwt.claims`, como o PostgREST.
const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

const nivelar = (db, dias = 10, aplicar = true) =>
  q1(db, "select public.nivelamento_automatico_gestao($1::int,$2::boolean) j", [dias, aplicar]);

const donoDe = async (db, n) =>
  (await q1(db, "select operador_email from public.casos where id=$1", [U(n)])).operador_email;

const corpoMd5 = async (db) =>
  (await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='nivelamento_automatico_gestao'`)).m;

// Cria um caso NA BASE DA GESTAO, com saldo e titulo vencido ha 60 dias — ou
// seja, elegivel por tudo, menos pelo que o teste quiser variar.
async function caso(db, n, extra = {}) {
  const {
    giro = null,              // giro_fidelizacao_ate
    dua = null,               // data_ultimo_acionamento
    naoAcionar = false,
    statusAtual = "EM COBRANCA",
    dono = GESTAO,
  } = extra;
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, saldo_total, status_atual, status_jornada)
     values ($1,$2,$3,$4,0,'EM COBRANCA','EM COBRANCA')`,
    [U(n), `Aluno ${n}`, CPF(n), String(n)]);
  await db.query(
    `insert into public.casos
       (id, aluno_id, nome, nome_aluno, cpf, cpf_limpo, chave_unificacao, operador_email, operador_nome,
        status_atual, status_acionamento, status_financeiro, status_jornada,
        data_ultimo_acionamento, nao_acionar, giro_fidelizacao_ate)
     values ($1,$1,$2,$2,$3,$3,$3,$4,'DONO',$5,'PENDENTE','EM ABERTO','EM COBRANCA',$6,$7,$8)`,
    [U(n), `Aluno ${n}`, CPF(n), dono, statusAtual, dua, naoAcionar, giro]);
  // Saldo: um titulo em aberto vencido ha 60 dias (entra na view e passa do p_dias).
  await db.query(
    `insert into public.acordos_titulos
       (id, aluno_id, cpf, situacao, status, acordo_id, vencimento, valor_original, valor_em_aberto)
     values ($1,$2,$3,'ABERTO','em_aberto',null, current_date - 60, 500, 500)`,
    [U(900000 + n), U(n), CPF(n)]);
}

async function construir(comMigration) {
  const db = new PGlite({ extensions: ext });
  await db.exec(FIXTURE);
  await db.exec(COMPLEMENTO);

  // PORTAO DE FIDELIDADE: se qualquer corpo divergir de producao, para aqui.
  const rows = await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries({ ...MD5_BASE, ...MD5_COMPL })) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ('OP UM',   '${OP1}', 'operador', true, 'OP UM',   true),
      ('OP DOIS', '${OP2}', 'operador', true, 'OP DOIS', true),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null, false);
  `);
  await como(db, GESTAO);
  if (comMigration) await db.exec(MIGRATION);
  return db;
}

let SEM, COM;

beforeAll(async () => {
  const a = await construir(false);
  SEM = await a.dumpDataDir();
  await a.close();
  const b = await construir(true);
  COM = await b.dumpDataDir();
  await b.close();
});

const abrir = async (dump) => {
  const db = new PGlite({ loadDataDir: dump, extensions: ext });
  await como(db, GESTAO);
  return db;
};
const semM3 = () => abrir(SEM);
const comM3 = () => abrir(COM);

// ===========================================================================
describe("a bancada reproduz produção", () => {
  it("o corpo alvo é o de produção, por md5", async () => {
    const db = await semM3();
    expect(await corpoMd5(db)).toBe(MD5_PROD_ALVO);
    await db.close();
  });

  it("e o corpo de produção NÃO lê a marca de giro — é esse o furo", async () => {
    const db = await semM3();
    const { n } = await q1(db,
      `select (length(p.prosrc) - length(replace(p.prosrc,'giro_fidelizacao_ate',''))) n
         from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace
        where nn.nspname='public' and p.proname='nivelamento_automatico_gestao'`);
    expect(Number(n)).toBe(0);
    await db.close();
  });
});

// ===========================================================================
describe("ANTES: o nivelamento desfaz a fidelização do lote", () => {
  it("caso com marca de giro VIVA é movido — o artigo 5 violado", async () => {
    const db = await semM3();
    await caso(db, 1, { giro: "2099-12-31" });
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(1);
    expect(r.j.movidos).toBe(1);
    expect(await donoDe(db, 1)).not.toBe(GESTAO); // saiu da gestao: a cota foi desfeita
    await db.close();
  });
});

// ===========================================================================
describe("DEPOIS: a marca viva protege, e só ela", () => {
  it("caso com marca VIVA não é elegível nem movido", async () => {
    const db = await comM3();
    await caso(db, 2, { giro: "2099-12-31" });
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(0);
    expect(r.j.movidos).toBe(0);
    expect(await donoDe(db, 2)).toBe(GESTAO);
    await db.close();
  });

  it("caso SEM marca continua nivelável — não endureceu demais", async () => {
    const db = await comM3();
    await caso(db, 3, { giro: null });
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(1);
    expect(r.j.movidos).toBe(1);
    expect(await donoDe(db, 3)).not.toBe(GESTAO);
    await db.close();
  });

  it("marca VENCIDA (ontem) volta a ser nivelável — a marca protege só enquanto viva", async () => {
    const db = await comM3();
    await db.query("select 1");
    const ontem = (await q1(db, "select ((now() at time zone 'America/Sao_Paulo')::date - 1)::text d")).d;
    await caso(db, 4, { giro: ontem });
    const r = await nivelar(db);
    expect(r.j.movidos).toBe(1);
    await db.close();
  });

  it("marca de HOJE ainda protege — a fronteira é `>=`, em data de Brasília", async () => {
    const db = await comM3();
    const hoje = (await q1(db, "select (now() at time zone 'America/Sao_Paulo')::date::text d")).d;
    await caso(db, 5, { giro: hoje });
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(0);
    expect(await donoDe(db, 5)).toBe(GESTAO);
    await db.close();
  });

  it("as duas fidelizações convivem: a marca barra mesmo com DUA antiga, e a DUA barra mesmo sem marca", async () => {
    const db = await comM3();
    await caso(db, 6, { giro: "2099-12-31", dua: null });              // só a marca
    await caso(db, 7, { giro: null });                                  // nenhuma das duas
    await db.query(
      "update public.casos set data_ultimo_acionamento = current_date - 3 where id = $1", [U(7)]);
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(0); // 6 barrado pela marca, 7 barrado pela DUA
    expect(await donoDe(db, 6)).toBe(GESTAO);
    expect(await donoDe(db, 7)).toBe(GESTAO);
    await db.close();
  });
});

// ===========================================================================
describe("as outras guardas seguem idênticas", () => {
  for (const [rotulo, montar] of [
    ["nao_acionar", async (db) => caso(db, 11, { naoAcionar: true })],
    ["encerrado operacional (suspensão de cobrança)", async (db) =>
      caso(db, 12, { statusAtual: "SUSPENSAO COBRANCA" })],
    ["link de pagamento vivo", async (db) => {
      await caso(db, 13);
      await db.query(
        `insert into public.links_pagamento (id, aluno_cpf, status) values ($1,$2,'AGUARDANDO_BAIXA')`,
        [U(800013), CPF(13)]);
    }],
    ["baixa aguardando", async (db) => {
      await caso(db, 14);
      await db.query(
        `insert into public.baixas_pagamento (id, aluno_id, aluno_cpf, status_baixa)
         values ($1,$2,$3,'AGUARDANDO_BAIXA')`,
        [U(800014), U(14), CPF(14)]);
    }],
    ["confirmação financeira aberta", async (db) => {
      await caso(db, 15);
      await db.query(
        `insert into public.solicitacoes_confirmacao_pagamento (id, aluno_id, status)
         values ($1,$2,'AGUARDANDO_CONFIRMACAO')`, [U(800015), U(15)]);
    }],
  ]) {
    it(`${rotulo} continua barrando, com a M3 aplicada`, async () => {
      const db = await comM3();
      await montar(db);
      const r = await nivelar(db);
      expect(r.j.elegiveis).toBe(0);
      await db.close();
    });
  }

  it("a janela de p_dias continua valendo: título vencido DENTRO do prazo não entra", async () => {
    const db = await comM3();
    await caso(db, 16);
    await db.query(
      "update public.acordos_titulos set vencimento = current_date - 2 where aluno_id = $1", [U(16)]);
    const r = await nivelar(db, 10, true);
    expect(r.j.elegiveis).toBe(0);
    await db.close();
  });

  it("saldo zero continua fora", async () => {
    const db = await comM3();
    await caso(db, 17);
    await db.query("update public.acordos_titulos set valor_original = 0, valor_em_aberto = 0 where aluno_id = $1", [U(17)]);
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(0);
    await db.close();
  });
});

// ===========================================================================
describe("a elegibilidade só SUBTRAI candidato", () => {
  it("o conjunto de elegíveis com a M3 é subconjunto do de antes", async () => {
    const montarLote = async (db) => {
      await caso(db, 21, { giro: "2099-12-31" });
      await caso(db, 22, { giro: null });
      await caso(db, 23, { giro: null });
    };
    const sem = await semM3(); await montarLote(sem);
    const com = await comM3(); await montarLote(com);
    const a = (await nivelar(sem, 10, false)).j.elegiveis;
    const b = (await nivelar(com, 10, false)).j.elegiveis;
    expect(a).toBe(3);
    expect(b).toBe(2);
    expect(b).toBeLessThanOrEqual(a);
    await sem.close(); await com.close();
  });
});

// ===========================================================================
describe("nada de financeiro, histórico ou retorno é tocado", () => {
  it("titularidade financeira do acordo, DUA e data_retorno ficam idênticos", async () => {
    const db = await comM3();
    await caso(db, 31, { giro: null });
    await db.query(
      `insert into public.acordos (id, aluno_id, cpf, status, valor_total, saldo, qtd_parcelas,
         numero_acordo, operador_responsavel_email, operador_responsavel_nome)
       values ($1,$2,$3,'ATIVO',1000,1000,1,9001,$4,'DONO FINANCEIRO')`,
      [U(700031), U(31), CPF(31), OP2]);
    const antes = await q1(db,
      `select (select operador_responsavel_email from public.acordos where id=$1) resp,
              (select data_ultimo_acionamento from public.casos where id=$2) dua,
              (select data_retorno from public.casos where id=$2) ret`, [U(700031), U(31)]);
    const r = await nivelar(db);
    expect(r.j.movidos).toBe(1);
    const depois = await q1(db,
      `select (select operador_responsavel_email from public.acordos where id=$1) resp,
              (select data_ultimo_acionamento from public.casos where id=$2) dua,
              (select data_retorno from public.casos where id=$2) ret`, [U(700031), U(31)]);
    expect(depois).toEqual(antes);
    await db.close();
  });

  it("o histórico continua registrando o nivelamento de quem foi movido", async () => {
    const db = await comM3();
    await caso(db, 32, { giro: null });
    await nivelar(db);
    const h = await qn(db,
      `select acao, operador_anterior_email from public.historico_operadores_alunos where aluno_id=$1`, [U(32)]);
    expect(h).toHaveLength(1);
    expect(h[0].acao).toBe("NIVELAMENTO_AUTOMATICO_GESTAO");
    expect(h[0].operador_anterior_email).toBe(GESTAO);
    await db.close();
  });

  it("simulação (p_aplicar=false) não move ninguém e não escreve histórico", async () => {
    const db = await comM3();
    await caso(db, 33, { giro: null });
    const r = await nivelar(db, 10, false);
    expect(r.j.elegiveis).toBe(1);
    expect(r.j.movidos).toBe(0);
    expect(await donoDe(db, 33)).toBe(GESTAO);
    expect(Number((await q1(db, "select count(*)::int n from public.historico_operadores_alunos")).n)).toBe(0);
    await db.close();
  });
});

// ===========================================================================
describe("a migration mexe só no que diz", () => {
  it("o arquivo não traz DDL de tabela/gatilho, nem DML, nem agendamento", async () => {
    const executaveis = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    for (const proibido of [
      "create table", "alter table", "drop table", "create trigger", "drop trigger",
      "insert into", "update ", "delete from", "truncate",
      "cron.schedule", "cron.alter_job", "cron.unschedule", "grant ", "revoke ",
    ]) {
      expect(executaveis).not.toContain(proibido);
    }
  });

  it("usa patch ancorado, não CREATE OR REPLACE da função inteira", async () => {
    const executaveis = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    expect(executaveis).toContain("internal.patch_funcao_ancorada");
    expect(executaveis).not.toContain("create or replace function public.nivelamento");
  });

  it("nenhuma outra função teve o corpo alterado", async () => {
    const corpos = async (db) => (await qn(db,
      `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal') and p.proname <> 'nivelamento_automatico_gestao'
        order by 1`));
    const sem = await semM3(); const com = await comM3();
    expect(await corpos(com)).toEqual(await corpos(sem));
    await sem.close(); await com.close();
  });

  it("o corpo do alvo muda, e passa a conter a guarda da marca", async () => {
    const db = await comM3();
    expect(await corpoMd5(db)).not.toBe(MD5_PROD_ALVO);
    const { n } = await q1(db,
      `select (length(p.prosrc) - length(replace(p.prosrc,'caso_em_giro_fidelizacao',''))) n
         from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace
        where nn.nspname='public' and p.proname='nivelamento_automatico_gestao'`);
    expect(Number(n)).toBeGreaterThan(0);
    await db.close();
  });

  it("a função ganha comentário declarando as DUAS fidelizações", async () => {
    const db = await comM3();
    const { c } = await q1(db,
      `select obj_description(p.oid,'pg_proc') c from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='nivelamento_automatico_gestao'`);
    expect(c).toMatch(/caso_em_giro_fidelizacao/);
    expect(c).toMatch(/caso_dentro_prazo_fidelizacao/);
    await db.close();
  });
});

// ===========================================================================
describe("idempotência e rollback", () => {
  it("aplicar a migration duas vezes não muda nada", async () => {
    const db = await comM3();
    const antes = await corpoMd5(db);
    await db.exec(MIGRATION);
    expect(await corpoMd5(db)).toBe(antes);
    await db.close();
  });

  it("o patch RECUSA se a âncora não existir mais", async () => {
    const db = await semM3();
    // Simula a funcao ter mudado: tira a linha-ancora.
    await db.exec(`
      do $$ declare v text;
      begin
        select pg_get_functiondef(p.oid) into v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='nivelamento_automatico_gestao';
        execute replace(v, 'and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)', 'and true');
      end $$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ocorrencia|ancora|revise/i);
    await db.close();
  });

  it("o rollback devolve o comportamento: caso com marca viva volta a ser movido", async () => {
    const db = await comM3();
    await db.exec(ROLLBACK);
    await caso(db, 41, { giro: "2099-12-31" });
    const r = await nivelar(db);
    expect(r.j.movidos).toBe(1);
    expect(await donoDe(db, 41)).not.toBe(GESTAO);
    await db.close();
  });

  it("o rollback DEVOLVE o comentário de produção e deixa escrito que a M3 foi revertida", async () => {
    // A funcao TEM comentario em producao (md5 553bb078eb33a0540194bce96b618681,
    // 250 caracteres, conferido em 21/10/2026). A primeira versao deste rollback
    // punha `is null` aqui e teria APAGADO esse comentario -- defeito pego antes
    // de aplicar, nao depois.
    const db = await comM3();
    const antes = (await q1(db,
      `select obj_description(p.oid,'pg_proc') c from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='nivelamento_automatico_gestao'`)).c;
    await db.exec(ROLLBACK);
    const { c, src } = await q1(db,
      `select obj_description(p.oid,'pg_proc') c, p.prosrc src
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='nivelamento_automatico_gestao'`);
    expect(c).not.toBeNull();
    expect(c).not.toBe(antes);
    expect(c).toMatch(/Tira da base da gestão/);
    expect(c).not.toMatch(/caso_em_giro_fidelizacao/);
    expect(src).toMatch(/M3 REVERTIDA/);
    await db.close();
  });

  it("depois do rollback a migration pode ser reaplicada", async () => {
    const db = await comM3();
    await db.exec(ROLLBACK);
    await db.exec(MIGRATION);
    await caso(db, 42, { giro: "2099-12-31" });
    const r = await nivelar(db);
    expect(r.j.elegiveis).toBe(0);
    await db.close();
  });
});

// ===========================================================================
describe("o portão de permissão não foi afrouxado", () => {
  it("quem não é gestão e tem JWT continua recusado", async () => {
    const db = await comM3();
    await como(db, OP1);
    await expect(db.query("select public.nivelamento_automatico_gestao(10, false)"))
      .rejects.toThrow(/sem permiss/i);
    await db.close();
  });
});
