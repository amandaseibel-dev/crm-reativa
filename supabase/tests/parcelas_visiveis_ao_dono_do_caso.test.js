// PARCELA DE ACORDO VISÍVEL PARA O DONO DO CASO -- teste de comportamento.
//
// Roda a MIGRATION REAL
// (supabase/migrations/20261021092408_parcelas_visiveis_ao_dono_do_caso.sql) e o
// ROLLBACK REAL num PostgreSQL real (PGlite), sobre duas fixtures com o texto
// EXATO de producao, cada corpo conferido por md5 do `prosrc`:
//
//   fidelizacao_por_dono_prod_20260930  -- parcelas, acordos, alunos, casos,
//     usuarios, os gatilhos de `casos` e as funcoes de bloqueio
//     (caso_encerrado_operacional, normalizar_status_acionamento,
//     saldo_titulos_aberto, usuario_e_gestao, usuario_e_gestao_fila);
//   parcelas_visiveis_prod_20261020     -- a tabela acordo_alertas_parcela e as
//     tres funcoes de leitura: parcela_viva, parcelas_vencendo_2_dias e
//     acordo_alertas_do_operador.
//
// Nada de duble nas regras. Unico stub: auth.jwt(), resolvido por GUC para o
// teste "entrar" como cada pessoa -- infraestrutura, nao regra.
//
// NENHUM DADO REAL: alunos e CPFs inventados, UUIDs sequenciais.
//
// A migration NAO FOI APLICADA em banco nenhum. Este teste e a unica coisa que
// a executa, num banco efemero que morre no fim.
//
// FUSO = UTC, como producao. As duas funcoes comparam com `current_date`, entao
// fuso solto faria o mesmo teste passar aqui e falhar no CI.
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
const COMPLEMENTO = ler("supabase/tests/fixtures/parcelas_visiveis_prod_20261020.sql");
const MD5_COMPL = JSON.parse(ler("supabase/tests/fixtures/parcelas_visiveis_prod_20261020.md5.json"));
const MIGRATION = ler("supabase/migrations/20261021092408_parcelas_visiveis_ao_dono_do_caso.sql");
const ROLLBACK = ler("supabase/rollbacks/20261021092408_parcelas_visiveis_ao_dono_do_caso.rollback.sql");

const DONO_CASO = "cobranca05@aelbra.com.br";   // LUANA -- o responsavel operacional
const DONO_ACORDO = "cobranca06@aelbra.com.br"; // MAURICIO -- quem fechou a negociacao
const GESTAO = "amanda.seibel@aelbra.com.br";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(30000000000 + n);

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

const selo = (db) => qn(db, "select * from public.parcelas_vencendo_2_dias()");
const lista = (db) => qn(db, "select * from public.acordo_alertas_do_operador()");

async function construir() {
  const db = new PGlite({ extensions: ext });
  await db.exec(FIXTURE);
  await db.exec(COMPLEMENTO);

  const rows = await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries({ ...MD5_BASE, ...MD5_COMPL })) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome) values
      ('LUANA',    '${DONO_CASO}',   'operador', true, 'LUANA'),
      ('MAURICIO', '${DONO_ACORDO}', 'operador', true, 'MAURICIO'),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null);
  `);
  return db;
}

// aluno + caso (dono operacional) + acordo (dono financeiro) + 1 parcela.
// `dias` = deslocamento do vencimento em relacao a hoje (negativo = vencida).
async function cenario(db, n, o = {}) {
  const {
    donoCaso = DONO_CASO, donoAcordo = DONO_ACORDO, dias = 2,
    status = "A_VENCER", statusAcordo = "ATIVO", valor = 1000,
    naoAcionar = false, statusAtual = null, comAlerta = false,
  } = o;
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome)
     values ($1,$2,$3,$4,$5,'DONO')`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, donoCaso]);
  await db.query(
    `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email, status_atual,
        nao_acionar, caso_codigo, caso_atualizado_em)
     values ($1,$2,$2,$3,$4,$5,$6,$7, now())`,
    [U(n), cpf, `Aluno Sintetico ${n}`, donoCaso, statusAtual, naoAcionar, n]);
  const acordo = await q1(db,
    `insert into public.acordos (aluno_id, cpf, status, operador_responsavel_email,
        operador_responsavel_nome, valor_total)
     values ($1,$2,$3,$4,'MAURICIO',$5) returning id, numero_acordo`,
    [U(n), cpf, statusAcordo, donoAcordo, valor]);
  const parcela = await q1(db,
    `insert into public.parcelas (acordo_id, numero, valor, vencimento, status)
     values ($1,1,$2, current_date + ($3::text||' days')::interval, $4) returning id`,
    [acordo.id, valor, dias, status]);
  if (comAlerta) {
    await db.query(
      `insert into public.acordo_alertas_parcela (acordo_id, aluno_id, parcela_id, numero_parcela,
          valor, vencimento, data_alerta, tipo, responsavel_email)
       values ($1,$2,$3,1,$4, current_date + ($5::text||' days')::interval, current_date, 'D2', $6)`,
      [acordo.id, U(n), parcela.id, valor, dias, donoAcordo]);
  }
  return { aluno: U(n), acordo: acordo.id, parcela: parcela.id };
}

