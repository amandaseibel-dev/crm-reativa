// #520 REBASEADO SOBRE O #523 -- COMPORTAMENTO, nao estrutura.
//
// Bancada = PRODUCAO DE HOJE, montada com os arquivos reais, nesta ordem:
//   20260922265000 (regra de 22/09: titulos_por_status_acordo e
//   cancelar_acordo_ficha de producao) -> 20260925123852 (#523, versao
//   registrada em producao) -> rollback do arquivo 1 do #520 (que carrega, byte
//   a byte, os tres corpos que estao em producao hoje, inclusive
//   _titulo_quita_com_o_acordo).
// Depois aplica o arquivo 1 do #520 REBASEADO e roda:
//   (1) TODOS os cenarios do #523 de novo -- nenhuma protecao pode se perder;
//   (2) os cenarios do #520 (proveniencia e porta PAGO -> NEGOCIADO);
//   (3) mutacao: o #520 ANTIGO (guarda de 22/09) reintroduz o defeito do #523;
//   (4) rollback: devolve exatamente producao de hoje.
//
// Gatilhos em `acordos` na ordem de producao (alfabetica):
//   trg_acordo_status_reavalia_titulos, trg_titulo_quita_com_o_acordo,
//   trg_titulos_por_status_acordo.
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
const MIG_523 = ler("supabase/migrations/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.sql");
const V2 = ler("supabase/aguardando_aprovacao/20260924_1_estrutural_mensalidade_segue_status_do_acordo.sql.pendente");
const V2_ROLLBACK = ler("supabase/aguardando_aprovacao/20260924_1_estrutural_mensalidade_segue_status_do_acordo.rollback.sql");

const PRODUCAO_HOJE = [REGRA_22_09, MIG_523, V2_ROLLBACK];

const md5 = (s) => createHash("md5").update(s).digest("hex");
const corpo = (sql, nome) => {
  const re = new RegExp(`create or replace function public\\.${nome}\\(.*?as \\$function\\$(.*?)\\$function\\$`, "is");
  return sql.match(re)[1];
};

