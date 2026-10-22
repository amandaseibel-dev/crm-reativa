// ONDA 1 · EXECUTOR CONTROLADO DO LOTE A — num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (supabase/migrations/20261021200000_onda1_executar.sql)
// e o ROLLBACK REAL, sobre corpos EXATOS de produção conferidos por md5(prosrc),
// COM OS GATILHOS DE `casos` ligados. Sem os gatilhos o teste seria teatro: é
// neles que mora a prova de que nenhum caso já atribuído é liberado e de que a
// fidelização de 10 dias sobrevive à troca de dono.
//
// O que estes testes protegem, em ordem de importância:
//   1. NÃO EXECUTA sem aprovação explícita da simulação;
//   2. RECUSA INTEIRA (zero escrita) em cada uma das condições da gestão;
//   3. nenhum caso JÁ ATRIBUÍDO de outro aluno é liberado pelo gatilho do teto;
//   4. responsável único por aluno, inclusive com ficha duplicada;
//   5. titularidade financeira intacta: acordo, parcela, título e honorário;
//   6. reversão devolve dono e marca SEM atropelar o que a operação fez depois.
//
// NENHUM DADO REAL: CPF, nome e e-mail são sintéticos.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que
// a executa, num banco efêmero que morre no fim.
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

const BASE = ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql");
const MD5_BASE = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const M3 = ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.sql");
const MD5_M3 = JSON.parse(ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.md5.json"));
const COMPL = ler("supabase/tests/fixtures/onda1_prod_20261021.sql");
const MD5_COMPL = JSON.parse(ler("supabase/tests/fixtures/onda1_prod_20261021.md5.json"));
const EXEC_FIX = ler("supabase/tests/fixtures/onda1_executor_prod_20261021.sql");
const MD5_EXEC = JSON.parse(ler("supabase/tests/fixtures/onda1_executor_prod_20261021.md5.json"));
const SIMULADOR = ler("supabase/migrations/20261021172255_onda1_simular.sql");
const MIGRATION = ler("supabase/migrations/20261021200000_onda1_executar.sql");
const ROLLBACK = ler("supabase/rollbacks/20261021200000_onda1_executar.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP = ["cobranca05@aelbra.com.br", "cobranca06@aelbra.com.br", "cobranca08@aelbra.com.br"];
const CG = "carteira.geral@reativa.local";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(40000000000 + n);

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);
const semLogin = (db) => db.query("select set_config('request.jwt.claims', '', false)");

const simular = async (db, crit = {}) =>
  (await q1(db, "select public.onda1_simular($1::jsonb) j", [JSON.stringify(crit)])).j;
const conferir = async (db, id) =>
  (await q1(db, "select public.onda1_conferir($1::uuid) j", [id])).j;
const executar = async (db, id) =>
  (await q1(db, "select public.onda1_executar($1::uuid) j", [id])).j;
const reverter = async (db, id) =>
  (await q1(db, "select public.onda1_reverter($1::uuid) j", [id])).j;
const aprovar = (db, id) => db.query("select public.calibragem_aprovar_simulacao($1::uuid)", [id]);

// Impressão digital de TODA a tabela casos: dono + marca. Qualquer movimento
// muda o hash. É assim que "zero escrita" deixa de ser promessa.
const digital = async (db) =>
  (await q1(db, `select md5(coalesce(string_agg(
       id::text||'|'||coalesce(operador_email,'-')||'|'||coalesce(giro_fidelizacao_ate::text,'-'),
       E'\\n' order by id),'')) d from public.casos`)).d;

async function aluno(db, n, o = {}) {
  const {
    dono = CG, sem2026 = false, semestre = "2026/2", valor = 1000,
    acordo = false, naoAcionar = false, statusAtual = "EM COBRANCA",
    giro = null, semCaso = false, casosExtras = 0, extraFechado = false,
  } = o;
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, saldo_total, status_atual, status_jornada)
     values ($1,$2,$3,$4,0,'EM COBRANCA','EM COBRANCA')`,
    [U(n), `Aluno ${n}`, CPF(n), String(n)]);

  if (!semCaso) {
    for (let i = 0; i <= casosExtras; i++) {
      const fechado = extraFechado && i > 0;
      // FORMA EXATA DOS 7 PARES REAIS, medida em produção em 21/10/2026: o caso
      // duplicado tem a COLUNA `encerrado_operacional` = true, enquanto a função
      // viva sobre `cpf_limpo` devolve false -- a coluna é um valor em cache que
      // ficou defasado. É isso que faz o par ENTRAR no lote (a simulação olha a
      // função, por cpf_limpo) e ao mesmo tempo NÃO disparar
      // ALUNO_JA_TEM_CASO_ABERTO (o gatilho olha a coluna). Reproduzir com
      // status 'CANCELADO' seria outra coisa: aí a simulação excluiria o aluno.
      if (fechado) {
        await db.exec(`alter table public.casos disable trigger trg_zz_caso_nao_duplica_aluno_before;
                       alter table public.casos disable trigger trg_zz_caso_nao_duplica_aluno;`);
      }
      await db.query(
        `insert into public.casos
           (id, aluno_id, nome, nome_aluno, cpf, cpf_limpo, chave_unificacao, operador_email, operador_nome,
            status_atual, status_acionamento, status_financeiro, status_jornada, nao_acionar, giro_fidelizacao_ate)
         values ($1,$2,$3,$3,$4,$4,$4,$5,'DONO',$6,'PENDENTE','EM ABERTO','EM COBRANCA',$7,$8)`,
        [U(n * 100 + i), U(n), `Aluno ${n}`, CPF(n), dono, statusAtual, naoAcionar, giro]);
      if (fechado) {
        // UPDATE que não mexe em nenhum dos cinco status: por isso
        // casos_set_encerrado_operacional PRESERVA o valor que gravamos.
        await db.query(
          `update public.casos set encerrado_operacional = true where id = $1`, [U(n * 100 + i)]);
        await db.exec(`alter table public.casos enable trigger trg_zz_caso_nao_duplica_aluno_before;
                       alter table public.casos enable trigger trg_zz_caso_nao_duplica_aluno;`);
      }
    }
  }
  if (!sem2026) {
    const venc = semestre === "2026/1" ? "2026-03-10" : "2026-09-10";
    await db.query(
      `insert into public.acordos_titulos
         (id, aluno_id, cpf, situacao, status, acordo_id, vencimento, valor_original, valor_em_aberto)
       values ($1,$2,$3,'ABERTO','em_aberto',null,$4::date,$5,$5)`,
      [U(900000 + n), U(n), CPF(n), venc, valor]);
  }
  if (acordo) {
    await db.query(
      `insert into public.acordos (id, aluno_id, cpf, status, valor_total, saldo, qtd_parcelas,
         numero_acordo, operador_responsavel_email, operador_responsavel_nome)
       values ($1,$2,$3,'ATIVO',5000,5000,2,$4,'dono.financeiro@aelbra.com.br','DONO FINANCEIRO')`,
      [U(700000 + n), U(n), CPF(n), 9000 + n]);
    await db.query(
      `insert into public.acordos_titulos
         (id, aluno_id, cpf, situacao, status, acordo_id, vencimento, valor_original, valor_em_aberto, tipo_boleto)
       values ($1,$2,$3,'ABERTO','em_aberto',$4,'2026-09-15',3000,3000,'Acordo')`,
      [U(800000 + n), U(n), CPF(n), U(700000 + n)]);
    await db.query(
      `insert into public.acordo_titulo_vinculo (id, acordo_id, titulo_id, ativo)
       values ($1,$2,$3,true)`, [U(600000 + n), U(700000 + n), U(800000 + n)]);
    await db.query(
      `insert into public.parcelas (id, acordo_id, numero, valor, vencimento, status)
       values ($1,$2,1,2500,'2026-09-20','A_VENCER'), ($3,$2,2,2500,'2026-10-20','A_VENCER')`,
      [U(500000 + n), U(700000 + n), U(400000 + n)]);
  }
}

async function construir(comMigration = true) {
  const db = new PGlite({ extensions: ext });
  await db.exec(BASE);
  await db.exec(M3);
  await db.exec(COMPL);
  await db.exec(EXEC_FIX);

  // PORTAO DE FIDELIDADE: se qualquer corpo divergir de producao, para aqui.
  const rows = await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries({ ...MD5_BASE, ...MD5_M3, ...MD5_COMPL, ...MD5_EXEC })) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ('OP UM',   '${OP[0]}', 'operador', true,  'OP UM',   true),
      ('OP DOIS', '${OP[1]}', 'operador', true,  'OP DOIS', true),
      ('OP TRES', '${OP[2]}', 'operador', true,  'OP TRES', true),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null, false);
    insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '700'::jsonb)
      on conflict (chave) do update set valor = excluded.valor;
  `);
  await como(db, GESTAO);
  await db.exec(SIMULADOR);
  if (comMigration) await db.exec(MIGRATION);
  return db;
}

