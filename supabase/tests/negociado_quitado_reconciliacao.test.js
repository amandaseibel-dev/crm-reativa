// MENSALIDADE NEGOCIADA CUJO ACORDO JA FOI PAGO TEM DE FICAR QUITADO --
// COMPORTAMENTO, nao estrutura.
//
// Roda a migration REAL (supabase/aguardando_aprovacao/20260930_1_...) num
// PostgreSQL real (PGlite), sobre uma bancada minima, com os CORPOS DE
// PRODUCAO de 30/09/2026 (supabase/audits/negociado_quitado_producao_
// 20260930.sql) carregados como motor: titulo_reavaliar, o gatilho de
// coerencia situacao/status e os dois gatilhos que chamam o motor.
//
// O teste nao reescreve a regra: ele usa a regra de producao e verifica o
// DESTINO da mensalidade. Se producao mudar o motor, recapture o audit.
//
// Os testes "mutacao" recarregam o corpo COM O DEFEITO (o rollback do arquivo
// 1) para provar que o defeito existia antes desta correcao.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MOTOR_PRODUCAO = ler("supabase/audits/negociado_quitado_producao_20260930.sql");
const MIGRATION = ler(
  "supabase/migrations/20260930153112_negociado_quitado_regra_definitiva.sql",
);
const COM_DEFEITO = ler(
  "supabase/rollbacks/20260930153112_negociado_quitado_regra_definitiva.rollback.sql",
);
const PORTAO = ler("supabase/migrations/20260930153601_negociado_quitado_portao_canonico.sql");

