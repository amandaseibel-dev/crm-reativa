// SANEAMENTO DAS 10 BAIXAS EXCEDENTES -- COMPORTAMENTO.
//
// Roda a migration REAL num PostgreSQL real (PGlite), sobre uma bancada que
// reproduz os quatro gatilhos de `baixas_pagamento` em producao -- inclusive os
// dois que a migration precisa silenciar (`trg_notif_divergencia_cartao`, que
// mandaria aviso falso de cartao, e `trg_recalc_baixa`, que escreveria em
// `alunos`). Os UUIDs abaixo sao os MESMOS da migration: se a lista literal
// mudar, estes testes quebram, que e o que se quer.
//
// NENHUM DADO REAL -- nomes e valores reproduzem a forma dos casos, nao a
// identidade de ninguem.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20260922300000_saneamento_dupla_baixa_historica.sql");
const ROLLBACK = ler("supabase/rollbacks/20260922300000_saneamento_dupla_baixa_historica.rollback.sql");

// os 10 pares, na ordem da migration: [devolver, fica, parcela]
const PARES = [
  ["41fcfcd6-8e6d-4636-884e-694b62b0a46b", "67f3e82a-0357-4d26-a822-50d948c2f716", "f41f03d3-e260-41d4-8299-bdba04ed5a17", 7873.68, 583.24],
  ["bd2fe50e-b2e2-49a5-bf71-836dac3ccd12", "e967c28d-3855-408d-949a-e4fc14ae1d98", "42319df4-06ae-43cb-9b68-3473a74fb63b", 1775.33, 131.51],
  ["f18fc685-8ba8-4254-ab48-f65b59505af8", "7d3a56fd-8b81-4deb-bf41-e05abd56adcf", "2ad09a00-101a-4431-8a74-9f3013b26b1a", 1637.95, 0],
  ["b7b336d1-8cc5-4114-90ac-0e958ad05560", "69c30813-7080-4d37-8a35-7532af67ce58", "84f8349f-eecb-4ea1-8d3d-6a4474a91f83", 1288.30, 0],
  ["9953927f-c80e-45e1-9e85-117b6a4d0fe6", "6f9009a7-d7d7-43d1-8971-94e3f33889e7", "4590c339-b5b8-4e71-9d99-48d67f9bf26f", 813.56, 0],
  ["3d9cf264-c8de-43cc-af57-7424f6cfca1c", "7544fc96-864b-4a31-8437-c6b6b7bd968b", "2e01f8a2-e384-4ff8-acce-f13a2b3bb9fd", 813.56, 0],
  ["80832d6f-b09c-40ab-9140-1e220dc1bfd6", "a83d863c-c149-47e0-b3bc-6148e5434b51", "15ea01b8-cb55-4aa6-b7bd-90234831f3e7", 813.56, 0],
  ["ec2fb7c7-5dc4-43e2-be88-00db70557018", "94bacbc9-3db3-46a0-8a71-f9ca59196c81", "d1cc1b6a-b4d9-4690-8e4f-996eb0e8dc60", 620.49, 0],
  ["4f84aff9-a590-4f21-b572-90e11857c664", "ce426d07-0807-4795-ad37-2fa4d52fedca", "c0f1d10f-c563-4be4-84ea-69b3a573d74f", 488.68, 0],
  ["c5a391ec-3f1d-4e65-b6bf-16e67f8e8cb1", "935ed174-0ed5-45c9-8759-80d3f0a41606", "365a7b42-26b5-40b5-b7d6-59c4a5645bc5", 309.73, 22.94],
];
const MAIARA_PARCELA = "e62006af-a61e-43eb-9729-367819c06e76";
const MAIARA_B1 = "aaaaaaaa-0000-4000-8000-000000000001";
const MAIARA_B2 = "aaaaaaaa-0000-4000-8000-000000000002";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create table public.alunos (id uuid primary key, nome text,
      status_atual text, status_acionamento text, proxima_acao text, fila_destino text,
      situacao_operacional text, saldo_total numeric, atualizado_em timestamptz default now());

    create table public.acordos (id uuid primary key, aluno_id uuid, status text default 'ATIVO',
      numero_acordo bigint, atualizado_em timestamptz default now());

    create table public.parcelas (id uuid primary key, acordo_id uuid, numero int,
      status text default 'PAGO', valor numeric, pago_em timestamptz,
      atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key, aluno_id text,
      parcela_id uuid references public.parcelas(id), acordo_id uuid references public.acordos(id),
      valor_pago numeric, honorarios_recebidos numeric, status_baixa text,
      responsavel_baixa_email text, operador_origem_email text, baixado_por_email text,
      aluno_nome text, baixado_em timestamptz, devolvido_em timestamptz,
      devolvido_por_email text, motivo_devolucao text, atualizado_em timestamptz default now());

    create table public.notificacoes (id bigserial primary key, usuario_destino_email text,
      tipo text, titulo text, mensagem text, aluno_id text, baixa_id uuid,
      url_destino text, lida boolean, criado_em timestamptz default now());

    -- GATILHO 1: o aviso falso de cartao (copia da logica de producao)
    create function public.tg_notif_divergencia_cartao() returns trigger
      language plpgsql as $$
      declare v_dest text := lower(coalesce(new.responsavel_baixa_email, new.operador_origem_email, ''));
      begin
        if new.devolvido_em is not null
           and (tg_op = 'INSERT' or old.devolvido_em is distinct from new.devolvido_em)
           and v_dest <> '' and v_dest <> 'amanda.seibel@aelbra.com.br' then
          insert into public.notificacoes(usuario_destino_email, tipo, titulo, mensagem, baixa_id)
          values (v_dest, 'DIVERGENCIA_CARTAO', 'Divergencia de cartao', 'voltou para voce', new.id);
        end if;
        return new;
      end $$;
    create trigger trg_notif_divergencia_cartao after insert or update of devolvido_em
      on public.baixas_pagamento for each row execute function tg_notif_divergencia_cartao();

    -- GATILHO 2: o recalculo que escreve em alunos
    create function public._trg_recalc_por_aluno_text() returns trigger
      language plpgsql as $$
      begin
        update public.alunos set situacao_operacional = 'RECALCULADO', atualizado_em = now()
         where id::text = coalesce(new.aluno_id, old.aluno_id);
        return null;
      end $$;
    create trigger trg_recalc_baixa after insert or update on public.baixas_pagamento
      for each row execute function _trg_recalc_por_aluno_text();

    -- GATILHO 3: o que bloqueia baixa em acordo cancelado (nao pode barrar aqui)
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
  `);
  return db;
}

async function semear(db) {
  const al = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const ac = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let i = 0;
  for (const [dev, fica, parc, valor, hon] of PARES) {
    i++;
    await db.query(`insert into public.alunos (id, nome, status_atual, status_acionamento, proxima_acao, situacao_operacional)
                    values ($1,$2,'Em cobranca','ACORDO_FECHADO','lembrar o aluno','EM_DIA')`, [al(i), "Aluno " + i]);
    await db.query(`insert into public.acordos (id, aluno_id, status, numero_acordo) values ($1,$2,'QUITADO',$3)`, [ac(i), al(i), 1000 + i]);
    await db.query(`insert into public.parcelas (id, acordo_id, numero, status, valor, pago_em)
                    values ($1,$2,1,'PAGO',$3, now())`, [parc, ac(i), valor]);
    for (const [id, quando] of [[fica, "2026-08-01 10:00:00+00"], [dev, "2026-08-01 10:00:07+00"]]) {
      await db.query(`insert into public.baixas_pagamento
          (id, aluno_id, parcela_id, acordo_id, valor_pago, honorarios_recebidos, status_baixa,
           responsavel_baixa_email, baixado_por_email, aluno_nome, baixado_em)
         values ($1,$2,$3,$4,$5,$6,'REALIZADA','cobranca0'||$7||'@aelbra.com.br','amanda.seibel@aelbra.com.br',$8,$9)`,
        [id, al(i), parc, ac(i), valor, hon, i % 9, "Aluno " + i, quando]);
    }
  }
  // a 11a: Maiara, que NAO pode ser tocada
  await db.query(`insert into public.alunos (id, nome, status_atual, situacao_operacional) values ($1,'Maiara','AGUARDANDO_BAIXA','EM_DIA')`, [al(99)]);
  await db.query(`insert into public.acordos (id, aluno_id, status, numero_acordo) values ($1,$2,'ATIVO',912)`, [ac(99), al(99)]);
  await db.query(`insert into public.parcelas (id, acordo_id, numero, status, valor, pago_em)
                  values ($1,$2,1,'PAGO',634.46, now())`, [MAIARA_PARCELA, ac(99)]);
  for (const [id, quando] of [[MAIARA_B1, "2026-08-28 16:56:54+00"], [MAIARA_B2, "2026-09-10 16:46:06+00"]]) {
    await db.query(`insert into public.baixas_pagamento
        (id, aluno_id, parcela_id, acordo_id, valor_pago, honorarios_recebidos, status_baixa,
         responsavel_baixa_email, baixado_por_email, aluno_nome, baixado_em)
       values ($1,$2,$3,$4,634.46,0,'REALIZADA','cobranca06@aelbra.com.br','amanda.seibel@aelbra.com.br','Maiara',$5)`,
      [id, al(99), MAIARA_PARCELA, ac(99), quando]);
  }
  // as notificacoes geradas pela SEMEADURA nao interessam: zera o contador
  await db.query(`delete from public.notificacoes`);
  await db.query(`update public.alunos set situacao_operacional='EM_DIA', atualizado_em='2026-01-01'`);
}

const vivas = (db, parcela) => um(db, `select count(*)::int from public.baixas_pagamento
  where parcela_id=$1 and devolvido_em is null`, [parcela]);

describe("saneamento das 10 baixas excedentes", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await semear(db); });

  it("saneia exatamente os 10 IDs da lista, e nenhum outro", async () => {
    await db.exec(MIGRATION);
    const devolvidas = await um(db, `select coalesce(jsonb_agg(id order by id),'[]'::jsonb)
      from public.baixas_pagamento where devolvido_em is not null`);
    expect(devolvidas).toHaveLength(10);
    expect(devolvidas.sort()).toEqual(PARES.map((p) => p[0]).sort());
  });

  it("a baixa que PERMANECE continua viva e REALIZADA nas 10 parcelas", async () => {
    await db.exec(MIGRATION);
    for (const [, fica] of PARES) {
      const b = await um(db, `select to_jsonb(b) from public.baixas_pagamento b where id=$1`, [fica]);
      expect(b.devolvido_em).toBeNull();
      expect(b.status_baixa).toBe("REALIZADA");
    }
  });

  it("a baixa excedente passa a BAIXA_DEVOLVIDA, com motivo e autor", async () => {
    await db.exec(MIGRATION);
    for (const [dev, fica] of PARES) {
      const b = await um(db, `select to_jsonb(b) from public.baixas_pagamento b where id=$1`, [dev]);
      expect(b.status_baixa).toBe("BAIXA_DEVOLVIDA");
      expect(b.devolvido_em).not.toBeNull();
      expect(b.devolvido_por_email).toBe("saneamento@sistema");
      expect(b.motivo_devolucao).toMatch(/^SANEAMENTO_DUPLICIDADE_HISTORICA_20260922/);
      expect(b.motivo_devolucao).toContain(fica);   // diz qual ficou
    }
  });

  it("o caso da rotina/sufixo registra o motivo especifico", async () => {
    await db.exec(MIGRATION);
    const m = await um(db, `select motivo_devolucao from public.baixas_pagamento
      where id='c5a391ec-3f1d-4e65-b6bf-16e67f8e8cb1'`);
    expect(m).toMatch(/rotina de baixa pelo documento/i);
    expect(m).toContain("50608170003");
    expect(m).toContain("50608170004");
  });

  it("MAIARA nao e tocada: segue com 2 baixas vivas", async () => {
    await db.exec(MIGRATION);
    expect(await vivas(db, MAIARA_PARCELA)).toBe(2);
    for (const id of [MAIARA_B1, MAIARA_B2]) {
      const b = await um(db, `select to_jsonb(b) from public.baixas_pagamento b where id=$1`, [id]);
      expect(b.devolvido_em).toBeNull();
      expect(b.status_baixa).toBe("REALIZADA");
      expect(b.motivo_devolucao).toBeNull();
    }
  });

  it("duplicidades: 11 -> 1 (so a da Maiara)", async () => {
    expect(await um(db, `select count(*)::int from (select parcela_id from public.baixas_pagamento
      where devolvido_em is null group by 1 having count(*)>1) x`)).toBe(11);
    await db.exec(MIGRATION);
    const restantes = await um(db, `select coalesce(jsonb_agg(parcela_id),'[]'::jsonb) from (
      select parcela_id from public.baixas_pagamento where devolvido_em is null
       group by 1 having count(*)>1) x`);
    expect(restantes).toEqual([MAIARA_PARCELA]);
  });

  it("nenhuma parcela muda: todas seguem PAGO, mesmo valor, mesmo atualizado_em", async () => {
    const antes = await um(db, `select jsonb_agg(to_jsonb(p) order by p.id) from public.parcelas p`);
    await db.exec(MIGRATION);
    expect(await um(db, `select jsonb_agg(to_jsonb(p) order by p.id) from public.parcelas p`)).toEqual(antes);
  });

  it("nenhum aluno muda de estado -- o recalculo nao escreve", async () => {
    const antes = await um(db, `select jsonb_agg(to_jsonb(a) order by a.id) from public.alunos a`);
    await db.exec(MIGRATION);
    expect(await um(db, `select jsonb_agg(to_jsonb(a) order by a.id) from public.alunos a`)).toEqual(antes);
  });

  it("nenhum acordo muda", async () => {
    const antes = await um(db, `select jsonb_agg(to_jsonb(a) order by a.id) from public.acordos a`);
    await db.exec(MIGRATION);
    expect(await um(db, `select jsonb_agg(to_jsonb(a) order by a.id) from public.acordos a`)).toEqual(antes);
  });

  it("nenhuma notificacao de divergencia de cartao e criada", async () => {
    await db.exec(MIGRATION);
    expect(await um(db, `select count(*)::int from public.notificacoes`)).toBe(0);
    expect(await um(db, `select count(*)::int from public.notificacoes where tipo='DIVERGENCIA_CARTAO'`)).toBe(0);
  });

  it("os gatilhos terminam TODOS habilitados", async () => {
    await db.exec(MIGRATION);
    expect(await um(db, `select count(*)::int from pg_trigger
      where tgrelid='public.baixas_pagamento'::regclass and not tgisinternal and tgenabled <> 'O'`)).toBe(0);
    expect(await um(db, `select count(*)::int from pg_trigger
      where tgrelid='public.baixas_pagamento'::regclass
        and tgname in ('trg_notif_divergencia_cartao','trg_recalc_baixa') and tgenabled='O'`)).toBe(2);
  });

  it("historico preservado: as 22 linhas continuam existindo, nada e apagado", async () => {
    const antes = await um(db, `select count(*)::int from public.baixas_pagamento`);
    await db.exec(MIGRATION);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento`)).toBe(antes);
    expect(antes).toBe(22);
  });

  it("acordo QUITADO nao barra o saneamento (trg_bloquear so olha REALIZADA)", async () => {
    expect(await um(db, `select count(*)::int from public.acordos where status='QUITADO'`)).toBe(10);
    await expect(db.exec(MIGRATION)).resolves.not.toThrow();
  });

  it("se uma das 10 ja estiver devolvida, a migration ABORTA inteira", async () => {
    await db.query(`update public.baixas_pagamento set devolvido_em=now(), status_baixa='BAIXA_DEVOLVIDA'
                     where id=$1`, [PARES[0][0]]);
    await db.query(`delete from public.notificacoes`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/SANEAMENTO ABORTADO/);
    // nada mais foi devolvido
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where devolvido_em is not null`)).toBe(1);
  });

  it("se a parcela nao tiver 2 baixas vivas, a migration ABORTA inteira", async () => {
    await db.query(`delete from public.baixas_pagamento where id=$1`, [PARES[1][0]]);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/SANEAMENTO ABORTADO/);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where devolvido_em is not null`)).toBe(0);
  });
});