let COM, SEM;
beforeAll(async () => {
  const a = await construir(true);
  COM = await a.dumpDataDir();
  await a.close();
  const b = await construir(false);
  SEM = await b.dumpDataDir();
  await b.close();
});
const abrir = async (comMigration = true) => {
  const db = new PGlite({ loadDataDir: comMigration ? COM : SEM, extensions: ext });
  await como(db, GESTAO);
  return db;
};

// Monta o lote: `qtd` alunos sem dono ativo, aprova e devolve o id.
async function lote(db, qtd = 9, extras = {}) {
  for (let n = 1; n <= qtd; n++) {
    await aluno(db, n, { dono: CG, semestre: n % 2 ? "2026/1" : "2026/2", ...(extras[n] || {}) });
  }
  const s = await simular(db);
  return s.simulacao_id;
}

// ===========================================================================
describe("a bancada reproduz produção, com os gatilhos ligados", () => {
  it("os doze corpos novos conferem por md5 (o portão roda no beforeAll)", async () => {
    const db = await abrir();
    const r = await qn(db,
      `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal')`);
    const m = Object.fromEntries(r.map((x) => [x.nome, x.md5]));
    for (const [nome, md5] of Object.entries(MD5_EXEC)) expect(m[nome]).toBe(md5);
    await db.close();
  });

  it("os seis gatilhos de casos estão de pé", async () => {
    const db = await abrir();
    const r = await qn(db,
      `select tgname from pg_trigger where tgrelid='public.casos'::regclass and not tgisinternal order by tgname`);
    const nomes = r.map((x) => x.tgname);
    for (const t of ["trg_casos_set_encerrado_operacional", "trg_giro_limpar_marca",
                     "trg_nome_do_operador_no_caso", "trg_zz_caso_nao_duplica_aluno_before",
                     "trigger_impor_teto_operador", "trigger_repor_caso_operador"]) {
      expect(nomes).toContain(t);
    }
    await db.close();
  });
});

