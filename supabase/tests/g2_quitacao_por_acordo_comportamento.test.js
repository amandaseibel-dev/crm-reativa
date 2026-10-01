// G2 -- QUITACAO POR ACORDO: PROVENIENCIA, DELEGACAO AO MOTOR E A PORTA DE VOLTA.
// COMPORTAMENTO, nao estrutura (os dois testes estruturais do fim sao a excecao
// e estao marcados como tal).
//
// A bancada nasce COM O DEFEITO: carrega os corpos de producao de 01/10/2026
// (supabase/audits/g2_quitacao_por_acordo_producao_20261001.sql), inclusive o
// `titulos_por_status_acordo` defeituoso, que quitava mensalidade sem conferir
// parcela viva. O primeiro bloco de testes prova que o defeito existe na
// bancada; os seguintes rodam as migrations REAIS e provam que ele morre.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const PRODUCAO = ler("supabase/audits/g2_quitacao_por_acordo_producao_20261001.sql");
const M1 = "supabase/migrations/20261001193805_origem_liquidacao_acordo_quitado.sql";
const M2 = "supabase/migrations/20261001193932_quitacao_por_acordo_delega_ao_motor.sql";
const M3 = "supabase/migrations/20261001194037_titulo_reabrir_quitacao_por_acordo.sql";
const M4 = "supabase/migrations/20261001194211_mensalidade_reconciliar_pago_sem_lastro.sql";
const R1 = "supabase/rollbacks/20261001193805_origem_liquidacao_acordo_quitado.rollback.sql";

// md5(prosrc) lidos de producao em 01/10/2026. A bancada tem de ser ESTE corpo.
const MD5_PRODUCAO = {
  titulo_reavaliar: "efdf3fd198a56198223ade82e4991d40",
  _titulo_situacao_e_status_coerentes: "938d1081a89106b4a37b116321d9d819",
  titulo_situacao_por_vinculo: "597e619bd709b70de3772d86f19cf8c8",
  _acordo_status_reavalia_titulos: "da92e1a790d17f41e4e28e96e8a86fe0",
  titulos_por_status_acordo: "67e21573381adb98f82fd9c8ff969bfc",
  _titulo_quita_com_o_acordo: "bde4388c3a26ea98f66e5163eef9bd51",
  _acordo_fecha_com_a_ultima_parcela: "9a2301342f99c312e7bfa971ac621a1e",
  _trg_auto_quitar_titulo: "8aa914112e90dd8bf960335f1bd8b213",
};

const semTransacao = (sql) =>
  sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function erroDe(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e.message ?? e);
  }
}

