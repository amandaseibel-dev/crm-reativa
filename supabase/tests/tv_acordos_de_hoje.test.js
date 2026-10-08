// ACORDOS DE HOJE — as duas definições, executadas no banco.
//
// O que estes casos travam, em Postgres de verdade (pglite) com a migration
// REAL 20261008120000:
//
//   1. "fechado hoje" = criado_em no fuso de SÃO PAULO. Um acordo criado às
//      02:00 UTC de amanhã ainda é HOJE em São Paulo — e um criado às 23:00
//      UTC de hoje já é AMANHÃ lá. Rodar com `current_date` erraria os dois.
//   2. duplicado e cancelado NÃO contam.
//   3. "convertido" = pagamento real em `pagamentos`, casado pelo boleto, com
//      data_pagamento >= o dia do acordo. Pagamento ANTERIOR não conta: é
//      registro retroativo, e em 45 dias de produção 171 dos 526 acordos pagos
//      eram exatamente isso.
//   4. `parcelas.status = 'PAGA'` sem pagamento real NÃO converte.
//   5. quem está em tv_equipe_oculta não aparece no ranking.
//   6. nenhum pagamento é contado duas vezes.
//
// NENHUM DADO REAL de aluno.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20261008120000_tv_acordos_de_hoje.sql");

const OLGA = "cobranca03@aelbra.com.br";
const ALLAN = "cobranca10@aelbra.com.br";
const NATALY = "cobranca05@aelbra.com.br";

// Andaime: as tabelas que a chave nova lê, mais um tv_snapshot_atualizar no
// formato de produção — com a âncora do v_ms, o filtro de equipe oculta e a
// chave magic, que o patch exige encontrar antes de mexer.
const ANDAIME = `
create table public.tv_snapshot (id boolean primary key default true, versao bigint not null default 0,
  payload jsonb, status text, gerado_em timestamptz, duracao_ms int);
create table public.tv_equipe_oculta (email text primary key, nome text not null);
create table public.magic_number_mensal (mes_referencia text primary key, valor numeric);
create table public.usuarios (email text primary key, nome text);
create table public.acordos (id uuid primary key default gen_random_uuid(), criado_em timestamptz,
  status text, duplicado_de uuid, operador_responsavel_email text);
create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
  boleto text, status text);
create table public.pagamentos (id uuid primary key default gen_random_uuid(),
  numero_parcela_completo text, valor_pago numeric, data_pagamento date);

insert into public.tv_equipe_oculta(email, nome) values ('${OLGA}', 'OLGA');
insert into public.usuarios(email, nome) values
  ('${ALLAN}','Allan'), ('${NATALY}','Nataly'), ('${OLGA}','Olga');

create or replace function public.tv_snapshot_calcular()
returns jsonb language sql security definer set search_path to 'public'
as $f$ select jsonb_build_object('mes', jsonb_build_object('honorarios', 0)) $f$;

create or replace function public.tv_snapshot_atualizar()
returns jsonb language plpgsql security definer set search_path to 'public'
set statement_timeout to '30s' as $function$
declare v_t0 timestamptz; v_ms int; v_payload jsonb;
begin
  insert into public.tv_snapshot (id) values (true) on conflict (id) do nothing;
  v_t0 := clock_timestamp();
  v_payload := public.tv_snapshot_calcular();

  v_payload := v_payload || jsonb_build_object('magic',
    (select jsonb_build_object('valor', round(mn.valor)::bigint) from public.magic_number_mensal mn limit 1));

  v_payload := v_payload || jsonb_build_object('playlist_reativa', '[]'::jsonb);
  -- marcador do filtro de equipe oculta, que o patch exige encontrar
  v_payload := v_payload || jsonb_build_object('oculta_ok',
    (select count(*) from public.tv_equipe_oculta));

    v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));

  update public.tv_snapshot set versao = versao + 1, payload = v_payload,
         status = 'ok', duracao_ms = v_ms where id = true;
  return jsonb_build_object('status','ok');
end;
$function$;
`;

const hojeSP = `(now() at time zone 'America/Sao_Paulo')::date`;

async function novoBanco() {
  const db = new PGlite();
  await db.exec(ANDAIME);
  await db.exec(MIGRATION);
  return db;
}

async function payload(db) {
  await db.query("select public.tv_snapshot_atualizar()");
  const r = await db.query("select payload from public.tv_snapshot where id = true");
  return r.rows[0].payload.acordos_hoje;
}

