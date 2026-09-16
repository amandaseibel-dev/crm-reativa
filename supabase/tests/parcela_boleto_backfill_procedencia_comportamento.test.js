// BACKFILL DO BOLETO POR PROCEDENCIA -- COMPORTAMENTO, nao estrutura.
//
// Executa a migration REAL num PostgreSQL real (PGlite). O trigger
// `trg_recalc_parcela` e a funcao `_trg_recalc_por_parcela` sao reproduzidos
// BYTE A BYTE de producao -- a propria migration confere md5 e definicao, entao
// um fixture aproximado seria recusado por ela.
//
// `recalcular_situacao_aluno` aqui e um DUBLE QUE ESCREVE em alunos e casos --
// e isso que a migration confere por hash PRE/POS. Ele tambem chama
// `nextval('chamadas_recalc')`: sequencia NAO e desfeita por rollback, entao a
// chamada fica registrada mesmo quando a migration aborta. E assim que o teste
// prova que o recalculo FOI chamado, e nao apenas que algo abortou.
//
// Os valores que dependem de dados (hash, 748, 301, 2644, 12461) sao trocados
// pelos do fixture; o restante da migration roda sem alteracao. O hash do
// fixture e calculado AQUI, em JS, de forma independente do SQL da migration.
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(AQUI, "..", "..",
  "supabase/migrations/20260916120000_backfill_boleto_parcela_por_procedencia.sql");
const SQL_REAL = readFileSync(MIG, "utf8");

// --- corpos EXATOS de producao ------------------------------------------------
const CORPO_RECALC = "\ndeclare v_aluno uuid;\nbegin\n  begin\n    select a.aluno_id into v_aluno from public.acordos a\n     where a.id = coalesce(NEW.acordo_id, OLD.acordo_id);\n    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, 'trg_parcela'); end if;\n  exception when others then null;\n  end;\n  return null;\nend; ";
const CORPO_PAGO_EM = "\nbegin\n  if new.status = 'PAGO' and new.pago_em is null then\n    new.pago_em := now();\n  end if;\n  return new;\nend;\n";

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const AL1 = U(901), AL2 = U(902), AL3 = U(903);
const AC1 = U(801), AC2 = U(802), AC3 = U(803);
const P = (n) => U(100 + n);

// candidatas do fixture: P1 (1:1 no lote L1), P2 e P3 (mesmo lote L2)
const CANDIDATAS = [
  { parcela_id: P(1), acordo_id: AC1, lote: "L1", bp: 1, bt: 2, doc: "050111110001" },
  { parcela_id: P(2), acordo_id: AC2, lote: "L2", bp: 3, bt: 4, doc: "050222220001" },
  { parcela_id: P(3), acordo_id: AC2, lote: "L2", bp: 5, bt: 6, doc: "050222220002" },
];
const bol = (d) => d.replace(/^0+/, "");
const HASH_FIXTURE = createHash("sha256").update(
  [...CANDIDATAS].sort((a, b) => (a.parcela_id < b.parcela_id ? -1 : 1))
    .map((c) => [c.parcela_id, c.acordo_id, c.lote, c.bp, c.bt, c.doc, bol(c.doc)].join("|")).join("\n"),
  "utf8").digest("hex");

const FIXTURE = { hash: HASH_FIXTURE, qtd: 3, acordos: 2, alunos: 2, nulos: 5, preenchidos: 2 };

