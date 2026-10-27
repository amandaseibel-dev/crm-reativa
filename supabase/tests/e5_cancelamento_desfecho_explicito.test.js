// E5: O CANCELAMENTO DEVOLVE O DESFECHO, NAO "ok: true" INDISTINTO --
// COMPORTAMENTO, nao estrutura.
//
// Roda as migrations REAIS, nesta ordem, num PostgreSQL real (PGlite):
//   20260922265000  a regra de 22/09 (acordo cancelado nao reabre)
//   20260925123852  a regra de 25/09 (sem pagamento na cadeia, reabre)
//   20261026180000  a E5 (aguardando_aprovacao/, NAO aplicada em producao)
//
// Bancada minima copiada de
// acordo_cancelado_sem_pagamento_reabre_mensalidade.test.js, mais o que a E5
// le: `origem_liquidacao`, `origem_liquidacao_ref`, `origem_encerramento`,
// a tabela `auditoria` e o duble de `auth.jwt()`.
//
// Os testes "SEM A E5" rodam so as duas primeiras para provar que o defeito
// relatado existe: os tres desfechos sao indistinguiveis no retorno. O teste
// de rollback prova que o arquivo de rollback devolve o corpo de producao, por
// md5(prosrc).
//
// liberar_caso_por_evento, crm_usuario_pode_quitar_baixar e auth.jwt sao
// DUBLES. NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const REGRA_22_09 = ler("supabase/migrations/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql");
const REGRA_25_09 = ler("supabase/migrations/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.sql");
const E5 = ler("supabase/aguardando_aprovacao/20261026180000_e5_cancelamento_desfecho_explicito.sql.pendente");
const E5_ROLLBACK = ler("supabase/aguardando_aprovacao/20261026180000_e5_cancelamento_desfecho_explicito.rollback.sql");

// Corpo de cancelar_acordo_ficha em producao em 26/10/2026 (versao
// 20260925123852). O rollback tem de devolver EXATAMENTE este.
const MD5_PRODUCAO = "130665ad5be7b222b74875ebcc767719";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco({ aplicar = [REGRA_22_09, REGRA_25_09, E5] } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.email() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email' $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric, qtd_parcelas int default 1, saldo numeric,
      numero_acordo bigint, numero_ulbra text, motivo_ajuste text,
      criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      documento text, valor_original numeric, valor_em_aberto numeric, situacao text, status text,
      tipo_boleto text default 'Cursos de Graduação', acordo_id uuid, motivo_ajuste text,
      origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamptz,
      origem_encerramento text,
      atualizado_em timestamptz default now());

    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text, origem text,
      criado_em timestamptz default clock_timestamp());

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      status text default 'A_VENCER', valor numeric, atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);

    create table public.auditoria (id bigserial primary key, usuario text, acao text,
      tabela_afetada text, registro_id uuid, detalhes jsonb, criado_em timestamptz default now());

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

const acordoFn = (db, aluno_id, { valor_total = 1000, qtd_parcelas = 1, status = "ATIVO", numero = 1 } = {}) =>
  um(db, `insert into public.acordos (aluno_id, valor_total, qtd_parcelas, status, numero_acordo)
          values ($1,$2,$3,$4,$5) returning id`, [aluno_id, valor_total, qtd_parcelas, status, numero]);

const titulo = (db, aluno_id, { valor_original = 1000, tipo_boleto = "Cursos de Graduação" } = {}) =>
  um(db, `insert into public.acordos_titulos (aluno_id, situacao, status, valor_original, valor_em_aberto, tipo_boleto)
          values ($1,'ABERTO','em_aberto',$2,$2,$3) returning id`, [aluno_id, valor_original, tipo_boleto]);

const vincular = (db, tituloId, acordoId) =>
  db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, origem)
            values ($1,$2,true,'EXATO_PRIME_195')`, [acordoId, tituloId]);

const parcela = (db, acordoId, status = "A_VENCER", valor = 1000) =>
  um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,$2,$3) returning id`,
    [acordoId, status, valor]);

