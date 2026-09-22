// CORRECAO AUTOMATICA DE UM UNICO CASO LEGADO -- COMPORTAMENTO.
//
// Roda a migration REAL num PostgreSQL real (PGlite), sobre uma bancada que
// reproduz os gatilhos de producao que a escrita atravessa -- inclusive a trava
// de baixa viva unica (20260922290000), que NAO e desabilitada aqui.
// Os UUIDs sao os mesmos da migration: se a lista literal mudar, quebra.
//
// NENHUM DADO REAL -- valores reproduzem a forma do caso, nao a identidade.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20260922310000_baixa_legado_50611040003.sql");
const ROLLBACK = ler("supabase/rollbacks/20260922310000_baixa_legado_50611040003.rollback.sql");

const PARCELA = "c411e507-b24a-4017-828d-5b93ee9210a1";
const ACORDO = "30a4d0cc-6c74-4604-a962-4871ba1c430b";
const ALUNO = "62390215-80f0-4eb5-89a2-de516ffadd7a";
const P4 = "dddddddd-0000-4000-8000-000000000004";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create table public.alunos (id uuid primary key, nome text, cpf text,
      situacao_operacional text, atualizado_em timestamptz default now());
    create table public.acordos (id uuid primary key, aluno_id uuid, status text,
      numero_acordo bigint, saldo numeric, motivo_ajuste text,
      operador_responsavel_email text, criado_por_email text, atualizado_em timestamptz default now());
    create table public.parcelas (id uuid primary key, acordo_id uuid, numero int,
      boleto text, status text, valor numeric, honorarios numeric, vencimento date,
      pago_em timestamptz, confirmado_por_email text, observacao text,
      atualizado_em timestamptz default now());
    create table public.pagamentos (id uuid primary key default gen_random_uuid(),
      numero_parcela_completo text, valor_pago numeric, valor_honorario numeric,
      data_pagamento date, status_conciliacao text);
    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(),
      aluno_id text, aluno_nome text, aluno_cpf text,
      parcela_id uuid references public.parcelas(id), acordo_id uuid references public.acordos(id),
      valor_pago numeric, honorarios_recebidos numeric, data_pagamento date, status_baixa text,
      responsavel_baixa_email text, baixado_por_email text, baixado_por_nome text,
      operador_origem_email text, observacao_operador text,
      recebido_em timestamptz, atualizado_em timestamptz, baixado_em timestamptz,
      devolvido_em timestamptz, motivo_devolucao text);

    -- a trava de baixa viva unica, copia da 20260922290000 (NAO desabilitada)
    create function public._baixa_viva_unica_por_parcela() returns trigger
      language plpgsql as $$
      declare v_ja public.baixas_pagamento%rowtype;
      begin
        if new.parcela_id is null then return new; end if;
        if new.devolvido_em is not null then return new; end if;
        perform 1 from public.parcelas where id = new.parcela_id for update;
        select * into v_ja from public.baixas_pagamento
         where parcela_id = new.parcela_id and devolvido_em is null limit 1;
        if found then
          raise exception 'Esta parcela ja tem baixa registrada' using errcode='P0001';
        end if;
        return new;
      end $$;
    create trigger trg_baixa_viva_unica_por_parcela before insert on public.baixas_pagamento
      for each row execute function _baixa_viva_unica_por_parcela();

    create function public._bloquear_baixa_acordo_encerrado() returns trigger
      language plpgsql as $$
      declare v_status text;
      begin
        if new.acordo_id is null then return new; end if;
        if coalesce(new.status_baixa,'') <> 'REALIZADA' then return new; end if;
        select upper(coalesce(status,'')) into v_status from public.acordos where id = new.acordo_id;
        if v_status = 'CANCELADO' then
          raise exception 'acordo_cancelado_operacao_nao_permitida' using errcode='P0001';
        end if;
        return new;
      end $$;
    create trigger trg_bloquear_baixa_acordo_encerrado before insert or update
      on public.baixas_pagamento for each row execute function _bloquear_baixa_acordo_encerrado();

    -- recalcula o aluno: AQUI e desejado que rode
    create function public._trg_recalc_por_aluno_text() returns trigger
      language plpgsql as $$
      begin
        update public.alunos set situacao_operacional='RECALCULADO', atualizado_em=now()
         where id::text = coalesce(new.aluno_id, old.aluno_id);
        return null;
      end $$;
    create trigger trg_recalc_baixa after insert or update on public.baixas_pagamento
      for each row execute function _trg_recalc_por_aluno_text();

    -- pago_em automatico: SO quando vem nulo
    create function public._parcela_pago_em_automatico() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'PAGO' and new.pago_em is null then new.pago_em := now(); end if;
        return new;
      end $$;
    create trigger trg_parcela_pago_em_automatico before insert or update on public.parcelas
      for each row execute function _parcela_pago_em_automatico();

    -- o acordo fecha so quando NAO sobra parcela em aberto
    create function public._acordo_fecha_com_a_ultima_parcela() returns trigger
      language plpgsql as $$
      declare v_acordo uuid := coalesce(new.acordo_id, old.acordo_id);
      begin
        update public.acordos a set status='QUITADO', saldo=0, atualizado_em=now()
         where a.id = v_acordo and upper(coalesce(a.status,''))='ATIVO'
           and exists (select 1 from public.parcelas p where p.acordo_id=a.id)
           and not exists (select 1 from public.parcelas p where p.acordo_id=a.id
                            and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));
        return null;
      end $$;
    create trigger trg_acordo_fecha_com_a_ultima_parcela after update of status on public.parcelas
      for each row execute function _acordo_fecha_com_a_ultima_parcela();
  `);
  return db;
}

async function semear(db, over = {}) {
  await db.query(`insert into public.alunos (id,nome,cpf,situacao_operacional)
    values ($1,'Aluno de Teste','00000000000','EM_DIA')`, [ALUNO]);
  await db.query(`insert into public.acordos (id,aluno_id,status,numero_acordo,operador_responsavel_email,criado_por_email)
    values ($1,$2,$3,475,'operador@aelbra.com.br','importacao@sistema')`,
    [ACORDO, ALUNO, over.acordoStatus ?? "ATIVO"]);
  await db.query(`insert into public.parcelas (id,acordo_id,numero,boleto,status,valor,honorarios,vencimento,observacao)
    values ($1,$2,3,$3,$4,291.48,21.59,'2026-09-03',
      'baixa em 01/09/2026 pelo documento: pago R$ 297.61 para parcela de R$ 291.48 -- diferenca e juros e multa')`,
    [PARCELA, ACORDO, over.boleto ?? "50611040003", over.parcelaStatus ?? "VENCIDA"]);
  // a parcela 4 segura o acordo ATIVO
  await db.query(`insert into public.parcelas (id,acordo_id,numero,boleto,status,valor,vencimento)
    values ($1,$2,4,'50611040004','A_VENCER',291.50,'2026-10-03')`, [P4, ACORDO]);
  if (over.semPagamento !== true) {
    await db.query(`insert into public.pagamentos (numero_parcela_completo,valor_pago,valor_honorario,data_pagamento)
      values ($1,$2,$3,$4)`,
      [over.boleto ?? "50611040003", over.valor ?? 297.61, over.honor ?? 21.59, over.data ?? "2026-08-17"]);
  }
}

const parcela = (db) => um(db, `select to_jsonb(p) from public.parcelas p where id=$1`, [PARCELA]);
const vivas = (db) => um(db, `select count(*)::int from public.baixas_pagamento
  where parcela_id=$1 and devolvido_em is null`, [PARCELA]);

describe("correcao de legado: boleto 50611040003", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("a parcela vai de VENCIDA para PAGO com pago_em em 17/08/2026", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    const p = await parcela(db);
    expect(p.status).toBe("PAGO");
    expect(String(p.pago_em)).toMatch(/2026-08-17/);
    expect(p.confirmado_por_email).toBe("correcao-legado@sistema");
  });

  it("cria exatamente uma baixa viva, com valor, honorario, data e autoria certos", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    expect(await vivas(db)).toBe(1);
    const b = await um(db, `select to_jsonb(b) from public.baixas_pagamento b where parcela_id=$1`, [PARCELA]);
    expect(Number(b.valor_pago)).toBe(297.61);
    expect(Number(b.honorarios_recebidos)).toBe(21.59);
    expect(String(b.data_pagamento)).toMatch(/2026-08-17/);
    expect(b.status_baixa).toBe("REALIZADA");
    expect(b.baixado_por_email).toBe("correcao-legado@sistema");
    // o responsavel segue a regra do fluxo oficial: a carteira do acordo
    expect(b.responsavel_baixa_email).toBe("operador@aelbra.com.br");
  });

  it("nao falsifica pessoa: nenhum e-mail humano aparece como quem executou", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    const b = await um(db, `select to_jsonb(b) from public.baixas_pagamento b where parcela_id=$1`, [PARCELA]);
    expect(b.baixado_por_email).toMatch(/@sistema$/);
    expect(b.baixado_por_nome).toMatch(/[Cc]orrecao automatica/);
    const p = await parcela(db);
    expect(p.confirmado_por_email).toMatch(/@sistema$/);
  });

  it("registra a procedencia na baixa e na parcela, sem apagar a observacao antiga", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    const b = await um(db, `select observacao_operador from public.baixas_pagamento where parcela_id=$1`, [PARCELA]);
    expect(b).toMatch(/CORRECAO_LEGADO_50611040003_20260922/);
    const p = await parcela(db);
    expect(p.observacao).toContain("baixa em 01/09/2026 pelo documento");   // a antiga fica
    expect(p.observacao).toMatch(/baixa automatica de legado/);             // a nova entra
    expect(p.observacao).toContain("6,13");
  });

  it("o acordo continua ATIVO -- a parcela 4 segue em aberto", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    expect(await um(db, `select status from public.acordos where id=$1`, [ACORDO])).toBe("ATIVO");
    expect(await um(db, `select status from public.parcelas where id=$1`, [P4])).toBe("A_VENCER");
  });

  it("o recalculo do aluno ACONTECE -- aqui e desejado", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    expect(await um(db, `select situacao_operacional from public.alunos where id=$1`, [ALUNO])).toBe("RECALCULADO");
  });

  it("nenhuma outra parcela e nenhum pagamento sao alterados", async () => {
    await semear(db);
    const p4 = await um(db, `select to_jsonb(p) from public.parcelas p where id=$1`, [P4]);
    const pg = await um(db, `select jsonb_agg(to_jsonb(g) order by g.id) from public.pagamentos g`);
    await db.exec(MIGRATION);
    expect(await um(db, `select to_jsonb(p) from public.parcelas p where id=$1`, [P4])).toEqual(p4);
    expect(await um(db, `select jsonb_agg(to_jsonb(g) order by g.id) from public.pagamentos g`)).toEqual(pg);
  });

  it("rodar duas vezes nao cria duplicidade: a segunda aborta", async () => {
    await semear(db);
    await db.exec(MIGRATION);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ABORTADO/);
    expect(await vivas(db)).toBe(1);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento`)).toBe(1);
  });

  // ---- as premissas, uma a uma ----
  const casos = [
    ["acordo nao esta ATIVO", { acordoStatus: "QUITADO" }],
    ["parcela nao esta VENCIDA", { parcelaStatus: "A_VENCER" }],
    ["nao existe pagamento", { semPagamento: true }],
    ["valor diferente", { valor: 300.00 }],
    ["data diferente", { data: "2026-08-18" }],
    ["honorario diferente", { honor: 20.00 }],
  ];
  for (const [nome, over] of casos) {
    it(`ABORTA quando ${nome}`, async () => {
      await semear(db, over);
      await expect(db.exec(MIGRATION)).rejects.toThrow(/ABORTADO/);
      expect(await vivas(db)).toBe(0);
      expect(await um(db, `select status from public.parcelas where id=$1`, [PARCELA]))
        .toBe(over.parcelaStatus ?? "VENCIDA");
    });
  }

  it("ABORTA quando ha dois pagamentos para o mesmo boleto", async () => {
    await semear(db);
    await db.query(`insert into public.pagamentos (numero_parcela_completo,valor_pago,valor_honorario,data_pagamento)
      values ('50611040003',297.61,21.59,'2026-08-17')`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ABORTADO/);
    expect(await vivas(db)).toBe(0);
  });

  // A guarda de "exatamente 1 pagamento" protege um caso que a guarda de
  // valor/data/honorario NAO pega: dois pagamentos no mesmo boleto com valores
  // DIFERENTES -- ali a segunda guarda contaria 1 e deixaria passar, mas ha
  // dinheiro nao explicado no boleto e a correcao nominal deixa de ser segura.
  it("ABORTA quando ha um segundo pagamento no boleto com valor diferente", async () => {
    await semear(db);
    await db.query(`insert into public.pagamentos (numero_parcela_completo,valor_pago,valor_honorario,data_pagamento)
      values ('50611040003',150.00,0,'2026-08-20')`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ABORTADO/);
    expect(await vivas(db)).toBe(0);
    expect(await um(db, `select status from public.parcelas where id=$1`, [PARCELA])).toBe("VENCIDA");
  });

  it("ABORTA quando o boleto aparece em duas parcelas", async () => {
    await semear(db);
    await db.query(`insert into public.parcelas (id,acordo_id,numero,boleto,status,valor,vencimento)
      values (gen_random_uuid(),$1,9,'50611040003','VENCIDA',291.48,'2026-11-03')`, [ACORDO]);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ABORTADO/);
    expect(await vivas(db)).toBe(0);
  });

  it("ABORTA quando a parcela ja tem baixa, mesmo devolvida", async () => {
    await semear(db);
    await db.query(`insert into public.baixas_pagamento (parcela_id,acordo_id,aluno_id,valor_pago,status_baixa,devolvido_em)
      values ($1,$2,$3,297.61,'BAIXA_DEVOLVIDA', now())`, [PARCELA, ACORDO, ALUNO]);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ABORTADO/);
    expect(await um(db, `select status from public.parcelas where id=$1`, [PARCELA])).toBe("VENCIDA");
  });
});

