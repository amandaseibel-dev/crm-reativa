// RODADA INCREMENTAL · A RESERVA PARA PENDÊNCIA BLOQUEADA — PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (supabase/migrations/20261023004500_*.sql) e o ROLLBACK
// REAL, sobre a BANCADA DE PRODUÇÃO da rodada (21/10) mais a BASE DE REFERÊNCIA
// das 448 pendências (22/10, da PR #737). Nenhum arquivo novo de bancada: as
// duas que já existem são reaproveitadas inteiras.
//
// ESCOPO DECLARADO, para não haver dúvida sobre o que está provado:
//
//   Prova-se o ORÇAMENTO: quantas vagas do lote vão para pendência com porta de
//   saída e quantas para pendência bloqueada por etapa desligada, antes e
//   depois da migration, simulando UM DIA INTEIRO (13 rodadas que aplicam ×
//   lote 25, que é o que os jobs 73/74/75 fazem hoje).
//
//   A DECISÃO FINANCEIRA é toda de `pagamento_conciliar_um` (24.824 caracteres
//   em produção) e aqui é DUBLADA, configurada para devolver o MESMO status que
//   o pagamento já tem -- isto é, para não resolver nada. É de propósito: o que
//   se mede é para ONDE vai o orçamento, não se a baixa está certa.
//
//   `sistema_sob_carga`, `calibragem_e_gestao`, `usuario_e_gestao` e
//   `_fila_pagamento_tentativa` entram com o corpo EXATO de produção, conferido
//   por md5 contra a fixture -- e o corpo da PRÓPRIA RODADA é conferido contra
//   o md5 lido em produção em 22/10/2026.
//
// LIMITE CONHECIDO DA BANCADA, dito em vez de escondido: a trava
// `pg_try_advisory_xact_lock` NÃO é coberta (PGlite é sessão única), e a base de
// referência é SINTÉTICA -- ela reproduz a distribuição medida em 22/10/2026,
// registrada em docs/TRIAGEM-FILA-PAGAMENTO-2026-10-22.md, não a produção de
// hoje.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que
// a executa, num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const BANCADA = ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.sql");
const MD5 = JSON.parse(ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.md5.json"));
const REFERENCIA = ler("supabase/tests/fixtures/fila_pagamento_triagem_referencia.sql");

const MIG_RODADA = ler("supabase/migrations/20261021195950_fluxo_pagamentos_incremental.sql");
const MIG_PERM = ler("supabase/migrations/20261021210208_vw_fluxo_monitor_fecha_escrita.sql");
const MIG_PREVIA = ler("supabase/migrations/20261021210416_fluxo_incremental_previa_sem_escrita.sql");
const MIG_ESPERA = ler("supabase/migrations/20261021223117_fluxo_incremental_espera_nao_exclui.sql");
const MIG_TRIAGEM = ler("supabase/migrations/20261023000700_fila_pagamento_triagem.sql");
const MIGRATION = ler("supabase/migrations/20261023004500_fluxo_incremental_reserva_bloqueado.sql");
const ROLLBACK = ler("supabase/rollbacks/20261023004500_fluxo_incremental_reserva_bloqueado.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";

// O CORPO VIVO EM PRODUÇÃO, lido com `pg_get_functiondef` em 22/10/2026 em
// `ahattpqrjmhkzsmnbdzs`. É o ponto de partida desta frente: se o repositório
// divergir do que está rodando, esta frente está construindo sobre o chão
// errado e o teste acusa ANTES de qualquer outra coisa.
const MD5_RODADA_PROD = "11c14ef5bcbc4283357de8ef2d798c5e";

// O QUE FOI MEDIDO EM PRODUÇÃO EM 22/10/2026, escrito como literal de propósito:
// se a base de referência mudar sem que a medição mude, o fechamento quebra
// aqui em vez de passar com números novos em silêncio.
const TOTAL_PENDENCIAS = 448;
const ELEGIVEIS = 415;   // 448 menos as 33 que a gestão já decidiu
const BLOQUEADAS = 265;  // dependem de `consulta_portador`, desligada em 15/09
const COM_SAIDA = 150;   // 415 - 265

// Os jobs 73/74/75, como estão em produção: lote 25, e 13 execuções por dia que
// APLICAM (1 do job 73 + 12 do job 74). O job 75 roda em prévia e não escreve.
const LOTE = 25;
const RODADAS_DO_DIA = 13;
const RESERVA = 5; // 20% de 25

const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const md5 = (s) => createHash("md5").update(s).digest("hex");

// O corpo da função como o arquivo de migration o escreve -- é isso que vira
// `prosrc` no banco, e é isso que se compara com o md5 de produção.
const corpoDoArquivo = (texto) => {
  const i = texto.indexOf("as $fn$") + "as $fn$".length;
  const j = texto.indexOf("$fn$;", i);
  return texto.slice(i, j);
};

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

const rodar = async (db, o = {}) => {
  const { lote = LOTE, seg = 120, tent = 8, espera = 24, aplicar = true } = o;
  return (await q1(db,
    "select public.fluxo_pagamentos_incremental($1,$2,$3,$4,$5) j",
    [lote, seg, tent, espera, aplicar])).j;
};

// O DUBLÊ NÃO RESOLVE NADA, de propósito: devolve a cada pagamento o status que
// ele já tem. Assim nenhuma pendência sai da fila por efeito do teste, e o que
// sobra de observável é exatamente a REPARTIÇÃO DO ORÇAMENTO.
const DUBLE_NEUTRO = `
  insert into public._dub_motor (pagamento_id, status, baixou)
  select p.id, p.status_conciliacao, false
    from public.pagamentos p
   where p.status_conciliacao is not null
     on conflict (pagamento_id) do nothing;
`;

// A BANCADA SÓ É MONTADA UMA VEZ. Gerar as 448 pendências da base de
// referência é a parte caríssima, e os três estágios diferem apenas por quais
// migrations já rodaram -- então o estágio sem a triagem é dumpado, e os outros
// dois nascem dele aplicando só o que falta. O CI já roda a 80% do seu teto.
async function montarBase() {
  const db = new PGlite();
  await db.exec(BANCADA);

  // PORTAO DE FIDELIDADE: corpo de producao divergente para aqui.
  const rows = await qn(db,
    `select 'public.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, esperado] of Object.entries(MD5)) {
    if (noBanco[nome] !== esperado) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(REFERENCIA);
  await como(db, GESTAO);

  await db.exec(MIG_RODADA);
  await db.exec(MIG_PERM);
  await db.exec(MIG_PREVIA);
  await db.exec(MIG_ESPERA);
  await db.exec(DUBLE_NEUTRO);
  return db;
}

// Carrega um dump, aplica as migrations que faltam e devolve o novo dump.
async function derivar(dump, ...migrations) {
  const db = new PGlite({ loadDataDir: dump });
  await como(db, GESTAO);
  for (const m of migrations) await db.exec(m);
  const novo = await db.dumpDataDir();
  await db.close();
  return novo;
}

let ANTES, DEPOIS, SEM_TRIAGEM;
// AS DUAS FOTOS DO DIA. Simular um dia custa 325 chamadas ao motor, e o CI já
// roda a 80% do seu teto -- então o dia é simulado UMA VEZ por estágio, aqui, e
// os casos abaixo leem a mesma foto em vez de repetir a simulação cada um.
let FOTO_ANTES, FOTO_DEPOIS;

beforeAll(async () => {
  const base = await montarBase();
  SEM_TRIAGEM = await base.dumpDataDir();
  await base.close();
  ANTES = await derivar(SEM_TRIAGEM, MIG_TRIAGEM);
  DEPOIS = await derivar(ANTES, MIGRATION);
  FOTO_ANTES = await simularUmDia("antes");
  FOTO_DEPOIS = await simularUmDia("com");
});

const DADOS = { antes: () => ANTES, com: () => DEPOIS, sem_triagem: () => SEM_TRIAGEM };
const abrir = async (estagio) => {
  const db = new PGlite({ loadDataDir: DADOS[estagio]() });
  await como(db, GESTAO);
  return db;
};

// Um dia de produção: as 13 execuções que APLICAM (job 73 uma vez às 08h BRT e
// job 74 de 09h a 20h), lote 25. Devolve tudo o que os casos precisam conferir,
// medido antes e depois, para que a simulação aconteça uma única vez.
async function simularUmDia(estagio) {
  const db = await abrir(estagio);
  const antes = await digitalIntocavel(db);
  const categoriasAntes = await categorias(db);

  const primeira = await rodar(db, { lote: LOTE });
  for (let i = 1; i < RODADAS_DO_DIA; i++) await rodar(db, { lote: LOTE });

  const foto = {
    primeira,
    antes,
    depois: await digitalIntocavel(db),
    categoriasAntes,
    categoriasDepois: await categorias(db),
    reparticao: await reparticao(db),
    naView: (await q1(db, `select count(*)::int n from public.vw_fila_pagamento_triagem`)).n,
    fila: await q1(db, `select count(*)::int n, count(distinct pagamento_id)::int u
                          from public.fila_pagamento_sem_vinculo`),
    forcaDeFora: await q1(db, `select
        (select count(*)::int from public._dub_chamadas c
           join public.pagamentos p on p.id = c.pagamento_id
          where p.status_conciliacao is null)                            as historico,
        (select count(*)::int from public._dub_chamadas c
           join public.pagamentos p on p.id = c.pagamento_id
          where p.status_conciliacao = 'BAIXADO')                        as baixado,
        (select count(*)::int from public._dub_chamadas c
           join public.fila_pagamento_sem_vinculo f on f.pagamento_id = c.pagamento_id
          where f.decisao is not null)                                   as decidido`),
  };
  await db.close();
  return foto;
}

// Quem foi tocado, e de que lado do orçamento estava. `_dub_chamadas` é o
// registro de cada chamada ao motor; a triagem diz a categoria.
const reparticao = async (db) => await q1(db, `
  select count(*)::int                                                           as toques,
         count(distinct c.pagamento_id)::int                                     as distintos,
         count(*) filter (where t.categoria = 'BLOQUEADO_ETAPA_DESATIVADA')::int as toques_bloqueado,
         count(*) filter (where t.categoria <> 'BLOQUEADO_ETAPA_DESATIVADA')::int as toques_com_saida,
         count(distinct c.pagamento_id) filter
           (where t.categoria = 'BLOQUEADO_ETAPA_DESATIVADA')::int               as distintos_bloqueado,
         count(distinct c.pagamento_id) filter
           (where t.categoria <> 'BLOQUEADO_ETAPA_DESATIVADA')::int              as distintos_com_saida
    from public._dub_chamadas c
    join public.vw_fila_pagamento_triagem t on t.pagamento_id = c.pagamento_id`);

const umDia = async (db, o = {}) => {
  for (let i = 0; i < RODADAS_DO_DIA; i++) await rodar(db, { lote: LOTE, ...o });
};

const categorias = async (db) => await qn(db,
  `select categoria, count(*)::int n from public.vw_fila_pagamento_triagem
    group by categoria order by categoria`);

// Digital de linha inteira das tabelas que esta frente NÃO pode mexer.
const digitalIntocavel = async (db) => await q1(db, `select
    md5(coalesce((select string_agg(c::text,'|' order by c.etapa)
                    from public.fluxo_pagamentos_config c),''))              as config,
    (select count(*)::int from public.fila_pagamento_sem_vinculo
      where decisao is not null)                                             as decididas,
    md5(coalesce((select string_agg(f.decisao,'|' order by f.pagamento_id)
                    from public.fila_pagamento_sem_vinculo f
                   where f.decisao is not null),''))                         as decisoes,
    (select count(*)::int from public.pagamentos where status_conciliacao is null) as historicos,
    (select count(*)::int from public.pagamentos
      where status_conciliacao is not null and status_conciliacao <> 'BAIXADO') as pendentes,
    (select count(*)::int from public.pagamentos where status_conciliacao = 'BAIXADO') as baixados,
    (select count(*)::int from public.baixas_pagamento)                      as linhas_de_baixa`);

// ===========================================================================
describe("o chão: o repositório é o que está rodando em produção", () => {
  it("o corpo da rodada no repositório tem o md5 LIDO em produção em 22/10/2026", () => {
    expect(md5(corpoDoArquivo(MIG_ESPERA))).toBe(MD5_RODADA_PROD);
  });

  it("o rollback restaura esse MESMO corpo, byte a byte", () => {
    expect(md5(corpoDoArquivo(ROLLBACK))).toBe(MD5_RODADA_PROD);
    expect(corpoDoArquivo(ROLLBACK)).toBe(corpoDoArquivo(MIG_ESPERA));
  });

  it("a bancada traz os quatro corpos de produção conferidos por md5", async () => {
    const db = await abrir("antes");
    const r = await qn(db,
      `select 'public.'||p.proname nome, md5(p.prosrc) md5 from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
    const m = Object.fromEntries(r.map((x) => [x.nome, x.md5]));
    for (const [nome, esperado] of Object.entries(MD5)) expect(m[nome]).toBe(esperado);
    await db.close();
  });

  it("a base de referência reproduz a partição medida: 448 / 415 elegíveis / 265 bloqueadas", async () => {
    const db = await abrir("antes");
    const t = await q1(db, `select
        (select count(*)::int from public.vw_fila_pagamento_triagem)                      as total,
        (select count(*)::int from public.vw_fila_pagamento_triagem
          where categoria = 'BLOQUEADO_ETAPA_DESATIVADA')                                 as bloqueadas,
        (select count(*)::int from public.fila_pagamento_sem_vinculo where decisao is not null) as decididas,
        (select sum(valor_pago)::numeric(14,2)::text from public.vw_fila_pagamento_triagem) as valor`);
    expect(t.total).toBe(TOTAL_PENDENCIAS);
    expect(t.bloqueadas).toBe(BLOQUEADAS);
    expect(t.total - t.decididas).toBe(ELEGIVEIS);
    expect(t.valor).toBe("377515.27");
    await db.close();
  });
});