// A guarda do NEGOCIADO orfao: a de 22/09 (sem prova de dinheiro) e a do #523.
const GUARDA_2209 = "    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO') then\n      return;\n";
const GUARDA_523_INICIO = "    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')\n       and exists (\n";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco({ aplicar = [...PRODUCAO_HOJE, V2] } = {}) {
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
      origem_liquidacao text, origem_encerramento text,
      atualizado_em timestamptz default now());

    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text, origem text,
      criado_em timestamptz default clock_timestamp());

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      status text default 'A_VENCER', valor numeric, atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);

    -- as tres fontes de "pagamento proprio" que a porta do #520 consulta
    create table public.pagamentos (id uuid primary key default gen_random_uuid(), titulo_numero text, valor_pago numeric);
    create table public.conferencia_pagamentos (id uuid primary key default gen_random_uuid(), titulo_numero text);
    create table public.solicitacoes_confirmacao_pagamento (id uuid primary key default gen_random_uuid(), titulo_id uuid);

    create table public._chamadas_liberar_evento (aluno_id uuid, evento text, registrado_em timestamptz default now());
    create function public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text,
        p_valor_pago numeric default null, p_data_pagamento date default current_date)
      returns void language plpgsql as $$
      begin insert into public._chamadas_liberar_evento (aluno_id, evento) values (p_aluno_id, p_evento); end $$;

    create function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $$ select true $$;

    -- corpos de producao dos gatilhos que chamam titulo_reavaliar e do de
    -- coerencia situacao/status (os mesmos da bancada do #523)
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

  // As colunas de proveniencia nascem no arquivo 1; o rollback (que monta
  // "producao de hoje") so redefine funcoes, entao roda antes delas existirem.
  for (const sql of aplicar) await db.exec(sql);

  await db.exec(`
    create trigger trg_acordo_status_reavalia_titulos after update of status on public.acordos
      for each row when (upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
      execute function _acordo_status_reavalia_titulos();
    -- so existe quando a bancada carrega os corpos de producao de hoje (a
    -- bancada "so 22/09", usada para reproduzir as ja presas, nao o tem)
    do $t$ begin
      if exists (select 1 from pg_proc where proname = '_titulo_quita_com_o_acordo') then
        create trigger trg_titulo_quita_com_o_acordo after update of status on public.acordos
          for each row execute function _titulo_quita_com_o_acordo();
      end if;
    end $t$;
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
let seqDoc = 5000000000;

async function acordoFn(db, aluno_id, { valor_total = 1000, qtd_parcelas = 1, numero = null } = {}) {
  return um(db, `insert into public.acordos (aluno_id, valor_total, qtd_parcelas, numero_acordo)
                 values ($1,$2,$3,$4) returning id`, [aluno_id, valor_total, qtd_parcelas, numero]);
}
async function titulo(db, aluno_id, { valor_original = 1000, tipo_boleto = "Cursos de Graduação", documento } = {}) {
  const doc = documento ?? String(++seqDoc);
  return um(db, `insert into public.acordos_titulos (aluno_id, situacao, status, valor_original, valor_em_aberto, tipo_boleto, documento)
                 values ($1,'ABERTO','em_aberto',$2,$2,$3,$4) returning id`, [aluno_id, valor_original, tipo_boleto, doc]);
}
async function vincular(db, tituloId, acordoId) {
  await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, origem)
                  values ($1,$2,true,'EXATO_PRIME_195')`, [acordoId, tituloId]);
}
async function parcela(db, acordoId, status = "A_VENCER", valor = 1000) {
  return um(db, `insert into public.parcelas (acordo_id, status, valor) values ($1,$2,$3) returning id`, [acordoId, status, valor]);
}
const linha = (db, id) => um(db, `select to_jsonb(t) from public.acordos_titulos t where id=$1`, [id]);
const estado = async (db, id) => {
  const l = await linha(db, id);
  return { situacao: l.situacao, status: l.status, acordo_id: l.acordo_id };
};
const ABERTO = { situacao: "ABERTO", status: "em_aberto", acordo_id: null };
const negociado = (acordo_id) => ({ situacao: "NEGOCIADO", status: "vinculada", acordo_id });
const quitada = (acordo_id) => ({ situacao: "PAGO", status: "quitada", acordo_id });
const cancelarFicha = (db, acordoId) => um(db, `select public.cancelar_acordo_ficha($1)`, [acordoId]);
async function cancelarDireto(db, acordoId) {
  await db.query(`update public.acordos set status='CANCELADO', saldo=0 where id=$1`, [acordoId]);
  await db.query(`update public.acordo_titulo_vinculo set ativo=false where acordo_id=$1`, [acordoId]);
}
const reavaliar = (db, id) => db.query(`select public.titulo_reavaliar($1)`, [id]);
const setStatusAcordo = (db, id, st) => db.query(`update public.acordos set status=$2 where id=$1`, [id, st]);

// Quitacao do acordo: todas as parcelas pagas, acordo vira QUITADO.
async function quitarAcordo(db, acordoId) {
  await db.query(`update public.parcelas set status='PAGO' where acordo_id=$1`, [acordoId]);
  await setStatusAcordo(db, acordoId, "QUITADO");
}
// Reabertura: uma parcela deixa de estar paga e o acordo volta para ATIVO.
async function reabrirAcordo(db, acordoId) {
  await db.query(`update public.parcelas set status='A_VENCER'
                   where id = (select id from public.parcelas where acordo_id=$1 order by id limit 1)`, [acordoId]);
  await setStatusAcordo(db, acordoId, "ATIVO");
}

// Impressao digital de tudo que e dinheiro: valores dos titulos, parcelas,
// baixas, pagamentos e valor/saldo dos acordos (fora o saldo que a propria
// RPC da ficha zera ao cancelar -- comportamento dela, anterior a tudo isto).
const digitalDinheiro = (db) => um(db, `select md5(concat_ws('|',
    (select string_agg(id::text||':'||coalesce(valor_original::text,'')||':'||coalesce(valor_em_aberto::text,''), ',' order by id) from public.acordos_titulos),
    (select string_agg(id::text||':'||coalesce(valor::text,''), ',' order by id) from public.parcelas),
    (select string_agg(id::text||':'||coalesce(devolvido_em::text,''), ',' order by id) from public.baixas_pagamento),
    (select string_agg(id::text||':'||coalesce(valor_pago::text,''), ',' order by id) from public.pagamentos),
    (select string_agg(id::text||':'||coalesce(valor_total::text,''), ',' order by id) from public.acordos)))`);