// cria um acordo hoje (SP) e devolve o id
async function acordo(db, { dono = ALLAN, status = "ATIVO", duplicado = false, offset = "0 hours" } = {}) {
  const r = await db.query(
    `insert into public.acordos (criado_em, status, operador_responsavel_email, duplicado_de)
     values ((${hojeSP} + time '12:00') at time zone 'America/Sao_Paulo' + $1::interval, $2, $3,
             case when $4 then gen_random_uuid() else null end)
     returning id`, [offset, status, dono, duplicado]);
  return r.rows[0].id;
}

async function parcelaComPagamento(db, acordoId, { boleto, diasPagamento, statusParcela = "A_VENCER", semPagamento = false, valor = 1000 }) {
  await db.query("insert into public.parcelas(acordo_id, boleto, status) values ($1,$2,$3)",
    [acordoId, boleto, statusParcela]);
  if (!semPagamento) {
    await db.query(
      `insert into public.pagamentos(numero_parcela_completo, valor_pago, data_pagamento)
       values ($1, $2, ${hojeSP} + ($3 || ' days')::interval)`, [boleto, valor, String(diasPagamento)]);
  }
}

let db;
beforeAll(async () => { db = await novoBanco(); });

describe("fechado hoje", () => {
  it("conta acordo criado hoje no fuso de São Paulo", async () => {
    const b = await novoBanco();
    await acordo(b, {});
    const p = await payload(b);
    expect(p.fechados).toBe(1);
    await b.close();
  });

  it("23:00 em São Paulo ainda é hoje, mesmo já sendo amanhã em UTC", async () => {
    const b = await novoBanco();
    await b.query(`insert into public.acordos (criado_em, status, operador_responsavel_email)
      values ((${hojeSP} + time '23:30') at time zone 'America/Sao_Paulo', 'ATIVO', $1)`, [ALLAN]);
    const p = await payload(b);
    expect(p.fechados).toBe(1);
    expect(p.data).toBe((await b.query(`select to_char(${hojeSP},'YYYY-MM-DD') d`)).rows[0].d);
    await b.close();
  });

  it("acordo de ontem não entra", async () => {
    const b = await novoBanco();
    await b.query(`insert into public.acordos (criado_em, status, operador_responsavel_email)
      values ((${hojeSP} - 1 + time '12:00') at time zone 'America/Sao_Paulo', 'ATIVO', $1)`, [ALLAN]);
    expect((await payload(b)).fechados).toBe(0);
    await b.close();
  });

  it("duplicado e cancelado não contam", async () => {
    const b = await novoBanco();
    await acordo(b, {});
    await acordo(b, { duplicado: true });
    await acordo(b, { status: "CANCELADO" });
    expect((await payload(b)).fechados).toBe(1);
    await b.close();
  });
});

describe("convertido em pagamento", () => {
  it("pagamento no dia do acordo conta", async () => {
    const b = await novoBanco();
    const a = await acordo(b, {});
    await parcelaComPagamento(b, a, { boleto: "B1", diasPagamento: 0, valor: 1500 });
    const p = await payload(b);
    expect(p.convertidos).toBe(1);
    expect(Number(p.valor_pago)).toBe(1500);
    expect(Number(p.taxa_pct)).toBe(100);
    await b.close();
  });

  it("pagamento ANTERIOR ao acordo NÃO conta — é registro retroativo", async () => {
    const b = await novoBanco();
    const a = await acordo(b, {});
    await parcelaComPagamento(b, a, { boleto: "B2", diasPagamento: -3, valor: 999 });
    const p = await payload(b);
    expect(p.fechados).toBe(1);
    expect(p.convertidos).toBe(0);
    expect(Number(p.valor_pago)).toBe(0);
    expect(Number(p.taxa_pct)).toBe(0);
    await b.close();
  });

  it("parcela marcada PAGA sem pagamento real não converte", async () => {
    const b = await novoBanco();
    const a = await acordo(b, {});
    await parcelaComPagamento(b, a, { boleto: "B3", statusParcela: "PAGA", semPagamento: true });
    const p = await payload(b);
    expect(p.fechados).toBe(1);
    expect(p.convertidos).toBe(0);
    await b.close();
  });

  it("parcela sem boleto não casa com pagamento nenhum", async () => {
    const b = await novoBanco();
    const a = await acordo(b, {});
    await b.query("insert into public.parcelas(acordo_id, boleto) values ($1, null)", [a]);
    await b.query(`insert into public.pagamentos(numero_parcela_completo, valor_pago, data_pagamento)
      values (null, 500, ${hojeSP})`);
    expect((await payload(b)).convertidos).toBe(0);
    await b.close();
  });

  it("duas parcelas pagas do MESMO acordo contam um acordo e somam os dois valores", async () => {
    const b = await novoBanco();
    const a = await acordo(b, {});
    await parcelaComPagamento(b, a, { boleto: "C1", diasPagamento: 0, valor: 300 });
    await parcelaComPagamento(b, a, { boleto: "C2", diasPagamento: 0, valor: 200 });
    const p = await payload(b);
    expect(p.fechados).toBe(1);
    expect(p.convertidos).toBe(1);
    expect(Number(p.valor_pago)).toBe(500);
    await b.close();
  });
});

