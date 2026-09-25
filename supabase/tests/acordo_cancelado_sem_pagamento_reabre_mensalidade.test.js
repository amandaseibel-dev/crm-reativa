// ACORDO CANCELADO SEM NENHUM PAGAMENTO DEVOLVE A MENSALIDADE PARA ABERTO --
// COMPORTAMENTO, nao estrutura.
//
// Roda as migrations REAIS 20260922265000 (a regra de 22/09) e 20260925123852
// (esta, versao registrada em producao), nesta ordem, num PostgreSQL real
// (PGlite), sobre a mesma bancada minima de
// acordo_cancelado_nao_reabre_mensalidade_comportamento.test.js: gatilhos
// reais de `acordos`/`acordo_titulo_vinculo` e a RPC cancelar_acordo_ficha,
// que e o botao "Cancelar acordo" da ficha.
//
// Os testes "mutacao" rodam so a 20260922265000 para provar que o defeito
// relatado em 25/09 existia; o teste de rollback prova que o arquivo de
// rollback devolve exatamente aquele comportamento.
//
// liberar_caso_por_evento e crm_usuario_pode_quitar_baixar sao DUBLES.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const REGRA_22_09 = ler("supabase/migrations/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql");
const MIGRATION = ler("supabase/migrations/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.sql");
const ROLLBACK = ler("supabase/rollbacks/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.rollback.sql");

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco({ aplicar = [REGRA_22_09, MIGRATION] } = {}) {
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
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text, origem text,
      criado_em timestamptz default clock_timestamp());

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

    -- os dois gatilhos que chamam titulo_reavaliar e o de coerencia
    -- situacao/status: corpos de producao, nenhuma migration daqui os muda.
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

  for (const sql of aplicar) await db.exec(sql);

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

async function acordoFn(db, aluno_id, { valor_total = 1000, qtd_parcelas = 1 } = {}) {
  return um(db, `insert into public.acordos (aluno_id, valor_total, qtd_parcelas)
                 values ($1,$2,$3) returning id`, [aluno_id, valor_total, qtd_parcelas]);
}

async function titulo(db, aluno_id, { valor_original = 1000, tipo_boleto = "Cursos de Graduação" } = {}) {
  return um(db, `insert into public.acordos_titulos (aluno_id, situacao, status, valor_original, valor_em_aberto, tipo_boleto)
                 values ($1,'ABERTO','em_aberto',$2,$2,$3) returning id`, [aluno_id, valor_original, tipo_boleto]);
}

// Vinculo como o automatico deixa (origem EXATO_PRIME_195, sem vinculado_por):
// linha ativa em acordo_titulo_vinculo; o gatilho do vinculo poe o titulo em
// NEGOCIADO apontando para o acordo.
async function vincularAutomatico(db, tituloId, acordoId) {
  await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, origem)
                  values ($1,$2,true,'EXATO_PRIME_195')`, [acordoId, tituloId]);
}

async function parcela(db, acordoId, status = "A_VENCER", valor = 1000) {
  return um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,$2,$3) returning id`,
    [acordoId, status, valor]);
}

const estado = async (db, tituloId) => {
  const l = await um(db, `select to_jsonb(t) from public.acordos_titulos t where id = $1`, [tituloId]);
  return { situacao: l.situacao, status: l.status, acordo_id: l.acordo_id };
};
const ABERTO = { situacao: "ABERTO", status: "em_aberto", acordo_id: null };
const negociado = (acordo_id) => ({ situacao: "NEGOCIADO", status: "vinculada", acordo_id });
const cancelarFicha = (db, acordoId) => um(db, `select public.cancelar_acordo_ficha($1)`, [acordoId]);
// Caminho que nao passa pelas travas da ficha (so existe hoje por correcao
// manual ou pela RPC morta acordo_cancelar): mesma ordem da ficha, status do
// acordo primeiro, vinculo depois.
async function cancelarDireto(db, acordoId) {
  await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [acordoId]);
  await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [acordoId]);
}