async function novoBanco({ migrar = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.email() returns text language sql stable as $$ select 'teste@reativa'::text $$;
    create function auth.role()  returns text language sql stable as $$ select 'service_role'::text $$;
    create function auth.jwt()   returns jsonb language sql stable as $$ select null::jsonb $$;

    create table public.alunos (id uuid primary key default gen_random_uuid(), cpf text,
      status_jornada text, status_atual text, status_acionamento text, valor_em_aberto numeric default 0);

    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric, saldo numeric, numero_acordo bigint,
      motivo_ajuste text, criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      cpf text, documento text, valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
      valor_cobranca_ajustado numeric, situacao text, status text,
      tipo_boleto text default 'Cursos de Graduação', acordo_id uuid, motivo_ajuste text,
      origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamptz,
      origem_encerramento text, origem_encerramento_ref text, origem_encerramento_em timestamptz,
      created_at timestamptz default now(), atualizado_em timestamptz default now());

    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text,
      motivo_desvinculo text, origem text, criado_em timestamptz default now());

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      numero int, status text default 'A_VENCER', valor numeric, vencimento date default current_date,
      criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      parcela_id uuid, valor_pago numeric, devolvido_em timestamptz);

    create table public.pagamentos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      cpf text, valor_pago numeric, data_pagamento date default current_date);

    create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      operador_email text, quitado_em date, status_financeiro text, origem_quitacao text,
      total_em_aberto numeric, criticidade text, caso_atualizado_por text, caso_atualizado_em timestamptz);

    create table public.solicitacoes_confirmacao_pagamento (id uuid primary key default gen_random_uuid(),
      aluno_id text, status text);

    create table public.audit_log (id bigserial primary key, tabela text, operacao text,
      registro_id text, usuario text, dados_antes jsonb, dados_depois jsonb,
      criado_em timestamptz default now());

    create table public.mensalidade_reconciliacao_log (id bigserial primary key, lote text,
      titulo_id uuid, aluno_id uuid, acordo_id uuid, numero_acordo bigint, documento text,
      valor_original numeric, situacao_antes text, status_antes text, situacao_depois text,
      status_depois text, motivo text, executado_por text, executado_em timestamptz default now());

    create function public.usuario_e_gestao() returns boolean language sql stable as $$ select true $$;
    create function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $$ select true $$;
    create function public._talvez_quitar_aluno(v_aluno uuid) returns void language plpgsql as $$ begin return; end $$;
    create function public.saldo_cobravel_aluno(p uuid) returns numeric language sql stable as $$ select 0::numeric $$;
  `);

  await db.exec(PRODUCAO);

  await db.exec(`
    create trigger trg_titulo_situacao_status_coerentes
      before insert or update of situacao, status on public.acordos_titulos
      for each row execute function public._titulo_situacao_e_status_coerentes();

    create trigger trg_titulo_situacao_por_vinculo
      after insert or delete or update on public.acordo_titulo_vinculo
      for each row execute function public.titulo_situacao_por_vinculo();

    create trigger trg_auto_quitar_titulo
      after update of situacao on public.acordos_titulos
      for each row execute function public._trg_auto_quitar_titulo();

    -- ORDEM ALFABETICA = ordem de disparo. titulos_por_status_acordo e o ULTIMO,
    -- e e exatamente por isso que ele sobrescrevia os outros dois.
    create trigger trg_acordo_status_reavalia_titulos
      after update of status on public.acordos
      for each row when (upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
      execute function public._acordo_status_reavalia_titulos();

    create trigger trg_titulo_quita_com_o_acordo
      after update of status on public.acordos
      for each row execute function public._titulo_quita_com_o_acordo();

    create trigger trg_titulos_por_status_acordo
      after update of status on public.acordos
      for each row execute function public.titulos_por_status_acordo();

    create trigger trg_acordo_fecha_com_a_ultima_parcela
      after insert or update of status on public.parcelas
      for each row execute function public._acordo_fecha_com_a_ultima_parcela();
  `);

  if (migrar) {
    await db.exec(semTransacao(ler(M1)));
    await db.exec(semTransacao(ler(M2)));
    await db.exec(semTransacao(ler(M3)));
    await db.exec(semTransacao(ler(M4)));
  }
  return db;
}

// Um aluno, um acordo, N mensalidades vinculadas, parcelas com os status dados.
async function cenario(db, {
  parcelas = ["A_VENCER"], mensalidades = 1, tipoBoleto = "Cursos de Graduação",
  valor = 100, numero = 1, origemLiquidacao = null, origemEncerramento = null,
  elo = "ambos", // 'ambos' | 'so_vinculo' | 'so_coluna'
} = {}) {
  const aluno = await um(db, `insert into public.alunos (cpf) values ('000') returning id`);
  const acordo = await um(db,
    `insert into public.acordos (aluno_id, status, numero_acordo, valor_total)
     values ($1,'ATIVO',$2,$3) returning id`, [aluno, numero, valor * mensalidades]);

  const titulos = [];
  for (let i = 0; i < mensalidades; i++) {
    const t = await um(db,
      `insert into public.acordos_titulos
         (aluno_id, documento, valor_original, saldo_corrigido, situacao, status,
          tipo_boleto, origem_liquidacao, origem_encerramento)
       values ($1,$2,$3,$3,'ABERTO','em_aberto',$4,$5,$6) returning id`,
      [aluno, `doc${numero}-${i}`, valor, tipoBoleto, origemLiquidacao, origemEncerramento]);

    if (elo !== "so_coluna") {
      await db.query(
        `insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, origem)
         values ($1,$2,true,'TESTE')`, [acordo, t]);
    }
    if (elo !== "so_vinculo") {
      await db.query(`update public.acordos_titulos set acordo_id=$1 where id=$2`, [acordo, t]);
    }
    titulos.push(t);
  }

  for (let i = 0; i < parcelas.length; i++) {
    await db.query(
      `insert into public.parcelas (acordo_id, numero, status, valor, vencimento)
       values ($1,$2,$3,$4, current_date + ($2)::int)`, [acordo, i + 1, parcelas[i], valor]);
  }
  return { aluno, acordo, titulos };
}

const estado = (db, id) =>
  db.query(`select situacao, status, acordo_id, origem_liquidacao, origem_liquidacao_ref,
                   origem_liquidacao_em, motivo_ajuste
              from public.acordos_titulos where id=$1`, [id]).then((r) => r.rows[0]);

const quitarAcordo = (db, acordo) =>
  db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);

// ===========================================================================

describe("custodia da bancada", () => {
  it("1. os corpos carregados sao os de producao de 01/10/2026 (md5 por funcao)", async () => {
    const db = await novoBanco({ migrar: false });
    const r = await db.query(
      `select proname, md5(prosrc) m from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and proname = any($1)`,
      [Object.keys(MD5_PRODUCAO)]);
    const vistos = Object.fromEntries(r.rows.map((x) => [x.proname, x.m]));
    expect(vistos).toEqual(MD5_PRODUCAO);
  });
});

describe("o defeito existe na bancada (mutacao)", () => {
  it("2. SEM as migrations, acordo QUITADO com parcela VIVA quita a mensalidade", async () => {
    const db = await novoBanco({ migrar: false });
    const { acordo, titulos } = await cenario(db, { parcelas: ["A_VENCER", "VENCIDA"] });
    await quitarAcordo(db, acordo);
    const e = await estado(db, titulos[0]);
    // o defeito: PAGO apesar de o acordo ter 2 parcelas vivas
    expect(e.situacao).toBe("PAGO");
    expect(e.status).toBe("quitada");
    expect(e.origem_liquidacao).toBeNull();
  });

  it("3. SEM as migrations, o titulo do proprio acordo tambem e quitado", async () => {
    const db = await novoBanco({ migrar: false });
    const { acordo, titulos } = await cenario(db, { parcelas: [], tipoBoleto: "Acordo" });
    await quitarAcordo(db, acordo);
    expect((await estado(db, titulos[0])).situacao).toBe("PAGO");
  });
});

describe("regra futura: quem decide e o motor", () => {
  it("4. acordo QUITADO com parcela VIVA nao quita mensalidade nenhuma", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["A_VENCER", "VENCIDA"] });
    await quitarAcordo(db, acordo);
    const e = await estado(db, titulos[0]);
    expect({ situacao: e.situacao, status: e.status, prov: e.origem_liquidacao })
      .toEqual({ situacao: "NEGOCIADO", status: "vinculada", prov: null });
  });

  it("5. acordo QUITADO sem parcela viva quita E grava a trinca de proveniencia", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO", "CANCELADA"] });
    await quitarAcordo(db, acordo);
    const e = await estado(db, titulos[0]);
    expect(e.situacao).toBe("PAGO");
    expect(e.status).toBe("quitada");
    expect(e.origem_liquidacao).toBe("ACORDO_QUITADO");
    expect(e.origem_liquidacao_ref).toBe(acordo);
    expect(e.origem_liquidacao_em).not.toBeNull();
  });

  it("6. parcela RENEGOCIADA nao e parcela viva: quita", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO", "RENEGOCIADA"] });
    await quitarAcordo(db, acordo);
    expect((await estado(db, titulos[0])).situacao).toBe("PAGO");
  });

  // ACHADO DE 01/10/2026, registrado aqui de proposito: o motor NAO tem guarda
  // de tipo_boleto. As guardas dele sao TRES -- vinculo vivo, acordo QUITADO e
  // zero parcela viva. A exclusao de tipo_boleto='Acordo' existia apenas em
  // _titulo_quita_com_o_acordo, e nunca valeu de fato, porque o terceiro gatilho
  // (trg_acordo_status_reavalia_titulos) chama o motor direto e quita o boleto do
  // proprio acordo de qualquer jeito. Logo a delegacao NAO e regressao: o
  // comportamento e identico ao de hoje. O grupo C do G2 (18 titulos 'Acordo')
  // continua fora deste pacote, por decisao da gestao, e seguira sendo produzido
  // enquanto o motor nao ganhar essa guarda -- frente separada.
  it("7. o boleto do proprio acordo e quitado -- IGUAL a hoje, com e sem as migrations", async () => {
    const semMig = await novoBanco({ migrar: false });
    const a = await cenario(semMig, { parcelas: [], tipoBoleto: "Acordo" });
    await quitarAcordo(semMig, a.acordo);

    const comMig = await novoBanco();
    const b = await cenario(comMig, { parcelas: [], tipoBoleto: "Acordo" });
    await quitarAcordo(comMig, b.acordo);

    const antes = await estado(semMig, a.titulos[0]);
    const depois = await estado(comMig, b.titulos[0]);
    expect(antes.situacao).toBe("PAGO");
    expect(depois.situacao).toBe(antes.situacao);
    expect(depois.status).toBe(antes.status);
  });

  it("8. titulo ligado SO pelo vinculo tambem quita (nao se perde o elo do vinculo)", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"], elo: "so_vinculo" });
    await quitarAcordo(db, acordo);
    const e = await estado(db, titulos[0]);
    expect(e.situacao).toBe("PAGO");
    expect(e.origem_liquidacao).toBe("ACORDO_QUITADO");
  });

  it("9. PRIME_LIQUIDACAO_OFICIAL nunca e sobrescrito pela quitacao por acordo", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db,
      { parcelas: ["PAGO"], origemLiquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
    await quitarAcordo(db, acordo);
    expect((await estado(db, titulos[0])).origem_liquidacao).toBe("PRIME_LIQUIDACAO_OFICIAL");
  });

  it("10. o vocabulario de origem_liquidacao e fechado", async () => {
    const db = await novoBanco();
    const { titulos } = await cenario(db, { parcelas: ["A_VENCER"] });
    const erro = await erroDe(() => db.query(
      `update public.acordos_titulos set origem_liquidacao='INVENTADO' where id=$1`, [titulos[0]]));
    expect(erro).toMatch(/origem_liquidacao_valida/);
  });
});

describe("a armadilha do par de colunas", () => {
  it("11. update que mexe SO em situacao e revertido em silencio para PAGO", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    await db.query(`update public.acordos_titulos set situacao='NEGOCIADO' where id=$1`, [titulos[0]]);
    const e = await estado(db, titulos[0]);
    // nao deu erro, nao reclamou -- e nao mudou nada
    expect({ situacao: e.situacao, status: e.status })
      .toEqual({ situacao: "PAGO", status: "quitada" });
  });
});

describe("PAGO continua terminal para o motor", () => {
  it("12. acordo volta a ATIVO com parcela viva e o titulo PERMANECE PAGO (cenario G2)", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    await db.query(`update public.parcelas set status='VENCIDA' where acordo_id=$1`, [acordo]);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [acordo]);
    const e = await estado(db, titulos[0]);
    expect(e.situacao).toBe("PAGO");
    expect(e.origem_liquidacao).toBe("ACORDO_QUITADO");
  });

  it("13. titulo_reavaliar chamado direto no titulo PAGO nao muda nada", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    await db.query(`update public.parcelas set status='VENCIDA' where acordo_id=$1`, [acordo]);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [acordo]);
    await db.query(`select public.titulo_reavaliar($1)`, [titulos[0]]);
    expect((await estado(db, titulos[0])).situacao).toBe("PAGO");
  });
});

describe("a porta explicita", () => {
  // Monta o cenario G2: titulo PAGO com proveniencia ACORDO_QUITADO, acordo
  // de volta em ATIVO e com parcela viva.
  async function cenarioG2(db) {
    const c = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, c.acordo);
    await db.query(`update public.parcelas set status='VENCIDA' where acordo_id=$1`, [c.acordo]);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [c.acordo]);
    return c;
  }

  it("14. abre o titulo, limpa a trinca e registra no log", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenarioG2(db);
    const r = await um(db, `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]);
    expect(r.ok).toBe(true);
    expect(r.parcelas_vivas).toBe(1);

    const e = await estado(db, titulos[0]);
    expect({ situacao: e.situacao, status: e.status }).toEqual({ situacao: "NEGOCIADO", status: "vinculada" });
    expect(e.acordo_id).toBe(acordo);
    expect(e.origem_liquidacao).toBeNull();
    expect(e.origem_liquidacao_ref).toBeNull();
    expect(e.origem_liquidacao_em).toBeNull();
    expect(e.motivo_ajuste).toMatch(/quitacao por acordo desfeita/);

    const log = await db.query(
      `select lote, situacao_antes, status_antes, situacao_depois, status_depois
         from public.mensalidade_reconciliacao_log where titulo_id=$1`, [titulos[0]]);
    expect(log.rows).toEqual([{
      lote: "REABRIR_QUITACAO_POR_ACORDO",
      situacao_antes: "PAGO", status_antes: "quitada",
      situacao_depois: "NEGOCIADO", status_depois: "vinculada",
    }]);
  });

  it("15. e idempotente: a segunda chamada recusa, nao duplica", async () => {
    const db = await novoBanco();
    const { titulos } = await cenarioG2(db);
    await db.query(`select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/NAO_ESTA_QUITADO/);
    const n = await um(db,
      `select count(*) from public.mensalidade_reconciliacao_log where titulo_id=$1`, [titulos[0]]);
    expect(Number(n)).toBe(1);
  });

  it("16. recusa titulo sem proveniencia ACORDO_QUITADO", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    await db.query(
      `update public.acordos_titulos set origem_liquidacao=null, origem_liquidacao_ref=null,
              origem_liquidacao_em=null where id=$1`, [titulos[0]]);
    await db.query(`update public.parcelas set status='VENCIDA' where acordo_id=$1`, [acordo]);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [acordo]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/ORIGEM_NAO_REABRIVEL/);
  });

  it("17. recusa PRIME_LIQUIDACAO_OFICIAL -- liquidacao na origem e terminal", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db,
      { parcelas: ["PAGO"], origemLiquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
    await quitarAcordo(db, acordo);
    await db.query(`update public.parcelas set status='VENCIDA' where acordo_id=$1`, [acordo]);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [acordo]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/ORIGEM_NAO_REABRIVEL.*PRIME_LIQUIDACAO_OFICIAL/s);
  });

  it("18. recusa enquanto o acordo ainda esta QUITADO", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    await db.query(`update public.parcelas set status='VENCIDA' where acordo_id=$1`, [acordo]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/ACORDO_AINDA_QUITADO/);
  });

  it("19. recusa quando o acordo nao tem parcela viva -- a quitacao tem lastro", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [acordo]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/ACORDO_SEM_PARCELA_VIVA/);
  });

  it("20. recusa titulo encerrado administrativamente", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenarioG2(db);
    await db.query(
      `update public.acordos_titulos set origem_encerramento='CONFERENCIA_PRIME_ADMINISTRATIVA'
        where id=$1`, [titulos[0]]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/ENCERRADO_ADMINISTRATIVAMENTE/);
  });

  it("21. recusa sem vinculo vivo", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenarioG2(db);
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where titulo_id=$1`, [titulos[0]]);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/SEM_VINCULO_VIVO/);
  });

  it("22. recusa quando o portao da gestao nega", async () => {
    const db = await novoBanco();
    const { titulos } = await cenarioG2(db);
    await db.exec(`create or replace function public.crm_usuario_pode_quitar_baixar()
                     returns boolean language sql stable as $$ select false $$`);
    const erro = await erroDe(() => db.query(
      `select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(erro).toMatch(/Acesso negado/);
  });

  it("23. nenhuma guarda que recusa deixa escrita para tras", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo); // acordo QUITADO -> a porta vai recusar em G6
    const antes = await estado(db, titulos[0]);
    const nLog = Number(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`));
    await erroDe(() => db.query(`select public.titulo_reabrir_quitacao_por_acordo($1)`, [titulos[0]]));
    expect(await estado(db, titulos[0])).toEqual(antes);
    expect(Number(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`))).toBe(nLog);
  });
});

describe("saneamento historico: as guardas de abertura", () => {
  it("24. a previa nao escreve nada e aborta quando a populacao nao e a congelada", async () => {
    const db = await novoBanco();
    await cenario(db, { parcelas: ["A_VENCER"] });
    // Na bancada a populacao do lote e vazia: a guarda G1 tem de abortar.
    const erro = await erroDe(() => db.query(
      `select public.mensalidade_reconciliar_pago_sem_lastro(false)`));
    expect(erro).toMatch(/ABORTADO G1: 0 titulos, esperado 491/);
  });

  it("25. a execucao confirmada aborta na mesma guarda, sem criar o backup", async () => {
    const db = await novoBanco();
    const erro = await erroDe(() => db.query(
      `select public.mensalidade_reconciliar_pago_sem_lastro(true)`));
    expect(erro).toMatch(/ABORTADO G1/);
    const existe = await um(db,
      `select to_regclass('public._backup_pago_sem_lastro_20261001') is not null`);
    expect(existe).toBe(false);
  });
});

describe("estrutural", () => {
  const semComentarios = (sql) =>
    sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

  it("26. titulo_reavaliar continua com UMA unica assinatura", async () => {
    const db = await novoBanco();
    const n = await um(db,
      `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='titulo_reavaliar'`);
    expect(Number(n)).toBe(1);
    const args = await um(db,
      `select pg_get_function_identity_arguments(p.oid) from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='titulo_reavaliar'`);
    expect(args).toBe("p_titulo uuid");
  });

  it("27. nenhuma migration nova grava situacao='PAGO' sem o status no mesmo update", () => {
    for (const m of [M1, M2, M3, M4]) {
      const corpo = semComentarios(ler(m));
      const ocorrencias = corpo.match(/set\s+situacao\s*=\s*'PAGO'[^;]*/gi) ?? [];
      for (const o of ocorrencias) {
        expect(o, `${m}: 'set situacao=PAGO' sem status no mesmo update`).toMatch(/status\s*=/);
      }
    }
  });

  it("28. nenhuma migration nova revoga EXECUTE de authenticated", () => {
    for (const m of [M1, M2, M3, M4]) {
      const corpo = semComentarios(ler(m));
      expect(corpo, m).not.toMatch(/revoke[^;]*execute[^;]*authenticated/i);
      expect(corpo, m).not.toMatch(/revoke\s+all\s+on\s+function[^;]*from\s+(public|authenticated)/i);
    }
  });
});

describe("rollback", () => {
  it("29. o rollback da etapa 1 devolve titulo_reavaliar ao md5 de producao", async () => {
    const db = await novoBanco();
    const depoisDaMigration = await um(db,
      `select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='titulo_reavaliar'`);
    expect(depoisDaMigration).not.toBe(MD5_PRODUCAO.titulo_reavaliar);

    await db.exec(semTransacao(ler(R1)));

    const depoisDoRollback = await um(db,
      `select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='titulo_reavaliar'`);
    expect(depoisDoRollback).toBe(MD5_PRODUCAO.titulo_reavaliar);

    // e o vocabulario volta a recusar ACORDO_QUITADO
    const { titulos } = await cenario(db, { parcelas: ["A_VENCER"] });
    const erro = await erroDe(() => db.query(
      `update public.acordos_titulos set origem_liquidacao='ACORDO_QUITADO' where id=$1`, [titulos[0]]));
    expect(erro).toMatch(/origem_liquidacao_valida/);
  });

  it("30. o rollback nao mexe em situacao nem status, so apaga a marca", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"] });
    await quitarAcordo(db, acordo);
    const antes = await estado(db, titulos[0]);
    expect(antes.origem_liquidacao).toBe("ACORDO_QUITADO");

    await db.exec(semTransacao(ler(R1)));

    const depois = await estado(db, titulos[0]);
    expect({ situacao: depois.situacao, status: depois.status })
      .toEqual({ situacao: antes.situacao, status: antes.status });
    expect(depois.origem_liquidacao).toBeNull();
    expect(depois.origem_liquidacao_ref).toBeNull();
    expect(depois.origem_liquidacao_em).toBeNull();
  });
});
