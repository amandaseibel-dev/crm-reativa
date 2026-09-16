// BOLETO DA PARCELA NA IMPORTACAO -- COMPORTAMENTO, nao estrutura.
//
// Executa a funcao real num PostgreSQL real (PGlite) e observa o que ela grava.
// Existe porque a camada estrutural ja deixou passar falha real neste projeto:
// texto certo com efeito errado.
//
// O QUE ESTE TESTE PROVA: `linha-fonte.documento -> parcela criada.boleto`.
// O QUE ELE NAO PROVA, DE PROPOSITO: que `parcelas.numero` esteja correto. A
// numeracao permanece como estava para a funcao seguir funcionando, mas NUNCA
// e usada como evidencia -- os pares documento->boleto sao conferidos por
// identidade do documento, jamais por "0001 virou parcela 1".
//
// NENHUM DADO REAL: todo CPF, documento e valor aqui e inventado.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(AQUI, "..", "..",
  "supabase/migrations/20260915200000_preserva_boleto_da_parcela_na_importacao.sql");
const sqlMigration = readFileSync(MIG, "utf8");

const ESQUEMA = `
create table public.acordos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, numero_acordo bigint,
  valor_total numeric, status text);
create table public.acordos_titulos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, cpf text, documento text,
  vencimento date, valor_original numeric, saldo_corrigido numeric, situacao text,
  tipo_boleto text, dados jsonb, importacao_id uuid, created_at timestamp default now(),
  status text default 'em_aberto', valor_em_aberto numeric, competencia text,
  motivo_ajuste text, atualizado_em timestamptz, acordo_id uuid,
  vinculado_em timestamptz, vinculado_por text);
create table public.parcelas (
  id uuid primary key, acordo_id uuid, numero int, valor numeric, vencimento date,
  status text, is_entrada boolean, boleto text, observacao text,
  criado_em timestamptz, atualizado_em timestamptz);
create table public._backup_completar_parcelas_lote (
  id uuid primary key default gen_random_uuid(), lote text, acordo_id uuid, acao text,
  parcela_id uuid, titulo_id uuid, titulo_snapshot jsonb, executado_por text,
  executado_em timestamptz default now());
create table public._backup_parcelas_acordo_erro_import (
  id uuid, aluno_id uuid, cpf text, documento text, vencimento date, valor_original numeric,
  saldo_corrigido numeric, situacao text, tipo_boleto text, dados jsonb, importacao_id uuid,
  created_at timestamp, status text, valor_em_aberto numeric, competencia text,
  motivo_ajuste text, atualizado_em timestamptz, acordo_id uuid, vinculado_em timestamptz,
  vinculado_por text);
create function public._gate_completar_parcelas() returns boolean
  language sql as $$ select true $$;
`;

const ALUNO = "11111111-1111-1111-1111-111111111111";
// documentos de 12 digitos: 050 + acordo(65001) + parcela(0001..)
const DOCS = Array.from({ length: 10 }, (_, i) => "05065001" + String(i + 1).padStart(4, "0"));
const VALOR = 239.13;

async function novoBanco() {
  const db = new PGlite();
  await db.exec(ESQUEMA);
  await db.exec(sqlMigration);
  return db;
}
async function semear(db, { docs = DOCS, valorTotal = null } = {}) {
  const total = valorTotal ?? Number((VALOR * docs.length).toFixed(2));
  await db.query(`insert into public.acordos (id,aluno_id,numero_acordo,valor_total,status)
                  values (gen_random_uuid(), $1, 65001, $2, 'ATIVO')`, [ALUNO, total]);
  for (const [i, d] of docs.entries()) {
    await db.query(`insert into public.acordos_titulos (aluno_id,documento,vencimento,valor_original,situacao,tipo_boleto)
                    values ($1,$2,$3,$4,'ABERTO','Acordo')`,
      [ALUNO, d, `2027-0${(i % 9) + 1}-16`, VALOR]);
  }
}
const rodar = (db, dry = false) =>
  db.query(`select * from public.completar_parcelas_acordo(100, $1, 'LOTE_TESTE', 'teste')`, [dry]);