// ===========================================================================
describe("o portão e as permissões", () => {
  it("as três funções nascem FECHADAS para anon", async () => {
    const db = await abrir();
    const r = await qn(db,
      `select p.proname,
              coalesce(array_to_string(p.proacl,'|'),'(default)') acl
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('onda1_conferir','onda1_executar','onda1_reverter')
        order by p.proname`);
    expect(r).toHaveLength(3);
    for (const f of r) {
      // sem `=X/` solto no inicio: PUBLIC nao tem EXECUTE
      expect(f.acl.split("|").some((e) => e.startsWith("=X"))).toBe(false);
      expect(f.acl).toContain("authenticated=X");
      expect(f.acl).toContain("service_role=X");
    }
    await db.close();
  });

  it("operador logado (não gestão) é recusado com 42501 nas três", async () => {
    const db = await abrir();
    const id = await lote(db, 6);
    await aprovar(db, id);
    await como(db, OP[0]);
    for (const fn of ["onda1_conferir", "onda1_executar", "onda1_reverter"]) {
      await expect(db.query(`select public.${fn}($1::uuid)`, [id]))
        .rejects.toThrow(/Sem permiss/);
    }
    await db.close();
  });

  it("chamada de máquina sem JWT nenhum passa pelo portão", async () => {
    const db = await abrir();
    const id = await lote(db, 6);
    // O stub de auth.jwt() da bancada devolve '{}' quando nao ha JWT, entao
    // `auth.jwt() is null` nunca seria verdade ali. Em PRODUCAO, medido em
    // 21/10/2026, auth.jwt() devolve NULL sem JWT -- e e por essa porta que
    // migration e cron executam. Aqui o stub e trocado pelo comportamento de
    // producao, so neste teste, para a porta de maquina ser exercitada.
    await db.exec(`create or replace function auth.jwt() returns jsonb
                   language sql stable as $$
                     select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
                   $$;`);
    await semLogin(db);
    expect((await q1(db, "select auth.jwt() is null v")).v).toBe(true);
    const pre = await conferir(db, id);
    expect(pre.pode_executar).toBe(true);
    await db.close();
  });
});