const cancelar = (db, acordoId) => um(db, `select public.cancelar_acordo_ficha($1)`, [acordoId]);

const estado = async (db, tituloId) => {
  const l = await um(db, `select to_jsonb(t) from public.acordos_titulos t where id = $1`, [tituloId]);
  return { situacao: l.situacao, status: l.status, acordo_id: l.acordo_id };
};
const ABERTO = { situacao: "ABERTO", status: "em_aberto", acordo_id: null };

const md5Corpo = (db) =>
  um(db, `select md5(prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='cancelar_acordo_ficha'`);

// `count(*)` volta como numero ou BigInt dependendo do caminho -- comparar
// sempre convertido, senao a asserties falha por tipo e nao por comportamento.
const contaAuditoria = async (db) =>
  Number(await um(db, `select count(*) from public.auditoria`));

// Marca o titulo como quitado POR ESTE acordo, do jeito que
// vincular_titulos_acordo deixa em producao: par escrito por fora, sem
// proveniencia. `origem_liquidacao_ref` fica nulo de proposito -- e o estado
// dos 274 titulos da coorte do diagnostico.
const quitarPeloAcordo = (db, tituloId, acordoId) =>
  db.query(`update public.acordos_titulos
               set situacao='PAGO', status='quitada', acordo_id=$2
             where id=$1`, [tituloId, acordoId]);