let SEM, COM;

beforeAll(async () => {
  const b1 = await construir();
  SEM = await b1.dumpDataDir();
  await b1.close();
  const b2 = await construir();
  await b2.exec(MIGRATION);
  COM = await b2.dumpDataDir();
  await b2.close();
});

const abrirSem = () => new PGlite({ loadDataDir: SEM, extensions: ext });
const abrirCom = () => new PGlite({ loadDataDir: COM, extensions: ext });

describe("a linha de base de produção endereça pelo dono do ACORDO", () => {
  it("o selo aparece para quem fechou a negociação, não para o dono do caso", async () => {
    const db = await abrirSem();
    await cenario(db, 1, { dias: 2 });

    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);   // quem acompanha NAO ve

    await como(db, DONO_ACORDO);
    expect(await selo(db)).toHaveLength(1);   // quem tem o honorario ve
    await db.close();
  });

  it("a lista de alertas tem o mesmo desvio", async () => {
    const db = await abrirSem();
    await cenario(db, 2, { dias: 2, comAlerta: true });

    await como(db, DONO_CASO);
    expect(await lista(db)).toHaveLength(0);

    await como(db, DONO_ACORDO);
    expect(await lista(db)).toHaveLength(1);
    await db.close();
  });

  it("e as parcelas VENCIDAS não aparecem em fila nenhuma", async () => {
    const db = await abrirSem();
    await cenario(db, 3, { dias: -10, status: "VENCIDA", comAlerta: true });
    for (const quem of [DONO_CASO, DONO_ACORDO, GESTAO]) {
      await como(db, quem);
      expect(await selo(db)).toHaveLength(0);
      // o alerta existe, mas e de uma parcela vencida -- e a tela nao tem onde
      // mostrar "vencida" com sentido, porque dias_restantes nao era usado assim
      const l = await lista(db);
      if (quem === DONO_CASO) expect(l).toHaveLength(0);
    }
    await db.close();
  });
});