// ===========================================================================
describe("APROVAÇÃO EXPLÍCITA é obrigatória", () => {
  it("RASCUNHO não executa, e nada é escrito", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    const antes = await digital(db);
    await expect(db.query("select public.onda1_executar($1::uuid)", [id]))
      .rejects.toThrow(/APROVADA/);
    expect(await digital(db)).toBe(antes);
    await db.close();
  });

  it("depois de calibragem_aprovar_simulacao, executa", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    const r = await executar(db, id);
    expect(r.status).toBe("EXECUTADA");
    expect(r.casos_movidos).toBe(9);
    await db.close();
  });

  it("a simulação de outra métrica é recusada", async () => {
    const db = await abrir();
    const id = await lote(db, 6);
    await db.query(
      `update public.calibragem_simulacoes set resultado = jsonb_set(resultado,'{metrica}','"OUTRA_COISA"') where id=$1`,
      [id]);
    await expect(db.query("select public.onda1_conferir($1::uuid)", [id]))
      .rejects.toThrow(/não é a Onda 1/);
    await db.close();
  });

  it("executar duas vezes não move nada na segunda", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await executar(db, id);
    const depois1 = await digital(db);
    await expect(db.query("select public.onda1_executar($1::uuid)", [id]))
      .rejects.toThrow(/APROVADA/);
    expect(await digital(db)).toBe(depois1);
    await db.close();
  });
});

