// O FLUXO DE REMESSAS, do jeito que a gestão definiu em 28/09/2026:
//
//   toda ação nasce de uma remessa NOVA, importada na hora;
//   a remessa anterior nunca vira carteira ativa sozinha;
//   a remessa seguinte é o que diz o que aconteceu com quem foi acionado.
//
// O QUE ESTE ARQUIVO PROTEGE, acima de tudo: a palavra. Um título que estava
// na remessa anterior e não está na seguinte é `REGULARIZADO_ENTRE_REMESSAS` —
// nunca pagamento confirmado. Ele pode ter sido pago, cancelado, renegociado,
// bolsado, ou simplesmente não ter entrado no recorte do relatório. A fonte não
// distingue, e há teste aqui para que o código nunca finja que distingue.
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

const MIGRATIONS = [
  "supabase/migrations/20260928143743_preventivo_estrutura.sql",
  "supabase/migrations/20260928143843_preventivo_importacao.sql",
  "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
  "supabase/migrations/20260928201351_preventivo_remessa_como_unidade.sql",
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
      `truncate ${TABELAS.map((t) => "public." + t).join(", ")} restart identity cascade`);
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
    insert into public.usuarios values ('${GESTAO}', true);
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

// Um título de remessa: o par (Dt Vcto, Vcto Origem) é a identidade.
//
// CADA ALUNO COM SEU PRÓPRIO NÚMERO, de propósito. Na primeira versão deste
// arquivo todos dividiam o mesmo celular, e a trava de contato compartilhado
// esvaziava o público inteiro — o sistema estava certo, o fixture é que era
// irreal. Um relatório de verdade tem números diferentes.
const t = (matricula, origem, saldo, over = {}) => ({
  matricula, aluno_nome: `Aluno ${matricula}`,
  vencimento: "2026-09-18", vencimento_origem: origem,
  valor: String(saldo), saldo: String(saldo), saldo_atualizado: String(saldo + 10),
  situacao: "EM ABERTO",
  celular: `(51) 9${matricula.slice(-4)}-${matricula.slice(-4)}`,
  email: `a${matricula}@exemplo.com`,
  ...over,
});