// ===========================================================================
describe("ANTES: o defeito existe, e a bancada o reproduz", () => {
  it("um dia inteiro gasta a maior parte do orçamento em pendência sem porta", () => {
    const r = FOTO_ANTES.reparticao;
    expect(r.toques).toBe(LOTE * RODADAS_DO_DIA);           // 325 avaliações no dia
    expect(r.toques_bloqueado).toBe(BLOQUEADAS);            // 265 delas, 81,5%
    expect(r.toques_com_saida).toBe(LOTE * RODADAS_DO_DIA - BLOQUEADAS); // 60
    // E o que mais dói: 90 das 150 pendências com saída não são olhadas no dia.
    expect(r.distintos_com_saida).toBe(60);
    expect(r.distintos_com_saida).toBeLessThan(COM_SAIDA);
  });

  it("e a rodada não tem como dizer isso: o retorno não reparte o lote", () => {
    const r = FOTO_ANTES.primeira;
    expect(r.processados).toBe(LOTE);
    expect(r.processados_bloqueado).toBeUndefined();
    expect(r.reserva_bloqueado).toBeUndefined();
  });
});

// ===========================================================================
describe("DEPOIS: a reserva devolve o orçamento a quem tem porta de saída", () => {
  it("uma rodada leva no máximo a reserva de bloqueados, e o lote continua 25", () => {
    const r = FOTO_DEPOIS.primeira;
    expect(r.processados).toBe(LOTE);
    expect(r.reserva_bloqueado).toBe(RESERVA);
    expect(r.processados_bloqueado).toBe(RESERVA);
    expect(r.processados_com_saida).toBe(LOTE - RESERVA);
  });

  it("um dia inteiro: as 150 com saída são TODAS vistas, e as bloqueadas seguem sendo reexaminadas", () => {
    const r = FOTO_DEPOIS.reparticao;
    expect(r.toques).toBe(LOTE * RODADAS_DO_DIA);                  // 325, o mesmo de antes
    expect(r.toques_com_saida).toBe((LOTE - RESERVA) * RODADAS_DO_DIA); // 260 (eram 60)
    expect(r.toques_bloqueado).toBe(RESERVA * RODADAS_DO_DIA);     // 65 (eram 265)
    // A promessa: nenhuma pendência com saída fica sem ser olhada num dia...
    expect(r.distintos_com_saida).toBe(COM_SAIDA);
    // ...e NENHUMA bloqueada desaparece: elas continuam sendo reexaminadas.
    expect(r.distintos_bloqueado).toBe(RESERVA * RODADAS_DO_DIA);
    expect(r.distintos_bloqueado).toBeGreaterThan(0);
  });

  it("nenhuma pendência desaparece da fila: o total continua 448 depois de um dia", () => {
    expect(FOTO_DEPOIS.depois.pendentes).toBe(TOTAL_PENDENCIAS);
    expect(FOTO_DEPOIS.depois.pendentes).toBe(FOTO_DEPOIS.antes.pendentes);
    expect(FOTO_DEPOIS.naView).toBe(TOTAL_PENDENCIAS);
    // E a fila continua com as mesmas 448 linhas, uma por pagamento.
    expect(FOTO_DEPOIS.fila.n).toBe(TOTAL_PENDENCIAS);
    expect(FOTO_DEPOIS.fila.u).toBe(TOTAL_PENDENCIAS);
  });

  it("a partição por categoria é a MESMA depois de um dia -- ninguém muda de balde", () => {
    expect(FOTO_DEPOIS.categoriasDepois).toEqual(FOTO_DEPOIS.categoriasAntes);
  });

  it("a reserva é PISO, não teto: com poucas pendências com saída, os bloqueados ocupam o resto", async () => {
    const db = await abrir("com");
    // Sobram 3 com saída; as outras 147 saem da fila da rodada por decisão da
    // gestão (é o caminho normal, e aqui é só para esvaziar o grupo).
    await db.query(`
      update public.fila_pagamento_sem_vinculo f
         set decisao = 'ENCERRADO_GESTAO', decidido_por = 'teste', decidido_em = now()
       where f.decisao is null
         and f.pagamento_id not in (select t.pagamento_id from public.vw_fila_pagamento_triagem t
                                     where t.categoria = 'BLOQUEADO_ETAPA_DESATIVADA')
         and f.pagamento_id not in (select t.pagamento_id from public.vw_fila_pagamento_triagem t
                                     where t.categoria <> 'BLOQUEADO_ETAPA_DESATIVADA'
                                     order by t.pagamento_id limit 3)`);
    const r = await rodar(db);
    expect(r.processados).toBe(LOTE);
    expect(r.processados_com_saida).toBe(3);
    expect(r.processados_bloqueado).toBe(LOTE - 3); // 22, não a reserva de 5
    await db.close();
  });

  it("sem nenhum bloqueado, a reserva não tira vaga de ninguém", async () => {
    const db = await abrir("com");
    // Religar a etapa é o caminho da gestão; aqui o efeito é o mesmo: some o
    // grupo dos bloqueados.
    await db.query(`update public.fluxo_pagamentos_config set ligado = true
                     where etapa = 'consulta_portador'`);
    const r = await rodar(db);
    expect(r.processados).toBe(LOTE);
    expect(r.processados_bloqueado).toBe(0);
    expect(r.processados_com_saida).toBe(LOTE);
    await db.close();
  });
});