// ===========================================================================
describe("A RECUSA É INTEIRA: nenhuma condição deixa escrever meia Onda", () => {
  const cenarios = [
    ["DONO_DE_ORIGEM_MUDOU", async (db) =>
      db.query(`update public.casos set operador_email=$1 where id=$2`, [OP[1], U(100)])],
    ["ALUNO_COM_RESPONSAVEL_ATIVO", async (db) =>
      db.query(`update public.casos set operador_email=$1 where aluno_id=$2`, [OP[2], U(1)])],
    ["NOVA_PROTECAO_NAO_ACIONAR", async (db) =>
      db.query(`update public.casos set nao_acionar=true where id=$1`, [U(200)])],
    ["NOVA_PROTECAO_MARCA_DE_GIRO", async (db) =>
      db.query(`update public.casos set giro_fidelizacao_ate=current_date+5 where id=$1`, [U(300)])],
    ["NOVA_PROTECAO_CONFIRMACAO_ABERTA", async (db) =>
      db.query(`insert into public.solicitacoes_confirmacao_pagamento (id, aluno_id, status)
                values ($1,$2,'AGUARDANDO_CONFIRMACAO')`, [U(111111), U(4)])],
    ["PERDEU_ELEGIBILIDADE", async (db) =>
      db.query(`update public.acordos_titulos set situacao='LIQUIDADO' where aluno_id=$1`, [U(5)])],
  ];

  for (const [condicao, quebrar] of cenarios) {
    it(`${condicao}: recusa e a digital de casos não muda`, async () => {
      const db = await abrir();
      const id = await lote(db, 9);
      await aprovar(db, id);
      await quebrar(db);
      const antes = await digital(db);

      const pre = await conferir(db, id);
      expect(pre.pode_executar).toBe(false);
      expect(pre.impedimentos.map((i) => i.condicao)).toContain(condicao);

      await expect(db.query("select public.onda1_executar($1::uuid)", [id]))
        .rejects.toThrow(/pré-voo/);
      expect(await digital(db)).toBe(antes);
      expect((await q1(db, `select count(*)::int n from public.calibragem_auditoria`)).n).toBe(0);
      await db.close();
    });
  }

  it("DESTINO_NAO_E_OPERADOR_ATIVO: operador desativado depois da simulação", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await db.query(`update public.usuarios set ativo=false where email=$1`, [OP[0]]);
    const antes = await digital(db);
    const pre = await conferir(db, id);
    expect(pre.impedimentos.map((i) => i.condicao)).toContain("DESTINO_NAO_E_OPERADOR_ATIVO");
    await expect(db.query("select public.onda1_executar($1::uuid)", [id])).rejects.toThrow(/pré-voo/);
    expect(await digital(db)).toBe(antes);
    await db.close();
  });

  it("TETO_ESTOURADO: recusa com o nome de quem estouraria, zero escrita", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    // Teto 1 por operador: 3 CPFs para cada um nao cabem.
    await db.query(`update public.calibragem_parametros set valor='1'::jsonb where chave='limite_carteira'`);
    const antes = await digital(db);
    const pre = await conferir(db, id);
    const imp = pre.impedimentos.find((i) => i.condicao === "TETO_ESTOURADO");
    expect(imp).toBeTruthy();
    expect(imp.quem).toMatch(/> 1/);
    await expect(db.query("select public.onda1_executar($1::uuid)", [id])).rejects.toThrow(/pré-voo/);
    expect(await digital(db)).toBe(antes);
    await db.close();
  });
});

// ===========================================================================
describe("NENHUM CASO JÁ ATRIBUÍDO É LIBERADO", () => {
  it("o gatilho do teto não tira caso de outro aluno do operador que recebe", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);

    // Carteira já atribuída, FORA do lote, do mesmo operador que vai receber.
    for (let n = 50; n < 56; n++) {
      await aluno(db, n, { dono: OP[0], sem2026: true });
    }
    const jaAtribuidos = await qn(db,
      `select id, operador_email from public.casos where operador_email=$1 order by id`, [OP[0]]);
    expect(jaAtribuidos.length).toBe(6);

    await executar(db, id);

    const depois = await qn(db,
      `select id, operador_email from public.casos where id = any($1::uuid[]) order by id`,
      [jaAtribuidos.map((r) => r.id)]);
    // Todos continuam com o mesmo dono: ninguem foi liberado.
    expect(depois.every((r) => r.operador_email === OP[0])).toBe(true);
    expect((await q1(db, `select count(*)::int n from public.historico_operadores_alunos
                           where acao='LIBERACAO_AUTOMATICA_TETO_EXCEDIDO'`)).n).toBe(0);
    await db.close();
  });

  it("o gatilho de reposição não dispara: na Onda 1 o dono sempre muda", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await executar(db, id);
    expect((await q1(db, `select count(*)::int n from public.reposicao_carteira_fila`)).n).toBe(0);
    await db.close();
  });
});