describe("rollback do saneamento", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await semear(db); await db.exec(MIGRATION); });

  it("restaura exatamente as 10, e as duplicidades voltam a 11", async () => {
    await db.exec(ROLLBACK);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where devolvido_em is not null`)).toBe(0);
    for (const [dev] of PARES) {
      const b = await um(db, `select to_jsonb(b) from public.baixas_pagamento b where id=$1`, [dev]);
      expect(b.status_baixa).toBe("REALIZADA");
      expect(b.motivo_devolucao).toBeNull();
      expect(b.devolvido_por_email).toBeNull();
    }
    expect(await um(db, `select count(*)::int from (select parcela_id from public.baixas_pagamento
      where devolvido_em is null group by 1 having count(*)>1) x`)).toBe(11);
  });

  it("o rollback nao toca na Maiara, nem em parcelas, alunos ou acordos", async () => {
    const p = await um(db, `select jsonb_agg(to_jsonb(x) order by x.id) from public.parcelas x`);
    const a = await um(db, `select jsonb_agg(to_jsonb(x) order by x.id) from public.alunos x`);
    const c = await um(db, `select jsonb_agg(to_jsonb(x) order by x.id) from public.acordos x`);
    await db.exec(ROLLBACK);
    expect(await um(db, `select jsonb_agg(to_jsonb(x) order by x.id) from public.parcelas x`)).toEqual(p);
    expect(await um(db, `select jsonb_agg(to_jsonb(x) order by x.id) from public.alunos x`)).toEqual(a);
    expect(await um(db, `select jsonb_agg(to_jsonb(x) order by x.id) from public.acordos x`)).toEqual(c);
    expect(await vivas(db, MAIARA_PARCELA)).toBe(2);
  });

  it("o rollback nao gera notificacao e devolve os gatilhos habilitados", async () => {
    await db.query(`delete from public.notificacoes`);
    await db.exec(ROLLBACK);
    expect(await um(db, `select count(*)::int from public.notificacoes`)).toBe(0);
    expect(await um(db, `select count(*)::int from pg_trigger
      where tgrelid='public.baixas_pagamento'::regclass and not tgisinternal and tgenabled <> 'O'`)).toBe(0);
  });

  it("nao reverte linha devolvida por OUTRO motivo depois do saneamento", async () => {
    await db.query(`update public.baixas_pagamento
        set motivo_devolucao='DEVOLUCAO_OPERACIONAL_LEGITIMA' where id=$1`, [PARES[3][0]]);
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/ROLLBACK ABORTADO/);
    expect(await um(db, `select count(*)::int from public.baixas_pagamento where devolvido_em is not null`)).toBe(10);
  });
});
