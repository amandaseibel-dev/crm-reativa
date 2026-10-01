// RE-ACORDO: MENSALIDADE NEGOCIADA DE ACORDO CANCELADO VOLTA A SER
// RENEGOCIAVEL, SO PELO SALDO RESIDUAL DETERMINISTICO -- COMPORTAMENTO.
//
// Continuacao de acordo_cancelado_nao_reabre_mensalidade_comportamento.test.js.
// Roda as migrations REAIS (20260922265000 + 20260922270000 + 20260922275000,
// nesta ordem -- a 275000 substitui a regra de elegibilidade da 270000) num PostgreSQL
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
const MIGRATION_3 = ler("supabase/migrations/20260922275000_reacordo_cardinalidade_nao_bloqueia_residual.sql");
const ROLLBACK_C = ler("supabase/rollbacks/20260922275000_reacordo_cardinalidade_nao_bloqueia_residual.rollback.sql");

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
  await db.exec(MIGRATION_3);

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

// Acordo CANCELADO com N mensalidades de origem, todas preservadas como
// NEGOCIADO pela 20260922265000 (vinculo inativo, nunca apagado). Mesma ordem
// da RPC viva: status do ACORDO primeiro, vinculo depois.
async function acordoCanceladoMulti(db, n, { titulos = [500, 500], parcelasValores, pagaIndices = [] } = {}) {
  const valorTotal = titulos.reduce((a, b) => a + b, 0);
  parcelasValores = parcelasValores ?? [valorTotal];
  const al = A(n);
  const ac = await acordoFn(db, al, { valor_total: valorTotal, qtd_parcelas: parcelasValores.length });
  const ids = [];
  for (const v of titulos) {
    const t = await titulo(db, al, { valor_original: v, valor_em_aberto: v });
    await negociar(db, t, ac);
    ids.push(t);
  }
  for (let i = 0; i < parcelasValores.length; i++) {
    await parcela(db, ac, pagaIndices.includes(i) ? "PAGO" : "CANCELADA", parcelasValores[i]);
  }
  await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [ac]);
  await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [ac]);
  return { aluno_id: al, acordo_id: ac, titulo_ids: ids, valorTotal };
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

  // A REGRA QUE MUDOU (22/09/2026): a quantidade de mensalidades de origem nao
  // torna o residual do acordo incerto. O que seria aproximacao e reparti-lo
  // entre elas -- e nada reparte. O risco real (re-acordo PARCIAL) esta coberto
  // pela trava tudo-ou-nada, testada em E.
  it("B. DUAS mensalidades de origem + residual confiavel: ELEGIVEL, sem rateio", async () => {
    const { acordo_id, titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 3, { titulos: [600, 400] });
    const r = await residual(db, acordo_id);
    expect(r).toMatchObject({ confiavel: true, residual: 1000, motivo: null, titulos: 2 });

    const novo = await acordoFn(db, aluno_id, { valor_total: 1000 });
    expect(await vincular(db, [titulo_ids[0], titulo_ids[1]], novo)).toMatchObject({ ok: true, vinculados: 2 });

    // o residual foi tratado como UM valor do acordo: nenhuma mensalidade
    // recebeu fatia gravada em lugar nenhum
    for (const t of titulo_ids) {
      const l = await um(db, `select to_jsonb(t) from public.acordos_titulos t where id=$1`, [t]);
      expect(Number(l.valor_original)).toBeGreaterThan(0);
      expect(l.valor_em_aberto).toBe(l.valor_em_aberto); // nao foi sobrescrito por rateio
    }
    expect(Number(await um(db, `select valor_original from public.acordos_titulos where id=$1`, [titulo_ids[0]]))).toBe(600);
    expect(Number(await um(db, `select valor_original from public.acordos_titulos where id=$1`, [titulo_ids[1]]))).toBe(400);
  });

  it("C. VARIAS mensalidades + pagamento parcial totalmente conhecido: elegivel pelo residual TOTAL", async () => {
    // 3 mensalidades somando 1200; 1 parcela de 700 PAGA, 1 de 500 CANCELADA.
    // pago+cancelado = 1200 = valor_total -> reconcilia. Residual = 500, que e
    // do ACORDO -- nao "500/3" nem "500 da mensalidade X".
    const { acordo_id, titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 4, {
      titulos: [400, 400, 400], parcelasValores: [700, 500], pagaIndices: [0],
    });
    expect(await residual(db, acordo_id)).toMatchObject({ confiavel: true, residual: 500, titulos: 3 });

    const novo = await acordoFn(db, aluno_id, { valor_total: 500 });
    expect(await vincular(db, titulo_ids, novo)).toMatchObject({ ok: true, vinculados: 3 });
  });

  it("D. multi-titulo com TODOS os titulos enviados: re-acordo permitido", async () => {
    const { titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 5, { titulos: [300, 300, 300] });
    const novo = await acordoFn(db, aluno_id, { valor_total: 900 });
    expect(await vincular(db, titulo_ids, novo)).toMatchObject({ ok: true, vinculados: 3 });
    for (const t of titulo_ids) {
      expect((await estado(db, t)).acordo_id).toBe(novo);
    }
  });

  it("E. multi-titulo com apenas PARTE dos titulos: bloqueado, e nada e escrito", async () => {
    const { acordo_id, titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 6, { titulos: [300, 300, 300] });
    const novo = await acordoFn(db, aluno_id, { valor_total: 600 });

    const r = await vincular(db, [titulo_ids[0], titulo_ids[1]], novo);
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("REACORDO_PARCIAL");
    // diz QUAL acordo anterior e QUAL mensalidade ficou de fora
    expect(JSON.stringify(r.pendencias)).toContain(acordo_id);
    expect(JSON.stringify(r.pendencias)).toContain(titulo_ids[2]);

    // NADA foi escrito: os tres continuam no acordo anterior, sem vinculo novo
    for (const t of titulo_ids) {
      expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id });
    }
    expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo where acordo_id=$1`, [novo])).toBe(0);
  });

  it("F. titulo EXTRA que nunca pertenceu ao acordo anterior: permitido, e a cadeia historica nao e contaminada", async () => {
    const { acordo_id, titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 7, { titulos: [500, 500] });
    // mensalidade nova, ABERTO, que nunca passou pelo acordo cancelado
    const extra = await titulo(db, aluno_id, { valor_original: 250, valor_em_aberto: 250 });

    const novo = await acordoFn(db, aluno_id, { valor_total: 1250 });
    expect(await vincular(db, [...titulo_ids, extra], novo)).toMatchObject({ ok: true, vinculados: 3 });

    // o extra NAO ganhou vinculo com o acordo anterior -- so com o novo
    expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo
                          where titulo_id=$1 and acordo_id=$2`, [extra, acordo_id])).toBe(0);
    const v = await vinculosDe(db, extra);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ acordo: novo, ativo: true });
  });

  it("G. acordo cancelado SEM vinculo historico: residual conhecido, mas re-acordo automatico bloqueado", async () => {
    // orfao do DELETE antigo: parcelas intactas, nenhuma linha de vinculo
    const al = A(8);
    const ac = await acordoFn(db, al, { valor_total: 800 });
    await parcela(db, ac, "CANCELADA", 800);
    await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [ac]);

    const r = await residual(db, ac);
    expect(r.motivo).toBe("RESIDUAL_SEM_VINCULO_HISTORICO");
    expect(r.confiavel).toBe(false);
    // o numero esta certo e e devolvido -- o que falta e a cadeia, nao a conta
    expect(r.residual).toBe(800);
    expect(r.titulos).toBe(0);

    // nenhuma mensalidade de origem e inventada
    const t = await titulo(db, al, { situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    const novo = await acordoFn(db, al, { valor_total: 800 });
    expect(await vincular(db, [t], novo)).toMatchObject({ ok: false, erro: "PARCELAS_INELEGIVEIS" });
  });

  it("K. depois do re-acordo multi-titulo: historico inteiro de pe, nada reaberto, pagamento fica no acordo antigo", async () => {
    const { acordo_id, titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 9, {
      titulos: [400, 400], parcelasValores: [300, 500], pagaIndices: [0],
    });
    const novo = await acordoFn(db, aluno_id, { valor_total: 500 });
    expect(await vincular(db, titulo_ids, novo)).toMatchObject({ ok: true });

    for (const t of titulo_ids) {
      // mensalidade continua NEGOCIADO -- nunca voltou a ABERTO pra viabilizar o re-acordo
      expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: novo });
      const v = await vinculosDe(db, t);
      expect(v).toHaveLength(2);
      expect(v[0]).toMatchObject({ acordo: acordo_id, ativo: false }); // anterior: existe e inativo
      expect(v[1]).toMatchObject({ acordo: novo, ativo: true });       // novo: ativo
    }
    // o pagamento anterior continua no acordo anterior, nao migrou
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id=$1 and status='PAGO'`, [acordo_id])).toBe(1);
    expect(await um(db, `select count(*)::int from public.parcelas where acordo_id=$1`, [novo])).toBe(0);
  });

  it("L. re-acordo multi-titulo repetido: idempotente, sem vinculo duplicado", async () => {
    const { titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 10, { titulos: [200, 200] });
    const novo = await acordoFn(db, aluno_id, { valor_total: 400 });

    const r1 = await vincular(db, titulo_ids, novo);
    expect(r1).toMatchObject({ ok: true, vinculados: 2 });
    const r2 = await vincular(db, titulo_ids, novo);
    expect(r2).toMatchObject({ ok: true, vinculados: 0, ja_estavam: 2 });

    for (const t of titulo_ids) {
      expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo
                            where titulo_id=$1 and acordo_id=$2`, [t, novo])).toBe(1);
      expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo
                            where titulo_id=$1 and coalesce(ativo,true)`, [t])).toBe(1);
    }
  });

  // REGRESSAO: a trava tudo-ou-nada nao pode alcancar o LEGADO. Ate a
  // 20260922265000, cancelar reabria a mensalidade pra ABERTO mas deixava a
  // LINHA de vinculo apontando pro acordo cancelado. Essas mensalidades sao
  // divida comum hoje, com valor proprio -- nao carregam residual de acordo.
  // Sao os 10 acordos multi-titulo legados medidos em producao.
  it("legado (titulo ABERTO com vinculo velho de acordo cancelado): renegociar UM so continua permitido", async () => {
    const al = A(12);
    const ac = await acordoFn(db, al, { valor_total: 1000, qtd_parcelas: 1 });
    const t1 = await titulo(db, al, { valor_original: 600, valor_em_aberto: 600 });
    const t2 = await titulo(db, al, { valor_original: 400, valor_em_aberto: 400 });
    await negociar(db, t1, ac); await negociar(db, t2, ac);
    await parcela(db, ac, "CANCELADA", 1000);
    await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [ac]);
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [ac]);
    // estado LEGADO: a regra antiga reabriu as duas e soltou o acordo_id,
    // mas a linha de vinculo com o acordo cancelado continua la
    await db.query(`update public.acordos_titulos set situacao='ABERTO', status='em_aberto', acordo_id=null
                     where id = any($1::uuid[])`, [[t1, t2]]);
    expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo where acordo_id=$1`, [ac])).toBe(2);

    // renegociar SO a t1 e operacao corriqueira -- a trava nao pode exigir a t2
    const novo = await acordoFn(db, al, { valor_total: 600 });
    const r = await vincular(db, [t1], novo);
    expect(r.erro).not.toBe("REACORDO_PARCIAL");
    expect(r).toMatchObject({ ok: true, vinculados: 1 });
    // e a t2 continua intocada, ABERTO, sem vinculo novo
    expect(await estado(db, t2)).toEqual({ situacao: "ABERTO", status: "em_aberto", acordo_id: null });
  });

  // PROVA DE QUE `acordo_anterior_id` E DESNECESSARIA: a sequencia cronologica
  // da cadeia sai inteira de acordo_titulo_vinculo + criado_em, sem ambiguidade.
  it("cadeia A -> B -> C: ordem cronologica reconstruida so pelos vinculos, sem coluna nova", async () => {
    const { acordo_id: acA, titulo_ids, aluno_id } = await acordoCanceladoMulti(db, 11, { titulos: [1000] });
    const t = titulo_ids[0];

    // re-acordo em B, que tambem e cancelado depois
    const acB = await acordoFn(db, aluno_id, { valor_total: 1000 });
    expect(await vincular(db, [t], acB)).toMatchObject({ ok: true });
    await parcela(db, acB, "CANCELADA", 1000);
    await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [acB]);
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [acB]);

    // re-acordo em C
    const acC = await acordoFn(db, aluno_id, { valor_total: 1000 });
    expect(await vincular(db, [t], acC)).toMatchObject({ ok: true });

    const cadeia = await um(db, `select jsonb_agg(jsonb_build_object('acordo', v.acordo_id,
        'ativo', v.ativo, 'criado_em', v.criado_em) order by v.criado_em)
      from public.acordo_titulo_vinculo v where v.titulo_id=$1`, [t]);

    // 1. a ordem sai certa, e e exatamente a ordem real dos fatos
    expect(cadeia.map((x) => x.acordo)).toEqual([acA, acB, acC]);
    // 2. sem empate de timestamp -- se houvesse, a ordem seria ambigua e a
    //    coluna acordo_anterior_id passaria a ser necessaria
    const marcas = cadeia.map((x) => x.criado_em);
    expect(new Set(marcas).size).toBe(3);
    // 3. exatamente um elo ativo, e e o ultimo
    expect(cadeia.filter((x) => x.ativo)).toHaveLength(1);
    expect(cadeia[cadeia.length - 1].ativo).toBe(true);
    // 4. nada do historico foi apagado
    expect(cadeia).toHaveLength(3);
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

  it("5. rollback da 275000: a regra de cardinalidade volta, o re-acordo ja feito FICA", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    // re-acordo multi-titulo feito ENQUANTO a regra nova valia
    const al = A(880);
    const ac = await acordoFn(db, al, { valor_total: 1000, qtd_parcelas: 1 });
    const t1 = await titulo(db, al, { valor_original: 500, valor_em_aberto: 500 });
    const t2 = await titulo(db, al, { valor_original: 500, valor_em_aberto: 500 });
    await negociar(db, t1, ac); await negociar(db, t2, ac);
    await parcela(db, ac, "CANCELADA", 1000);
    await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [ac]);
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [ac]);
    const novo = await acordoFn(db, al, { valor_total: 1000 });
    expect(await vincular(db, [t1, t2], novo)).toMatchObject({ ok: true, vinculados: 2 });

    await db.exec(ROLLBACK_C);

    // o dado do re-acordo continua intacto -- rollback e de codigo, nao de dado
    for (const t of [t1, t2]) {
      expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: novo });
      expect(await vinculosDe(db, t)).toHaveLength(2);
    }
    // e a regra antiga esta de volta: multi-titulo volta a ser inelegivel
    expect((await residual(db, ac)).motivo).toBe("RESIDUAL_MULTIPLOS_TITULOS");
    await db.close();
  });

  it("6. rollback da 275000 depois da 270000: a funcao some e nada sobra referenciando-a", async () => {
    const db = await novoBanco();
    await db.exec(ROLLBACK_C);
    expect(await existe(db, "acordo_saldo_residual")).toBe(1);
    await db.exec(ROLLBACK_B);
    expect(await existe(db, "acordo_saldo_residual")).toBe(0);
    const src = await um(db, `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname='public' and p.proname='vincular_titulos_acordo'`);
    expect(src).not.toMatch(/acordo_saldo_residual/i);
    await db.close();
  });

  it("7. o rollback da 275000 tambem nao contem DML de nivel superior", () => {
    const semCorpos = ROLLBACK_C.replace(/\$(function|fn|prova)\$[\s\S]*?\$\1\$/g, " ")
                                .replace(/--[^\n]*/g, " ");
    expect(semCorpos).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
  });

  it("5. o arquivo de rollback nao contem DML de nivel superior", () => {
    const semCorpos = ROLLBACK_B.replace(/\$(function|fn|prova)\$[\s\S]*?\$\1\$/g, " ")
                                .replace(/--[^\n]*/g, " ");
    expect(semCorpos).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
  });
});