// ===========================================================================
describe("RESPONSÁVEL ÚNICO POR ALUNO", () => {
  it("aluno com ficha duplicada (um caso aberto, um fechado) vai inteiro para o mesmo operador", async () => {
    const db = await abrir();
    // aluno 3 reproduz os 7 pares reais: 2 casos, o segundo CANCELADO.
    const id = await lote(db, 9, { 3: { casosExtras: 1, extraFechado: true } });
    await aprovar(db, id);

    const pre = await conferir(db, id);
    expect(pre.pode_executar).toBe(true);
    expect(pre.impedimentos).toEqual([]);

    const r = await executar(db, id);
    expect(r.casos_movidos).toBe(10); // 9 alunos, um deles com 2 casos

    const donos = await qn(db,
      `select distinct operador_email from public.casos where aluno_id=$1`, [U(3)]);
    expect(donos).toHaveLength(1);
    expect(donos[0].operador_email).not.toBeNull();
    await db.close();
  });

  it("o caso fechado do par continua fechado: o recálculo preserva encerrado_operacional", async () => {
    const db = await abrir();
    const id = await lote(db, 9, { 3: { casosExtras: 1, extraFechado: true } });
    await aprovar(db, id);
    await executar(db, id);
    const r = await q1(db,
      `select count(*) filter (where coalesce(encerrado_operacional,false))::int fechados,
              count(*)::int total from public.casos where aluno_id=$1`, [U(3)]);
    expect(r.total).toBe(2);
    expect(r.fechados).toBe(1);
    await db.close();
  });

  it("aluno com DOIS casos abertos: recusa antes do banco derrubar a transação", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    // Estado HERDADO: dois casos abertos do mesmo aluno. O gatilho barra o
    // proprio insert, por isso ele e desligado so para criar a linha -- e o
    // que explica os pares reais existirem na base: nasceram antes do gatilho.
    await db.exec(`alter table public.casos disable trigger trg_zz_caso_nao_duplica_aluno_before;
                   alter table public.casos disable trigger trg_zz_caso_nao_duplica_aluno;`);
    await db.query(
      `insert into public.casos
         (id, aluno_id, nome, nome_aluno, cpf, cpf_limpo, chave_unificacao, operador_email, operador_nome,
          status_atual, status_acionamento, status_financeiro, status_jornada)
       values ($1,$2,$3,$3,$4,$4,$4,$5,'DONO','EM COBRANCA','EM COBRANCA','EM ABERTO','EM COBRANCA')`,
      [U(3999), U(3), "Aluno 3", CPF(3), CG]);
    await db.exec(`alter table public.casos enable trigger trg_zz_caso_nao_duplica_aluno_before;
                   alter table public.casos enable trigger trg_zz_caso_nao_duplica_aluno;`);
    await aprovar(db, id);
    const antes = await digital(db);
    const pre = await conferir(db, id);
    expect(pre.impedimentos.map((i) => i.condicao)).toContain("FICHA_DUPLICADA_ABERTA");
    await expect(db.query("select public.onda1_executar($1::uuid)", [id])).rejects.toThrow(/pré-voo/);
    expect(await digital(db)).toBe(antes);
    await db.close();
  });
});

// ===========================================================================
describe("FIDELIZAÇÃO DE 10 DIAS", () => {
  it("a marca é gravada com a data da simulação e sobrevive à troca de dono", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    const pre = await conferir(db, id);
    const r = await executar(db, id);
    expect(r.fidelizacao_ate).toBe(pre.fidelizacao_ate);

    const m = await qn(db,
      `select distinct giro_fidelizacao_ate::text g from public.casos where operador_email = any($1::text[])`,
      [OP]);
    expect(m).toHaveLength(1);
    expect(m[0].g).toBe(pre.fidelizacao_ate);
    // E a marca vale: caso_em_giro_fidelizacao diz que esta em giro.
    expect((await q1(db, `select public.caso_em_giro_fidelizacao($1::date) v`, [m[0].g])).v).toBe(true);
    await db.close();
  });
});