// ===========================================================================
describe("RELIGAR A ETAPA devolve o orçamento normal, sem editar SQL", () => {
  it("com a etapa ligada, a rodada escolhe EXATAMENTE o que a versão de 21/10 escolheria", async () => {
    // A prova é por comparação direta: mesma base, duas funções, mesma escolha.
    const comReserva = await abrir("com");
    await comReserva.query(`update public.fluxo_pagamentos_config set ligado = true
                             where etapa = 'consulta_portador'`);
    await rodar(comReserva);
    const escolhaNova = (await qn(comReserva,
      `select pagamento_id from public._dub_chamadas order by n`)).map((x) => x.pagamento_id);
    await comReserva.close();

    const semReserva = await abrir("antes");
    await rodar(semReserva);
    const escolhaVelha = (await qn(semReserva,
      `select pagamento_id from public._dub_chamadas order by n`)).map((x) => x.pagamento_id);
    await semReserva.close();

    expect(escolhaNova).toHaveLength(LOTE);
    expect(escolhaNova).toEqual(escolhaVelha);
  });

  it("e a reclassificação vem da CONFIGURAÇÃO: não há nome de etapa no SQL da rodada", async () => {
    const db = await abrir("com");
    // O CÓDIGO, sem os comentários: o corpo CITA a configuração no comentário
    // que explica de onde vem a classificação, e é o que ele EXECUTA que vale.
    const r = await q1(db, `select regexp_replace(p.prosrc, '--.*$', '', 'gn') src
                              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                             where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`);
    expect(r.src).not.toContain("consulta_portador");
    expect(r.src).not.toContain("fluxo_pagamentos_config");
    expect(r.src).toContain("vw_fila_pagamento_triagem");
    // nem no texto cru aparece nome de etapa -- nem em comentário
    const cru = await q1(db, `select p.prosrc src from pg_proc p
                                join pg_namespace n on n.oid=p.pronamespace
                               where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`);
    expect(cru.src).not.toContain("consulta_portador");
    await db.close();
  });

  it("desligar OUTRA etapa não muda nada hoje, porque o mapa é da triagem e não da rodada", async () => {
    const db = await abrir("com");
    await db.query(`update public.fluxo_pagamentos_config set ligado = false
                     where etapa = 'encerrar_ja_paga_conferida'`);
    const r = await rodar(db);
    // A triagem só declara dependência de motivo para `consulta_portador`;
    // mexer em outra etapa não inventa bloqueio novo na rodada.
    expect(r.processados_bloqueado).toBe(RESERVA);
    await db.close();
  });
});

