// MENSALIDADE NEGOCIADA NAO VOLTA A SER ABERTA SO PORQUE O ACORDO FOI
// CANCELADO -- COMPORTAMENTO, nao estrutura.
//
// Roda a migration REAL (20260922260000) num PostgreSQL real (PGlite), sobre
// uma bancada minima com os tres pontos que ela corrige: titulo_reavaliar,
// titulos_por_status_acordo (ambos disparados pelos gatilhos reais de
// producao em `acordos`/`acordo_titulo_vinculo`) e a RPC cancelar_acordo_ficha
// (a que a tela realmente chama). Os testes "mutacao" recarregam os TRES
// corpos de producao de 22/09/2026 (supabase/audits/
// acordo_cancelado_nao_reabre_mensalidade_producao_20260922.sql) para provar
// que o defeito existia antes desta migration.
//
// liberar_caso_por_evento e crm_usuario_pode_quitar_baixar sao DUBLES: o que
// esta sob teste e o destino da MENSALIDADE, nao a fila de casos (ja coberta
// em acordo_cancelado_nao_cancela_cobranca.test.js) nem o portao de acesso.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATION = ler("supabase/migrations/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql");
const PRODUCAO_ANTES = ler("supabase/audits/acordo_cancelado_nao_reabre_mensalidade_producao_20260922.sql");
const ROLLBACK = ler("supabase/rollbacks/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.rollback.sql");

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco({ corrigido = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.email() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email' $$;

    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric, qtd_parcelas int default 1, saldo numeric,
      numero_acordo bigint, numero_ulbra text, motivo_ajuste text,
      criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      documento text, valor_original numeric, valor_em_aberto numeric, situacao text, status text,
      tipo_boleto text default 'Cursos de Graduação', acordo_id uuid, motivo_ajuste text,
      atualizado_em timestamptz default now());

    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text,
      criado_em timestamptz default now());

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      status text default 'A_VENCER', valor numeric, atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);

    create table public._chamadas_liberar_evento (aluno_id uuid, evento text, registrado_em timestamptz default now());
    create function public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text,
        p_valor_pago numeric default null, p_data_pagamento date default current_date)
      returns void language plpgsql as $$
      begin insert into public._chamadas_liberar_evento (aluno_id, evento) values (p_aluno_id, p_evento); end $$;

    create function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $$ select true $$;

    -- os dois gatilhos que chamam titulo_reavaliar (corpo de producao, nao
    -- mudou nesta migration) e o gatilho de coerencia situacao/status.
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

  // os tres corpos sob teste: producao de 22/09 (mutacao) ou a migration nova.
  await db.exec(corrigido ? MIGRATION : PRODUCAO_ANTES);

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

async function aluno(db, n) {
  const id = A(n);
  return id;
}

async function acordoFn(db, aluno_id, { status = "ATIVO", valor_total = 1000, qtd_parcelas = 1, numero_acordo = null } = {}) {
  return um(db, `insert into public.acordos (aluno_id, status, valor_total, qtd_parcelas, numero_acordo)
                 values ($1,$2,$3,$4,$5) returning id`, [aluno_id, status, valor_total, qtd_parcelas, numero_acordo]);
}

async function titulo(db, aluno_id, { situacao = "ABERTO", status = "em_aberto", valor_original = 1000,
    valor_em_aberto = 1000, acordo_id = null } = {}) {
  return um(db, `insert into public.acordos_titulos (aluno_id, situacao, status, valor_original, valor_em_aberto, acordo_id)
                 values ($1,$2,$3,$4,$5,$6) returning id`, [aluno_id, situacao, status, valor_original, valor_em_aberto, acordo_id]);
}