// ===========================================================================
describe("TITULARIDADE FINANCEIRA INTACTA", () => {
  it("acordo, parcela, título e honorário ficam byte a byte iguais", async () => {
    const db = await abrir();
    const id = await lote(db, 9, { 2: { acordo: true }, 4: { acordo: true } });
    await aprovar(db, id);

    const fin = async () => (await q1(db, `select
        md5(coalesce((select string_agg(id::text||status||coalesce(operador_responsavel_email,'-')||saldo::text, ',' order by id) from public.acordos),'')) a,
        md5(coalesce((select string_agg(id::text||status||valor::text, ',' order by id) from public.parcelas),'')) p,
        md5(coalesce((select string_agg(id::text||situacao||status||coalesce(acordo_id::text,'-'), ',' order by id) from public.acordos_titulos),'')) t,
        md5(coalesce((select string_agg(id::text||coalesce(honorario::text,'-')||coalesce(status_financeiro,'-')||coalesce(valor_pago::text,'-'), ',' order by id) from public.casos),'')) c
      `));
    const antes = await fin();
    await executar(db, id);
    const depois = await fin();
    expect(depois.a).toBe(antes.a);
    expect(depois.p).toBe(antes.p);
    expect(depois.t).toBe(antes.t);
    expect(depois.c).toBe(antes.c);
    await db.close();
  });

  it("o titular do acordo continua o mesmo, mesmo com outro responsável operacional", async () => {
    const db = await abrir();
    const id = await lote(db, 9, { 2: { acordo: true } });
    await aprovar(db, id);
    await executar(db, id);
    const r = await q1(db,
      `select a.operador_responsavel_email titular, c.operador_email operacional
         from public.acordos a join public.casos c on c.aluno_id=a.aluno_id where a.aluno_id=$1`, [U(2)]);
    expect(r.titular).toBe("dono.financeiro@aelbra.com.br");
    expect(OP).toContain(r.operacional);
    await db.close();
  });
});

// ===========================================================================
describe("REGISTRO INDIVIDUAL DE CADA MOVIMENTAÇÃO", () => {
  it("uma linha de auditoria por caso, com antes e depois", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    const r = await executar(db, id);

    const a = await qn(db,
      `select caso_id, operador_anterior_email, operador_novo_email, regra, evento,
              situacao_anterior->>'operador_email' sa, situacao_posterior->>'operador_email' sp,
              situacao_posterior->>'giro_fidelizacao_ate' sg
         from public.calibragem_auditoria where simulacao_id=$1 and evento='MOVIMENTACAO_ONDA1'`, [id]);
    expect(a).toHaveLength(r.casos_movidos);
    expect(new Set(a.map((x) => x.caso_id)).size).toBe(r.casos_movidos);
    for (const x of a) {
      expect(x.regra).toBe("ONDA1_LOTE_A");
      expect(x.operador_anterior_email).toBe(CG);
      expect(OP).toContain(x.operador_novo_email);
      expect(x.sa).toBe(CG);
      expect(x.sp).toBe(x.operador_novo_email);
      expect(x.sg).toBe(r.fidelizacao_ate);
    }
    await db.close();
  });

  it("a trilha é append-only: update e delete são recusados", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await executar(db, id);
    await expect(db.query(`update public.calibragem_auditoria set motivo='x' where simulacao_id=$1`, [id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query(`delete from public.calibragem_auditoria where simulacao_id=$1`, [id]))
      .rejects.toThrow(/append-only/);
    await db.close();
  });
});