// ---------------------------------------------------------------------------
describe("(1) nenhuma protecao do #523 se perde com o #520 rebaseado", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("CANCELADO sem nenhum pagamento na cadeia (botao da ficha): mensalidade volta para ABERTO/em_aberto e o vinculo fica, inativo", async () => {
    const al = A(1);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "VENCIDA");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    expect(await estado(db, t)).toEqual(negociado(ac));

    await cancelarFicha(db, ac);

    expect(await estado(db, t)).toEqual(ABERTO);
    expect(await um(db, `select jsonb_agg(ativo) from public.acordo_titulo_vinculo where titulo_id=$1`, [t])).toEqual([false]);
  });

  it("varias mensalidades no mesmo acordo sem pagamento: todas voltam para ABERTO", async () => {
    const al = A(2);
    const ac = await acordoFn(db, al, { valor_total: 2200, qtd_parcelas: 2 });
    await parcela(db, ac, "VENCIDA", 1100);
    await parcela(db, ac, "A_VENCER", 1100);
    const ts = [];
    for (const v of [1000, 800, 400]) { const t = await titulo(db, al, { valor_original: v }); await vincular(db, t, ac); ts.push(t); }
    await cancelarFicha(db, ac);
    for (const t of ts) expect(await estado(db, t)).toEqual(ABERTO);
  });

  it("mensalidade reaberta entra num acordo novo normalmente", async () => {
    const al = A(3);
    const velho = await acordoFn(db, al);
    const t = await titulo(db, al);
    await vincular(db, t, velho);
    await cancelarFicha(db, velho);
    const novo = await acordoFn(db, al);
    await vincular(db, t, novo);
    expect(await estado(db, t)).toEqual(negociado(novo));
  });

  it("CANCELADO com parcela PAGO no proprio acordo: NAO reabre pelo valor cheio, continua NEGOCIADA", async () => {
    const al = A(4);
    const ac = await acordoFn(db, al, { valor_total: 1000, qtd_parcelas: 2 });
    await parcela(db, ac, "PAGO", 500);
    await parcela(db, ac, "CANCELADA", 500);
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await cancelarDireto(db, ac);
    expect(await estado(db, t)).toEqual(negociado(ac));
  });

  it("CANCELADO com baixa viva e sem parcela PAGO: continua NEGOCIADA", async () => {
    const al = A(5);
    const ac = await acordoFn(db, al);
    const p = await parcela(db, ac, "A_VENCER");
    await db.query(`insert into public.baixas_pagamento (acordo_id, parcela_id, baixado_em) values ($1,$2,now())`, [ac, p]);
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await cancelarDireto(db, ac);
    expect(await estado(db, t)).toEqual(negociado(ac));
  });

  it("baixa DEVOLVIDA nao conta como pagamento: cancelar pela ficha reabre", async () => {
    const al = A(6);
    const ac = await acordoFn(db, al);
    const p = await parcela(db, ac, "A_VENCER");
    await db.query(`insert into public.baixas_pagamento (acordo_id, parcela_id, baixado_em, devolvido_em) values ($1,$2,now(),now())`, [ac, p]);
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await cancelarFicha(db, ac);
    expect(await estado(db, t)).toEqual(ABERTO);
  });

  it("CANCELADO com pagamento em OUTRO acordo da cadeia (re-acordo A pago em parte -> B cancelado sem pagar): continua NEGOCIADA", async () => {
    const al = A(7);
    const acA = await acordoFn(db, al, { valor_total: 1000, qtd_parcelas: 2 });
    await parcela(db, acA, "PAGO", 400);
    await parcela(db, acA, "CANCELADA", 600);
    const t = await titulo(db, al);
    await vincular(db, t, acA);
    await cancelarDireto(db, acA);
    const acB = await acordoFn(db, al, { valor_total: 600 });
    await parcela(db, acB, "VENCIDA", 600);
    await vincular(db, t, acB);
    await cancelarFicha(db, acB);
    expect(await estado(db, t)).toEqual(negociado(acB));
  });

  it("correcao das ja presas: NEGOCIADA em acordo cancelado sem pagamento, reavaliada, volta para ABERTO", async () => {
    const antigo = await novoBanco({ aplicar: [REGRA_22_09] });
    const al = A(11);
    const ac = await acordoFn(antigo, al);
    const t = await titulo(antigo, al);
    await vincular(antigo, t, ac);
    await cancelarFicha(antigo, ac);
    expect(await estado(antigo, t)).toEqual(negociado(ac));
    for (const sql of [MIG_523, V2_ROLLBACK, V2]) await antigo.exec(sql);
    await reavaliar(antigo, t);
    expect(await estado(antigo, t)).toEqual(ABERTO);
    await antigo.close();
  });

  it("PAGO (sem proveniencia) e CANCELADA continuam terminais no cancelamento", async () => {
    const al = A(9);
    const ac = await acordoFn(db, al);
    const paga = await titulo(db, al);
    const cancelada = await titulo(db, al);
    await vincular(db, paga, ac);
    await vincular(db, cancelada, ac);
    await db.query(`update public.acordos_titulos set situacao='PAGO', status='quitada' where id=$1`, [paga]);
    await db.query(`update public.acordos_titulos set situacao='CANCELADA', status='cancelada' where id=$1`, [cancelada]);
    await cancelarFicha(db, ac);
    expect((await estado(db, paga)).situacao).toBe("PAGO");
    expect((await estado(db, cancelada)).situacao).toBe("CANCELADA");
  });
});