describe("o boleto vem da propria linha-fonte", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await semear(db); });

  it("toda parcela criada tem boleto preenchido", async () => {
    await rodar(db);
    const { rows } = await db.query("select count(*)::int n, count(boleto)::int com from public.parcelas");
    expect(rows[0].n).toBe(10);
    expect(rows[0].com).toBe(10);
  });

  it("o conjunto de boletos e exatamente o ltrim dos documentos-fonte", async () => {
    await rodar(db);
    const { rows } = await db.query("select boleto from public.parcelas order by boleto");
    const esperado = DOCS.map((d) => d.replace(/^0+/, "")).sort();
    expect(rows.map((r) => r.boleto).sort()).toEqual(esperado);
  });

  it("grava 11 digitos comecando com 5, nunca os 12 do documento", async () => {
    await rodar(db);
    const { rows } = await db.query("select boleto from public.parcelas");
    for (const r of rows) {
      expect(r.boleto).toMatch(/^5\d{10}$/);
      expect(DOCS).not.toContain(r.boleto);            // nao e o documento cru
    }
  });

  it("cada parcela carrega o boleto do titulo que a originou -- conferido pelo documento no backup, nao pelo numero", async () => {
    await rodar(db);
    const { rows } = await db.query(`
      select q.documento, p.boleto
        from public._backup_completar_parcelas_lote b
        join public._backup_parcelas_acordo_erro_import q on q.id = b.titulo_id
        join public.parcelas p on p.boleto = ltrim(q.documento,'0')
       where b.acao = 'TITULO_QUARENTENA'`);
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(r.boleto).toBe(r.documento.replace(/^0+/, ""));
  });

  it("a ordem dos titulos nao altera o par documento->boleto", async () => {
    const db2 = await novoBanco();
    await semear(db2, { docs: [...DOCS].reverse() });
    await rodar(db2);
    const { rows } = await db2.query("select boleto from public.parcelas order by boleto");
    expect(rows.map((r) => r.boleto).sort()).toEqual(DOCS.map((d) => d.replace(/^0+/, "")).sort());
  });
});

describe("o comportamento anterior nao mudou", () => {
  it("dry-run continua sem gravar nada", async () => {
    const db = await novoBanco(); await semear(db);
    const r = await rodar(db, true);
    expect(r.rows[0].acao).toBe("DRY_RUN");
    const { rows } = await db.query("select count(*)::int n from public.parcelas");
    expect(rows[0].n).toBe(0);
  });

  it("acordo que ja tem parcela nao e alvo -- nada e atualizado", async () => {
    const db = await novoBanco(); await semear(db);
    const { rows: [a] } = await db.query("select id from public.acordos limit 1");
    await db.query(`insert into public.parcelas (id,acordo_id,numero,valor,boleto)
                    values (gen_random_uuid(), $1, 1, 1, 'JA_EXISTIA')`, [a.id]);
    await rodar(db);
    const { rows } = await db.query("select count(*)::int n from public.parcelas");
    expect(rows[0].n).toBe(1);
    const { rows: b } = await db.query("select boleto from public.parcelas");
    expect(b[0].boleto).toBe("JA_EXISTIA");
  });

  it("a guarda de divergencia continua abortando", async () => {
    const db = await novoBanco();
    await semear(db, { valorTotal: 9999.99 });
    const { rows } = await db.query("select count(*)::int n from public.parcelas");
    expect(rows[0].n).toBe(0);                          // nem entra no alvo: soma != valor_total
  });

  it("os dois backups continuam sendo gravados", async () => {
    const db = await novoBanco(); await semear(db); await rodar(db);
    const { rows: l } = await db.query(
      "select acao, count(*)::int n from public._backup_completar_parcelas_lote group by acao order by acao");
    expect(l).toEqual([{ acao: "PARCELA_CRIADA", n: 10 }, { acao: "TITULO_QUARENTENA", n: 10 }]);
    const { rows: q } = await db.query("select count(*)::int n from public._backup_parcelas_acordo_erro_import");
    expect(q[0].n).toBe(10);
  });

  it("o titulo sai de acordos_titulos, como antes", async () => {
    const db = await novoBanco(); await semear(db); await rodar(db);
    const { rows } = await db.query("select count(*)::int n from public.acordos_titulos");
    expect(rows[0].n).toBe(0);
  });

  it("o gate nega quando falso", async () => {
    const db = await novoBanco(); await semear(db);
    await db.exec("create or replace function public._gate_completar_parcelas() returns boolean language sql as $$ select false $$;");
    await expect(rodar(db)).rejects.toThrow(/Acesso negado/);
  });
});
