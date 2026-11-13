// ACOES MASSIVAS: elegibilidade R5 integrada sobre a #941 (valor exigivel).
//
// Parte da definicao PUBLICADA (8f94a168) e aplica, nesta ordem:
//   1. 20261112235500 (#941: valor e faixa)            -> MD5 52f8ca6c...
//   2. 20261112235600 (R5: elegibilidade)               -> MD5 final (ver MD5_R5)
// Cobre: sem caso, caso encerrado antigo com saldo positivo, total_em_aberto nulo, caso aberto
// (comportamento preservado), R5 com cada evidencia de pagamento, vencimento futuro (F1) e valor.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, comoGestao, alunos, universo } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql");
const TIPO_PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql");
const MIG_941 = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.sql.pendente");
const MIG_R5 = ler("../aguardando_aprovacao/20261112235600_acoes_massivas_r5_sobre_valor.sql.pendente");
// Os testes aplicam so os patches da R5; a conferencia de MD5 final e feita por md5() abaixo.
const MIG_R5_SEM_GUARDA_FINAL = MIG_R5.split("-- 2. MD5 FINAL")[0] + "COMMIT;";
const MD5_941 = "52f8ca6c4e4428e9dc5d0912e2b9751a";
const MD5_R5 = "78e55b9a43598129831b18ff62e50e40";

const COLUNAS = `
  alter table public.acordos add column if not exists saldo numeric default 0;
  alter table public.parcelas add column if not exists boleto text;
  alter table public.parcelas add column if not exists boleto_confiavel boolean default false;
  alter table public.parcelas add column if not exists renegociada_no_acordo_id uuid;
  alter table public.parcelas add column if not exists pago_em timestamptz;
  alter table public.acordos_titulos add column if not exists documento text;
  alter table public.prime_extrato add column if not exists cpf text;
  alter table public.prime_extrato add column if not exists boleto text;
  alter table public.prime_extrato add column if not exists liquidado_em timestamptz;
  create table if not exists public.pagamentos (aluno_id uuid, numero_parcela_completo text,
    titulo_numero text, data_pagamento timestamptz, valor_pago numeric);`;

let db;
let seq = 0;

beforeEach(async () => {
  db = await novoBanco();
  await db.exec(COLUNAS);
  await db.exec(PUBLICADO);
  await db.exec(TIPO_PUBLICADO);
  await db.exec(MIG_941);
  await db.exec(MIG_R5_SEM_GUARDA_FINAL);
  await comoGestao(db);
  seq = 0;
});

const md5 = async () => (await db.query(
  "select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'")).rows[0].m;

// Aluno sem titulo de acordo (so entra pela parcela), dono e responsavel vazios.
async function aluno({ caso } = {}) {
  seq += 1;
  const [id] = await alunos(db, 1, { ini: 900 + seq, valor: 0 });
  await db.query("delete from public.acordos_titulos where aluno_id = $1", [id]);
  await db.query("delete from public.casos where aluno_id = $1", [id]);
  if (caso) {
    await db.query(
      `insert into public.casos (aluno_id, total_em_aberto, encerrado_operacional, operador_email, cpf_limpo)
       values ($1, $2, $3, null, '')`,
      [id, caso.total === undefined ? 500 : caso.total, caso.encerrado === true]);
  }
  return id;
}

async function acordo(alunoId, o = {}) {
  const r = await db.query(
    "insert into public.acordos (aluno_id, status, operador_responsavel_email, saldo) values ($1, $2, null, $3) returning id",
    [alunoId, o.status ?? "ATIVO", o.saldo === undefined ? 100 : o.saldo]);
  return r.rows[0].id;
}

// Parcela VENCIDA com boleto confiavel por padrao (a evidencia que o R5 exige).
async function parcela(acordoId, o = {}) {
  seq += 1;
  const boleto = o.boleto === undefined ? `BOL${seq}` : o.boleto;
  await db.query(
    `insert into public.parcelas (acordo_id, status, vencimento, valor, boleto, boleto_confiavel, renegociada_no_acordo_id, pago_em)
     values ($1, 'VENCIDA', current_date + $2::int, $3, $4, $5, $6, $7)`,
    [acordoId, o.dias ?? -20, o.v ?? 320, boleto, o.conf ?? true, o.renegociada ?? null, o.pago ?? null]);
  return boleto;
}

// Aluno que so tem parcela vencida com evidencia R5 completa.
async function alunoR5(caso, opts = {}) {
  const id = await aluno({ caso });
  const ac = await acordo(id, opts.acordo);
  await parcela(ac, opts.parcela);
  return id;
}