// ---------------------------------------------------------------------------
describe("(2) o que o #520 acrescenta: proveniencia e porta PAGO -> NEGOCIADO", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  async function mensalidadeQuitadaPeloAcordo(n) {
    const al = A(n);
    const ac = await acordoFn(db, al, { numero: 70000 + n });
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await quitarAcordo(db, ac);
    return { al, ac, t };
  }

  it("acordo QUITADO: mensalidade vinculada fica PAGO/quitada, com a proveniencia gravada", async () => {
    const { ac, t } = await mensalidadeQuitadaPeloAcordo(20);
    expect(await estado(db, t)).toEqual(quitada(ac));
    const l = await linha(db, t);
    expect(l.quitacao_origem).toBe("ACORDO");
    expect(l.quitacao_origem_acordo_id).toBe(ac);
    expect(l.quitacao_origem_em).not.toBeNull();
  });

  it("acordo sai de QUITADO e volta para ATIVO: a mensalidade quitada SO por causa dele volta para NEGOCIADO, proveniencia limpa e motivo registrado", async () => {
    const { ac, t } = await mensalidadeQuitadaPeloAcordo(21);
    await reabrirAcordo(db, ac);
    expect(await estado(db, t)).toEqual(negociado(ac));
    const l = await linha(db, t);
    expect(l.quitacao_origem).toBeNull();
    expect(l.quitacao_origem_acordo_id).toBeNull();
    expect(l.motivo_ajuste).toMatch(/reaberta como NEGOCIADA .* deixou de estar quitado/);
  });

  const independentes = [
    ["pagamento proprio (pagamentos.titulo_numero)", async (t) => {
      const doc = (await linha(db, t)).documento;
      await db.query(`insert into public.pagamentos (titulo_numero, valor_pago) values ($1, 1000)`, [doc]);
    }],
    ["conferencia propria (conferencia_pagamentos)", async (t) => {
      const doc = (await linha(db, t)).documento;
      await db.query(`insert into public.conferencia_pagamentos (titulo_numero) values ($1)`, [doc]);
    }],
    ["solicitacao de confirmacao apontando o titulo", async (t) => {
      await db.query(`insert into public.solicitacoes_confirmacao_pagamento (titulo_id) values ($1)`, [t]);
    }],
    ["liquidacao independente (origem_liquidacao)", async (t) => {
      await db.query(`update public.acordos_titulos set origem_liquidacao='PRIME_195' where id=$1`, [t]);
    }],
    ["encerramento administrativo (origem_encerramento)", async (t) => {
      await db.query(`update public.acordos_titulos set origem_encerramento='ADM' where id=$1`, [t]);
    }],
  ];
  independentes.forEach(([nome, marcar], i) => {
    it(`titulo com ${nome}: continua PAGO quando o acordo reabre`, async () => {
      const { ac, t } = await mensalidadeQuitadaPeloAcordo(30 + i);
      await marcar(t);
      await reabrirAcordo(db, ac);
      expect(await estado(db, t)).toEqual(quitada(ac));
    });
  });

  it("PAGO historico SEM proveniencia gravada (tudo antes do #520): continua PAGO quando o acordo reabre -- a migration e inerte para o passado", async () => {
    const al = A(40);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    // PAGO gravado antes da regra de proveniencia existir (quitacao_origem nula)
    await db.query(`update public.acordos_titulos set situacao='PAGO', status='quitada', acordo_id=$2 where id=$1`, [t, ac]);
    await quitarAcordo(db, ac);              // passa por QUITADO: o motor sai cedo (PAGO), nao grava proveniencia
    expect((await linha(db, t)).quitacao_origem).toBeNull();
    await reabrirAcordo(db, ac);             // volta para ATIVO: a porta exige proveniencia, nao abre
    expect(await estado(db, t)).toEqual(quitada(ac));
  });

  it("proveniencia de OUTRO acordo: nao reabre", async () => {
    const { al, ac, t } = await mensalidadeQuitadaPeloAcordo(41);
    const outro = await acordoFn(db, al);
    await db.query(`update public.acordos_titulos set quitacao_origem_acordo_id=$2 where id=$1`, [t, outro]);
    await reabrirAcordo(db, ac);
    expect(await estado(db, t)).toEqual(quitada(ac));
  });

  it("acordo QUITADO que depois e CANCELADO (por fora da ficha): a mensalidade paga continua PAGO", async () => {
    const { ac, t } = await mensalidadeQuitadaPeloAcordo(42);
    await cancelarDireto(db, ac);
    expect((await estado(db, t)).situacao).toBe("PAGO");
  });

  it("reaberta pela porta e depois cancelada SEM nenhum dinheiro na cadeia: segue a regra do #523 e volta para ABERTO", async () => {
    const { ac, t } = await mensalidadeQuitadaPeloAcordo(43);
    await reabrirAcordo(db, ac);                               // uma parcela A_VENCER, as demais... nenhuma
    await db.query(`update public.parcelas set status='A_VENCER' where acordo_id=$1`, [ac]); // nenhuma paga
    await cancelarFicha(db, ac);
    expect(await estado(db, t)).toEqual(ABERTO);
  });
});

