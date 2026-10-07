// RECORTE DOS INDICADORES, RÓTULOS DE ENTRADA E PRECISÃO DA EXTRAÇÃO.
//
// O que este arquivo protege:
//   1. título com vencimento de ORIGEM fora do período da carteira continua na
//      carteira e na ação, mas NÃO entra em nenhum indicador — e a resposta
//      diz quantos são, quanto valem e por quê;
//   2. "entradas" tem três nomes distintos: na série, ainda presentes e as que
//      já saíram — e os três fecham entre si;
//   3. remessa sem hora comprovada ordena por (data, ordem no dia), nunca por
//      um horário inventado;
//   4. quando a foto é do MESMO dia do envio e falta hora comprovada de algum
//      lado, o resultado da ação fica PENDENTE — nulo, não zero;
//   5. o que já existia antes desta migration nasce NAO_COMPROVADA: o horário
//      do upload segue gravado, mas não vale como hora de extração;
//   6. o DIA é o de America/Sao_Paulo — a resposta não muda se a sessão que
//      consulta está em UTC ou em Brasília;
//   7. UMA ordenação só para todas as funções: duas fotos com hora conhecida
//      no mesmo dia nascem ambas com ordem_no_dia = 1 (o default da tela, que
//      nem pergunta a ordem quando a hora é conhecida) e mesmo assim precisam
//      ser reconhecidas como consecutivas, pelo horário DECLARADO;
//   8. ORDENAR NÃO É COMPROVAR: o desempate por faixa de precisão ou por id
//      serve só para enfileirar a tela. Onde a ordem saiu dele, a comparação
//      fica pendente em vez de devolver número.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const GESTAO = "amanda.seibel@aelbra.com.br";
const OUTRA = "cobranca07@aelbra.com.br";

const MIG_RECORTE = "supabase/migrations/20261006165832_preventivo_recorte_e_precisao_da_extracao.sql";

const MIGRATIONS = [
  "supabase/migrations/20260928143743_preventivo_estrutura.sql",
  "supabase/migrations/20260928143843_preventivo_importacao.sql",
  "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
  "supabase/migrations/20260928201351_preventivo_remessa_como_unidade.sql",
  "supabase/migrations/20261005124732_preventivo_update_com_where.sql",
  "supabase/migrations/20261005191400_preventivo_contexto_da_acao.sql",
  "supabase/migrations/20261006114523_preventivo_acao_externa_e_data_da_extracao.sql",
  MIG_RECORTE,
].map(ler);

const TABELAS = [
  "prev_acao_destinatario", "prev_acao", "prev_evento", "prev_titulo_snapshot",
  "prev_sinc_fila", "prev_sinc", "prev_titulo_lote", "prev_titulo",
  "prev_lote_recusa", "prev_lote", "prev_carteira",
];