// Negocia diretamente (sem o motor de vincular_titulos_acordo, fora do escopo
// deste teste): cria o vinculo ativo e deixa o titulo como NEGOCIADO, do jeito
// que a negociacao real deixa.
async function negociar(db, tituloId, acordoId) {
  await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por)
                  values ($1,$2,true,'teste')`, [acordoId, tituloId]);
  await db.query(`update public.acordos_titulos set situacao='NEGOCIADO', status='vinculada', acordo_id=$2
                  where id=$1`, [tituloId, acordoId]);
}

const linha = (db, tituloId) => um(db, `select to_jsonb(t) from public.acordos_titulos t where id = $1`, [tituloId]);
const estado = async (db, tituloId) => {
  const l = await linha(db, tituloId);
  return { situacao: l.situacao, status: l.status, acordo_id: l.acordo_id };
};
const cancelarStatus = (db, acordoId, status) =>
  db.query(`update public.acordos set status = $2, atualizado_em = now() where id = $1`, [acordoId, status]);
const cancelarFicha = (db, acordoId) => um(db, `select public.cancelar_acordo_ficha($1)`, [acordoId]);

describe("acordo cancelado nao reabre mensalidade negociada", () => {
  let db;
  beforeEach(async () => { db = await novoBanco({ corrigido: true }); });

  it("A. mensalidade ABERTA + acordo ATIVO -> negociar -> NEGOCIADO", async () => {
    const al = await aluno(db, 1);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
  });

  it("B. acordo ATIVO -> CANCELADO: mensalidade continua NEGOCIADA", async () => {
    const al = await aluno(db, 2);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);

    await cancelarStatus(db, ac, "CANCELADO");

    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    // o vinculo nunca e apagado pela reavaliacao automatica
    expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo where titulo_id=$1`, [t])).toBe(1);
  });

  it("B (mutacao: corpo de producao de 22/09). O mesmo cenario reabre para ABERTO -- o defeito", async () => {
    const antigo = await novoBanco({ corrigido: false });
    const al = await aluno(antigo, 20);
    const ac = await acordoFn(antigo, al);
    const t = await titulo(antigo, al);
    await negociar(antigo, t, ac);

    await cancelarStatus(antigo, ac, "CANCELADO");

    expect(await estado(antigo, t)).toEqual({ situacao: "ABERTO", status: "em_aberto", acordo_id: null });
    await antigo.close();
  });

  it("C. acordo ATIVO -> QUEBRADO: mensalidade original nao e reaberta automaticamente", async () => {
    const al = await aluno(db, 3);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);

    await cancelarStatus(db, ac, "QUEBRADO");

    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
  });

  it("C2. acordo ATIVO -> INATIVO: mesma protecao", async () => {
    const al = await aluno(db, 30);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);

    await cancelarStatus(db, ac, "INATIVO");

    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
  });

  it("D. acordo CANCELADO reavaliado de novo: idempotente, sem mudanca adicional", async () => {
    const al = await aluno(db, 4);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    await cancelarStatus(db, ac, "CANCELADO");

    const antes = await linha(db, t);
    await db.query(`select public.titulo_reavaliar($1)`, [t]);
    await db.query(`select public.titulo_reavaliar($1)`, [t]);
    const depois = await linha(db, t);

    expect(depois).toEqual(antes); // inclusive atualizado_em: nao houve UPDATE nenhum
  });

  it("E. varias mensalidades no mesmo acordo: nenhuma volta", async () => {
    const al = await aluno(db, 5);
    const ac = await acordoFn(db, al, { valor_total: 3000 });
    const t1 = await titulo(db, al, { valor_original: 1000, valor_em_aberto: 1000 });
    const t2 = await titulo(db, al, { valor_original: 800, valor_em_aberto: 800 });
    const t3 = await titulo(db, al, { valor_original: 1200, valor_em_aberto: 1200 });
    await negociar(db, t1, ac);
    await negociar(db, t2, ac);
    await negociar(db, t3, ac);

    await cancelarStatus(db, ac, "CANCELADO");

    for (const t of [t1, t2, t3]) {
      expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    }
  });

  it("F. dois acordos historicos, os dois cancelados: nao reabre pelo mais antigo", async () => {
    const al = await aluno(db, 6);
    const t = await titulo(db, al);
    const ac1 = await acordoFn(db, al, { numero_acordo: 1 });
    await negociar(db, t, ac1);
    await cancelarStatus(db, ac1, "CANCELADO"); // primeira negociacao cai

    // renegocia num acordo novo (vinculo antigo fica inativo, novo entra ativo)
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where titulo_id=$1`, [t]);
    const ac2 = await acordoFn(db, al, { numero_acordo: 2 });
    await negociar(db, t, ac2);
    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac2 });

    // o segundo acordo tambem cai
    await cancelarStatus(db, ac2, "CANCELADO");

    const s = await estado(db, t);
    expect(s.situacao).toBe("NEGOCIADO");
    expect(s.status).toBe("vinculada");
    // nao virou ABERTO nem foi religado ao acordo mais antigo
    expect(s.acordo_id).not.toBeNull();
  });

  it("G. pagamento parcial no acordo cancelado: pagamento preservado, mensalidade nao recriada", async () => {
    const al = await aluno(db, 7);
    const ac = await acordoFn(db, al, { qtd_parcelas: 2 });
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    const pPaga = await um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,'PAGO',500) returning id`, [ac]);
    await um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,'A_VENCER',500) returning id`, [ac]);

    await cancelarStatus(db, ac, "CANCELADO");

    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    // titulo_reavaliar nunca escreve em parcelas: o pagamento fica intacto
    const parcelaPaga = await um(db, `select to_jsonb(p) from public.parcelas p where id=$1`, [pPaga]);
    expect(parcelaPaga).toMatchObject({ status: "PAGO", valor: 500 });
    // nenhuma mensalidade nova foi criada para este aluno
    expect(await um(db, `select count(*)::int from public.acordos_titulos where aluno_id=$1`, [al])).toBe(1);
  });

  it("G2. cancelar_acordo_ficha continua recusando quando ha parcela paga (guarda preexistente, intacta)", async () => {
    const al = await aluno(db, 70);
    const ac = await acordoFn(db, al, { qtd_parcelas: 2 });
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    await um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,'PAGO',500) returning id`, [ac]);

    await expect(cancelarFicha(db, ac)).rejects.toThrow(/ja tem parcela paga/);
    expect(await um(db, `select status from public.acordos where id=$1`, [ac])).toBe("ATIVO");
    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
  });

  it("H. saldo: sem duplicidade entre mensalidade negociada e parcelas do acordo cancelado", async () => {
    const al = await aluno(db, 8);
    const ac = await acordoFn(db, al, { valor_total: 1000 });
    const t = await titulo(db, al, { valor_original: 1000, valor_em_aberto: 1000 });
    await negociar(db, t, ac);
    await um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,'A_VENCER',1000) returning id`, [ac]);

    await cancelarFicha(db, ac);

    // bucket 1: mensalidades "em aberto" -- a negociada nao entra
    const abertoTitulos = await um(db,
      `select coalesce(sum(valor_em_aberto),0) from public.acordos_titulos where aluno_id=$1 and situacao='ABERTO'`, [al]);
    // bucket 2: parcelas do acordo que ainda contam como divida viva -- todas CANCELADA
    const abertoParcelas = await um(db,
      `select coalesce(sum(valor),0) from public.parcelas where acordo_id=$1 and status in ('A_VENCER','VENCIDA')`, [ac]);
    expect(Number(abertoTitulos)).toBe(0);
    expect(Number(abertoParcelas)).toBe(0);
    expect(await um(db, `select status from public.parcelas where acordo_id=$1`, [ac])).toBe("CANCELADA");
  });

  it("I. fila operacional: mensalidade negociada nao aparece como ABERTO", async () => {
    const al = await aluno(db, 9);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    await cancelarStatus(db, ac, "CANCELADO");

    const naFilaComoAberto = await um(db,
      `select count(*)::int from public.acordos_titulos where id=$1 and situacao='ABERTO'`, [t]);
    expect(naFilaComoAberto).toBe(0);
  });

  it("J. acoes massivas: mensalidade negociada de acordo cancelado nao volta a ser elegivel", async () => {
    const al = await aluno(db, 10);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    await cancelarStatus(db, ac, "CANCELADO");

    // filtro tipico de elegibilidade de acoes massivas / vinculo a novo acordo
    const elegivel = await um(db,
      `select count(*)::int from public.acordos_titulos where id=$1 and situacao in ('ABERTO','VENCIDO')`, [t]);
    expect(elegivel).toBe(0);
  });

  // ---- cancelar_acordo_ficha (a RPC real da tela) -------------------------

  it("cancelar_acordo_ficha: vinculo so DESATIVA, nunca apaga -- a cadeia fica inteira", async () => {
    const al = await aluno(db, 11);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);

    const r = await cancelarFicha(db, ac);
    expect(r).toMatchObject({ ok: true, acordo_id: ac, vinculos_desativados: 1 });
    expect(r.titulos_reabertos).toBeUndefined();

    const v = await um(db, `select to_jsonb(v) from public.acordo_titulo_vinculo v where titulo_id=$1`, [t]);
    expect(v).toMatchObject({ acordo_id: ac, titulo_id: t, ativo: false });
    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    expect(await um(db, `select status from public.acordos where id=$1`, [ac])).toBe("CANCELADO");
    expect(await um(db, `select count(*)::int from public._chamadas_liberar_evento where aluno_id=$1 and evento='CANCELADO'`, [al])).toBe(1);
  });

  it("cancelar_acordo_ficha (mutacao: corpo de producao de 22/09). O vinculo era APAGADO e o titulo reabria", async () => {
    const antigo = await novoBanco({ corrigido: false });
    const al = await aluno(antigo, 21);
    const ac = await acordoFn(antigo, al);
    const t = await titulo(antigo, al);
    await negociar(antigo, t, ac);

    const r = await um(antigo, `select public.cancelar_acordo_ficha($1)`, [ac]);
    expect(r).toMatchObject({ ok: true, titulos_reabertos: 1, vinculos_removidos: 1 });
    expect(await um(antigo, `select count(*)::int from public.acordo_titulo_vinculo where titulo_id=$1`, [t])).toBe(0);
    expect(await estado(antigo, t)).toEqual({ situacao: "ABERTO", status: "em_aberto", acordo_id: null });
    await antigo.close();
  });

  it("cancelar_acordo_ficha continua recusando acordo ja cancelado e com baixa viva", async () => {
    const al = await aluno(db, 12);
    const ac = await acordoFn(db, al);
    await cancelarStatus(db, ac, "CANCELADO");
    await expect(cancelarFicha(db, ac)).rejects.toThrow(/ja esta cancelado/);

    const al2 = await aluno(db, 13);
    const ac2 = await acordoFn(db, al2);
    await um(db, `insert into public.baixas_pagamento (acordo_id, baixado_por_email, baixado_em) values ($1,'x@x.com', now()) returning id`, [ac2]);
    await expect(cancelarFicha(db, ac2)).rejects.toThrow(/baixa\/pagamento registrado/);
  });
});

// ROLLBACK: o codigo volta, o dado fica.
//
// O rollback desta migration e de CODIGO e COMPORTAMENTO, por decisao da
// gestao em 22/09/2026 -- nao faz saneamento de dado, nao apaga historico, nao
// reabre titulo em lote. Estes testes provam as duas metades: que as funcoes
// voltam ao corpo EXATO de producao, e que nada de financeiro e removido.
describe("rollback de 20260922265000: codigo volta, dado fica", () => {
  const CORPOS = ["titulo_reavaliar", "titulos_por_status_acordo", "cancelar_acordo_ficha"];
  const fonte = (db, fn) =>
    um(db, `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = $1`, [fn]);

  it("1. migration aplicada: comportamento novo -- cancelar mantem NEGOCIADO", async () => {
    const db = await novoBanco({ corrigido: true });
    const al = await aluno(db, 900);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    await cancelarStatus(db, ac, "CANCELADO");
    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    await db.close();
  });

  it("2. rollback aplicado: as tres funcoes voltam ao corpo EXATO de producao de 22/09", async () => {
    const revertido = await novoBanco({ corrigido: true });
    await revertido.exec(ROLLBACK);
    const referencia = await novoBanco({ corrigido: false });

    for (const fn of CORPOS) {
      expect(await fonte(revertido, fn), `${fn} nao voltou ao corpo de producao`)
        .toBe(await fonte(referencia, fn));
    }
    await revertido.close();
    await referencia.close();
  });

  it("3. e o comportamento antigo volta junto: cancelar reabre para ABERTO", async () => {
    const db = await novoBanco({ corrigido: true });
    await db.exec(ROLLBACK);
    const al = await aluno(db, 901);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);
    await cancelarStatus(db, ac, "CANCELADO");
    // e o defeito que a migration corrigia -- reverter o codigo traz o defeito de volta
    expect(await estado(db, t)).toEqual({ situacao: "ABERTO", status: "em_aberto", acordo_id: null });
    await db.close();
  });

  it("4. nenhum dado financeiro e apagado e a estrutura continua valida", async () => {
    const db = await novoBanco({ corrigido: true });
    const al = await aluno(db, 902);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await negociar(db, t, ac);

    const contar = async () => ({
      acordos: await um(db, `select count(*)::int from public.acordos`),
      titulos: await um(db, `select count(*)::int from public.acordos_titulos`),
      vinculos: await um(db, `select count(*)::int from public.acordo_titulo_vinculo`),
    });
    const antes = await contar();
    await db.exec(ROLLBACK);
    const depois = await contar();

    expect(depois).toEqual(antes);
    // o titulo que ficou NEGOCIADO sob a regra nova NAO e mexido pelo rollback
    expect(await estado(db, t)).toEqual({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: ac });
    // e as tabelas continuam la
    expect(await um(db, `select count(*)::int from information_schema.tables
                          where table_schema='public' and table_name in
                          ('acordos','acordos_titulos','acordo_titulo_vinculo')`)).toBe(3);
    await db.close();
  });

  it("5. o arquivo de rollback nao contem DML de nivel superior", () => {
    const semCorpos = ROLLBACK.replace(/\$(function|fn|prova)\$[\s\S]*?\$\1\$/g, " ")
                              .replace(/--[^\n]*/g, " ");
    expect(semCorpos).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
  });
});