// ===========================================================================
describe("O QUE NÃO PODE MUDAR", () => {
  it("o lote e o teto de tempo continuam valendo", async () => {
    const db = await abrir("com");
    const r = await rodar(db, { lote: 9999, seg: 9999 });
    expect(r.lote).toBe(500);
    expect(r.orcamento_s).toBe(120);
    expect(r.processados).toBeLessThanOrEqual(500);
    await db.close();
  });

  it("a rodada para no meio quando o tempo acaba, e marca esgotou_tempo", async () => {
    const db = await abrir("com");
    await db.query(`update public._dub_motor set dorme_ms = 400`);
    const r = await rodar(db, { lote: LOTE, seg: 1 });
    expect(r.processados).toBeGreaterThan(0);
    expect(r.processados).toBeLessThan(LOTE);
    expect(r.esgotou_tempo).toBe(true);
    // e a soma das duas pontas continua fechando com o processado
    expect(r.processados_bloqueado + r.processados_com_saida).toBe(r.processados);
    await db.close();
  });

  it("a fronteira de 14/09 segue intacta: status_conciliacao NULO nunca é tocado", () => {
    expect(FOTO_DEPOIS.antes.historicos).toBeGreaterThan(0);
    expect(FOTO_DEPOIS.depois.historicos).toBe(FOTO_DEPOIS.antes.historicos);
    expect(FOTO_DEPOIS.forcaDeFora.historico).toBe(0);
  });

  it("BAIXADO não volta para a fila, e a decisão da gestão continua respeitada", () => {
    expect(FOTO_DEPOIS.forcaDeFora.baixado).toBe(0);
    expect(FOTO_DEPOIS.forcaDeFora.decidido).toBe(0);
  });

  it("nenhuma etapa é religada, nenhuma decisão é alterada, nenhuma baixa é dada", () => {
    const { antes, depois } = FOTO_DEPOIS;
    expect(depois.config).toBe(antes.config);            // config intacta
    expect(depois.decididas).toBe(antes.decididas);      // as 33 continuam 33
    expect(depois.decisoes).toBe(antes.decisoes);        // e com as MESMAS decisões
    expect(depois.baixados).toBe(antes.baixados);
    expect(depois.linhas_de_baixa).toBe(antes.linhas_de_baixa);
  });

  it("a prévia continua sem escrever: nem contador, nem status, nem fila", async () => {
    const db = await abrir("com");
    await db.exec(`alter table public.fila_pagamento_sem_vinculo
                   enable trigger trg_fila_pagamento_tentativa`);
    const antes = await q1(db, `select
        md5(coalesce((select string_agg(f::text,'|' order by f.id)
                        from public.fila_pagamento_sem_vinculo f),'')) fila,
        md5(coalesce((select string_agg(p::text,'|' order by p.id)
                        from public.pagamentos p),''))                 pag`);
    const r = await rodar(db, { aplicar: false });
    const depois = await q1(db, `select
        md5(coalesce((select string_agg(f::text,'|' order by f.id)
                        from public.fila_pagamento_sem_vinculo f),'')) fila,
        md5(coalesce((select string_agg(p::text,'|' order by p.id)
                        from public.pagamentos p),''))                 pag`);
    expect(r.modo).toBe("previa");
    expect(r.previa_revertida).toBe(true);
    expect(depois.fila).toBe(antes.fila);
    expect(depois.pag).toBe(antes.pag);
    await db.exec(`alter table public.fila_pagamento_sem_vinculo
                   disable trigger trg_fila_pagamento_tentativa`);
    await db.close();
  });

  it("a função continua com UMA assinatura -- a chamada de 5 argumentos dos jobs não fica ambígua", async () => {
    const db = await abrir("com");
    const r = await q1(db, `select count(*)::int n, min(pg_get_function_identity_arguments(p.oid)) args
                              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                             where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`);
    expect(r.n).toBe(1);
    expect(r.args).toBe(
      "p_lote integer, p_segundos integer, p_tentativas_max integer, "
      + "p_espera_horas integer, p_aplicar boolean");
    // e a chamada posicional dos jobs 73/74/75 resolve
    const j = await q1(db, `select public.fluxo_pagamentos_incremental(25, 20, 8, 24, false) j`);
    expect(j.j.modo).toBe("previa");
    await db.close();
  });

  it("o portão fechado: anon não executa, authenticated executa", async () => {
    const db = await abrir("com");
    const r = await q1(db, `select
        has_function_privilege('anon',
          'public.fluxo_pagamentos_incremental(int,int,int,int,boolean)','EXECUTE') a,
        has_function_privilege('authenticated',
          'public.fluxo_pagamentos_incremental(int,int,int,int,boolean)','EXECUTE') b`);
    expect(r.a).toBe(false);
    expect(r.b).toBe(true);
    await db.close();
  });

  it("a migration não toca em cron nem em etapa", () => {
    // Nenhuma chamada nem leitura do agendador: os jobs 73/74/75 ficam como
    // estão, inclusive o `active`. A palavra "cron" aparece no cabeçalho em
    // prosa, e é isso que o recorte abaixo distingue de uso real.
    expect(MIGRATION).not.toMatch(/cron\.(job|schedule|unschedule|alter_job)/i);
    expect(MIGRATION).not.toMatch(/\bselect\s+cron\b/i);
    // nenhuma escrita na configuração de etapas
    expect(MIGRATION).not.toMatch(/update\s+public\.fluxo_pagamentos_config/i);
    expect(MIGRATION).not.toMatch(/insert\s+into\s+public\.fluxo_pagamentos_config/i);
  });
});