describe("com a migration, quem acompanha é quem vê", () => {
  it("o selo vai para o dono do CASO", async () => {
    const db = await abrirCom();
    await cenario(db, 10, { dias: 2 });

    await como(db, DONO_CASO);
    const s = await selo(db);
    expect(s).toHaveLength(1);
    expect(s[0].operador_email).toBe(DONO_CASO);

    await como(db, DONO_ACORDO);
    expect(await selo(db)).toHaveLength(0);
    await db.close();
  });

  it("o alerta D-2 vai para o dono do CASO", async () => {
    const db = await abrirCom();
    await cenario(db, 11, { dias: 2, comAlerta: true });

    await como(db, DONO_CASO);
    const l = await lista(db);
    expect(l).toHaveLength(1);
    expect(l[0].responsavel_email).toBe(DONO_CASO);
    expect(l[0].dias_restantes).toBe(2);
    await db.close();
  });

  it("a VENCIDA de 10 dias entra na lista, com `dias_restantes` negativo", async () => {
    const db = await abrirCom();
    await cenario(db, 12, { dias: -10, status: "VENCIDA" });

    await como(db, DONO_CASO);
    const l = await lista(db);
    expect(l).toHaveLength(1);
    expect(l[0].dias_restantes).toBe(-10);
    expect(l[0].responsavel_email).toBe(DONO_CASO);
    await db.close();
  });

  it("a vencida de 40 dias NÃO entra: a janela é de 30", async () => {
    const db = await abrirCom();
    await cenario(db, 13, { dias: -40, status: "VENCIDA" });
    await como(db, DONO_CASO);
    expect(await lista(db)).toHaveLength(0);
    await db.close();
  });

  it("o selo mantém a janela de D-2: vencida não acende o selo", async () => {
    const db = await abrirCom();
    await cenario(db, 14, { dias: -10, status: "VENCIDA" });
    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);     // selo nao
    expect(await lista(db)).toHaveLength(1);    // lista sim
    await db.close();
  });

  it("sem duplicidade: parcela com alerta aparece UMA vez", async () => {
    const db = await abrirCom();
    await cenario(db, 15, { dias: 2, comAlerta: true });
    await cenario(db, 16, { dias: -5, status: "VENCIDA", comAlerta: true });

    await como(db, DONO_CASO);
    const l = await lista(db);
    expect(l).toHaveLength(2);
    expect(new Set(l.map((r) => r.parcela_id)).size).toBe(2);
    await db.close();
  });

  it("a gestão continua vendo o que não é dela", async () => {
    const db = await abrirCom();
    await cenario(db, 17, { dias: 2, comAlerta: true });
    await como(db, GESTAO);
    expect((await selo(db)).length).toBe(1);
    expect((await lista(db)).length).toBe(1);
    await db.close();
  });
});

describe("os bloqueios do artigo 6 passam a valer nas duas filas", () => {
  it("`nao_acionar` sai do selo e da lista", async () => {
    const db = await abrirCom();
    await cenario(db, 20, { dias: 2, comAlerta: true, naoAcionar: true });
    await cenario(db, 21, { dias: -5, status: "VENCIDA", naoAcionar: true });
    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);
    expect(await lista(db)).toHaveLength(0);
    await db.close();
  });

  it("suspensão de cobrança sai das duas", async () => {
    const db = await abrirCom();
    await cenario(db, 22, { dias: 2, comAlerta: true, statusAtual: "SUSPENSAO COBRANCA" });
    await cenario(db, 23, { dias: -5, status: "VENCIDA", statusAtual: "SUSPENSAO COBRANCA" });
    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);
    expect(await lista(db)).toHaveLength(0);
    await db.close();
  });

  it("restrição jurídica sai das duas", async () => {
    const db = await abrirCom();
    await cenario(db, 24, { dias: 2, comAlerta: true, statusAtual: "JURIDICO" });
    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);
    expect(await lista(db)).toHaveLength(0);
    await db.close();
  });

  it("parcela PAGA ou CANCELADA continua fora (parcela_viva intacta)", async () => {
    const db = await abrirCom();
    await cenario(db, 25, { dias: 2, status: "PAGO" });
    await cenario(db, 26, { dias: -5, status: "CANCELADA" });
    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);
    expect(await lista(db)).toHaveLength(0);
    await db.close();
  });

  it("acordo CANCELADO não gera acompanhamento de vencida", async () => {
    const db = await abrirCom();
    await cenario(db, 27, { dias: -5, status: "VENCIDA", statusAcordo: "CANCELADO" });
    await como(db, DONO_CASO);
    expect(await lista(db)).toHaveLength(0);
    await db.close();
  });
});

