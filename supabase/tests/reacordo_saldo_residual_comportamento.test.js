// RE-ACORDO: MENSALIDADE NEGOCIADA DE ACORDO CANCELADO VOLTA A SER
// RENEGOCIAVEL, SO PELO SALDO RESIDUAL DETERMINISTICO -- COMPORTAMENTO.
//
// Continuacao de acordo_cancelado_nao_reabre_mensalidade_comportamento.test.js.
// Roda as migrations REAIS (20260922260000 + 20260922270000) num PostgreSQL
// real (PGlite), sobre a mesma bancada minima daquele arquivo, acrescida do
// que vincular_titulos_acordo/acordo_saldo_residual precisam: auditoria,
// acordo_avista_porta_interna (dublado false -- so importa a porta humana
// aqui) e o indice parcial que faz a regra "um vinculo ativo por titulo"
// valer de verdade.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATION_1 = ler("supabase/migrations/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql");
const ROLLBACK_B = ler("supabase/rollbacks/20260922270000_reacordo_saldo_residual_deterministico.rollback.sql");
const MIGRATION_2 = ler("supabase/migrations/20260922270000_reacordo_saldo_residual_deterministico.sql");

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.email() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email' $$;

    create sequence public.acordos_numero_acordo_seq;
    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric, qtd_parcelas int default 1, saldo numeric,
      numero_acordo bigint default nextval('public.acordos_numero_acordo_seq'), numero_ulbra text,
      motivo_ajuste text, criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      documento text, valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
      situacao text, status text,
      tipo_boleto text default 'Cursos de Graduação', acordo_id uuid, motivo_ajuste text,
      vinculado_em timestamptz, vinculado_por text, atualizado_em timestamptz default now());

    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text,
      criado_em timestamptz default now());
    create unique index ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo;

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      status text default 'A_VENCER', valor numeric, atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);

    create table public.auditoria (id uuid primary key default gen_random_uuid(), usuario text, acao text,
      tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamptz default now());

    create function public.acordo_avista_porta_interna() returns boolean language sql stable as $$ select false $$;

    create table public._chamadas_liberar_evento (aluno_id uuid, evento text, registrado_em timestamptz default now());
    create function public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text,
        p_valor_pago numeric default null, p_data_pagamento date default current_date)
      returns void language plpgsql as $$
      begin insert into public._chamadas_liberar_evento (aluno_id, evento) values (p_aluno_id, p_evento); end $$;

    create function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $$ select true $$;

    create function public._acordo_status_reavalia_titulos() returns trigger
      language plpgsql security definer set search_path to 'public' as $$
      declare v_titulo uuid;
      begin
        for v_titulo in
          select distinct t.id from public.acordos_titulos t where t.acordo_id = new.id
          union
          select distinct v.titulo_id from public.acordo_titulo_vinculo v where v.acordo_id = new.id
        loop
          perform public.titulo_reavaliar(v_titulo);
        end loop;
        return null;
      end $$;

    create function public.titulo_situacao_por_vinculo() returns trigger
      language plpgsql security definer set search_path to 'public' as $$
      declare v_titulo uuid;
      begin
        foreach v_titulo in array
          array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
        loop
          perform public.titulo_reavaliar(v_titulo);
        end loop;
        return coalesce(new, old);
      end $$;

    create function public._titulo_situacao_e_status_coerentes() returns trigger
      language plpgsql set search_path to 'public' as $$
      declare v_sit text; v_st text;
      begin
        v_sit := upper(coalesce(new.situacao,''));
        v_st  := lower(coalesce(new.status,''));
        if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
          new.situacao := 'PAGO'; v_sit := 'PAGO';
        end if;
        if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
          new.status := 'quitada';
        elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
          new.status := 'em_aberto';
        elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
          new.status := 'vinculada';
        elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
          new.status := 'cancelada';
        end if;
        return new;
      end $$;
  `);

  await db.exec(MIGRATION_1);
  await db.exec(MIGRATION_2);

  await db.exec(`
    create trigger trg_acordo_status_reavalia_titulos after update of status on public.acordos
      for each row when (upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
      execute function _acordo_status_reavalia_titulos();
    create trigger trg_titulos_por_status_acordo after update of status on public.acordos
      for each row execute function titulos_por_status_acordo();
    create trigger trg_titulo_situacao_por_vinculo after insert or delete or update on public.acordo_titulo_vinculo
      for each row execute function titulo_situacao_por_vinculo();
    create trigger trg_titulo_situacao_status_coerentes before insert or update of situacao, status
      on public.acordos_titulos for each row execute function _titulo_situacao_e_status_coerentes();
  `);
  return db;
}

const A = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const comoGestao = (db, email = "amanda.seibel@aelbra.com.br") =>
  db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email, role: "authenticated" })]);

async function acordoFn(db, aluno_id, { status = "ATIVO", valor_total = 1000, qtd_parcelas = 1 } = {}) {
  return um(db, `insert into public.acordos (aluno_id, status, valor_total, qtd_parcelas)
                 values ($1,$2,$3,$4) returning id`, [aluno_id, status, valor_total, qtd_parcelas]);
}
async function titulo(db, aluno_id, { situacao = "ABERTO", status = "em_aberto", valor_original = 1000,
    valor_em_aberto = 1000, acordo_id = null } = {}) {
  return um(db, `insert into public.acordos_titulos (aluno_id, situacao, status, valor_original, valor_em_aberto, acordo_id)
                 values ($1,$2,$3,$4,$5,$6) returning id`, [aluno_id, situacao, status, valor_original, valor_em_aberto, acordo_id]);
}
async function negociar(db, tituloId, acordoId) {
  await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por)
                  values ($1,$2,true,'teste')`, [acordoId, tituloId]);
  await db.query(`update public.acordos_titulos set situacao='NEGOCIADO', status='vinculada', acordo_id=$2
                  where id=$1`, [tituloId, acordoId]);
}
async function parcela(db, acordoId, status, valor) {
  return um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,$2,$3) returning id`, [acordoId, status, valor]);
}
const estado = async (db, tituloId) => {
  const l = await um(db, `select to_jsonb(t) from public.acordos_titulos t where id=$1`, [tituloId]);
  return { situacao: l.situacao, status: l.status, acordo_id: l.acordo_id };
};
const residual = (db, acordoId) => um(db, `select public.acordo_saldo_residual($1)`, [acordoId]);
const vincular = (db, ids, acordoId) => um(db, `select public.vincular_titulos_acordo($1::uuid[], $2)`, [ids, acordoId]);
const vinculosDe = (db, tituloId) => um(db, `select coalesce(jsonb_agg(jsonb_build_object(
    'acordo', v.acordo_id, 'ativo', v.ativo) order by v.criado_em), '[]'::jsonb)
  from public.acordo_titulo_vinculo v where v.titulo_id = $1`, [tituloId]);

// Constroi um acordo ja CANCELADO com o titulo NEGOCIADO preso a ele --
// exatamente o estado final que 20260922260000 passa a preservar. Nao chama
// cancelar_acordo_ficha porque a RPC viva RECUSA cancelar acordo com parcela
// paga ("protege o historico financeiro") -- e os cenarios B/E (pagamento
// parcial antes do cancelamento) sao estados que hoje so existem em producao
// por outro caminho (a RPC morta acordo_cancelar, ou correcao manual). Por
// isso a sequencia abaixo e a mesma ordem que 20260922260000 exige (status do
// ACORDO muda primeiro, vinculo desativa depois) para exercitar os gatilhos
// reais de titulo_reavaliar -- so pula a trava de parcela paga.
async function acordoCanceladoComTitulo(db, n, { valorTotal = 1000, parcelasValores,
    pagaIndices = [], comVinculoExtra = false } = {}) {
  parcelasValores = parcelasValores ?? [valorTotal];
  const al = A(n);
  const ac = await acordoFn(db, al, { valor_total: valorTotal, qtd_parcelas: parcelasValores.length });
  const t = await titulo(db, al, { valor_original: valorTotal, valor_em_aberto: valorTotal });
  await negociar(db, t, ac);
  if (comVinculoExtra) {
    const t2 = await titulo(db, al, { valor_original: 1, valor_em_aberto: 1 });
    await negociar(db, t2, ac);
  }
  for (let i = 0; i < parcelasValores.length; i++) {
    const status = pagaIndices.includes(i) ? "PAGO" : "CANCELADA";
    await parcela(db, ac, status, parcelasValores[i]);
  }
  await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [ac]);
  await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [ac]);
  return { aluno_id: al, acordo_id: ac, titulo_id: t };
}

describe("re-acordo: saldo residual deterministico", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await comoGestao(db); });

  it("A. acordo cancelado SEM pagamento: divida continua renegociavel, historico preservado", async () => {
    const { aluno_id, acordo_id, titulo_id } = await acordoCanceladoComTitulo(db, 1, { valorTotal: 1000, parcelasValores: [1000] });
    expect(await residual(db, acordo_id)).toMatchObject({ confiavel: true, residual: 1000, motivo: null });

    const novo = await acordoFn(db, aluno_id, { valor_total: 1000 });
    const r = await vincular(db, [titulo_id], novo);
    expect(r).toMatchObject({ ok: true, vinculados: 1 });
    expect(await estado(db, titulo_id)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: novo });
    // historico do acordo anterior nao foi tocado
    expect(await vinculosDe(db, titulo_id)).toEqual([
      { acordo: acordo_id, ativo: false },
      { acordo: novo, ativo: true },
    ]);
  });

  it("B. acordo cancelado APOS pagamento parcial: residual correto, nunca o principal integral", async () => {
    // mensalidade R$1000, 2 parcelas de 500, uma paga -> residual = 500, nao 1000
    const { aluno_id, acordo_id, titulo_id } = await acordoCanceladoComTitulo(db, 2, {
      valorTotal: 1000, parcelasValores: [500, 500], pagaIndices: [0],
    });
    expect(await residual(db, acordo_id)).toMatchObject({ confiavel: true, residual: 500, motivo: null });

    const novo = await acordoFn(db, aluno_id, { valor_total: 500 });
    const r = await vincular(db, [titulo_id], novo);
    expect(r.ok).toBe(true);
    // a mensalidade continua com valor_original 1000 -- nao foi sobrescrita
    expect(Number(await um(db, `select valor_original from public.acordos_titulos where id=$1`, [titulo_id]))).toBe(1000);
  });

  it("C. acordo com VARIAS mensalidades originais: nao ratear -- inelegivel", async () => {
    const { acordo_id, titulo_id, aluno_id } = await acordoCanceladoComTitulo(db, 3, {
      valorTotal: 1001, parcelasValores: [1001], comVinculoExtra: true,
    });
    const r = await residual(db, acordo_id);
    expect(r.confiavel).toBe(false);
    expect(r.motivo).toBe("RESIDUAL_MULTIPLOS_TITULOS");

    const novo = await acordoFn(db, aluno_id, { valor_total: 1001 });
    const resp = await vincular(db, [titulo_id], novo);
    expect(resp).toMatchObject({ ok: false, erro: "PARCELAS_INELEGIVEIS" });
    expect(resp.bloqueados).toContain(titulo_id);
  });

  it("D. re-acordo: cadeia historica consultavel de ponta a ponta", async () => {
    const { aluno_id, acordo_id, titulo_id } = await acordoCanceladoComTitulo(db, 4, { valorTotal: 700 });
    const novo = await acordoFn(db, aluno_id, { valor_total: 700 });
    await vincular(db, [titulo_id], novo);

    // de titulo -> acordo atual (novo) e -> historico completo (ambos)
    const cadeia = await um(db, `select jsonb_build_object(
        'titulo_acordo_atual', t.acordo_id,
        'historico', (select jsonb_agg(jsonb_build_object('acordo', v.acordo_id, 'ativo', v.ativo) order by v.criado_em)
                       from public.acordo_titulo_vinculo v where v.titulo_id = t.id)
      ) from public.acordos_titulos t where t.id = $1`, [titulo_id]);
    expect(cadeia.titulo_acordo_atual).toBe(novo);
    expect(cadeia.historico).toEqual([
      { acordo: acordo_id, ativo: false },
      { acordo: novo, ativo: true },
    ]);
    expect(await um(db, `select status from public.acordos where id=$1`, [acordo_id])).toBe("CANCELADO");
  });

  it("E. acordo anterior ja teve pagamento: pagamentos continuam ligados a ele", async () => {
    const { aluno_id, acordo_id, titulo_id } = await acordoCanceladoComTitulo(db, 5, {
      valorTotal: 1000, parcelasValores: [400, 600], pagaIndices: [0],
    });
    const novo = await acordoFn(db, aluno_id, { valor_total: 600 });
    await vincular(db, [titulo_id], novo);

    const pagas = await um(db, `select count(*)::int from public.parcelas where acordo_id=$1 and status='PAGO'`, [acordo_id]);
    expect(pagas).toBe(1);
    const pagasNoNovo = await um(db, `select count(*)::int from public.parcelas where acordo_id=$1`, [novo]);
    expect(pagasNoNovo).toBe(0); // o re-acordo nao move nem cria parcela sozinho
  });

  it("F. re-acordo criado: titulo NEGOCIADO no novo, acordo anterior CANCELADO, vinculo formal com a origem", async () => {
    const { aluno_id, acordo_id, titulo_id } = await acordoCanceladoComTitulo(db, 6, { valorTotal: 300 });
    const novo = await acordoFn(db, aluno_id, { valor_total: 300 });
    await vincular(db, [titulo_id], novo);

    expect(await estado(db, titulo_id)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: novo });
    expect(await um(db, `select status from public.acordos where id=$1`, [acordo_id])).toBe("CANCELADO");
    const vinculoNovo = await um(db, `select ativo from public.acordo_titulo_vinculo where titulo_id=$1 and acordo_id=$2`, [titulo_id, novo]);
    expect(vinculoNovo).toBe(true);
  });

  it("G. execucao repetida: idempotente, sem duplicar vinculo nem trabalho", async () => {
    const { aluno_id, titulo_id } = await acordoCanceladoComTitulo(db, 7, { valorTotal: 200 });
    const novo = await acordoFn(db, aluno_id, { valor_total: 200 });
    const r1 = await vincular(db, [titulo_id], novo);
    expect(r1).toMatchObject({ ok: true, vinculados: 1 });
    const r2 = await vincular(db, [titulo_id], novo);
    expect(r2).toMatchObject({ ok: true, vinculados: 0, ja_estavam: 1 });
    const n = await um(db, `select count(*)::int from public.acordo_titulo_vinculo where titulo_id=$1 and acordo_id=$2`, [titulo_id, novo]);
    expect(n).toBe(1);
  });

  it("H. saldo residual zero: nao permite gerar novo acordo", async () => {
    // tudo pago (nao deveria ter sido cancelado, mas o acordo pode ter sido
    // cancelado por engano depois de quitado) -- residual = 0
    const { acordo_id, titulo_id, aluno_id } = await acordoCanceladoComTitulo(db, 8, {
      valorTotal: 500, parcelasValores: [500], pagaIndices: [0],
    });
    const r = await residual(db, acordo_id);
    expect(r).toMatchObject({ confiavel: false, residual: 0, motivo: "RESIDUAL_ZERO" });

    const novo = await acordoFn(db, aluno_id, { valor_total: 0 });
    const resp = await vincular(db, [titulo_id], novo);
    expect(resp).toMatchObject({ ok: false, erro: "PARCELAS_INELEGIVEIS" });
  });

  it("divergencia estrutural (sem pagamento, parcelas nao somam valor_total): inelegivel com motivo proprio", async () => {
    const { acordo_id, titulo_id, aluno_id } = await acordoCanceladoComTitulo(db, 9, {
      valorTotal: 1000, parcelasValores: [400], // 400 cancelado != 1000 valor_total, sem pagamento
    });
    expect(await residual(db, acordo_id)).toMatchObject({ confiavel: false, residual: null, motivo: "RESIDUAL_DIVERGENCIA_ESTRUTURAL" });
    const novo = await acordoFn(db, aluno_id, { valor_total: 1000 });
    expect(await vincular(db, [titulo_id], novo)).toMatchObject({ ok: false, erro: "PARCELAS_INELEGIVEIS" });
  });

  it("acordo cancelado sem NENHUMA parcela: divergencia estrutural", async () => {
    const al = A(10);
    const ac = await acordoFn(db, al, { valor_total: 500 });
    const t = await titulo(db, al, { valor_original: 500, valor_em_aberto: 500 });
    await negociar(db, t, ac);
    await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [ac]);
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [ac]);
    expect(await residual(db, ac)).toMatchObject({ confiavel: false, motivo: "RESIDUAL_DIVERGENCIA_ESTRUTURAL" });
  });

  it("pagamento fora da estrutura (com pagamento, mas nao reconcilia): inelegivel com motivo proprio", async () => {
    // pago(300) + cancelado(500) = 800 != valor_total(1000) -- diverge COM pagamento
    const { acordo_id, titulo_id, aluno_id } = await acordoCanceladoComTitulo(db, 11, {
      valorTotal: 1000, parcelasValores: [300, 500], pagaIndices: [0],
    });
    expect(await residual(db, acordo_id)).toMatchObject({ confiavel: false, residual: null, motivo: "RESIDUAL_PAGAMENTO_FORA_DA_ESTRUTURA" });
    const novo = await acordoFn(db, aluno_id, { valor_total: 1000 });
    expect(await vincular(db, [titulo_id], novo)).toMatchObject({ ok: false, erro: "PARCELAS_INELEGIVEIS" });
  });

  it("correcao posterior da estrutura: volta a ser elegivel automaticamente (calculo ao vivo, nunca cacheado)", async () => {
    const { acordo_id, titulo_id, aluno_id } = await acordoCanceladoComTitulo(db, 12, {
      valorTotal: 1000, parcelasValores: [400], // diverge: falta parcela de 600
    });
    expect((await residual(db, acordo_id)).confiavel).toBe(false);

    // gestao corrige a estrutura: a parcela que faltava aparece
    await parcela(db, acordo_id, "CANCELADA", 600);
    expect(await residual(db, acordo_id)).toMatchObject({ confiavel: true, residual: 1000 });

    const novo = await acordoFn(db, aluno_id, { valor_total: 1000 });
    expect(await vincular(db, [titulo_id], novo)).toMatchObject({ ok: true, vinculados: 1 });
  });

  it("nenhuma perda de saldo: soma(residual do acordo antigo) == soma(parcelas canceladas), sempre", async () => {
    const { acordo_id } = await acordoCanceladoComTitulo(db, 13, { valorTotal: 1234.56, parcelasValores: [1234.56] });
    const r = await residual(db, acordo_id);
    const somaCancelada = await um(db, `select coalesce(sum(valor),0) from public.parcelas where acordo_id=$1 and status='CANCELADA'`, [acordo_id]);
    expect(r.residual).toBe(Number(somaCancelada));
  });

  it("nenhuma duplicidade: apos re-acordo so ha 1 vinculo ativo, principal nao dobra", async () => {
    const { aluno_id, titulo_id } = await acordoCanceladoComTitulo(db, 14, { valorTotal: 900 });
    const novo = await acordoFn(db, aluno_id, { valor_total: 900 });
    await vincular(db, [titulo_id], novo);
    const ativos = await um(db, `select count(*)::int from public.acordo_titulo_vinculo where titulo_id=$1 and coalesce(ativo,true)`, [titulo_id]);
    expect(ativos).toBe(1);
  });

  it("nenhum operador contorna a trava chamando a RPC direto: PARCELAS_INELEGIVEIS mesmo autenticado como gestao", async () => {
    const { acordo_id, titulo_id, aluno_id } = await acordoCanceladoComTitulo(db, 15, {
      valorTotal: 1000, parcelasValores: [999], // nao reconcilia
    });
    await comoGestao(db);
    const novo = await acordoFn(db, aluno_id, { valor_total: 1000 });
    const r = await vincular(db, [titulo_id], novo);
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("PARCELAS_INELEGIVEIS");
    expect(await estado(db, titulo_id)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id });
  });
});

// ROLLBACK: a funcao nova sai, a antiga volta, o re-acordo ja feito fica.
describe("rollback de 20260922270000: codigo volta, dado fica", () => {
  const existe = (db, fn) =>
    um(db, `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = $1`, [fn]);

  it("1. migration aplicada: acordo_saldo_residual existe e responde", async () => {
    const db = await novoBanco();
    expect(await existe(db, "acordo_saldo_residual")).toBe(1);
    await db.close();
  });

  it("2. rollback aplicado: acordo_saldo_residual sai, vincular_titulos_acordo fica", async () => {
    const db = await novoBanco();
    await db.exec(ROLLBACK_B);
    expect(await existe(db, "acordo_saldo_residual")).toBe(0);
    expect(await existe(db, "vincular_titulos_acordo")).toBe(1);
    await db.close();
  });

  it("3. a funcao restaurada nao referencia a que foi removida", async () => {
    const db = await novoBanco();
    await db.exec(ROLLBACK_B);
    const src = await um(db, `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname='public' and p.proname='vincular_titulos_acordo'`);
    expect(src).not.toMatch(/acordo_saldo_residual/i);
    await db.close();
  });

  it("4. nenhuma tabela e apagada e nenhum dado financeiro some", async () => {
    const db = await novoBanco();
    const ac = await acordoCanceladoComTitulo(db, 950, {});
    const contar = async () => ({
      acordos: await um(db, `select count(*)::int from public.acordos`),
      titulos: await um(db, `select count(*)::int from public.acordos_titulos`),
      parcelas: await um(db, `select count(*)::int from public.parcelas`),
      baixas: await um(db, `select count(*)::int from public.baixas_pagamento`),
    });
    const antes = await contar();
    await db.exec(ROLLBACK_B);
    expect(await contar()).toEqual(antes);
    expect(await um(db, `select count(*)::int from information_schema.tables
                          where table_schema='public' and table_name in
                          ('acordos','acordos_titulos','parcelas','baixas_pagamento')`)).toBe(4);
    expect(ac).toBeTruthy();
    await db.close();
  });

  it("5. o arquivo de rollback nao contem DML de nivel superior", () => {
    const semCorpos = ROLLBACK_B.replace(/\$(function|fn|prova)\$[\s\S]*?\$\1\$/g, " ")
                                .replace(/--[^\n]*/g, " ");
    expect(semCorpos).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
  });
});