// PGlite roda em autocommit: begin/commit do arquivo atrapalham.
const semTransacao = (sql) =>
  sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.email() returns text language sql stable as $$ select 'teste@reativa'::text $$;
    create function auth.role()  returns text language sql stable as $$ select 'service_role'::text $$;

    create table public.alunos (id uuid primary key default gen_random_uuid(), cpf text,
      saldo_total numeric default 0);

    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric, qtd_parcelas int default 1, saldo numeric,
      numero_acordo bigint, motivo_ajuste text,
      criado_em timestamptz default now(), atualizado_em timestamptz default now());

    create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      documento text, valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
      situacao text, status text, tipo_boleto text default 'Cursos de Graduação',
      acordo_id uuid, motivo_ajuste text,
      origem_liquidacao text, origem_encerramento text,
      atualizado_em timestamptz default now());

    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
      acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text,
      origem text, criado_em timestamptz default now());

    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      numero int, status text default 'A_VENCER', valor numeric,
      atualizado_em timestamptz default now());

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      parcela_id uuid, valor_pago numeric, baixado_em timestamptz, devolvido_em timestamptz);

    create table public.pagamentos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      valor_pago numeric, data_pagamento date default current_date);

    -- espelho do Prime, so o necessario para a rotina do portador 195
    create table public.prime_extrato (matricula text, liquidado_em date, valor_liquido numeric,
      boleto text, portador int);
    create table public.prime_contratos (registration text, cpf text);

    create function public.usuario_e_gestao() returns boolean language sql stable as $$ select true $$;
    create function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $$ select true $$;
    create function public.recalcular_situacao_aluno(p uuid) returns void language plpgsql as $$ begin return; end $$;
  `);

  await db.exec(MOTOR_PRODUCAO);

  await db.exec(`
    create trigger trg_titulo_situacao_status_coerentes
      before insert or update of situacao, status on public.acordos_titulos
      for each row execute function public._titulo_situacao_e_status_coerentes();

    create trigger trg_titulo_situacao_por_vinculo
      after insert or delete or update on public.acordo_titulo_vinculo
      for each row execute function public.titulo_situacao_por_vinculo();

    create trigger trg_acordo_status_reavalia_titulos
      after update of status on public.acordos
      for each row when (upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
      execute function public._acordo_status_reavalia_titulos();
  `);

  // A bancada nasce COM O DEFEITO: instala o corpo original de producao de
  // `prime_vincular_por_negociacao` (o arquivo de rollback e copia literal
  // dele). Isso e requisito da migration, que e um PATCH ANCORADO -- ela le
  // pg_get_functiondef e troca um trecho, entao precisa da funcao ja existir.
  // De quebra, o teste passa a provar que o patch morde o corpo REAL.
  await db.exec(semTransacao(COM_DEFEITO));

  await db.exec(semTransacao(MIGRATION));
  await db.exec(semTransacao(PORTAO));
  return db;
}

// Monta um aluno com um acordo e N mensalidades vinculadas a ele.
// `parcelas` e a lista de status das parcelas do acordo.
async function cenario(db, { statusAcordo = "ATIVO", parcelas = [], mensalidades = 1,
                             tipoBoleto = "Cursos de Graduação", valor = 100,
                             situacaoInicial = null, origemLiquidacao = null,
                             numero = 1 } = {}) {
  const aluno = await um(db, `insert into public.alunos (cpf) values ('000') returning id`);
  // nasce ATIVO: o vinculo entra com o acordo ainda em aberto, como na vida real
  const acordo = await um(db,
    `insert into public.acordos (aluno_id, status, numero_acordo, valor_total)
     values ($1,'ATIVO',$2,$3) returning id`, [aluno, numero, valor * mensalidades]);

  const titulos = [];
  for (let i = 0; i < mensalidades; i++) {
    const t = await um(db,
      `insert into public.acordos_titulos
         (aluno_id, documento, valor_original, saldo_corrigido, situacao, status,
          tipo_boleto, origem_liquidacao)
       values ($1,$2,$3,$3,'ABERTO','em_aberto',$4,$5) returning id`,
      [aluno, `doc${numero}${i}`, valor, tipoBoleto, origemLiquidacao]);
    await db.query(
      `insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, origem)
       values ($1,$2,true,'TESTE')`, [acordo, t]);
    titulos.push(t);
  }

  for (let i = 0; i < parcelas.length; i++) {
    await db.query(
      `insert into public.parcelas (acordo_id, numero, status, valor) values ($1,$2,$3,$4)`,
      [acordo, i + 1, parcelas[i], valor]);
  }

  if (situacaoInicial) {
    await db.query(`update public.acordos_titulos set situacao=$2 where id=any($1)`,
      [titulos, situacaoInicial]);
  }
  if (statusAcordo !== "ATIVO") {
    await db.query(`update public.acordos set status=$2 where id=$1`, [acordo, statusAcordo]);
  }
  return { aluno, acordo, titulos };
}

const sit = (db, id) =>
  um(db, `select situacao from public.acordos_titulos where id=$1`, [id]);
const reconciliar = (db, confirmar) =>
  um(db, `select public.mensalidade_reconciliar_negociado_quitado($1)`, [confirmar]);

describe("reconciliacao NEGOCIADO -> QUITADO pela liquidacao do acordo", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  // ---------------------------------------------------------------- 1
  it("1. mensalidade paga diretamente continua QUITADO", async () => {
    const aluno = await um(db, `insert into public.alunos (cpf) values ('1') returning id`);
    const t = await um(db,
      `insert into public.acordos_titulos (aluno_id, documento, valor_original, situacao, status)
       values ($1,'direto',500,'PAGO','quitada') returning id`, [aluno]);

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(0);
    expect(await sit(db, t)).toBe("PAGO");
  });

  // ---------------------------------------------------------------- 2
  it("2. negociada com acordo ainda aberto continua NEGOCIADO", async () => {
    const { titulos } = await cenario(db, { parcelas: ["A_VENCER", "A_VENCER"] });
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
  });

  // ---------------------------------------------------------------- 3
  it("3. acordo parcialmente pago: enquanto houver saldo, continua NEGOCIADO", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO", "VENCIDA"] });
    // mesmo que alguem marque o acordo como QUITADO, a parcela viva manda
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);

    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
  });

  // ---------------------------------------------------------------- 4
  it("4. acordo totalmente pago: a mensalidade vira QUITADO e o vinculo fica", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO", "PAGO"] });
    // o acordo vira QUITADO SEM disparar o gatilho (o buraco real: vinculo
    // criado depois, ou rotina que sobrescreve). Simula o estoque preso.
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(1);
    expect(r.alterados).toBe(1);
    expect(await sit(db, titulos[0])).toBe("PAGO");

    // o historico NAO foi apagado
    const vinculo = await um(db,
      `select count(*) from public.acordo_titulo_vinculo
        where titulo_id=$1 and acordo_id=$2 and ativo`, [titulos[0], acordo]);
    expect(Number(vinculo)).toBe(1);
    expect(await um(db, `select acordo_id from public.acordos_titulos where id=$1`, [titulos[0]]))
      .toBe(acordo);
    const motivo = await um(db, `select motivo_ajuste from public.acordos_titulos where id=$1`, [titulos[0]]);
    expect(motivo).toMatch(/quitada junto com o acordo/);
    // as parcelas continuam intactas
    expect(Number(await um(db, `select count(*) from public.parcelas where acordo_id=$1`, [acordo]))).toBe(2);
  });

  // ---------------------------------------------------------------- 5
  it("5. acordo cancelado nao vira QUITADO sem pagamento valido", async () => {
    const { titulos } = await cenario(db, { parcelas: ["CANCELADA", "CANCELADA"],
      statusAcordo: "CANCELADO" });
    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).not.toBe("PAGO");
  });

  // ---------------------------------------------------------------- 6
  it("6. acordo quebrado (parcela viva, rotulo QUITADO) nao vira QUITADO", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO", "VENCIDA", "A_VENCER"] });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
  });

  // ---------------------------------------------------------------- 7
  it("7. pagamento estornado: parcela que volta a viva reprova a quitacao", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO", "PAGO"] });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    // estorno: a baixa foi devolvida e a parcela voltou a viva
    await db.query(`insert into public.baixas_pagamento (acordo_id, valor_pago, baixado_em, devolvido_em)
                    values ($1, 100, now(), now())`, [acordo]);
    await db.query(`update public.parcelas set status='VENCIDA'
                     where acordo_id=$1 and numero=2`, [acordo]);

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
  });

  // ---------------------------------------------------------------- 8
  it("8. varias mensalidades no mesmo acordo viram todas juntas", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"], mensalidades: 4 });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(4);
    expect(r.acordos).toBe(1);
    expect(r.alunos).toBe(1);
    for (const t of titulos) expect(await sit(db, t)).toBe("PAGO");
  });

  // ---------------------------------------------------------------- 9
  it("9. varios pagamentos no mesmo acordo: so quita quando nao sobra parcela viva", async () => {
    const { acordo, titulos } = await cenario(db,
      { parcelas: ["PAGO", "PAGO", "VENCIDA"], mensalidades: 2 });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    // tres pagamentos registrados, mas a terceira parcela ainda esta viva
    expect((await reconciliar(db, true)).mensalidades).toBe(0);
    for (const t of titulos) expect(await sit(db, t)).toBe("NEGOCIADO");

    // agora a ultima e paga: o acordo fecha de verdade
    await db.query(`update public.parcelas set status='PAGO' where acordo_id=$1`, [acordo]);
    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(2);
    for (const t of titulos) expect(await sit(db, t)).toBe("PAGO");
  });

  // ---------------------------------------------------------------- 10
  it("10. rodar duas vezes: a segunda execucao nao altera nada", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"], mensalidades: 3 });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    const r1 = await reconciliar(db, true);
    expect(r1.mensalidades).toBe(3);

    const antes = await um(db, `select count(*) from public.mensalidade_reconciliacao_log`);
    const r2 = await reconciliar(db, true);
    expect(r2.mensalidades).toBe(0);
    expect(r2.alterados).toBe(0);
    const depois = await um(db, `select count(*) from public.mensalidade_reconciliacao_log`);
    expect(depois).toBe(antes);
    for (const t of titulos) expect(await sit(db, t)).toBe("PAGO");
  });

  // ------------------------------------------------- exclusoes deliberadas
  it("boleto do proprio acordo nunca e quitado por aqui: nunca foi divida", async () => {
    const { acordo, titulos } = await cenario(db,
      { parcelas: ["PAGO"], tipoBoleto: "Acordo" });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    expect((await reconciliar(db, true)).mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
  });

  it("titulo com liquidacao propria fica de fora: a origem da quitacao nao e o acordo", async () => {
    const { acordo, titulos } = await cenario(db,
      { parcelas: ["PAGO"], origemLiquidacao: "PRIME_195" });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    expect((await reconciliar(db, true)).mensalidades).toBe(0);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO");
  });

  // ------------------------------------------------------------ auditoria
  it("a previa nao escreve, e o log registra o estado anterior e o posterior", async () => {
    const { acordo, titulos } = await cenario(db, { parcelas: ["PAGO"], mensalidades: 2 });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    const previa = await reconciliar(db, false);
    expect(previa.modo).toBe("previa");
    expect(previa.mensalidades).toBe(2);
    expect(previa.ids).toHaveLength(2);
    expect(await sit(db, titulos[0])).toBe("NEGOCIADO"); // previa nao escreveu
    expect(Number(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`))).toBe(0);

    await reconciliar(db, true);
    const log = await db.query(
      `select situacao_antes, status_antes, situacao_depois, status_depois, acordo_id
         from public.mensalidade_reconciliacao_log order by titulo_id`);
    expect(log.rows).toHaveLength(2);
    for (const l of log.rows) {
      expect(l.situacao_antes).toBe("NEGOCIADO");
      expect(l.status_antes).toBe("vinculada");
      expect(l.situacao_depois).toBe("PAGO");
      expect(l.status_depois).toBe("quitada");
      expect(l.acordo_id).toBe(acordo);
    }
  });

  it("nao toca em mensalidade de outro aluno nem em acordo de fora da populacao", async () => {
    const alvo = await cenario(db, { parcelas: ["PAGO"], numero: 1 });
    await db.query(`alter table public.acordos disable trigger trg_acordo_status_reavalia_titulos`);
    await db.query(`update public.acordos set status='QUITADO' where id=$1`, [alvo.acordo]);
    await db.query(`alter table public.acordos enable trigger trg_acordo_status_reavalia_titulos`);

    const vizinho = await cenario(db, { parcelas: ["VENCIDA"], numero: 2 });
    const aberta = await um(db,
      `insert into public.acordos_titulos (aluno_id, documento, valor_original, situacao, status)
       values ($1,'solta',300,'ABERTO','em_aberto') returning id`, [vizinho.aluno]);

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(1);
    expect(await sit(db, alvo.titulos[0])).toBe("PAGO");
    expect(await sit(db, vizinho.titulos[0])).toBe("NEGOCIADO");
    expect(await sit(db, aberta)).toBe("ABERTO");
  });
});