// ---------------------------------------------------------------------------
describe("(2b) boleto do proprio acordo (tipo_boleto='Acordo')", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("cancelamento sem pagamento: o boleto e CANCELADO junto, nunca vira mensalidade ABERTA", async () => {
    const al = A(60);
    const ac = await acordoFn(db, al);
    const boleto = await titulo(db, al, { tipo_boleto: "Acordo" });
    await vincular(db, boleto, ac);
    await cancelarFicha(db, ac);
    expect((await estado(db, boleto)).situacao).toBe("CANCELADA");
  });

  it("a porta PAGO -> NEGOCIADO nunca abre para o boleto do acordo", async () => {
    const al = A(61);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const boleto = await titulo(db, al, { tipo_boleto: "Acordo" });
    await vincular(db, boleto, ac);
    await quitarAcordo(db, ac);
    const depoisDeQuitar = await estado(db, boleto);
    await reabrirAcordo(db, ac);
    expect(await estado(db, boleto)).toEqual(depoisDeQuitar);
  });

  it("DOCUMENTA o comportamento de producao que nenhum dos dois PRs muda: titulo_reavaliar marca o boleto vinculado como quitado junto com o acordo", async () => {
    // _titulo_quita_com_o_acordo (producao) e titulos_por_status_acordo (#520)
    // excluem tipo_boleto='Acordo'; titulo_reavaliar -- o primeiro gatilho a
    // rodar -- nao exclui, em producao HOJE (#523) e na versao final. Fica
    // registrado aqui para a decisao ser explicita (ver relatorio).
    const al = A(62);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "A_VENCER");
    const boleto = await titulo(db, al, { tipo_boleto: "Acordo" });
    await vincular(db, boleto, ac);
    await quitarAcordo(db, ac);
    expect(await estado(db, boleto)).toEqual(quitada(ac));
  });
});