describe("acordo cancelado sem pagamento devolve a mensalidade", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("vinculo automatico + cancelar pela ficha sem nenhuma parcela paga: mensalidade volta para ABERTO", async () => {
    const al = A(1);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "VENCIDA");
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, ac);
    expect(await estado(db, t)).toEqual(negociado(ac));

    const r = await cancelarFicha(db, ac);

    expect(r.ok).toBe(true);
    expect(await estado(db, t)).toEqual(ABERTO);
    // a composicao do acordo cancelado nao se perde: o vinculo fica, inativo
    expect(await um(db, `select jsonb_agg(jsonb_build_object('ativo', ativo, 'origem', origem))
                           from public.acordo_titulo_vinculo where titulo_id=$1`, [t]))
      .toEqual([{ ativo: false, origem: "EXATO_PRIME_195" }]);
    expect(await um(db, `select status from public.acordos where id=$1`, [ac])).toBe("CANCELADO");
    expect(await um(db, `select status from public.parcelas where acordo_id=$1`, [ac])).toBe("CANCELADA");
  });

  it("varias mensalidades no mesmo acordo: todas voltam", async () => {
    const al = A(2);
    const ac = await acordoFn(db, al, { valor_total: 2200, qtd_parcelas: 2 });
    await parcela(db, ac, "VENCIDA", 1100);
    await parcela(db, ac, "A_VENCER", 1100);
    const ts = [];
    for (const v of [1000, 800, 400]) {
      const t = await titulo(db, al, { valor_original: v });
      await vincularAutomatico(db, t, ac);
      ts.push(t);
    }

    await cancelarFicha(db, ac);

    for (const t of ts) expect(await estado(db, t)).toEqual(ABERTO);
  });

  it("mensalidade reaberta entra num acordo novo normalmente", async () => {
    const al = A(3);
    const velho = await acordoFn(db, al);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, velho);
    await cancelarFicha(db, velho);

    const novo = await acordoFn(db, al);
    await vincularAutomatico(db, t, novo);

    expect(await estado(db, t)).toEqual(negociado(novo));
  });

  it("acordo cancelado por fora da ficha COM parcela paga: mensalidade continua NEGOCIADA (re-acordo pelo residual)", async () => {
    const al = A(4);
    const ac = await acordoFn(db, al, { valor_total: 1000, qtd_parcelas: 2 });
    await parcela(db, ac, "PAGO", 500);
    await parcela(db, ac, "CANCELADA", 500);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, ac);

    await cancelarDireto(db, ac);

    expect(await estado(db, t)).toEqual(negociado(ac));
  });

  it("acordo cancelado com baixa viva e sem parcela PAGO: continua NEGOCIADA", async () => {
    const al = A(5);
    const ac = await acordoFn(db, al);
    const p = await parcela(db, ac, "A_VENCER");
    await db.query(`insert into public.baixas_pagamento (acordo_id, parcela_id, baixado_em) values ($1,$2,now())`, [ac, p]);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, ac);

    await cancelarDireto(db, ac);

    expect(await estado(db, t)).toEqual(negociado(ac));
  });

  it("baixa DEVOLVIDA nao conta como pagamento: cancelar pela ficha reabre", async () => {
    const al = A(6);
    const ac = await acordoFn(db, al);
    const p = await parcela(db, ac, "A_VENCER");
    await db.query(`insert into public.baixas_pagamento (acordo_id, parcela_id, baixado_em, devolvido_em)
                    values ($1,$2,now(),now())`, [ac, p]);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, ac);

    await cancelarFicha(db, ac);

    expect(await estado(db, t)).toEqual(ABERTO);
  });

  it("re-acordo A (pago em parte) -> B cancelado sem pagar: o dinheiro entrou em A, mensalidade continua NEGOCIADA", async () => {
    const al = A(7);
    const acA = await acordoFn(db, al, { valor_total: 1000, qtd_parcelas: 2 });
    await parcela(db, acA, "PAGO", 400);
    await parcela(db, acA, "CANCELADA", 600);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, acA);
    await cancelarDireto(db, acA);
    expect(await estado(db, t)).toEqual(negociado(acA));

    // re-acordo pelo residual de A (a regra de 22/09 continua de pe)
    const acB = await acordoFn(db, al, { valor_total: 600 });
    await parcela(db, acB, "VENCIDA", 600);
    await vincularAutomatico(db, t, acB);
    expect(await estado(db, t)).toEqual(negociado(acB));

    await cancelarFicha(db, acB);

    expect(await estado(db, t)).toEqual(negociado(acB));
  });

  it("boleto do proprio acordo continua sendo cancelado junto (nao vira mensalidade aberta)", async () => {
    const al = A(8);
    const ac = await acordoFn(db, al);
    const boleto = await titulo(db, al, { tipo_boleto: "Acordo" });
    await vincularAutomatico(db, boleto, ac);

    await cancelarFicha(db, ac);

    expect((await estado(db, boleto)).situacao).toBe("CANCELADA");
  });

  it("mensalidade PAGO e CANCELADA continuam terminais", async () => {
    const al = A(9);
    const ac = await acordoFn(db, al);
    const paga = await titulo(db, al);
    const cancelada = await titulo(db, al);
    await vincularAutomatico(db, paga, ac);
    await vincularAutomatico(db, cancelada, ac);
    await db.query(`update public.acordos_titulos set situacao='PAGO', status='quitada' where id=$1`, [paga]);
    await db.query(`update public.acordos_titulos set situacao='CANCELADA', status='cancelada' where id=$1`, [cancelada]);

    await cancelarFicha(db, ac);

    expect((await estado(db, paga)).situacao).toBe("PAGO");
    expect((await estado(db, cancelada)).situacao).toBe("CANCELADA");
  });

  it("titulo_reavaliar de novo numa mensalidade ja reaberta: nenhum UPDATE", async () => {
    const al = A(10);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, ac);
    await cancelarFicha(db, ac);

    const antes = await um(db, `select to_jsonb(t) from public.acordos_titulos t where id=$1`, [t]);
    await db.query(`select public.titulo_reavaliar($1)`, [t]);
    const depois = await um(db, `select to_jsonb(t) from public.acordos_titulos t where id=$1`, [t]);

    expect(depois).toEqual(antes); // inclusive atualizado_em
  });

  it("correcao das ja presas: reavaliar mensalidade NEGOCIADA em acordo cancelado sem pagamento reabre", async () => {
    // estado que a regra de 22/09 deixou em producao
    const antigo = await novoBanco({ aplicar: [REGRA_22_09] });
    const al = A(11);
    const ac = await acordoFn(antigo, al);
    const t = await titulo(antigo, al);
    await vincularAutomatico(antigo, t, ac);
    await cancelarFicha(antigo, ac);
    expect(await estado(antigo, t)).toEqual(negociado(ac));

    await antigo.exec(MIGRATION);
    await antigo.query(`select public.titulo_reavaliar($1)`, [t]);

    expect(await estado(antigo, t)).toEqual(ABERTO);
    await antigo.close();
  });
});