// ===========================================================================
describe("REVERSÃO SEGURA", () => {
  it("devolve dono e marca ao estado anterior", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    const antes = await digital(db);
    await aprovar(db, id);
    await executar(db, id);
    expect(await digital(db)).not.toBe(antes);

    const r = await reverter(db, id);
    expect(r.voltaram).toBe(9);
    expect(r.pulados).toBe(0);
    expect(r.status).toBe("REVERTIDA");
    expect(await digital(db)).toBe(antes);
    await db.close();
  });

  it("NÃO atropela o que a operação fez depois: caso remanejado fica como está", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await executar(db, id);

    // A operação move um caso para outro operador depois da Onda 1.
    const alvo = await q1(db, `select id, operador_email from public.casos where aluno_id=$1`, [U(7)]);
    const outro = OP.find((e) => e !== alvo.operador_email);
    await db.query(`update public.casos set operador_email=$1 where id=$2`, [outro, alvo.id]);

    const r = await reverter(db, id);
    expect(r.voltaram).toBe(8);
    expect(r.pulados).toBe(1);

    // O caso remanejado NAO voltou: continua com quem a operacao pos.
    expect((await q1(db, `select operador_email e from public.casos where id=$1`, [alvo.id])).e).toBe(outro);
    const pulado = await q1(db,
      `select caso_id, motivo from public.calibragem_auditoria
        where simulacao_id=$1 and evento='PULADO_REVERSAO_ONDA1'`, [id]);
    expect(pulado.caso_id).toBe(alvo.id);
    expect(pulado.motivo).toMatch(/já saiu das mãos/);
    await db.close();
  });

  it("não reverte o que não foi executado", async () => {
    const db = await abrir();
    const id = await lote(db, 6);
    await expect(db.query("select public.onda1_reverter($1::uuid)", [id]))
      .rejects.toThrow(/EXECUTADA/);
    await aprovar(db, id);
    await expect(db.query("select public.onda1_reverter($1::uuid)", [id]))
      .rejects.toThrow(/EXECUTADA/);
    await db.close();
  });

  it("reverter duas vezes não desfaz nada na segunda", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await executar(db, id);
    await reverter(db, id);
    const d = await digital(db);
    await expect(db.query("select public.onda1_reverter($1::uuid)", [id]))
      .rejects.toThrow(/EXECUTADA/);
    expect(await digital(db)).toBe(d);
    await db.close();
  });
});

// ===========================================================================
describe("o pré-voo não escreve nada", () => {
  it("conferir repetido não muda casos, auditoria nem simulação", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    const antes = await digital(db);
    const st = await q1(db, `select status, executado_em from public.calibragem_simulacoes where id=$1`, [id]);
    for (let i = 0; i < 3; i++) await conferir(db, id);
    expect(await digital(db)).toBe(antes);
    expect((await q1(db, `select count(*)::int n from public.calibragem_auditoria`)).n).toBe(0);
    const st2 = await q1(db, `select status, executado_em from public.calibragem_simulacoes where id=$1`, [id]);
    expect(st2.status).toBe(st.status);
    expect(st2.executado_em).toBe(st.executado_em);
    await db.close();
  });

  it("conferir e executar convivem na mesma transação", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await db.exec("begin");
    await conferir(db, id);
    const r = await executar(db, id);
    await db.exec("commit");
    expect(r.casos_movidos).toBe(9);
    await db.close();
  });
});

// ===========================================================================
describe("a migration e o rollback", () => {
  it("antes da migration as três funções não existem", async () => {
    const db = await abrir(false);
    const r = await q1(db,
      `select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('onda1_conferir','onda1_executar','onda1_reverter')`);
    expect(r.n).toBe(0);
    await db.close();
  });

  it("o rollback apaga as três e NÃO desmove ninguém nem apaga a trilha", async () => {
    const db = await abrir();
    const id = await lote(db, 9);
    await aprovar(db, id);
    await executar(db, id);
    const depois = await digital(db);

    await db.exec(ROLLBACK);
    const r = await q1(db,
      `select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('onda1_conferir','onda1_executar','onda1_reverter')`);
    expect(r.n).toBe(0);
    // casos no lugar onde a Onda 1 os deixou, e a trilha preservada
    expect(await digital(db)).toBe(depois);
    expect((await q1(db, `select count(*)::int n from public.calibragem_auditoria
                           where simulacao_id=$1 and evento='MOVIMENTACAO_ONDA1'`, [id])).n).toBe(9);
    await db.close();
  });

  it("a migration é idempotente: aplicar duas vezes não muda nada", async () => {
    const db = await abrir();
    await db.exec(MIGRATION);
    const id = await lote(db, 9);
    await aprovar(db, id);
    expect((await executar(db, id)).casos_movidos).toBe(9);
    await db.close();
  });
});