describe("E5: desfecho do cancelamento", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  // ---------- CENARIO 1: cancelamento efetivo ----------

  it("CANCELAMENTO_EFETIVO: vinculo ativo, mensalidade volta para ABERTO", async () => {
    const al = A(1);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "VENCIDA");
    const t = await titulo(db, al);
    await vincular(db, t, ac);

    const r = await cancelar(db, ac);

    expect(r.ok).toBe(true);
    expect(r.desfecho).toBe("CANCELAMENTO_EFETIVO");
    expect(r.composicao_ausente).toBe(false);
    expect(r.vinculos_desativados).toBe(1);
    expect(r.vinculos_total).toBe(1);
    expect(r.mensalidades_devolvidas).toBe(1);
    expect(r.titulos_conferir).toBe(0);
    // a regra de 25/09 continua valendo: o titulo volta mesmo
    expect(await estado(db, t)).toEqual(ABERTO);
    // e a composicao nao se perde -- vinculo inativo, nunca apagado
    expect(await um(db, `select ativo from public.acordo_titulo_vinculo where titulo_id=$1`, [t])).toBe(false);
  });

  it("CANCELAMENTO_EFETIVO com 0 devolvidas: re-acordo cuja cadeia recebeu dinheiro", async () => {
    const al = A(2);
    // A recebeu dinheiro e esta QUITADO; B e a renegociacao que caiu sem pagar.
    const a = await acordoFn(db, al, { numero: 10 });
    await parcela(db, a, "PAGO");
    const b = await acordoFn(db, al, { numero: 11 });
    await parcela(db, b, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, a);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [a]);
    await vincular(db, t, b);

    const r = await cancelar(db, b);

    expect(r.desfecho).toBe("CANCELAMENTO_EFETIVO");
    expect(r.vinculos_desativados).toBe(1);
    expect(r.mensalidades_devolvidas).toBe(0);
    // A ANCORA DE ATRIBUICAO: o titulo esta quitado por A, nao por B. Sem ela,
    // este caso legitimo apareceria como CONFERENCIA_NECESSARIA.
    expect(r.titulos_conferir).toBe(0);
    const e = await estado(db, t);
    expect(e.situacao).toBe("PAGO");
    expect(e.acordo_id).toBe(a);
  });

  // ---------- CENARIO 2: ausencia legitima de vinculos ----------

  it("COMPOSICAO_AUSENTE: acordo importado sem nenhum vinculo (o caso dos 624)", async () => {
    const al = A(3);
    const ac = await acordoFn(db, al, { valor_total: 936.2 });
    await parcela(db, ac, "A_VENCER", 936.2);
    // o aluno TEM mensalidade em aberto, mas ninguem a amarrou ao acordo
    const t = await titulo(db, al, { valor_original: 826.74 });

    const r = await cancelar(db, ac);

    expect(r.ok).toBe(true);
    expect(r.desfecho).toBe("COMPOSICAO_AUSENTE");
    expect(r.composicao_ausente).toBe(true);
    expect(r.vinculos_desativados).toBe(0);
    expect(r.vinculos_total).toBe(0);
    expect(r.mensalidades_devolvidas).toBe(0);
    expect(r.titulos_conferir).toBe(0);
    expect(r.parcelas_canceladas).toBe(1);
    // a divida original segue EXATAMENTE como estava
    expect(await estado(db, t)).toEqual(ABERTO);
  });

  it("COMPOSICAO_AUSENTE distingue 'nunca teve' de 'ja estava solto' por vinculos_total", async () => {
    const al = A(4);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    // alguem desfez a composicao antes do cancelamento
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [ac]);

    const r = await cancelar(db, ac);

    expect(r.desfecho).toBe("COMPOSICAO_AUSENTE");
    expect(r.vinculos_desativados).toBe(0);
    expect(r.vinculos_total).toBe(1);
  });

  // ---------- CENARIO 3: inconsistencia que exige conferencia ----------

  it("CONFERENCIA_NECESSARIA: sobrou mensalidade quitada presa ao acordo, e NADA e reaberto", async () => {
    const al = A(5);
    const ac = await acordoFn(db, al, { numero: 5038 });
    // acordo QUITADO sem parcela PAGO (quitado por parcela renegociada): e o
    // unico jeito de a trava da ficha deixar cancelar um acordo que quitou
    // mensalidade.
    await parcela(db, ac, "RENEGOCIADA");
    const t = await titulo(db, al, { valor_original: 826.74 });
    await vincular(db, t, ac);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [ac]);
    await quitarPeloAcordo(db, t, ac);
    const antes = await estado(db, t);
    expect(antes.situacao).toBe("PAGO");

    const r = await cancelar(db, ac);

    expect(r.ok).toBe(true);
    expect(r.desfecho).toBe("CONFERENCIA_NECESSARIA");
    expect(r.titulos_conferir).toBe(1);
    expect(r.mensalidades_devolvidas).toBe(0);
    // CONDICAO 3 DO PEDIDO: nao reabre. O titulo sai como entrou.
    expect(await estado(db, t)).toEqual(antes);
    // e fica registrado na auditoria, no mecanismo que ja existe
    const aud = await um(db, `select to_jsonb(a) from public.auditoria a
                               where a.acao='ACORDO_CANCELADO_COM_MENSALIDADE_QUITADA'`);
    expect(aud.registro_id).toBe(ac);
    expect(aud.detalhes.titulos_conferir).toBe(1);
    expect(aud.detalhes.numero_acordo).toBe(5038);
  });

  it("CONFERENCIA_NECESSARIA tem precedencia sobre COMPOSICAO_AUSENTE", async () => {
    const al = A(6);
    const ac = await acordoFn(db, al, { numero: 77 });
    await parcela(db, ac, "RENEGOCIADA");
    // quitado pela COLUNA acordo_id, sem vinculo nenhum -- os 155 alcancaveis
    // so por essa perna
    const t = await titulo(db, al);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [ac]);
    await quitarPeloAcordo(db, t, ac);

    const r = await cancelar(db, ac);

    expect(r.vinculos_desativados).toBe(0);
    expect(r.vinculos_total).toBe(0);
    expect(r.desfecho).toBe("CONFERENCIA_NECESSARIA");
    expect(r.titulos_conferir).toBe(1);
  });

  it("quitacao legitima na origem NAO vira conferencia", async () => {
    const al = A(7);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await db.query(`update public.acordos_titulos
                       set situacao='PAGO', status='quitada', acordo_id=$2,
                           origem_liquidacao='PRIME_LIQUIDACAO_OFICIAL',
                           origem_liquidacao_ref='pagamento-real'
                     where id=$1`, [t, ac]);

    const r = await cancelar(db, ac);

    expect(r.titulos_conferir).toBe(0);
    expect(r.desfecho).toBe("CANCELAMENTO_EFETIVO");
    // segue quitado: liquidacao na origem e terminal
    expect((await estado(db, t)).situacao).toBe("PAGO");
  });

  it("encerramento administrativo NAO vira conferencia", async () => {
    const al = A(8);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await db.query(`update public.acordos_titulos
                       set situacao='PAGO', status='quitada', acordo_id=$2,
                           origem_encerramento='CONFERENCIA_PRIME'
                     where id=$1`, [t, ac]);

    const r = await cancelar(db, ac);

    expect(r.titulos_conferir).toBe(0);
    expect(r.desfecho).toBe("CANCELAMENTO_EFETIVO");
  });

  // ---------- preservacao e travas (condicoes 1 e 3) ----------

  it("as duas travas de entrada continuam recusando, e nada e tocado", async () => {
    const al = A(9);
    const comPaga = await acordoFn(db, al);
    await parcela(db, comPaga, "PAGO");
    await expect(cancelar(db, comPaga)).rejects.toThrow(/parcela paga/i);
    expect(await um(db, `select status from public.acordos where id=$1`, [comPaga])).toBe("ATIVO");

    const comBaixa = await acordoFn(db, al, { numero: 2 });
    await parcela(db, comBaixa, "A_VENCER");
    await db.query(`insert into public.baixas_pagamento (acordo_id) values ($1)`, [comBaixa]);
    await expect(cancelar(db, comBaixa)).rejects.toThrow(/baixa\/pagamento/i);
    expect(await um(db, `select status from public.acordos where id=$1`, [comBaixa])).toBe("ATIVO");

    // recusa na entrada nao chega a medir desfecho nenhum: a excecao aborta
    // antes, e `auditoria` fica vazia.
    expect(await contaAuditoria(db)).toBe(0);
  });

  it("a auditoria NAO e escrita quando nao ha o que conferir", async () => {
    const al = A(10);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);

    await cancelar(db, ac);

    expect(await contaAuditoria(db)).toBe(0);
  });

  it("acordo ja cancelado continua recusado", async () => {
    const al = A(11);
    const ac = await acordoFn(db, al, { status: "CANCELADO" });
    await expect(cancelar(db, ac)).rejects.toThrow(/ja esta cancelado/i);
  });

  it("libera o caso uma vez, como antes", async () => {
    const al = A(12);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    await cancelar(db, ac);
    expect(await um(db, `select jsonb_agg(jsonb_build_object('aluno_id', aluno_id, 'evento', evento))
                           from public._chamadas_liberar_evento`))
      .toEqual([{ aluno_id: al, evento: "CANCELADO" }]);
  });

  // ---------- mutacao: o defeito existe sem a E5 ----------

  describe("SEM A E5 (so as regras de 22/09 e 25/09)", () => {
    let antiga;
    beforeEach(async () => { antiga = await novoBanco({ aplicar: [REGRA_22_09, REGRA_25_09] }); });

    it("o corpo de producao e o md5 de referencia", async () => {
      expect(await md5Corpo(antiga)).toBe(MD5_PRODUCAO);
    });

    it("o retorno NAO distingue cancelamento efetivo de ausencia de composicao", async () => {
      const al = A(20);
      const efetivo = await acordoFn(antiga, al, { numero: 1 });
      await parcela(antiga, efetivo, "A_VENCER");
      const t = await titulo(antiga, al);
      await vincular(antiga, t, efetivo);

      const semComposicao = await acordoFn(antiga, al, { numero: 2 });
      await parcela(antiga, semComposicao, "A_VENCER");

      const r1 = await cancelar(antiga, efetivo);
      const r2 = await cancelar(antiga, semComposicao);

      // o defeito relatado: os dois dizem ok:true e nenhum campo novo existe
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1.desfecho).toBeUndefined();
      expect(r2.desfecho).toBeUndefined();
      expect(r1.titulos_conferir).toBeUndefined();
      expect(r2.mensalidades_devolvidas).toBeUndefined();
      // `vinculos_desativados` ja existia, mas 0 nao e lido por ninguem: a
      // tela mostrava "Acordo cancelado." nos dois.
      expect(r1.vinculos_desativados).toBe(1);
      expect(r2.vinculos_desativados).toBe(0);
    });

    it("e nao registra nada em auditoria no caso que precisaria de conferencia", async () => {
      const al = A(21);
      const ac = await acordoFn(antiga, al, { numero: 3 });
      await parcela(antiga, ac, "RENEGOCIADA");
      const t = await titulo(antiga, al);
      await vincular(antiga, t, ac);
      await antiga.query(`update public.acordos set status='QUITADO' where id=$1`, [ac]);
      await quitarPeloAcordo(antiga, t, ac);

      const r = await cancelar(antiga, ac);

      expect(r.desfecho).toBeUndefined();
      expect(await contaAuditoria(antiga)).toBe(0);
    });
  });

  // ---------- rollback ----------

  it("o rollback devolve o corpo de producao byte a byte (md5)", async () => {
    expect(await md5Corpo(db)).not.toBe(MD5_PRODUCAO);
    await db.exec(E5_ROLLBACK);
    expect(await md5Corpo(db)).toBe(MD5_PRODUCAO);

    // e o comportamento volta ao de antes
    const al = A(30);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    const r = await cancelar(db, ac);
    expect(r.desfecho).toBeUndefined();
    expect(await estado(db, t)).toEqual(ABERTO);
  });

  it("aplicar a E5 duas vezes deixa o mesmo corpo (idempotente)", async () => {
    const antes = await md5Corpo(db);
    await db.exec(E5);
    expect(await md5Corpo(db)).toBe(antes);
  });

  // ---------- guarda de md5 e grants (ressalvas do Guardiao, 27/10) ----------

  it("FALHA FECHADO: corpo diferente do de producao e recusado, e nada e aplicado", async () => {
    const limpo = await novoBanco({ aplicar: [REGRA_22_09, REGRA_25_09] });
    // mexe no corpo sem mexer no que a E5 troca: o md5 muda, a marca nao aparece
    await limpo.exec(
      "create or replace function public.cancelar_acordo_ficha(p_acordo_id uuid)\n" +
      "returns jsonb language plpgsql security definer set search_path to 'public' as\n" +
      "$function$ begin return jsonb_build_object('ok', true, 'outra_coisa', true); end $function$;"
    );
    const md5Antes = await md5Corpo(limpo);
    await expect(limpo.exec(E5)).rejects.toThrow(/E5\/GUARDA: md5 do corpo/);
    // O `begin` do arquivo deixa a transacao abortada -- que e exatamente o
    // efeito desejado: nada aplicado. Quem cola no SQL Editor recebe o erro e a
    // transacao morre com ele; aqui o rollback e so para seguir consultando.
    await limpo.exec("rollback");
    expect(await md5Corpo(limpo)).toBe(md5Antes);
  });

  it("a guarda nao atrapalha a aplicacao legitima: do corpo de producao ela passa", async () => {
    const limpo = await novoBanco({ aplicar: [REGRA_22_09, REGRA_25_09] });
    expect(await md5Corpo(limpo)).toBe(MD5_PRODUCAO);
    await limpo.exec(E5);
    expect(await md5Corpo(limpo)).not.toBe(MD5_PRODUCAO);
  });

  it("os grants sao reconfirmados: anon fora, authenticated dentro", async () => {
    const acl = await um(db,
      "select coalesce(array_to_string(proacl,','),'(nula)') from pg_proc where proname='cancelar_acordo_ficha'");
    expect(acl).not.toContain("anon=X");
    expect(acl).toContain("authenticated=X");
  });
});