// ===========================================================================
// A CAUSA RAIZ: a rotina do Prime nao pode mais sobrescrever o motor
// ===========================================================================
describe("prime_vincular_por_negociacao nao sobrescreve a decisao do motor", () => {
  let db;

  async function bancadaPrime(database) {
    const aluno = await um(database,
      `insert into public.alunos (cpf) values ('12345678900') returning id`);
    // acordo JA QUITADO, todas as parcelas pagas -- o caso dos 64
    const acordo = await um(database,
      `insert into public.acordos (aluno_id, status, numero_acordo, valor_total, criado_em)
       values ($1,'QUITADO',188,1000, now()) returning id`, [aluno]);
    await database.query(
      `insert into public.parcelas (acordo_id, numero, status, valor) values ($1,1,'PAGO',1000)`,
      [acordo]);
    const titulo = await um(database,
      `insert into public.acordos_titulos (aluno_id, documento, valor_original, saldo_corrigido, situacao, status)
       values ($1,'1580130',1580.13,1580.13,'ABERTO','em_aberto') returning id`, [aluno]);
    await database.query(
      `insert into public.prime_contratos (registration, cpf) values ('M1','12345678900')`);
    await database.query(
      `insert into public.prime_extrato (matricula, liquidado_em, valor_liquido, boleto, portador)
       values ('M1', current_date, 1580.13, '1580130', 195)`);
    return { aluno, acordo, titulo };
  }

  beforeEach(async () => { db = await novoBanco(); });

  it("corrigida: acordo ja QUITADO => a mensalidade nasce QUITADO", async () => {
    const { titulo, acordo } = await bancadaPrime(db);

    const r = await um(db, `select public.prime_vincular_por_negociacao(true, 45)`);
    expect(r.vinculos_criados).toBe(1);

    expect(await sit(db, titulo)).toBe("PAGO");
    // o historico diz que a origem foi o acordo, E que veio pelo Prime
    const motivo = await um(db, `select motivo_ajuste from public.acordos_titulos where id=$1`, [titulo]);
    expect(motivo).toMatch(/quitada junto com o acordo 188/);
    expect(motivo).toMatch(/vinculado pelo Prime/);
    // o vinculo ficou
    expect(Number(await um(db,
      `select count(*) from public.acordo_titulo_vinculo where titulo_id=$1 and acordo_id=$2 and ativo`,
      [titulo, acordo]))).toBe(1);
  });

  it("corrigida: acordo ATIVO => a mensalidade continua NEGOCIADO (nada mudou nesse caso)", async () => {
    const { titulo, acordo } = await bancadaPrime(db);
    await db.query(`update public.parcelas set status='A_VENCER' where acordo_id=$1`, [acordo]);
    await db.query(`update public.acordos set status='ATIVO' where id=$1`, [acordo]);

    await um(db, `select public.prime_vincular_por_negociacao(true, 45)`);
    expect(await sit(db, titulo)).toBe("NEGOCIADO");
  });

  it("mutacao: com o corpo ANTIGO, o acordo QUITADO deixava a mensalidade em NEGOCIADO", async () => {
    const { titulo } = await bancadaPrime(db);
    // recarrega o corpo com o defeito (o rollback do arquivo 1)
    await db.exec(semTransacao(COM_DEFEITO));

    await um(db, `select public.prime_vincular_por_negociacao(true, 45)`);

    // o defeito: o motor quitou, o UPDATE da rotina desfez
    expect(await sit(db, titulo)).toBe("NEGOCIADO");
    // e deixou a digital -- o motivo do motor sobreviveu ao UPDATE
    const motivo = await um(db, `select motivo_ajuste from public.acordos_titulos where id=$1`, [titulo]);
    expect(motivo).toMatch(/quitada junto com o acordo 188/);
  });

  it("mutacao: a reconciliacao conserta exatamente o que o corpo antigo estragou", async () => {
    const { titulo } = await bancadaPrime(db);
    await db.exec(semTransacao(COM_DEFEITO));
    await um(db, `select public.prime_vincular_por_negociacao(true, 45)`);
    expect(await sit(db, titulo)).toBe("NEGOCIADO");

    const r = await reconciliar(db, true);
    expect(r.mensalidades).toBe(1);
    expect(await sit(db, titulo)).toBe("PAGO");
  });
});