describe("nada é alterado: nem valor, nem pagamento, nem titularidade", () => {
  it("ler as duas filas não muda uma linha das tabelas financeiras", async () => {
    const db = await abrirCom();
    await cenario(db, 30, { dias: 2, comAlerta: true });
    await cenario(db, 31, { dias: -5, status: "VENCIDA" });

    const foto = async () => ({
      parcelas: await qn(db, "select id, valor, vencimento, status, acordo_id from public.parcelas order by id"),
      acordos: await qn(db, "select id, status, valor_total, operador_responsavel_email, operador_responsavel_nome from public.acordos order by id"),
      alertas: await qn(db, "select id, responsavel_email, resolvido_em, valor, vencimento from public.acordo_alertas_parcela order by id"),
      pagamentos: await qn(db, "select count(*)::int n from public.pagamentos"),
      titulos: await qn(db, "select id, saldo_corrigido, situacao, status from public.acordos_titulos order by id"),
    });

    const antes = await foto();
    await como(db, DONO_CASO);
    await selo(db); await lista(db);
    await como(db, GESTAO);
    await selo(db); await lista(db);
    const depois = await foto();

    expect(depois).toEqual(antes);
    await db.close();
  });

  it("a titularidade financeira do acordo continua com quem fechou", async () => {
    const db = await abrirCom();
    await cenario(db, 32, { dias: 2 });
    await como(db, DONO_CASO);
    await selo(db);
    const a = await q1(db, "select operador_responsavel_email e from public.acordos limit 1");
    expect(a.e).toBe(DONO_ACORDO);
    await db.close();
  });

  it("`responsavel_email` guardado na tabela de alertas não é reescrito", async () => {
    const db = await abrirCom();
    await cenario(db, 33, { dias: 2, comAlerta: true });
    await como(db, DONO_CASO);
    await lista(db);
    const x = await q1(db, "select responsavel_email e from public.acordo_alertas_parcela limit 1");
    expect(x.e).toBe(DONO_ACORDO); // o registro de quem fechou fica intacto
    await db.close();
  });

  it("as duas funções não contêm nenhum caminho de escrita", async () => {
    const db = await abrirCom();
    const defs = await qn(db,
      `select p.proname, pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('parcelas_vencendo_2_dias','acordo_alertas_do_operador')`);
    expect(defs).toHaveLength(2);
    for (const f of defs) {
      const corpo = f.d.toLowerCase();
      for (const proibido of ["insert into", "update public.", "delete from", "perform ", "truncate"]) {
        expect(corpo).not.toContain(proibido);
      }
      expect(corpo).toContain("language sql");
    }
    await db.close();
  });

  it("nenhuma outra função foi alterada pela migration", async () => {
    const sem = await abrirSem();
    const com = await abrirCom();
    const corpos = async (db) => Object.fromEntries((await qn(db,
      `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal')`)).map((r) => [r.nome, r.md5]));
    const a = await corpos(sem);
    const b = await corpos(com);
    const mudaram = Object.keys(a).filter((k) => a[k] !== b[k]).sort();
    expect(mudaram).toEqual(["public.acordo_alertas_do_operador", "public.parcelas_vencendo_2_dias"]);
    await sem.close();
    await com.close();
  });
});

describe("o rollback devolve o estado anterior", () => {
  it("volta a endereçar pelo dono do acordo", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    await cenario(db, 40, { dias: 2, comAlerta: true });

    await como(db, DONO_CASO);
    expect(await selo(db)).toHaveLength(0);
    await como(db, DONO_ACORDO);
    expect(await selo(db)).toHaveLength(1);
    await db.close();
  });

  it("devolve os dois corpos byte a byte, por md5", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    const m = Object.fromEntries((await qn(db,
      `select p.proname, md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('parcelas_vencendo_2_dias','acordo_alertas_do_operador')`))
      .map((r) => [r.proname, r.md5]));
    expect(m.parcelas_vencendo_2_dias).toBe(MD5_COMPL["public.parcelas_vencendo_2_dias"]);
    expect(m.acordo_alertas_do_operador).toBe(MD5_COMPL["public.acordo_alertas_do_operador"]);
    await db.close();
  });
});

describe("a migration é idempotente", () => {
  it("aplicar duas vezes não muda nada", async () => {
    const db = await abrirCom();
    const antes = await qn(db,
      `select p.proname, md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('parcelas_vencendo_2_dias','acordo_alertas_do_operador')
        order by p.proname`);
    await db.exec(MIGRATION);
    const depois = await qn(db,
      `select p.proname, md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('parcelas_vencendo_2_dias','acordo_alertas_do_operador')
        order by p.proname`);
    expect(depois).toEqual(antes);
    await db.close();
  });
});