// ===========================================================================
describe("O MONITOR mostra a reparticao", () => {
  it("as três colunas novas aparecem, e as antigas continuam no mesmo lugar", async () => {
    const db = await abrir("com");
    await rodar(db);
    const m = await q1(db, `select * from public.vw_fluxo_pagamentos_monitor limit 1`);
    expect(m.situacao).toBe("aplicado");
    expect(m.processados).toBe(LOTE);
    expect(m.processados_bloqueado).toBe(RESERVA);
    expect(m.processados_com_saida).toBe(LOTE - RESERVA);
    expect(m.reserva_bloqueado).toBe(RESERVA);
    await db.close();
  });

  it("execução anterior à migration aparece com as colunas novas nulas, sem quebrar a view", async () => {
    const db = await abrir("antes");
    await rodar(db);                       // grava sem as chaves novas
    await db.exec(MIGRATION);
    const m = await q1(db, `select * from public.vw_fluxo_pagamentos_monitor limit 1`);
    expect(m.processados).toBe(LOTE);
    expect(m.processados_bloqueado).toBeNull();
    expect(m.reserva_bloqueado).toBeNull();
    await db.close();
  });

  it("o monitor continua só de leitura para authenticated, e com security_invoker", async () => {
    const db = await abrir("com");
    const v = await q1(db, `select
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','select') s,
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','update') u,
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','delete') d,
        has_table_privilege('anon','public.vw_fluxo_pagamentos_monitor','select') anon,
        coalesce(array_to_string(c.reloptions,','),'(sem)') op
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='vw_fluxo_pagamentos_monitor'`);
    expect(v.s).toBe(true);
    expect([v.u, v.d, v.anon]).toEqual([false, false, false]);
    expect(v.op).toMatch(/security_invoker=(true|on)/);
    await db.close();
  });
});