const linha = (rows, id) => rows.find((r) => r.aluno_id === id);
const disponivel = (rows, id) => linha(rows, id)?.disponivel === true;
const valor = (rows, id) => Number(linha(rows, id)?.valor);
const ACORDOS = { operador: "todos", tipo_cobranca: "ACORDOS_VENCIDOS" };
const JUNTO = { operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS" };

describe("integracao R5 sobre a #941", () => {
  it("MD5 final confere com o pacote", async () => {
    expect(await md5()).toBe(MD5_R5);
  });

  it("base de origem e a #941 (52f8ca6c...)", async () => {
    // a #941 ja esta aplicada no beforeEach; o MD5 final da R5 e checado acima
    expect(MIG_941.includes(MD5_941)).toBe(true);
  });

  describe("sem caso", () => {
    it("aluno sem caso com evidencia R5 completa ENTRA (cobertura de quem nao tem ficha)", async () => {
      const id = await alunoR5(null);
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(true);
    });

    it("aluno sem caso com boleto NAO confiavel fica FORA", async () => {
      const id = await aluno();
      await parcela(await acordo(id), { conf: false });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("aluno sem caso com pagamento desde o vencimento (-10 dias) fica FORA", async () => {
      const id = await alunoR5(null);
      await db.query("insert into public.pagamentos (aluno_id, data_pagamento, valor_pago) values ($1, now() - interval '5 days', 50)", [id]);
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });
  });

  describe("caso ENCERRADO antigo com saldo positivo", () => {
    it("NAO autoriza: parcela sem evidencia R5 continua FORA", async () => {
      const id = await aluno({ caso: { total: 500, encerrado: true } });
      await parcela(await acordo(id), { conf: false });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("com evidencia R5 completa ENTRA, mas pela evidencia e nao pelo caso", async () => {
      const id = await alunoR5({ total: 500, encerrado: true });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(true);
    });
  });

  describe("total_em_aberto nulo", () => {
    it("caso aberto com total NULO nao autoriza parcela sem evidencia R5", async () => {
      const id = await aluno({ caso: { total: null } });
      await parcela(await acordo(id), { conf: false });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("total NULO com evidencia R5 completa ENTRA", async () => {
      const id = await alunoR5({ total: null });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(true);
    });
  });

  describe("caso ABERTO (comportamento preservado)", () => {
    it("caso aberto com total positivo continua autorizando parcela sem evidencia R5", async () => {
      const id = await aluno({ caso: { total: 500, encerrado: false } });
      await parcela(await acordo(id), { conf: false });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(true);
    });
  });

  describe("evidencias R5 (criterio aprovado em 12/11)", () => {
    it("saldo zero no acordo fica FORA", async () => {
      const id = await alunoR5(null, { acordo: { saldo: 0 } });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("parcela renegociada fica FORA", async () => {
      const id = await aluno();
      await parcela(await acordo(id), { renegociada: "00000000-0000-4000-9000-000000000001" });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("pagamento que casa com o boleto da parcela fica FORA", async () => {
      const id = await aluno();
      const b = await parcela(await acordo(id));
      await db.query("insert into public.pagamentos (aluno_id, numero_parcela_completo, data_pagamento, valor_pago) values ($1, $2, now() - interval '100 days', 100)", [id, b]);
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("Prime liquidou o mesmo CPF desde o vencimento fica FORA", async () => {
      const id = await aluno();
      await db.query("update public.alunos set cpf = '11122233344' where id = $1", [id]);
      await parcela(await acordo(id));
      await db.query("insert into public.prime_extrato (cpf, boleto, liquidado_em) values ('11122233344', 'OUTRO', now() - interval '3 days')");
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("parcela gemea (vencimento a 5 dias) ja paga fica FORA", async () => {
      const id = await aluno();
      const ac = await acordo(id);
      await parcela(ac, { dias: -20 });
      await db.query(
        `insert into public.parcelas (acordo_id, status, vencimento, valor, boleto, pago_em) values ($1, 'PAGA', current_date - 16, 320, 'GEMEA', now())`, [ac]);
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });
  });

  describe("vencimento (F1) e valor", () => {
    it("parcela VENCIDA com vencimento futuro nao autoriza, mesmo com evidencia", async () => {
      const id = await aluno();
      await parcela(await acordo(id), { dias: 10 });
      expect(disponivel(await universo(db, ACORDOS), id)).toBe(false);
    });

    it("valor do aluno R5 = so as parcelas vencidas (valor nao muda com a R5)", async () => {
      const id = await alunoR5(null, { parcela: { v: 320 } });
      expect(valor(await universo(db, ACORDOS), id)).toBe(320);
    });

    it("valor nao depende do total_em_aberto do caso", async () => {
      const id = await alunoR5({ total: 0 }, { parcela: { v: 320 } });
      expect(valor(await universo(db, ACORDOS), id)).toBe(320);
      expect(valor(await universo(db, JUNTO), id)).toBe(320);
    });
  });
});