describe("Preventivo — a remessa é a unidade", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Carteira', null, '2026-01-01'::date, '2027-12-31'::date)`);
  });

  const importar = (nome, linhas) => um(db,
    `select public.preventivo_lote_confirmar($1::uuid, $2, 'rel.csv', '{}'::jsonb, null, $3::jsonb)`,
    [carteira, nome, JSON.stringify(linhas)]);

  it("a remessa guarda tudo que a gestão pediu para o resumo", async () => {
    const r = await importar("Remessa 1", [
      t("2026000001", "2026-06-05", 100),
      t("2026000002", "2026-07-05", 200, { celular: "(51) 3333-4444" }),   // sem celular
      t("2026000003", "2026-08-05", 300, { email: "a@x.com b@y.com" }),    // e-mail múltiplo
      { ...t("2026000004", "2026-09-05", 0), valor: "0", saldo: "0" },     // recusada
    ]);
    const lote = r.lote_id;
    const resumo = await um(db, `select public.preventivo_remessa_resumo($1::uuid)`, [lote]);

    expect(resumo.alunos).toBe(3);
    expect(resumo.titulos).toBe(3);
    expect(Number(resumo.valor)).toBe(600);
    expect(resumo.whatsapp_disponivel).toBe(2);
    expect(resumo.email_disponivel).toBe(2);
    expect(resumo.para_revisao).toBe(2);
    expect(resumo.recusas).toBe(1);
    expect(resumo.recusas_por_motivo.VALOR_INVALIDO).toBe(1);
    expect(resumo.importada_por).toBe(GESTAO);
    expect(resumo.importada_em).not.toBe(null);
  });

  it("o valor da remessa é o DAQUELA remessa, não o da primeira entrada", async () => {
    await importar("Remessa 1", [t("2026000001", "2026-06-05", 100)]);
    const r2 = await importar("Remessa 2", [t("2026000001", "2026-06-05", 130)]);

    const primeira = await um(db, `select public.preventivo_remessa_resumo(
      (select id from public.prev_lote where nome = 'Remessa 1'))`);
    const segunda = await um(db, `select public.preventivo_remessa_resumo($1::uuid)`, [r2.lote_id]);

    expect(Number(primeira.valor)).toBe(100);
    expect(Number(segunda.valor)).toBe(130);
    // e o valor de ENTRADA na carteira segue intocado
    expect(Number(await um(db, `select saldo_informado from public.prev_titulo`))).toBe(100);
  });

  it("classifica os três casos entre remessas", async () => {
    await importar("Remessa 1", [
      t("2026000001", "2026-06-05", 100),   // vai continuar
      t("2026000002", "2026-07-05", 200),   // vai sumir
    ]);
    const r2 = await importar("Remessa 2", [
      t("2026000001", "2026-06-05", 110),   // continua
      t("2026000003", "2026-08-05", 300),   // novo
    ]);

    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [r2.lote_id]);
    expect(c.primeira_remessa).toBe(false);
    expect(c.continua_em_aberto.titulos).toBe(1);
    expect(c.regularizados_entre_remessas.titulos).toBe(1);
    // o valor do regularizado é o da remessa ANTERIOR, onde ele existia
    expect(Number(c.regularizados_entre_remessas.valor)).toBe(200);
    expect(c.novos_na_remessa.titulos).toBe(1);
    expect(Number(c.novos_na_remessa.valor)).toBe(300);
  });

  it("a primeira remessa não inventa comparação", async () => {
    const r = await importar("Remessa 1", [t("2026000001", "2026-06-05", 100)]);
    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [r.lote_id]);
    expect(c.primeira_remessa).toBe(true);
    expect(c.regularizados_entre_remessas).toBeUndefined();
  });

  it("regularizado entre remessas NUNCA é chamado de pagamento", async () => {
    await importar("Remessa 1", [t("2026000001", "2026-06-05", 100)]);
    const r2 = await importar("Remessa 2", [t("2026000002", "2026-07-05", 200)]);
    const c = await um(db, `select public.preventivo_remessa_comparar($1::uuid)`, [r2.lote_id]);

    expect(c.definicao).toMatch(/NÃO é pagamento confirmado/);
    const texto = JSON.stringify(c).toUpperCase();
    expect(texto).not.toMatch(/"PAGO"|PAGAMENTO_CONFIRMADO|RECEBIDO/);
    // e o rótulo é o que a gestão pediu
    expect(Object.keys(c)).toContain("regularizados_entre_remessas");
  });

  it("a lista por classificação traz cada título no balde certo", async () => {
    await importar("Remessa 1", [
      t("2026000001", "2026-06-05", 100),
      t("2026000002", "2026-07-05", 200),
    ]);
    const r2 = await importar("Remessa 2", [
      t("2026000001", "2026-06-05", 110),
      t("2026000003", "2026-08-05", 300),
    ]);
    const reg = await um(db, `select public.preventivo_remessa_titulos($1::uuid, 'REGULARIZADO_ENTRE_REMESSAS')`, [r2.lote_id]);
    expect(reg).toHaveLength(1);
    expect(reg[0].matricula).toBe("2026000002");
    expect(Number(reg[0].saldo_na_remessa)).toBe(200);

    const cont = await um(db, `select public.preventivo_remessa_titulos($1::uuid, 'CONTINUA_EM_ABERTO')`, [r2.lote_id]);
    expect(cont.map((x) => x.matricula)).toEqual(["2026000001"]);
  });
});