// ===========================================================================
describe("O PORTÃO DE ENTRADA: sem a view da #737, a migration RECUSA", () => {
  it("recusa em vez de duplicar a classificação", async () => {
    const db = await abrir("sem_triagem");
    expect((await q1(db, `select to_regclass('public.vw_fila_pagamento_triagem') v`)).v).toBeNull();
    await expect(db.exec(MIGRATION)).rejects.toThrow(/RECUSADO[\s\S]*#737/);
    // e a rodada de 21/10 continua intacta depois da recusa
    const r = await q1(db, `select md5(p.prosrc) m from pg_proc p
                              join pg_namespace n on n.oid=p.pronamespace
                             where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`);
    expect(r.m).toBe(MD5_RODADA_PROD);
    await db.close();
  });
});

// ===========================================================================
describe("O ROLLBACK", () => {
  it("devolve o corpo de 21/10 byte a byte e o monitor de 15 colunas", async () => {
    const db = await abrir("com");
    await db.exec(ROLLBACK);

    const r = await q1(db, `select md5(p.prosrc) m from pg_proc p
                              join pg_namespace n on n.oid=p.pronamespace
                             where n.nspname='public' and p.proname='fluxo_pagamentos_incremental'`);
    expect(r.m).toBe(MD5_RODADA_PROD);

    const cols = await qn(db, `select column_name from information_schema.columns
                                where table_schema='public'
                                  and table_name='vw_fluxo_pagamentos_monitor'
                                order by ordinal_position`);
    expect(cols).toHaveLength(15);
    expect(cols.map((c) => c.column_name)).not.toContain("processados_bloqueado");
    await db.close();
  });

  it("depois de reverter, o orçamento volta a ser gasto nas bloqueadas -- é o que se perde", async () => {
    const db = await abrir("com");
    await db.exec(ROLLBACK);
    await umDia(db);
    const r = await reparticao(db);
    expect(r.toques_bloqueado).toBe(BLOQUEADAS);
    expect(r.distintos_com_saida).toBe(60);
    await db.close();
  });

  it("o portão do rollback RECUSA um corpo que não seja o de 21/10", async () => {
    const db = await abrir("com");
    // Um rollback EDITADO: alguém mexeu numa linha do corpo restaurado. O
    // portão confere o md5 e recusa, em vez de deixar passar um corpo que
    // ninguém conferiu.
    const adulterado = ROLLBACK.replace(
      "if p_lote > 500 then p_lote := 500; end if;",
      "if p_lote > 499 then p_lote := 499; end if;");
    expect(adulterado).not.toBe(ROLLBACK);
    await expect(db.exec(adulterado)).rejects.toThrow(/ROLLBACK ABORTADO/);
    await db.close();
  });

  it("o monitor não volta gravável por authenticated depois do rollback", async () => {
    const db = await abrir("com");
    await db.exec(ROLLBACK);
    const v = await q1(db, `select
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','delete') d,
        has_table_privilege('authenticated','public.vw_fluxo_pagamentos_monitor','select') s`);
    expect(v.d).toBe(false);
    expect(v.s).toBe(true);
    await db.close();
  });
});

// ===========================================================================
describe("a migration é idempotente", () => {
  it("aplicar duas vezes não muda nada", async () => {
    const db = await abrir("com");
    await db.exec(MIGRATION);
    const r = await rodar(db);
    expect(r.processados).toBe(LOTE);
    expect(r.processados_bloqueado).toBe(RESERVA);
    await db.close();
  });
});
