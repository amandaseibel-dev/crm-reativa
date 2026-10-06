// AÇÃO FEITA FORA DO CRM — registro, ordem por data de extração e evolução.
//
// O que este arquivo protege:
//   1. a data da EXTRAÇÃO ordena as remessas, não o momento do upload — é o
//      que permite registrar uma foto antiga sem inverter a história;
//   2. a ação externa nasce com envio confirmado e marca EXTERNA, e o módulo
//      nunca finge que foi ele quem enviou;
//   3. o público da ação externa é a remessa inteira — o arquivo É a lista;
//   4. a régua continua sendo a primeira remessa extraída DEPOIS do envio;
//   5. recusas que impedem história impossível: envio antes da extração,
//      canal ou contexto inválidos, remessa de outra carteira;
//   6. a evolução não soma ações nem conta título duas vezes.
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

const MIGRATIONS = [
  "supabase/migrations/20260928143743_preventivo_estrutura.sql",
  "supabase/migrations/20260928143843_preventivo_importacao.sql",
  "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
  "supabase/migrations/20260928201351_preventivo_remessa_como_unidade.sql",
  "supabase/migrations/20261005124732_preventivo_update_com_where.sql",
  "supabase/migrations/20261005191400_preventivo_contexto_da_acao.sql",
  "supabase/migrations/20261006114523_preventivo_acao_externa_e_data_da_extracao.sql",
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

describe("Preventivo — ação externa e data da extração", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Out', null, '2026-10-01'::date, '2026-10-31'::date)`);
  });

  // Importa informando QUANDO o relatório foi extraído.
  const importar = (nome, linhas, extraidoEm) => um(db,
    `select public.preventivo_lote_confirmar_v2($1::uuid, $2, 'rel.csv', '{}'::jsonb, null, $3::jsonb, $4::timestamptz)`,
    [carteira, nome, JSON.stringify(linhas), extraidoEm]);

  // `matriculas` null = declara que o envio cobriu a remessa inteira.
  const registrar = (lote, nome, canal, contexto, enviadaEm, matriculas = null) => um(db,
    `select public.preventivo_acao_externa_registrar($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7::text[], $8::boolean)`,
    [carteira, lote, nome, canal, contexto, enviadaEm, matriculas, matriculas === null]);

  const evolucao = () => um(db, `select public.preventivo_evolucao($1::uuid)`, [carteira]);

  it("a remessa guarda a data da EXTRAÇÃO, não a do upload", async () => {
    const r = await importar("Sexta", [t("2026000001")], "2026-10-02 09:00-03");
    const l = await db.query(
      `select extraido_em, criado_em from public.prev_lote where id = $1::uuid`, [r.lote_id]);
    const { extraido_em, criado_em } = l.rows[0];
    expect(new Date(extraido_em).toISOString()).toContain("2026-10-02");
    // o upload é agora; a extração é de sexta — são datas diferentes de propósito
    expect(new Date(criado_em).getTime()).toBeGreaterThan(new Date(extraido_em).getTime());
  });

  it("importar sem data de extração é recusado", async () => {
    await expect(importar("Sem data", [t("2026000001")], null)).rejects.toThrow(/extra/i);
  });

  it("extração no futuro é recusada", async () => {
    await expect(importar("Futuro", [t("2026000001")], "2030-01-01 10:00-03"))
      .rejects.toThrow(/futuro/i);
  });

  it("a ORDEM é a da extração, mesmo importando a foto antiga por último", async () => {
    // a de ontem entra primeiro no banco; a de sexta é importada depois
    const ontem = await importar("Ontem", [t("2026000001"), t("2026000002")], "2026-10-05 15:00-03");
    const sexta = await importar("Sexta", [t("2026000001"), t("2026000002"), t("2026000003")], "2026-10-02 09:00-03");

    // para a remessa de ONTEM, a anterior é a de SEXTA — e não "nenhuma"
    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [ontem.lote_id]);
    expect(c.primeira_remessa).toBe(false);
    expect(c.remessa_anterior).toBe(sexta.lote_id);
    expect(c.saiu_da_base.titulos).toBe(1);        // o 003 sumiu
    expect(c.continua_em_aberto.titulos).toBe(2);

    // e a de SEXTA é que é a primeira
    const c2 = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [sexta.lote_id]);
    expect(c2.primeira_remessa).toBe(true);
  });

  it("a ação externa nasce com envio confirmado, marca EXTERNA e a remessa inteira", async () => {
    const sexta = await importar("Sexta", [t("2026000001"), t("2026000002")], "2026-10-02 09:00-03");
    const a = await registrar(sexta.lote_id, "E-mail de sexta", "EMAIL", "PROXIMO_VENCIMENTO",
                              "2026-10-02 14:30-03");
    expect(a.origem).toBe("EXTERNA");
    expect(a.estado).toBe("ENVIO_CONFIRMADO");
    expect(a.canal).toBe("EMAIL");
    expect(a.contexto).toBe("PROXIMO_VENCIMENTO");
    expect(a.incluidos).toBe(2);                 // a remessa inteira é o público
    expect(new Date(a.envio_confirmado_em).toISOString()).toContain("2026-10-02");
    expect(a.separados).toEqual({});             // ninguém é separado: já foi enviado
  });

  it("envio anterior à extração é recusado", async () => {
    const r = await importar("Sexta", [t("2026000001")], "2026-10-02 09:00-03");
    await expect(registrar(r.lote_id, "Impossível", "EMAIL", "PROXIMO_VENCIMENTO",
                           "2026-10-01 10:00-03")).rejects.toThrow(/anterior à extração/i);
  });

  it("canal e contexto inválidos são recusados", async () => {
    const r = await importar("Sexta", [t("2026000001")], "2026-10-02 09:00-03");
    await expect(registrar(r.lote_id, "X", "SMS", "PROXIMO_VENCIMENTO", "2026-10-02 10:00-03"))
      .rejects.toThrow(/Canal inválido/i);
    await expect(registrar(r.lote_id, "X", "EMAIL", "QUALQUER", "2026-10-02 10:00-03"))
      .rejects.toThrow(/Contexto inválido/i);
    await expect(registrar(r.lote_id, "", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 10:00-03"))
      .rejects.toThrow(/nome/i);
  });

  it("a régua da ação externa é a primeira remessa extraída depois do envio", async () => {
    const sexta = await importar("Sexta", [t("2026000001"), t("2026000002")], "2026-10-02 09:00-03");
    const a = await registrar(sexta.lote_id, "E-mail", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 14:00-03");

    // ainda sem remessa posterior
    let r = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);
    expect(r.aguardando_proxima_remessa).toBe(true);
    expect(r.saiu_da_base).toBe(null);

    // a de ontem é extraída depois do envio: vira a régua
    const ontem = await importar("Ontem", [t("2026000001")], "2026-10-05 15:00-03");
    r = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);
    expect(r.remessa_seguinte).toBe(ontem.lote_id);
    expect(r.titulos_acionados).toBe(2);
    expect(r.saiu_da_base).toBe(1);
    expect(r.alunos_que_sairam).toBe(1);
    expect(r.taxa_regularizacao).toBe(50.0);
    expect(r.origem).toBe("EXTERNA");
  });

  it("remessa extraída ANTES do envio não mede a ação", async () => {
    const sexta = await importar("Sexta", [t("2026000001")], "2026-10-02 09:00-03");
    await importar("Antes", [t("2026000001")], "2026-10-03 09:00-03");
    const a = await registrar(sexta.lote_id, "E-mail", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-04 10:00-03");
    const r = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);
    expect(r.aguardando_proxima_remessa).toBe(true);   // a de 03/10 é anterior ao envio
  });

  it("a evolução devolve um ponto por remessa, na ordem da extração", async () => {
    const sexta = await importar("Sexta", [t("2026000001", 100), t("2026000002", 200), t("2026000003", 300)], "2026-10-02 09:00-03");
    await registrar(sexta.lote_id, "E-mail sexta", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 14:00-03");
    await importar("Ontem", [t("2026000001", 100), t("2026000002", 200)], "2026-10-05 15:00-03");
    await importar("Hoje", [t("2026000001", 100)], "2026-10-06 08:00-03");

    const e = await evolucao();
    expect(e.pontos.map((p) => p.nome)).toEqual(["Sexta", "Ontem", "Hoje"]);
    expect(e.pontos.map((p) => p.titulos)).toEqual([3, 2, 1]);
    expect(e.pontos.map((p) => Number(p.saldo))).toEqual([600, 300, 100]);
    expect(e.pontos[0].saiu_da_base_titulos).toBe(null);   // primeira não tem anterior
    expect(e.pontos[1].saiu_da_base_titulos).toBe(1);
    expect(Number(e.pontos[1].saiu_da_base_valor)).toBe(300);
    expect(e.pontos[2].saiu_da_base_titulos).toBe(1);
    expect(e.acoes).toHaveLength(1);
    expect(e.acoes[0].origem).toBe("EXTERNA");
    expect(e.acoes[0].remessa_nome).toBe("Sexta");
  });

  it("os cards comparam a primeira com a última remessa, sem somar ações", async () => {
    const sexta = await importar("Sexta", [t("2026000001", 100), t("2026000002", 200), t("2026000003", 300)], "2026-10-02 09:00-03");
    await registrar(sexta.lote_id, "A1", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 14:00-03");
    const ontem = await importar("Ontem", [t("2026000001", 100), t("2026000002", 200)], "2026-10-05 15:00-03");
    // DUAS ações sobre a MESMA remessa: os mesmos títulos não podem ser somados
    await registrar(ontem.lote_id, "A2 e-mail", "EMAIL", "BOLETO_VENCIDO", "2026-10-05 16:00-03");
    await registrar(ontem.lote_id, "A3 whats", "WHATSAPP", "BOLETO_VENCIDO", "2026-10-05 17:00-03");
    await importar("Hoje", [t("2026000001", 100)], "2026-10-06 08:00-03");

    const c = (await evolucao()).cards;
    expect(c.remessas).toBe(3);
    expect(c.titulos_inicial).toBe(3);
    expect(Number(c.saldo_inicial)).toBe(600);
    expect(c.titulos_ainda_abertos).toBe(1);
    expect(Number(c.saldo_ainda_aberto)).toBe(100);
    expect(c.saiu_da_base_titulos).toBe(2);        // 3 -> 1, e NÃO 1+2+2 das ações
    expect(Number(c.saiu_da_base_valor)).toBe(500);
    // 3 ações, mas só 3 alunos distintos acionados — sem dupla contagem
    expect(c.alunos_acionados).toBe(3);
  });

  it("título com Vcto Origem FORA do período da carteira é recusado, com motivo", async () => {
    const r = await importar("Sexta", [
      t("2026000001", 100, "2026-10-05"),               // origem em outubro: entra
      t("2026000002", 200, "2026-09-05"),               // setembro reemitido: recusado
      t("2026000003", 300, "2026-04-01"),               // abril reemitido: recusado
      t("2026000004", 400, "2026-10-20"),               // outro dia de outubro: entra
    ], "2026-10-02 09:00-03");

    expect(r.linhas_aceitas).toBe(2);
    expect(r.linhas_recusadas).toBe(2);
    expect(r.recusas_por_motivo.ORIGEM_FORA_DO_PERIODO).toBe(2);

    // a linha recusada não some: fica com o motivo e os dados brutos
    const rec = await db.query(
      `select motivo, dados->>'matricula' as matricula from public.prev_lote_recusa
        where lote_id = $1::uuid order by 2`, [r.lote_id]);
    expect(rec.rows.map((x) => x.matricula)).toEqual(["2026000002", "2026000003"]);
    expect(rec.rows.every((x) => x.motivo === "ORIGEM_FORA_DO_PERIODO")).toBe(true);

    // e o que entrou são só os dois de outubro
    const mats = await db.query(
      `select matricula_prime from public.prev_titulo order by 1`);
    expect(mats.rows.map((x) => x.matricula_prime)).toEqual(["2026000001", "2026000004"]);
  });

  it("a regra usa o período DA CARTEIRA, não outubro no código", async () => {
    const setembro = await um(db,
      `select public.preventivo_carteira_criar('Set', null, '2026-09-01'::date, '2026-09-30'::date)`);
    const r = await um(db,
      `select public.preventivo_lote_confirmar_v2($1::uuid, 'R', 'r.csv', '{}'::jsonb, null, $2::jsonb, $3::timestamptz)`,
      [setembro, JSON.stringify([
        { ...t("2026000010", 100, "2026-09-05"), vencimento: "2026-09-05" },   // entra
        { ...t("2026000011", 200, "2026-10-05"), vencimento: "2026-09-05" },   // origem de outubro: recusada
      ]), "2026-09-06 09:00-03"]);
    expect(r.linhas_aceitas).toBe(1);
    expect(r.recusas_por_motivo.ORIGEM_FORA_DO_PERIODO).toBe(1);
  });

  it("vencimento atual e origem seguem sendo campos separados", async () => {
    const r = await importar("R", [t("2026000001", 100, "2026-10-01")], "2026-10-02 09:00-03");
    const l = await db.query(
      `select vencimento::text as v, vencimento_origem::text as o from public.prev_titulo`);
    expect(l.rows[0].v).toBe("2026-10-05");
    expect(l.rows[0].o).toBe("2026-10-01");
    expect(r.linhas_aceitas).toBe(1);
  });

  it("ENTRADAS NOVAS: o card não subtrai totais, compara título a título", async () => {
    // 3 na primeira, 2 saem, 2 novos entram -> total final 3.
    // Subtrair totais daria 0 saídas. A conta certa é 2.
    await importar("F1", [t("2026000001", 100), t("2026000002", 200), t("2026000003", 300)], "2026-10-02 09:00-03");
    await importar("F2", [
      t("2026000001", 100),
      t("2026000010", 400),   // novo
      t("2026000011", 500),   // novo
    ], "2026-10-06 09:00-03");

    const e = await evolucao();
    expect(e.cards.titulos_inicial).toBe(3);
    expect(e.cards.titulos_ainda_abertos).toBe(3);        // mesmo total!
    expect(e.cards.saiu_da_base_titulos).toBe(2);         // e NÃO 3 - 3 = 0
    expect(Number(e.cards.saiu_da_base_valor)).toBe(500); // 200 + 300, saldo da PRIMEIRA
    expect(e.cards.entraram_depois).toBe(2);
  });

  it("REENTRADA: título que saiu e voltou não conta como saída", async () => {
    await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02 09:00-03");
    const a = await registrar(
      (await db.query(`select id from public.prev_lote where nome='F1'`)).rows[0].id,
      "Ação", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 10:00-03");

    await importar("F2", [t("2026000001", 100)], "2026-10-03 09:00-03");          // o 002 some
    await importar("F3", [t("2026000001", 100), t("2026000002", 200)], "2026-10-04 09:00-03"); // volta

    const e = await evolucao();
    // o ponto do meio registra a saída daquele intervalo...
    expect(e.pontos[1].saiu_da_base_titulos).toBe(1);
    expect(e.pontos[2].entraram).toBe(1);
    // ...mas o acumulado da AÇÃO compara com a ÚLTIMA foto: ninguém saiu
    const ac = e.acoes.find((x) => x.id === a.id);
    expect(ac.atualizacoes_depois).toBe(2);
    expect(ac.saiu_titulos).toBe(0);
    expect(ac.em_aberto).toBe(2);
    expect(ac.taxa_titulos).toBe(0);
    // e o card também não conta o que voltou
    expect(e.cards.saiu_da_base_titulos).toBe(0);
  });

  it("PÚBLICO PARCIAL: a ação acompanha só quem recebeu", async () => {
    const f1 = await importar("F1", [t("2026000001", 100), t("2026000002", 200), t("2026000003", 300)], "2026-10-02 09:00-03");
    // só dois receberam
    const a = await registrar(f1.lote_id, "Parcial", "EMAIL", "PROXIMO_VENCIMENTO",
                              "2026-10-02 10:00-03", ["2026000001", "2026000002"]);
    expect(a.incluidos).toBe(2);
    expect(a.filtros.publico).toBe("lista_informada");

    // some um de quem recebeu e um de quem NÃO recebeu
    await importar("F2", [t("2026000001", 100)], "2026-10-03 09:00-03");

    const ac = (await evolucao()).acoes.find((x) => x.id === a.id);
    expect(ac.base_titulos).toBe(2);              // base é o público, não a remessa
    expect(ac.saiu_titulos).toBe(1);              // só o 002, que recebeu
    expect(Number(ac.saiu_valor)).toBe(200);      // o 300 não entra: não foi acionado
    expect(ac.taxa_titulos).toBe(50.0);
  });

  it("não dá para registrar sem dizer quem recebeu", async () => {
    const f1 = await importar("F1", [t("2026000001")], "2026-10-02 09:00-03");
    await expect(um(db,
      `select public.preventivo_acao_externa_registrar($1::uuid, $2::uuid, 'X', 'EMAIL',
         'PROXIMO_VENCIMENTO', $3::timestamptz, null, false)`,
      [carteira, f1.lote_id, "2026-10-02 10:00-03"])).rejects.toThrow(/Informe quem recebeu/i);
  });

  it("lista e remessa inteira ao mesmo tempo é recusado", async () => {
    const f1 = await importar("F1", [t("2026000001")], "2026-10-02 09:00-03");
    await expect(um(db,
      `select public.preventivo_acao_externa_registrar($1::uuid, $2::uuid, 'X', 'EMAIL',
         'PROXIMO_VENCIMENTO', $3::timestamptz, array['2026000001'], true)`,
      [carteira, f1.lote_id, "2026-10-02 10:00-03"])).rejects.toThrow(/Escolha um/i);
  });

  it("matrícula informada que não está na remessa é ignorada e reportada", async () => {
    const f1 = await importar("F1", [t("2026000001")], "2026-10-02 09:00-03");
    const a = await registrar(f1.lote_id, "X", "EMAIL", "PROXIMO_VENCIMENTO",
                              "2026-10-02 10:00-03", ["2026000001", "9999999999"]);
    expect(a.incluidos).toBe(1);
    expect(a.fora_da_remessa).toBe(1);

    await expect(registrar(f1.lote_id, "Y", "EMAIL", "PROXIMO_VENCIMENTO",
                           "2026-10-02 10:00-03", ["9999999999"]))
      .rejects.toThrow(/Nenhuma das matrículas/i);
  });

  it("ação SEM envio confirmado não ganha resultado — fica nula, não zero", async () => {
    const f1 = await importar("F1", [t("2026000001"), t("2026000002")], "2026-10-02 09:00-03");
    // ação do módulo, preparada e nunca enviada
    const prep = await um(db,
      `select public.preventivo_acao_preparar_v2($1::uuid, 'Preparada', 'WHATSAPP', '{}'::jsonb, 'PROXIMO_VENCIMENTO')`,
      [carteira]);
    await importar("F2", [t("2026000001")], "2026-10-03 09:00-03");

    const ac = (await evolucao()).acoes.find((x) => x.id === prep.id);
    expect(ac.sem_envio_confirmado).toBe(true);
    expect(ac.atualizacoes_depois).toBe(0);
    expect(ac.saiu_titulos).toBe(null);
    expect(ac.taxa_titulos).toBe(null);
    expect(ac.em_aberto).toBe(null);
    expect(f1.lote_id).toBeTruthy();
  });

  it("remessa anterior ao envio não entra no acompanhamento da ação", async () => {
    const f1 = await importar("F1", [t("2026000001"), t("2026000002")], "2026-10-02 09:00-03");
    await importar("F2", [t("2026000001")], "2026-10-03 09:00-03");   // antes do envio
    const a = await registrar(f1.lote_id, "Depois", "EMAIL", "BOLETO_VENCIDO", "2026-10-04 10:00-03");

    const ac = (await evolucao()).acoes.find((x) => x.id === a.id);
    expect(ac.atualizacoes_depois).toBe(0);     // a F2 é anterior ao envio
    expect(ac.saiu_titulos).toBe(null);
  });

  it("a palavra é SAIU DA BASE e não há promessa de pagamento", async () => {
    const r = await importar("Sexta", [t("2026000001")], "2026-10-02 09:00-03");
    await registrar(r.lote_id, "A", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 14:00-03");
    const texto = JSON.stringify(await evolucao()).toLowerCase();
    expect(texto).toContain("saiu da base");
    expect(texto).toContain("não é pagamento confirmado");
    expect(texto).not.toMatch(/"pago"|valor_pago|recebido|recuperado/);
  });

  it("as três portas novas continuam fechadas para quem não é gestão", async () => {
    const r = await importar("Sexta", [t("2026000001")], "2026-10-02 09:00-03");
    await db.exec(`update public._jwt set email = '${OUTRA}'`);
    await expect(importar("X", [t("2026000009")], "2026-10-02 09:00-03")).rejects.toThrow(/gestão/i);
    await expect(registrar(r.lote_id, "X", "EMAIL", "PROXIMO_VENCIMENTO", "2026-10-02 14:00-03")).rejects.toThrow(/gestão/i);
    await expect(evolucao()).rejects.toThrow(/gestão/i);
    await db.exec(`update public._jwt set email = '${GESTAO}'`);
  });
});