describe("ranking por operador", () => {
  it("usa operador_responsavel_email e traz fechados, convertidos e valor", async () => {
    const b = await novoBanco();
    const a1 = await acordo(b, { dono: ALLAN });
    await acordo(b, { dono: ALLAN });
    const a3 = await acordo(b, { dono: NATALY });
    await parcelaComPagamento(b, a1, { boleto: "R1", diasPagamento: 0, valor: 800 });
    await parcelaComPagamento(b, a3, { boleto: "R2", diasPagamento: 0, valor: 400 });

    const p = await payload(b);
    const allan = p.ranking.find((r) => r.operador === "Allan");
    const nataly = p.ranking.find((r) => r.operador === "Nataly");
    expect(allan).toEqual({ operador: "Allan", fechados: 2, convertidos: 1, valor_pago: 800 });
    expect(nataly).toEqual({ operador: "Nataly", fechados: 1, convertidos: 1, valor_pago: 400 });
    await b.close();
  });

  it("quem está em tv_equipe_oculta NÃO aparece no ranking", async () => {
    const b = await novoBanco();
    await acordo(b, { dono: OLGA });
    await acordo(b, { dono: ALLAN });
    const p = await payload(b);
    expect(JSON.stringify(p.ranking).toUpperCase()).not.toContain("OLGA");
    expect(p.ranking.map((r) => r.operador)).toContain("Allan");
    await b.close();
  });

  it("mas o TOTAL continua somando todo mundo — número sem nome não esconde operação", async () => {
    const b = await novoBanco();
    await acordo(b, { dono: OLGA });
    await acordo(b, { dono: ALLAN });
    const p = await payload(b);
    expect(p.fechados).toBe(2);
    expect(p.ranking).toHaveLength(1);
    await b.close();
  });

  it("acordo sem dono aparece como Sem responsável", async () => {
    const b = await novoBanco();
    await acordo(b, { dono: null });
    const p = await payload(b);
    expect(p.ranking.map((r) => r.operador)).toContain("Sem responsável");
    await b.close();
  });
});

describe("dia vazio e idempotência", () => {
  it("sem acordo nenhum, devolve zeros e taxa nula — não 0%", async () => {
    const b = await novoBanco();
    const p = await payload(b);
    expect(p.fechados).toBe(0);
    expect(p.convertidos).toBe(0);
    expect(Number(p.valor_pago)).toBe(0);
    expect(p.taxa_pct).toBeNull();
    expect(p.ranking).toEqual([]);
    await b.close();
  });

  it("rodar a migration de novo não duplica a chave nem derruba o que já existia", async () => {
    const def = async () => (await db.query(`
      select pg_get_functiondef(p.oid) src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='tv_snapshot_atualizar'`)).rows[0].src;
    const antes = await def();
    await db.exec(MIGRATION);
    const depois = await def();
    expect(depois).toBe(antes);
    expect(depois).toContain("tv_equipe_oculta");
    expect(depois).toContain("magic_number_mensal");
  });

  it("sem a âncora, aborta sem alterar nada", async () => {
    const b = new PGlite();
    await b.exec(ANDAIME);
    await b.exec(`create or replace function public.tv_snapshot_atualizar()
      returns jsonb language sql security definer set search_path to 'public'
      as $f$ select '{}'::jsonb $f$;`);
    await expect(b.exec(MIGRATION)).rejects.toThrow(/ancora|estado inesperado/i);
    await b.close();
  });
});

describe("rollback", () => {
  it("tira a chave e preserva o filtro de equipe oculta e a chave magic", async () => {
    const b = await novoBanco();
    await acordo(b, {});
    expect((await payload(b)).fechados).toBe(1);

    await b.exec(ler("supabase/rollbacks/20261008120000_tv_acordos_de_hoje.rollback.sql"));

    await b.query("select public.tv_snapshot_atualizar()");
    const r = await b.query("select payload from public.tv_snapshot where id = true");
    expect(r.rows[0].payload.acordos_hoje).toBeUndefined();

    const src = (await b.query(`select pg_get_functiondef(p.oid) src from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tv_snapshot_atualizar'`)).rows[0].src;
    expect(src).toContain("tv_equipe_oculta");
    expect(src).toContain("magic_number_mensal");
    await b.close();
  });
});