// ---------------------------------------------------------------------------
describe("(2c) idempotencia e dinheiro", () => {
  it("titulo_reavaliar repetido nao escreve nada em nenhum dos estados finais (inclusive atualizado_em)", async () => {
    const db = await novoBanco();
    const al = A(70);
    // ABERTO reaberto pelo #523
    const ac1 = await acordoFn(db, al);
    const t1 = await titulo(db, al);
    await vincular(db, t1, ac1);
    await cancelarFicha(db, ac1);
    // NEGOCIADO preservado (dinheiro na cadeia)
    const ac2 = await acordoFn(db, al);
    await parcela(db, ac2, "PAGO");
    const t2 = await titulo(db, al);
    await vincular(db, t2, ac2);
    await cancelarDireto(db, ac2);
    // PAGO com proveniencia
    const ac3 = await acordoFn(db, al);
    await parcela(db, ac3, "A_VENCER");
    const t3 = await titulo(db, al);
    await vincular(db, t3, ac3);
    await quitarAcordo(db, ac3);
    // NEGOCIADO reaberto pela porta
    const ac4 = await acordoFn(db, al);
    await parcela(db, ac4, "A_VENCER");
    const t4 = await titulo(db, al);
    await vincular(db, t4, ac4);
    await quitarAcordo(db, ac4);
    await reabrirAcordo(db, ac4);

    for (const t of [t1, t2, t3, t4]) {
      const antes = await linha(db, t);
      await reavaliar(db, t);
      await reavaliar(db, t);
      expect(await linha(db, t)).toEqual(antes);
    }
    await db.close();
  });

  it("nenhum valor de dinheiro muda: nem ao aplicar o arquivo, nem em nenhuma transicao feita pelo motor", async () => {
    const db = await novoBanco({ aplicar: PRODUCAO_HOJE });
    const al = A(80);
    const ac = await acordoFn(db, al);
    await parcela(db, ac, "PAGO", 700);
    const t = await titulo(db, al, { valor_original: 1234.56 });
    await vincular(db, t, ac);
    await db.query(`insert into public.pagamentos (titulo_numero, valor_pago) values ('x', 99)`);

    const d0 = await digitalDinheiro(db);
    await db.exec(V2);                       // aplicar o arquivo 1 nao toca em dado
    expect(await digitalDinheiro(db)).toBe(d0);
    expect(await um(db, `select count(*)::int from public.acordos_titulos where quitacao_origem is not null`)).toBe(0);

    await quitarAcordo(db, ac);              // PAGO pela regra
    await reabrirAcordo(db, ac);             // NEGOCIADO pela porta (a parcela volta a A_VENCER, valor igual)
    await reavaliar(db, t);
    expect(await digitalDinheiro(db)).toBe(d0);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
describe("(3) mutacao: o #520 ANTIGO (guarda de 22/09) desfaria o #523", () => {
  it("com a guarda de 22/09 no lugar da do #523, o cancelamento sem pagamento prende a mensalidade -- o defeito que o #523 corrigiu", async () => {
    const [prefixo, resto] = V2.split(GUARDA_523_INICIO);
    const fim = resto.indexOf("      return;\n") + "      return;\n".length;
    const V2_ANTIGO = prefixo + GUARDA_2209 + resto.slice(fim);
    expect(V2_ANTIGO).not.toBe(V2);

    const db = await novoBanco({ aplicar: [...PRODUCAO_HOJE, V2_ANTIGO] });
    const al = A(90);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await cancelarFicha(db, ac);
    expect(await estado(db, t)).toEqual(negociado(ac));
    await db.close();
  });
});

// ---------------------------------------------------------------------------
describe("(4) texto e rollback", () => {
  it("a producao de hoje e exatamente o que o rollback carrega (md5 dos tres corpos)", () => {
    expect(md5(corpo(MIG_523, "titulo_reavaliar"))).toBe("efdf3fd198a56198223ade82e4991d40");
    expect(md5(corpo(V2_ROLLBACK, "titulo_reavaliar"))).toBe("efdf3fd198a56198223ade82e4991d40");
    expect(md5(corpo(V2_ROLLBACK, "titulos_por_status_acordo"))).toBe("67e21573381adb98f82fd9c8ff969bfc");
    expect(md5(corpo(V2_ROLLBACK, "_titulo_quita_com_o_acordo"))).toBe("bde4388c3a26ea98f66e5163eef9bd51");
  });

  it("a guarda do #523 esta na versao final byte a byte, e a de 22/09 nao volta", () => {
    const final = corpo(V2, "titulo_reavaliar");
    const inicio = corpo(MIG_523, "titulo_reavaliar").indexOf(GUARDA_523_INICIO);
    const guarda523 = corpo(MIG_523, "titulo_reavaliar").slice(inicio, corpo(MIG_523, "titulo_reavaliar").indexOf("    end if;\n  end if;\n", inicio));
    expect(final.includes(guarda523)).toBe(true);
    expect(final.includes(GUARDA_2209)).toBe(false);
  });

  it("rollback: volta ao comportamento de producao de hoje (#523 intacto)", async () => {
    const db = await novoBanco({ aplicar: [...PRODUCAO_HOJE, V2, V2_ROLLBACK] });
    const al = A(95);
    const ac = await acordoFn(db, al);
    const t = await titulo(db, al);
    await vincular(db, t, ac);
    await cancelarFicha(db, ac);
    expect(await estado(db, t)).toEqual(ABERTO);
    expect(await um(db, `select md5(prosrc) from pg_proc where proname='titulo_reavaliar'`)).toBe("efdf3fd198a56198223ade82e4991d40");
    await db.close();
  });
});