describe("prova do defeito e do rollback", () => {
  async function cenarioFicha(db) {
    const al = A(50);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await vincularAutomatico(db, t, ac);
    await cancelarFicha(db, ac);
    return { ac, t };
  }

  it("mutacao: so com a regra de 22/09 a mensalidade fica presa no acordo cancelado -- o defeito relatado", async () => {
    const db = await novoBanco({ aplicar: [REGRA_22_09] });
    const { ac, t } = await cenarioFicha(db);
    expect(await estado(db, t)).toEqual(negociado(ac));
    await db.close();
  });

  it("rollback devolve o comportamento de 22/09", async () => {
    const db = await novoBanco({ aplicar: [REGRA_22_09, MIGRATION, ROLLBACK] });
    const { ac, t } = await cenarioFicha(db);
    expect(await estado(db, t)).toEqual(negociado(ac));
    await db.close();
  });
});

describe("os corpos partem de producao", () => {
  const corpo = (sql, nome) => {
    const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${nome}\\(.*?AS \\$function\\$(.*?)\\$function\\$`, "s");
    return sql.match(re)[1];
  };
  const md5 = (s) => createHash("md5").update(s).digest("hex");
  const semComentario = (s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("a base (22/09) e o que esta em producao em 25/09, md5(prosrc)", () => {
    expect(md5(corpo(REGRA_22_09, "titulo_reavaliar"))).toBe("5704f3aa88cbd1856480dbefac3f9807");
    expect(md5(corpo(REGRA_22_09, "cancelar_acordo_ficha"))).toBe("6cc366f032b76fa9e0fca15d08db9964");
  });

  it("cancelar_acordo_ficha muda so o comentario", () => {
    expect(semComentario(corpo(MIGRATION, "cancelar_acordo_ficha")))
      .toBe(semComentario(corpo(REGRA_22_09, "cancelar_acordo_ficha")));
  });

  it("titulo_reavaliar muda so o guarda do NEGOCIADO", () => {
    const antes = semComentario(corpo(REGRA_22_09, "titulo_reavaliar"));
    const depois = semComentario(corpo(MIGRATION, "titulo_reavaliar"));
    const guardaAntiga = "    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO') then\n";
    expect(antes.split(guardaAntiga)).toHaveLength(2);
    const [prefixo, sufixo] = antes.split(guardaAntiga);
    expect(depois.startsWith(prefixo)).toBe(true);
    expect(depois.endsWith(sufixo)).toBe(true);
  });

  it("o rollback carrega os corpos de producao byte a byte", () => {
    expect(md5(corpo(ROLLBACK, "titulo_reavaliar"))).toBe("5704f3aa88cbd1856480dbefac3f9807");
    expect(md5(corpo(ROLLBACK, "cancelar_acordo_ficha"))).toBe("6cc366f032b76fa9e0fca15d08db9964");
  });
});