let bancoDoArquivo = null;
async function novoBanco() {
  if (bancoDoArquivo) {
    await bancoDoArquivo.exec(
      `truncate ${TABELAS.map((t) => "public." + t).join(", ")} restart identity cascade;
       update public._jwt set email = '${GESTAO}';`);
    return bancoDoArquivo;
  }
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table public._jwt (email text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('email', (select email from public._jwt limit 1)) $$;
    create table public.usuarios (email text, ativo boolean default true);
    insert into public.usuarios values ('${GESTAO}', true), ('${OUTRA}', true);
    insert into public._jwt values ('${GESTAO}');
  `);
  for (const m of MIGRATIONS) await db.exec(m);
  bancoDoArquivo = db;
  return db;
}
beforeAll(async () => { await novoBanco(); });

const um = async (db, sql, p = []) => {
  const r = await db.query(sql, p);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
};

const t = (matricula, saldo = 100, origem = "2026-10-05") => ({
  matricula, aluno_nome: `Aluno ${matricula}`,
  vencimento: "2026-10-05", vencimento_origem: origem,
  valor: String(saldo), saldo: String(saldo), saldo_atualizado: String(saldo),
  situacao: "EM ABERTO",
  celular: `(51) 9${matricula.slice(-4)}-${matricula.slice(-4)}`,
  email: `a${matricula}@exemplo.com`,
});

describe("Preventivo — recorte dos indicadores e precisão da extração", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Out', null, '2026-10-01'::date, '2026-10-31'::date)`);
  });

  // precisao/ordem vão como argumentos novos, com default compatível.
  const importar = (nome, linhas, extraidoEm, precisao = "DATA_E_HORA", ordem = 1) => um(db,
    `select public.preventivo_lote_confirmar_v2($1::uuid, $2, 'rel.csv', '{}'::jsonb, null,
            $3::jsonb, $4::timestamptz, $5, $6::int)`,
    [carteira, nome, JSON.stringify(linhas), extraidoEm, precisao, ordem]);

  const registrar = (lote, nome, canal, ctx, em, matriculas = null, prec = "DATA_E_HORA") => um(db,
    `select public.preventivo_acao_externa_registrar($1::uuid, $2::uuid, $3, $4, $5,
            $6::timestamptz, $7::text[], $8::boolean, $9)`,
    [carteira, lote, nome, canal, ctx, em, matriculas, matriculas === null, prec]);

  const evolucao = () => um(db, `select public.preventivo_evolucao($1::uuid)`, [carteira]);
  const resultado = (a) => um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a]);

  // --- 1. O RECORTE -----------------------------------------------------

  it("título com origem fora do período fica na carteira, mas fora dos indicadores", async () => {
    // o importador já recusa a LINHA nova; aqui o caso é o título que entrou
    // antes da regra existir, então ele é criado por dentro, como em produção.
    const r = await importar("Foto", [t("2026000001", 100), t("2026000002", 200)],
                             "2026-10-05 15:00-03");
    await db.exec(`
      update public.prev_titulo set vencimento_origem = '2026-09-05'
       where matricula_prime = '2026000002'`);

    const e = await evolucao();
    expect(e.fora_do_recorte.motivo).toBe("ORIGEM_FORA_DO_PERIODO");
    expect(e.fora_do_recorte.titulos).toBe(1);
    expect(Number(e.fora_do_recorte.valor)).toBe(200);
    expect(e.fora_do_recorte.matriculas).toEqual(["2026000002"]);

    // o indicador conta só o que está no recorte...
    expect(e.cards.titulos_inicial).toBe(1);
    expect(Number(e.cards.saldo_inicial)).toBe(100);
    expect(e.pontos[0].titulos).toBe(1);

    // ...mas o título NÃO foi apagado de lugar nenhum.
    expect(await um(db, `select count(*)::int from public.prev_titulo where carteira_id = $1::uuid`,
                    [carteira])).toBe(2);
    expect(await um(db, `select count(*)::int from public.prev_titulo_lote tl
                           join public.prev_titulo t on t.id = tl.titulo_id
                          where tl.lote_id = $1::uuid`, [r.lote_id])).toBe(2);
  });

  it("a ação preserva o destinatário fora do recorte e o declara", async () => {
    const r = await importar("Foto", [t("2026000001"), t("2026000002")], "2026-10-05 15:00-03");
    await db.exec(`update public.prev_titulo set vencimento_origem = '2026-09-05'
                    where matricula_prime = '2026000002'`);
    const a = await registrar(r.lote_id, "Mensalidade", "EMAIL", "BOLETO_VENCIDO",
                              "2026-10-05 16:00-03");

    // os dois continuam destinatários — ninguém é removido da ação
    expect(await um(db, `select count(*)::int from public.prev_acao_destinatario
                          where acao_id = $1::uuid and incluido`, [a.id])).toBe(2);

    const res = await resultado(a.id);
    expect(res.titulos_acionados).toBe(1);                 // só o do recorte
    expect(res.fora_do_recorte.titulos).toBe(1);
    expect(res.fora_do_recorte.motivo).toBe("ORIGEM_FORA_DO_PERIODO");
  });

  it("a comparação entre remessas também aplica o recorte", async () => {
    const f1 = await importar("F1", [t("2026000001"), t("2026000002")], "2026-10-02 09:00-03");
    await db.exec(`update public.prev_titulo set vencimento_origem = '2026-09-05'
                    where matricula_prime = '2026000002'`);
    const f2 = await importar("F2", [t("2026000001")], "2026-10-05 15:00-03");

    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [f2.lote_id]);
    // sem o recorte, o 002 (origem de setembro) apareceria como "saiu da base"
    expect(c.saiu_da_base.titulos).toBe(0);
    expect(c.continua_em_aberto.titulos).toBe(1);
    expect(c.fora_do_recorte.titulos).toBe(0);  // o 002 não está em F2
    expect(f1.lote_id).toBe(c.remessa_anterior);
  });

  // --- 2. OS TRÊS RÓTULOS DE ENTRADA ------------------------------------

  it("entradas na série, ainda presentes e que já saíram fecham entre si", async () => {
    // F1: 001, 002       F2: 001, 003, 004      F3: 001, 004
    //   003 entrou e saiu; 004 entrou e ficou; 002 saiu.
    await importar("F1", [t("2026000001"), t("2026000002")], "2026-10-02 09:00-03");
    await importar("F2", [t("2026000001"), t("2026000003"), t("2026000004")], "2026-10-03 09:00-03");
    await importar("F3", [t("2026000001"), t("2026000004")], "2026-10-04 09:00-03");

    const c = (await evolucao()).cards;
    expect(c.entradas_na_serie).toBe(2);         // 003 e 004
    expect(c.entradas_ainda_presentes).toBe(1);  // 004
    expect(c.entradas_que_sairam).toBe(1);       // 003
    expect(c.entradas_na_serie).toBe(c.entradas_ainda_presentes + c.entradas_que_sairam);

    // "saiu da base" continua sendo da PRIMEIRA foto: só o 002.
    expect(c.saiu_da_base_titulos).toBe(1);
  });

  // --- 3. DATA SEM HORA INVENTADA ---------------------------------------

  it("duas fotos no MESMO dia ordenam pela ordem declarada, não pelo horário", async () => {
    // as duas entram com a MESMA hora gravada: só a ordem no dia distingue.
    const manha = await importar("Ontem manhã", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 00:00-03", "DATA", 1);
    const tarde = await importar("Ontem tarde", [t("2026000001")],
                                 "2026-10-05 00:00-03", "DATA", 2);

    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [tarde.lote_id]);
    expect(c.remessa_anterior).toBe(manha.lote_id);
    expect(c.saiu_da_base.titulos).toBe(1);

    const c2 = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [manha.lote_id]);
    expect(c2.primeira_remessa).toBe(true);

    const e = await evolucao();
    expect(e.pontos.map((p) => p.remessa)).toEqual([manha.lote_id, tarde.lote_id]);
    expect(e.pontos[0].extraido_precisao).toBe("DATA");
    expect(e.pontos[0].ordem_no_dia).toBe(1);
    expect(e.pontos[1].ordem_no_dia).toBe(2);
  });

  it("a precisão é DATA_E_HORA por padrão e só aceita os dois valores", async () => {
    const r = await importar("Foto", [t("2026000001")], "2026-10-05 15:00-03");
    expect(await um(db, `select extraido_precisao from public.prev_lote where id = $1::uuid`,
                    [r.lote_id])).toBe("DATA_E_HORA");
    expect(await um(db, `select ordem_no_dia from public.prev_lote where id = $1::uuid`,
                    [r.lote_id])).toBe(1);
    await expect(importar("X", [t("2026000009")], "2026-10-05 15:00-03", "APROXIMADA"))
      .rejects.toThrow(/precis/i);
    await expect(importar("Y", [t("2026000009")], "2026-10-05 15:00-03", "DATA", 0))
      .rejects.toThrow(/ordem/i);
  });

  // --- 4. SEM SEQUÊNCIA COMPROVADA, RESULTADO PENDENTE ------------------

  it("foto do mesmo dia sem hora comprovada deixa o resultado PENDENTE", async () => {
    const manha = await importar("Ontem manhã", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 00:00-03", "DATA", 1);
    // envio no mesmo dia, hora não comprovada
    const a = await registrar(manha.lote_id, "WhatsApp de ontem", "WHATSAPP", "BOLETO_VENCIDO",
                              "2026-10-05 00:00-03", null, "DATA");
    // a foto da tarde é do MESMO dia: não dá para provar que veio depois
    await importar("Ontem tarde", [t("2026000001")], "2026-10-05 00:00-03", "DATA", 2);

    const res = await resultado(a.id);
    expect(res.sequencia_nao_comprovada).toBe(true);
    expect(res.remessa_seguinte).toBeNull();
    expect(res.saiu_da_base).toBeNull();          // pendente, NÃO zero
    expect(res.taxa_regularizacao).toBeNull();
    expect(res.resultado_pendente).toBe(true);
    expect(res.titulos_acionados).toBe(2);        // a base acionada é conhecida

    const ac = (await evolucao()).acoes.find((x) => x.id === a.id);
    expect(ac.sequencia_nao_comprovada).toBe(true);
    expect(ac.saiu_titulos).toBeNull();
    expect(ac.taxa_titulos).toBeNull();
  });

  it("foto de um dia POSTERIOR resolve a pendência mesmo sem hora", async () => {
    const manha = await importar("Ontem", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 00:00-03", "DATA", 1);
    const a = await registrar(manha.lote_id, "WhatsApp", "WHATSAPP", "BOLETO_VENCIDO",
                              "2026-10-05 00:00-03", null, "DATA");
    await importar("Hoje", [t("2026000001")], "2026-10-06 00:00-03", "DATA", 1);

    const res = await resultado(a.id);
    expect(res.remessa_seguinte).not.toBeNull();
    expect(res.saiu_da_base).toBe(1);             // o 002 não voltou
    expect(res.taxa_regularizacao).toBe(50);
  });

  it("com hora comprovada dos dois lados, o mesmo dia conta normalmente", async () => {
    const manha = await importar("Ontem manhã", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 09:00-03");
    const a = await registrar(manha.lote_id, "E-mail", "EMAIL", "BOLETO_VENCIDO",
                              "2026-10-05 10:00-03");
    await importar("Ontem tarde", [t("2026000001")], "2026-10-05 15:00-03", "DATA_E_HORA", 2);

    const res = await resultado(a.id);
    expect(res.sequencia_nao_comprovada).toBe(false);
    expect(res.saiu_da_base).toBe(1);
  });

  it("envio anterior à extração continua recusado, por dia quando falta hora", async () => {
    const r = await importar("Ontem", [t("2026000001")], "2026-10-05 00:00-03", "DATA", 1);
    // mesmo dia + precisão DATA: NÃO é recusado, porque a ordem é desconhecida
    await expect(registrar(r.lote_id, "Ok", "EMAIL", "BOLETO_VENCIDO",
                           "2026-10-05 00:00-03", null, "DATA")).resolves.toBeTruthy();
    // dia anterior é recusado
    await expect(registrar(r.lote_id, "Antes", "EMAIL", "BOLETO_VENCIDO",
                           "2026-10-04 00:00-03", null, "DATA")).rejects.toThrow(/anterior/i);
  });

  // --- 5. O QUE JÁ EXISTIA NÃO VIRA CERTEZA -----------------------------

  it("remessa e ação anteriores à migration ficam NAO_COMPROVADA, com o horário intacto", async () => {
    // reconstrói o estado de antes: coluna ausente, linha já gravada.
    await db.exec(`
      alter table public.prev_lote  drop column extraido_precisao;
      alter table public.prev_acao  drop column envio_precisao;`);
    const r = await um(db,
      `select public.preventivo_lote_confirmar($1::uuid, 'Antiga', 'rel.csv', '{}'::jsonb, null, $2::jsonb)`,
      [carteira, JSON.stringify([t("2026000001")])]);
    const antes = await um(db,
      `select extraido_em from public.prev_lote where id = $1::uuid`, [r.lote_id]);

    // reaplica só o trecho da migration que cria as colunas
    await db.exec(ler(MIG_RECORTE));

    const depois = await db.query(
      `select extraido_em, extraido_precisao from public.prev_lote where id = $1::uuid`,
      [r.lote_id]);
    // o horário NÃO foi tocado...
    expect(new Date(depois.rows[0].extraido_em).getTime())
      .toBe(new Date(antes).getTime());
    // ...e não foi promovido a hora comprovada
    expect(depois.rows[0].extraido_precisao).toBe("NAO_COMPROVADA");
  });

  it("NAO_COMPROVADA não prova sequência dentro do mesmo dia", async () => {
    const r = await importar("Foto", [t("2026000001"), t("2026000002")], "2026-10-05 09:00-03");
    // força o estado herdado: horário gravado, precisão não comprovada
    await db.exec(`update public.prev_lote set extraido_precisao = 'NAO_COMPROVADA'`);
    const a = await registrar(r.lote_id, "Envio", "EMAIL", "BOLETO_VENCIDO",
                              "2026-10-05 08:00-03");
    await importar("Mesmo dia", [t("2026000001")], "2026-10-05 15:00-03");
    await db.exec(`update public.prev_lote set extraido_precisao = 'NAO_COMPROVADA'
                    where nome = 'Mesmo dia'`);

    const res = await resultado(a.id);
    expect(res.sequencia_nao_comprovada).toBe(true);
    expect(res.saiu_da_base).toBeNull();
  });

  // --- 6. O DIA É O DE SÃO PAULO ---------------------------------------

  // 05/10 23:30 em Brasília é 06/10 02:30 em UTC. Com `::date` cru numa sessão
  // UTC, a foto cairia no dia SEGUINTE ao envio das 22h e passaria a "provar"
  // a sequência — uma virada de dia que só existe no fuso de quem consulta.
  it("a virada do dia é a de Brasília, e a resposta não muda com o fuso da sessão", async () => {
    const manha = await importar("Manhã", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 00:00-03", "DATA", 1);
    const a = await registrar(manha.lote_id, "Envio das 22h", "WHATSAPP", "BOLETO_VENCIDO",
                              "2026-10-05 22:00-03", null, "DATA");
    // 23h30 de Brasília — ainda 05/10 lá, já 06/10 em UTC
    await importar("Noite", [t("2026000001")], "2026-10-05 23:30-03", "DATA", 2);

    const porFuso = {};
    for (const tz of ["UTC", "America/Sao_Paulo"]) {
      await db.exec(`set time zone '${tz}'`);
      const res = await resultado(a.id);
      const ev = (await evolucao()).acoes.find((x) => x.id === a.id);
      porFuso[tz] = {
        pendente: res.sequencia_nao_comprovada,
        saiu: res.saiu_da_base,
        seguinte: res.remessa_seguinte,
        evPendente: ev.sequencia_nao_comprovada,
        ordem: (await evolucao()).pontos.map((x) => x.remessa).join(","),
      };
    }
    await db.exec(`set time zone 'UTC'`);

    // os dois fusos enxergam o MESMO dia, logo a MESMA resposta
    expect(porFuso.UTC).toEqual(porFuso["America/Sao_Paulo"]);
    // e a resposta é: mesmo dia sem hora comprovada → pendente
    expect(porFuso.UTC.pendente).toBe(true);
    expect(porFuso.UTC.saiu).toBeNull();
    expect(porFuso.UTC.seguinte).toBeNull();
  });

  it("o dia anterior continua provando a sequência nos dois fusos", async () => {
    const r = await importar("Ontem", [t("2026000001"), t("2026000002")],
                             "2026-10-05 00:00-03", "DATA", 1);
    const a = await registrar(r.lote_id, "Envio", "WHATSAPP", "BOLETO_VENCIDO",
                              "2026-10-05 22:00-03", null, "DATA");
    // 00h30 de 06/10 em Brasília — dia seguinte nos dois fusos
    await importar("Hoje", [t("2026000001")], "2026-10-06 00:30-03", "DATA", 1);

    for (const tz of ["UTC", "America/Sao_Paulo"]) {
      await db.exec(`set time zone '${tz}'`);
      const res = await resultado(a.id);
      expect(res.remessa_seguinte).not.toBeNull();
      expect(res.saiu_da_base).toBe(1);
    }
    await db.exec(`set time zone 'UTC'`);
  });

  it("a comparação entre remessas usa o dia de Brasília para achar a anterior", async () => {
    const cedo = await importar("Cedo", [t("2026000001"), t("2026000002")],
                                "2026-10-05 08:00-03", "DATA", 1);
    const tarde = await importar("Tarde", [t("2026000001")],
                                 "2026-10-05 23:30-03", "DATA", 2);
    for (const tz of ["UTC", "America/Sao_Paulo"]) {
      await db.exec(`set time zone '${tz}'`);
      const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [tarde.lote_id]);
      // mesmo dia em São Paulo: a ordem no dia é que decide quem veio antes
      expect(c.remessa_anterior).toBe(cedo.lote_id);
      expect(c.saiu_da_base.titulos).toBe(1);
    }
    await db.exec(`set time zone 'UTC'`);
  });

  // --- 7. UMA ORDENAÇÃO SÓ PARA TODAS AS FUNÇÕES -----------------------

  // O caso que estava quebrado: a tela não pergunta a ordem no dia quando a
  // hora é conhecida, então as duas fotos nascem com ordem_no_dia = 1. A
  // comparação olhava só (dia, ordem) e empatava — a de 15h não achava a de
  // 09h e se declarava "primeira remessa". `importar` aqui é chamado com os
  // valores PADRÃO da tela de propósito.
  it("duas fotos DATA_E_HORA no mesmo dia, 09h e 15h, com os padrões da tela", async () => {
    const manha = await importar("Manhã", [t("2026000001"), t("2026000002"), t("2026000003")],
                                 "2026-10-05 09:00-03");
    const tarde = await importar("Tarde", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 15:00-03");

    // as duas nasceram com o mesmo ordem_no_dia — é esse o cenário
    const ordens = await db.query(
      `select ordem_no_dia, extraido_precisao from public.prev_lote order by extraido_em`);
    expect(ordens.rows.map((r) => r.ordem_no_dia)).toEqual([1, 1]);
    expect(ordens.rows.map((r) => r.extraido_precisao)).toEqual(["DATA_E_HORA", "DATA_E_HORA"]);

    // comparar: a de 15h reconhece a de 09h como anterior
    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [tarde.lote_id]);
    expect(c.primeira_remessa).toBe(false);
    expect(c.remessa_anterior).toBe(manha.lote_id);
    expect(c.sequencia_nao_comprovada).toBe(false);   // hora DECLARADA nos dois
    expect(c.saiu_da_base.titulos).toBe(1);
    expect(c.continua_em_aberto.titulos).toBe(2);

    // ...e a de 09h é que é a primeira
    const c2 = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [manha.lote_id]);
    expect(c2.primeira_remessa).toBe(true);

    // evolução: a MESMA ordem, e os cards batem com a comparação
    const e = await evolucao();
    expect(e.pontos.map((x) => x.remessa)).toEqual([manha.lote_id, tarde.lote_id]);
    expect(e.pontos.map((x) => x.ordem)).toEqual([1, 2]);
    expect(e.pontos[1].saiu_da_base_titulos).toBe(c.saiu_da_base.titulos);
    expect(e.cards.titulos_inicial).toBe(3);
    expect(e.cards.titulos_ainda_abertos).toBe(2);
    expect(e.cards.saiu_da_base_titulos).toBe(1);
    expect(e.cards.ordem_ambigua).toBe(false);
  });

  it("as três funções concordam sobre qual remessa vem depois do envio", async () => {
    const manha = await importar("Manhã", [t("2026000001"), t("2026000002")],
                                 "2026-10-05 09:00-03");
    const a = await registrar(manha.lote_id, "E-mail das 10h", "EMAIL", "BOLETO_VENCIDO",
                              "2026-10-05 10:00-03");
    const tarde = await importar("Tarde", [t("2026000001")], "2026-10-05 15:00-03");

    const res = await resultado(a.id);
    const ev = (await evolucao()).acoes.find((x) => x.id === a.id);
    // acao_resultado escolhe a PRIMEIRA depois; evolucao, a ÚLTIMA. Com duas
    // remessas e só uma depois do envio, as duas têm que apontar a mesma.
    expect(res.remessa_seguinte).toBe(tarde.lote_id);
    expect(ev.comparado_com).toBe(tarde.lote_id);
    expect(res.saiu_da_base).toBe(ev.saiu_titulos);
    expect(res.saiu_da_base).toBe(1);
    expect(res.sequencia_nao_comprovada).toBe(false);
  });

  // --- 8. ORDENAR NÃO É COMPROVAR ---------------------------------------

  it("ordem arbitrária serve para EXIBIR; a comparação fica pendente", async () => {
    // Mesmo dia, mesma ordem_no_dia = 1, e só uma tem hora. A fila da tela
    // põe a com hora primeiro — mas isso é desempate por faixa de precisão,
    // não prova. Ninguém sabe qual relatório saiu antes.
    const comHora = await importar("Com hora", [t("2026000001"), t("2026000002")],
                                   "2026-10-05 09:00-03");
    const semHora = await importar("Sem hora", [t("2026000001")],
                                   "2026-10-05 00:00-03", "DATA", 1);

    // EXIBIR: a ordem existe e é estável
    const e = await evolucao();
    expect(e.pontos.map((x) => x.remessa)).toEqual([comHora.lote_id, semHora.lote_id]);
    expect(e.cards.ordem_ambigua).toBe(true);

    // AFIRMAR: não. O delta entre os dois pontos é nulo, não zero.
    expect(e.pontos[1].sequencia_nao_comprovada).toBe(true);
    expect(e.pontos[1].saiu_da_base_titulos).toBeNull();
    expect(e.pontos[1].saiu_da_base_valor).toBeNull();
    expect(e.pontos[1].entraram).toBeNull();

    // e a comparação devolve pendente, com a anterior só para referência
    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [semHora.lote_id]);
    expect(c.sequencia_nao_comprovada).toBe(true);
    expect(c.primeira_remessa).toBe(false);
    expect(c.remessa_anterior).toBe(comHora.lote_id);
    expect(c.saiu_da_base).toBeNull();
    expect(c.continua_em_aberto).toBeNull();
    expect(c.novos_na_remessa).toBeNull();
    expect(c.observacao).toMatch(/arbitr/i);
  });

  it("duas fotos no mesmo dia, nenhuma com hora e a MESMA ordem: pendente", async () => {
    const a = await importar("A", [t("2026000001"), t("2026000002")], "2026-10-05 00:00-03", "DATA", 1);
    const b = await importar("B", [t("2026000001")], "2026-10-05 00:00-03", "DATA", 1);

    // a fila é a ordem de REGISTRO — estável, e não um sorteio de uuid
    const e0 = await evolucao();
    expect(e0.pontos.map((x) => x.remessa)).toEqual([a.lote_id, b.lote_id]);

    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [b.lote_id]);
    expect(c.remessa_anterior).toBe(a.lote_id);
    expect(c.sequencia_nao_comprovada).toBe(true);
    expect(c.saiu_da_base).toBeNull();

    const e = await evolucao();
    expect(e.cards.ordem_ambigua).toBe(true);
    expect(e.pontos[1].saiu_da_base_titulos).toBeNull();
  });

  it("declarar a ordem no dia resolve a ambiguidade", async () => {
    const a = await importar("A", [t("2026000001"), t("2026000002")], "2026-10-05 00:00-03", "DATA", 1);
    const b = await importar("B", [t("2026000001")], "2026-10-05 00:00-03", "DATA", 2);

    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [b.lote_id]);
    expect(c.sequencia_nao_comprovada).toBe(false);
    expect(c.remessa_anterior).toBe(a.lote_id);
    expect(c.saiu_da_base.titulos).toBe(1);

    const e = await evolucao();
    expect(e.cards.ordem_ambigua).toBe(false);
    expect(e.pontos[1].saiu_da_base_titulos).toBe(1);
  });

  it("dias diferentes nunca são ambíguos, mesmo sem hora nenhuma", async () => {
    await importar("Ontem", [t("2026000001"), t("2026000002")], "2026-10-05 00:00-03", "DATA", 1);
    const hoje = await importar("Hoje", [t("2026000001")], "2026-10-06 00:00-03", "DATA", 1);

    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [hoje.lote_id]);
    expect(c.sequencia_nao_comprovada).toBe(false);
    expect(c.saiu_da_base.titulos).toBe(1);
    expect((await evolucao()).cards.ordem_ambigua).toBe(false);
  });

  // --- 9. PORTÃO --------------------------------------------------------

  it("quem não é da gestão não lê nem registra", async () => {
    const r = await importar("Foto", [t("2026000001")], "2026-10-05 15:00-03");
    await db.exec(`update public._jwt set email = '${OUTRA}'`);
    await expect(evolucao()).rejects.toThrow(/gest/i);
    await expect(um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [r.lote_id]))
      .rejects.toThrow(/gest/i);
    await expect(registrar(r.lote_id, "X", "EMAIL", "BOLETO_VENCIDO", "2026-10-05 16:00-03"))
      .rejects.toThrow(/gest/i);
  });
});