function migracao(valores = FIXTURE, trocas = []) {
  let s = SQL_REAL
    .replace(/(c_hash_aprovado\s+constant text\s+:=\s+)'[^']*';/, `$1'${valores.hash}';`)
    .replace(/(c_qtd\s+constant integer\s+:=\s+)\d+;/, `$1${valores.qtd};`)
    .replace(/(c_acordos\s+constant integer\s+:=\s+)\d+;/, `$1${valores.acordos};`)
    .replace(/(c_alunos\s+constant integer\s+:=\s+)\d+;/, `$1${valores.alunos};`)
    .replace(/(c_nulos_antes\s+constant integer\s+:=\s+)\d+;/, `$1${valores.nulos};`)
    .replace(/(c_preenchidos_antes\s+constant integer\s+:=\s+)\d+;/, `$1${valores.preenchidos};`);
  for (const [de, para] of trocas) {
    if (!s.includes(de)) throw new Error("mutacao nao encontrou o alvo: " + de.slice(0, 60));
    s = s.replace(de, para);
  }
  return s;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create table public.alunos (id uuid primary key, situacao text);
    create table public.casos  (id uuid primary key default gen_random_uuid(), aluno_id uuid, situacao text);
    create table public.acordos (id uuid primary key, aluno_id uuid, status text);
    create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid, documento text);
    create table public.pagamentos (id uuid primary key default gen_random_uuid(), numero_parcela_completo text);
    create table public.parcelas (
      id uuid primary key, acordo_id uuid, numero int, valor numeric, vencimento date,
      status text, pago_em timestamptz, boleto text, observacao text);
    create table public._backup_completar_parcelas_lote (
      id bigint primary key, lote text, acordo_id uuid, acao text,
      parcela_id uuid, titulo_id uuid, titulo_snapshot jsonb);
    create table public._backup_parcelas_acordo_erro_import (id uuid, documento text);

    create sequence public.chamadas_recalc;
    create function public.recalcular_situacao_aluno(p uuid, o text) returns void language plpgsql as $$
      begin
        perform nextval('public.chamadas_recalc');
        update public.alunos set situacao = 'RECALCULADO' where id = p;
        update public.casos  set situacao = 'RECALCULADO' where aluno_id = p;
      end $$;
  `);
  await db.query(`create function public._trg_recalc_por_parcela() returns trigger language plpgsql security definer as $b$${CORPO_RECALC}$b$`);
  await db.query(`create function public._parcela_pago_em_automatico() returns trigger language plpgsql security definer as $b$${CORPO_PAGO_EM}$b$`);
  await db.exec(`
    create trigger trg_recalc_parcela after insert or delete or update on public.parcelas
      for each row execute function _trg_recalc_por_parcela();
    create trigger trg_parcela_pago_em_automatico before insert or update on public.parcelas
      for each row execute function _parcela_pago_em_automatico();
  `);
  // dados: suprime o trigger so durante a carga do fixture, para nascer limpo
  await db.exec(`alter table public.parcelas disable trigger trg_recalc_parcela`);
  await db.query(`insert into public.alunos values ($1,'ORIGINAL'),($2,'ORIGINAL'),($3,'ORIGINAL')`, [AL1, AL2, AL3]);
  await db.query(`insert into public.casos (aluno_id, situacao) values ($1,'ORIGINAL'),($2,'ORIGINAL'),($3,'ORIGINAL')`, [AL1, AL2, AL3]);
  await db.query(`insert into public.acordos values ($1,$2,'ATIVO'),($3,$4,'ATIVO'),($5,$6,'ATIVO')`, [AC1, AL1, AC2, AL2, AC3, AL3]);
  await db.query(`insert into public.acordos_titulos (aluno_id, documento) values ($1,'4000001'),($2,'4000002')`, [AL1, AL2]);
  await db.query(`insert into public.pagamentos (numero_parcela_completo) values ($1)`, [bol(CANDIDATAS[0].doc)]);
  const parcela = (id, ac, num, status, boleto) =>
    db.query(`insert into public.parcelas (id,acordo_id,numero,valor,status,boleto) values ($1,$2,$3,100,$4,$5)`,
      [id, ac, num, status, boleto]);
  await parcela(P(1), AC1, 1, "A_VENCER", null);        // candidata (1:1)
  await parcela(P(2), AC2, 1, "VENCIDA", null);         // candidata
  await parcela(P(3), AC2, 2, "PAGO", null);            // candidata PAGO, mas com pago_em (abaixo)
  await db.query(`update public.parcelas set pago_em = '2026-01-01' where id = $1`, [P(3)]);
  await parcela(P(4), AC3, 1, "A_VENCER", "59999990001"); // ja tem boleto -> fora
  await parcela(P(5), AC3, 2, "A_VENCER", null);        // colisao externa -> fora
  await parcela(P(6), AC3, 3, "A_VENCER", "50444440001"); // dona do boleto que colide
  await parcela(P(7), AC3, 4, "A_VENCER", null);        // sem procedencia -> fora
  const trilha = async (id, lote, ac, acao, pid, doc) =>
    db.query(`insert into public._backup_completar_parcelas_lote (id,lote,acordo_id,acao,parcela_id,titulo_snapshot)
              values ($1,$2,$3,$4,$5,$6)`, [id, lote, ac, acao, pid, doc ? JSON.stringify({ documento: doc }) : null]);
  for (const c of CANDIDATAS) {
    await trilha(c.bp, c.lote, c.acordo_id, "PARCELA_CRIADA", c.parcela_id, null);
    await trilha(c.bt, c.lote, c.acordo_id, "TITULO_QUARENTENA", null, c.doc);
  }
  await trilha(7, "L3", AC3, "PARCELA_CRIADA", P(4), null);      await trilha(8, "L3", AC3, "TITULO_QUARENTENA", null, "050333330001");
  await trilha(9, "L4", AC3, "PARCELA_CRIADA", P(5), null);      await trilha(10, "L4", AC3, "TITULO_QUARENTENA", null, "050444440001");
  await db.exec(`alter table public.parcelas enable trigger trg_recalc_parcela`);
  await db.exec(`alter sequence public.chamadas_recalc restart`);
  return db;
}

const chamadasRecalc = async (db) =>
  Number((await db.query(`select case when is_called then last_value else 0 end n from public.chamadas_recalc`)).rows[0].n);

async function retrato(db) {
  const q = async (s) => JSON.stringify((await db.query(s)).rows);
  return {
    parcelas: await q("select * from public.parcelas order by id"),
    alunos: await q("select * from public.alunos order by id"),
    casos: await q("select aluno_id, situacao from public.casos order by aluno_id"),
    triggers: await q(`select tgname, tgenabled::text e from pg_trigger
                        where tgrelid='public.parcelas'::regclass and not tgisinternal order by tgname`),
  };
}

async function falhaSemEfeito(db, sql, motivo) {
  const antes = await retrato(db);
  await expect(db.exec(sql)).rejects.toThrow(motivo);
  const depois = await retrato(db);
  expect(depois.parcelas, "parcelas mudou apesar do abort").toBe(antes.parcelas);
  expect(depois.alunos, "alunos mudou apesar do abort").toBe(antes.alunos);
  expect(depois.casos, "casos mudou apesar do abort").toBe(antes.casos);
  expect(depois.triggers, "estado de trigger mudou apesar do abort").toBe(antes.triggers);
}

// =============================================================================
describe("caminho feliz", () => {
  it("controle: SEM supressao, o duble de recalculo escreveria em alunos", async () => {
    const db = await novoBanco();
    await db.query(`update public.parcelas set boleto = 'x' where id = $1`, [P(1)]);
    const { rows } = await db.query(`select situacao from public.alunos where id = $1`, [AL1]);
    expect(rows[0].situacao).toBe("RECALCULADO");   // prova que o teste enxerga o recalculo
  });

  it("aplica: grava exatamente as candidatas, com o boleto da procedencia", async () => {
    const db = await novoBanco();
    await db.exec(migracao());
    const { rows } = await db.query(`select id, boleto from public.parcelas order by id`);
    const porId = Object.fromEntries(rows.map((r) => [r.id, r.boleto]));
    for (const c of CANDIDATAS) expect(porId[c.parcela_id]).toBe(bol(c.doc));
    expect(porId[P(4)]).toBe("59999990001");   // ja tinha: intocada
    expect(porId[P(5)]).toBeNull();            // colisao: fora
    expect(porId[P(6)]).toBe("50444440001");   // dona da colisao: intocada
    expect(porId[P(7)]).toBeNull();            // sem procedencia: fora
  });

  it("nao recalcula ninguem: recalcular_situacao_aluno nunca e chamado, alunos e casos intactos", async () => {
    const db = await novoBanco();
    const antes = await retrato(db);
    await db.exec(migracao());
    expect(await chamadasRecalc(db)).toBe(0);
    const depois = await retrato(db);
    expect(depois.alunos).toBe(antes.alunos);
    expect(depois.casos).toBe(antes.casos);
  });

  it("trigger termina habilitado, e nenhum outro trigger mudou", async () => {
    const db = await novoBanco();
    const antes = await retrato(db);
    await db.exec(migracao());
    expect((await retrato(db)).triggers).toBe(antes.triggers);
  });

  it("nenhuma coluna alem de boleto mudou em nenhuma parcela", async () => {
    const db = await novoBanco();
    const sem = async () => JSON.stringify((await db.query(
      `select id, acordo_id, numero, valor, vencimento, status, pago_em, observacao from public.parcelas order by id`)).rows);
    const antes = await sem();
    await db.exec(migracao());
    expect(await sem()).toBe(antes);
  });

  it("segunda execucao: 0 candidatas -> aborta, sem escrita", async () => {
    const db = await novoBanco();
    await db.exec(migracao());
    await falhaSemEfeito(db, migracao(), /0 candidatas/);
  });
});

// =============================================================================
describe("mutacoes: cada uma aborta antes de escrever e restaura tudo", () => {
  it("trigger ausente", async () => {
    const db = await novoBanco();
    await db.exec(`drop trigger trg_recalc_parcela on public.parcelas`);
    await falhaSemEfeito(db, migracao(), /ausente/);
  });

  it("trigger ja desabilitado", async () => {
    const db = await novoBanco();
    await db.exec(`alter table public.parcelas disable trigger trg_recalc_parcela`);
    await falhaSemEfeito(db, migracao(), /nao esta habilitado/);
  });

  it("definicao do trigger diferente", async () => {
    const db = await novoBanco();
    await db.exec(`drop trigger trg_recalc_parcela on public.parcelas;
      create trigger trg_recalc_parcela after update on public.parcelas
        for each row execute function _trg_recalc_por_parcela();`);
    await falhaSemEfeito(db, migracao(), /definicao do trigger/);
  });

  it("corpo da funcao do trigger alterado", async () => {
    const db = await novoBanco();
    await db.query(`create or replace function public._trg_recalc_por_parcela() returns trigger
      language plpgsql security definer as $b$${CORPO_RECALC} $b$`);
    await falhaSemEfeito(db, migracao(), /corpo de _trg_recalc_por_parcela mudou/);
  });

  it("tentativa de desabilitar mais de um trigger", async () => {
    const db = await novoBanco();
    const sql = migracao(FIXTURE, [[
      "alter table public.parcelas disable trigger trg_recalc_parcela;",
      "alter table public.parcelas disable trigger trg_recalc_parcela;\n  alter table public.parcelas disable trigger trg_parcela_pago_em_automatico;",
    ]]);
    await falhaSemEfeito(db, sql, /outro trigger de parcelas mudou de estado junto com o DISABLE/);
  });

  it("candidata PAGO sem pago_em", async () => {
    const db = await novoBanco();
    await db.exec(`alter table public.parcelas disable trigger trg_parcela_pago_em_automatico`);
    await db.query(`update public.parcelas set pago_em = null where id = $1`, [P(3)]);
    await db.exec(`alter table public.parcelas enable trigger trg_parcela_pago_em_automatico`);
    await falhaSemEfeito(db, migracao(), /PAGO sem pago_em/);
  });

  it("hash divergente", async () => {
    const db = await novoBanco();
    await falhaSemEfeito(db, migracao({ ...FIXTURE, hash: "0".repeat(64) }), /SHA256/);
  });

  it("quantidade aprovada uma a menos", async () => {
    const db = await novoBanco();
    await falhaSemEfeito(db, migracao({ ...FIXTURE, qtd: FIXTURE.qtd - 1 }), /candidatas, aprovado/);
  });

  it("quantidade aprovada uma a mais", async () => {
    const db = await novoBanco();
    await falhaSemEfeito(db, migracao({ ...FIXTURE, qtd: FIXTURE.qtd + 1 }), /candidatas, aprovado/);
  });

  it("colisao: boleto de uma candidata aparece em outra parcela", async () => {
    const db = await novoBanco();
    await db.exec(`alter table public.parcelas disable trigger trg_recalc_parcela`);
    await db.query(`update public.parcelas set boleto = $1 where id = $2`, [bol(CANDIDATAS[0].doc), P(7)]);
    await db.exec(`alter table public.parcelas enable trigger trg_recalc_parcela`);
    await falhaSemEfeito(db, migracao(), /candidatas, aprovado/);
  });

  it("boleto ja preenchido numa candidata", async () => {
    const db = await novoBanco();
    await db.exec(`alter table public.parcelas disable trigger trg_recalc_parcela`);
    await db.query(`update public.parcelas set boleto = '59999990002' where id = $1`, [P(2)]);
    await db.exec(`alter table public.parcelas enable trigger trg_recalc_parcela`);
    await falhaSemEfeito(db, migracao(), /candidatas, aprovado/);
  });

  it("par N/N+1 quebrado", async () => {
    const db = await novoBanco();
    await db.exec(`update public._backup_completar_parcelas_lote set id = 60 where id = 4`);
    await falhaSemEfeito(db, migracao(), /candidatas, aprovado/);
  });

  it("base mudou: contagem de nulos diferente da aprovada", async () => {
    const db = await novoBanco();
    await falhaSemEfeito(db, migracao({ ...FIXTURE, nulos: FIXTURE.nulos + 1 }), /base mudou/);
  });

  it("trigger nao reabilitado", async () => {
    const db = await novoBanco();
    const sql = migracao(FIXTURE, [[
      "alter table public.parcelas enable trigger trg_recalc_parcela;", "null;",
    ]]);
    await falhaSemEfeito(db, sql, /nao voltou a O/);
  });

  it("alteracao de coluna diferente de boleto", async () => {
    const db = await novoBanco();
    const sql = migracao(FIXTURE, [[
      "set boleto = c.boleto_novo", "set boleto = c.boleto_novo, numero = coalesce(p.numero,0) + 100",
    ]]);
    await falhaSemEfeito(db, sql, /alem de boleto mudou/);
  });

  it("supressao removida por inteiro: recalcular_situacao_aluno E CHAMADO e a migration reprova", async () => {
    const db = await novoBanco();
    // tira o DISABLE, a conferencia de estado D e o ENABLE: o trigger fica ligado
    // o tempo todo e todas as checagens de estado de trigger passam
    const sql = migracao(FIXTURE, [
      ["alter table public.parcelas disable trigger trg_recalc_parcela;", "null;"],
      ["if v_estado is distinct from 'D' then", "if false then"],
      ["alter table public.parcelas enable trigger trg_recalc_parcela;", "null;"],
    ]);
    expect(await chamadasRecalc(db)).toBe(0);
    await falhaSemEfeito(db, sql, /o recalculo rodou/);
    expect(await chamadasRecalc(db)).toBeGreaterThan(0);   // foi chamado de fato...
  });                                                         // ...e nada persistiu (falhaSemEfeito)

  it("so o DISABLE removido: aborta na conferencia de estado, antes do UPDATE e sem recalcular", async () => {
    const db = await novoBanco();
    const sql = migracao(FIXTURE, [["alter table public.parcelas disable trigger trg_recalc_parcela;", "null;"]]);
    await falhaSemEfeito(db, sql, /apos o DISABLE, trigger trg_recalc_parcela nao esta D/);
    expect(await chamadasRecalc(db)).toBe(0);
  });
});

// =============================================================================
describe("regressao tecnica: por que a prova NAO usa xmin", () => {
  it("escrita dentro de bloco `begin ... exception` recebe xid de SUBTRANSACAO, invisivel a xmin = xid principal", async () => {
    // Registro do aprendizado de 16/09/2026. `_trg_recalc_por_parcela` envolve o
    // recalculo exatamente num bloco assim. Uma prova por xmin do xid principal
    // teria aprovado a migration mesmo com o recalculo rodando. Por isso a
    // migration prova seguranca por ESTADO: trigger conferido em pg_trigger e
    // hash PRE/POS das linhas de alunos e casos.
    const db = new PGlite();
    await db.exec(`
      create table alvo (id int primary key, v text);
      insert into alvo select g, 'orig' from generate_series(1,3) g;
      create function escreve_em_subtx(p int) returns void language plpgsql as $$
        begin begin update alvo set v = 'subtx' where id = p; exception when others then null; end; end $$;`);
    await db.exec("begin");
    await db.exec("update alvo set v = 'principal' where id = 1");
    await db.exec("select escreve_em_subtx(2)");
    const { rows } = await db.query(`select
      (select count(*)::int from alvo where v <> 'orig') as escritas_reais,
      (select count(*)::int from alvo where xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text) as vistas_por_xmin`);
    await db.exec("commit");
    expect(rows[0].escritas_reais).toBe(2);
    expect(rows[0].vistas_por_xmin).toBe(1);   // perde a da subtransacao
  });
});