describe("rollback da correcao de legado", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await semear(db); await db.exec(MIGRATION); });

  it("devolve a parcela a VENCIDA, sem pago_em, e remove a baixa criada", async () => {
    await db.exec(ROLLBACK);
    const p = await parcela(db);
    expect(p.status).toBe("VENCIDA");
    expect(p.pago_em).toBeNull();
    expect(p.confirmado_por_email).toBeNull();
    expect(p.observacao).toBe("baixa em 01/09/2026 pelo documento: pago R$ 297.61 para parcela de R$ 291.48 -- diferenca e juros e multa");
    expect(await um(db, `select count(*)::int from public.baixas_pagamento`)).toBe(0);
  });

  it("nao toca no acordo, na parcela 4 nem nos pagamentos", async () => {
    const ac = await um(db, `select to_jsonb(a) from public.acordos a where id=$1`, [ACORDO]);
    const p4 = await um(db, `select to_jsonb(p) from public.parcelas p where id=$1`, [P4]);
    const pg = await um(db, `select jsonb_agg(to_jsonb(g)) from public.pagamentos g`);
    await db.exec(ROLLBACK);
    expect(await um(db, `select to_jsonb(a) from public.acordos a where id=$1`, [ACORDO])).toEqual(ac);
    expect(await um(db, `select to_jsonb(p) from public.parcelas p where id=$1`, [P4])).toEqual(p4);
    expect(await um(db, `select jsonb_agg(to_jsonb(g)) from public.pagamentos g`)).toEqual(pg);
  });

  it("ABORTA se aparecer outra baixa na parcela -- nao apaga o que nao criou", async () => {
    await db.query(`update public.baixas_pagamento set baixado_por_email='alguem@aelbra.com.br'
                     where parcela_id=$1`, [PARCELA]);
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/ROLLBACK ABORTADO/);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento`)).toBe(1);
  });

  it("depois do rollback, a migration pode rodar de novo do zero", async () => {
    await db.exec(ROLLBACK);
    await db.exec(MIGRATION);
    expect(await vivas(db)).toBe(1);
    expect(await um(db, `select status from public.parcelas where id=$1`, [PARCELA])).toBe("PAGO");
  });
});