describe("Preventivo — a ação nasce de uma remessa", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Carteira', null, '2026-01-01'::date, '2027-12-31'::date)`);
  });

  const importar = (nome, linhas) => um(db,
    `select public.preventivo_lote_confirmar($1::uuid, $2, 'rel.csv', '{}'::jsonb, null, $3::jsonb)`,
    [carteira, nome, JSON.stringify(linhas)]);
  const acao = (nome, canal = "WHATSAPP", filtros = {}) => um(db,
    `select public.preventivo_acao_preparar($1::uuid, $2, $3, $4::jsonb)`,
    [carteira, nome, canal, JSON.stringify(filtros)]);

  it("sem remessa não há ação", async () => {
    await expect(acao("Aviso")).rejects.toThrow(/Toda ação nasce de uma remessa/);
  });

  it("a ação fica vinculada à remessa e só pega os títulos dela", async () => {
    await importar("Remessa 1", [
      t("2026000001", "2026-06-05", 100),
      t("2026000002", "2026-07-05", 200),
    ]);
    const r2 = await importar("Remessa 2", [t("2026000003", "2026-08-05", 300)]);

    // sem dizer qual, usa a ÚLTIMA — nunca a carteira acumulada
    const a = await acao("Aviso da 2");
    expect(a.incluidos).toBe(1);
    expect(await um(db, `select lote_id from public.prev_acao where id = $1::uuid`, [a.id])).toBe(r2.lote_id);
  });

  it("dá para acionar uma remessa específica", async () => {
    const r1 = await importar("Remessa 1", [
      t("2026000001", "2026-06-05", 100),
      t("2026000002", "2026-07-05", 200),
    ]);
    await importar("Remessa 2", [t("2026000003", "2026-08-05", 300)]);
    const a = await acao("Aviso da 1", "WHATSAPP", { lote_id: r1.lote_id });
    expect(a.incluidos).toBe(2);
  });

  it("o resultado espera a próxima remessa antes de afirmar qualquer coisa", async () => {
    await importar("Remessa 1", [t("2026000001", "2026-06-05", 100)]);
    const a = await acao("Aviso");
    const res = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);
    expect(res.aguardando_proxima_remessa).toBe(true);
    expect(res.regularizados_entre_remessas).toBe(null);
    expect(res.taxa_regularizacao).toBe(null);
    expect(res.titulos_acionados).toBe(1);
    expect(Number(res.valor_acionado)).toBe(100);
  });

  it("com a próxima remessa, mede regularização e taxa", async () => {
    await importar("Remessa 1", [
      t("2026000001", "2026-06-05", 100),
      t("2026000002", "2026-07-05", 200),
      t("2026000003", "2026-08-05", 300),
    ]);
    const a = await acao("Aviso");
    expect(a.incluidos).toBe(3);

    // na remessa seguinte, um sumiu
    await importar("Remessa 2", [
      t("2026000001", "2026-06-05", 110),
      t("2026000002", "2026-07-05", 210),
    ]);

    const res = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);
    expect(res.aguardando_proxima_remessa).toBe(false);
    expect(res.titulos_acionados).toBe(3);
    expect(res.continuam_em_aberto).toBe(2);
    expect(res.regularizados_entre_remessas).toBe(1);
    // VALOR DA REMESSA EM QUE FOI ACIONADO: 300, não o da remessa seguinte
    expect(Number(res.valor_regularizado)).toBe(300);
    expect(Number(res.valor_acionado)).toBe(600);
    expect(Number(res.taxa_regularizacao)).toBeCloseTo(33.3, 1);
    expect(res.definicao).toMatch(/NÃO é pagamento confirmado/);
  });

  it("os três estados continuam valendo, e exportar não é enviar", async () => {
    await importar("Remessa 1", [t("2026000001", "2026-06-05", 100)]);
    const a = await acao("Aviso");
    expect(a.estado).toBe("PREPARADA");
    await expect(um(db, `select public.preventivo_acao_marcar($1::uuid, 'ENVIO_CONFIRMADO')`, [a.id]))
      .rejects.toThrow(/depois de exportar/);
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'EXPORTADA')`, [a.id]);
    const fim = await um(db, `select public.preventivo_acao_marcar($1::uuid, 'ENVIO_CONFIRMADO')`, [a.id]);
    expect(fim.estado).toBe("ENVIO_CONFIRMADO");
  });

  it("o histórico lista as remessas da mais nova para a mais velha, com a comparação", async () => {
    await importar("Remessa 1", [t("2026000001", "2026-06-05", 100)]);
    await importar("Remessa 2", [t("2026000002", "2026-07-05", 200)]);
    const h = await um(db, `select public.preventivo_remessas($1::uuid)`, [carteira]);
    expect(h).toHaveLength(2);
    expect(h[0].nome).toBe("Remessa 2");
    expect(h[0].comparacao.regularizados_entre_remessas.titulos).toBe(1);
    expect(h[1].comparacao.primeira_remessa).toBe(true);
  });

  it("nenhuma rotina automática foi criada junto", async () => {
    // o fluxo é manual por decisão: nada de cron, nada de gatilho novo.
    const gatilhos = (await db.query(`
      select tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
       where not tg.tgisinternal and c.relname like 'prev\\_%'`)).rows;
    expect(gatilhos).toEqual([]);
  });
});
