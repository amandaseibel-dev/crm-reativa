// PAINEL OBJETIVO — os três cards e o acompanhamento por ação.
//
// O que este arquivo protege:
//   1. os três cards: início, saiu, hoje — sempre dentro do recorte;
//   2. a CONTA FECHA em toda ação: antes − saiu + entradas + ajuste = depois;
//   3. o ajuste aparece quando o saldo de quem FICOU muda, e não é somado a
//      "saiu" — confundir os dois seria chamar encargo de recuperação;
//   4. alunos acionados conta cada aluno UMA vez, e é nulo (não zero) enquanto
//      nenhum envio estiver confirmado;
//   5. ação sem régua comprovada não inventa resultado;
//   6. a proteção de ordem ambígua vale também aqui: se duas fotos vizinhas
//      não têm ordem provada, os cards avisam;
//   7. foto ambígua do mesmo dia NÃO mantém a ação pendente quando já existe
//      remessa posterior válida — nesse caso a comparação é contra a posterior.
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
  "supabase/migrations/20261006165832_preventivo_recorte_e_precisao_da_extracao.sql",
  "supabase/migrations/20261007113426_preventivo_painel_objetivo.sql",
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
    create schema auth; create table public._jwt (email text);
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

const t = (matricula, saldo, origem = "2026-10-05") => ({
  matricula, aluno_nome: `Aluno ${matricula}`,
  vencimento: "2026-10-05", vencimento_origem: origem,
  valor: String(saldo), saldo: String(saldo), saldo_atualizado: String(saldo),
  situacao: "EM ABERTO",
  celular: `(51) 9${matricula.slice(-4)}-${matricula.slice(-4)}`,
  email: `a${matricula}@exemplo.com`,
});

describe("Preventivo — painel objetivo", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Out', null, '2026-10-01'::date, '2026-10-31'::date)`);
  });

  const importar = (nome, linhas, dia, ordem = 1, prec = "DATA", hora = "00:00") => um(db,
    `select public.preventivo_lote_confirmar_v2($1::uuid, $2, 'rel.csv', '{}'::jsonb, null,
            $3::jsonb, $4::timestamptz, $5, $6::int)`,
    [carteira, nome, JSON.stringify(linhas), `${dia} ${hora}-03`, prec, ordem]);

  const registrar = (lote, nome, canal, em) => um(db,
    `select public.preventivo_acao_externa_registrar($1::uuid, $2::uuid, $3, $4,
            'BOLETO_VENCIDO', $5::timestamptz, null, true, 'DATA')`,
    [carteira, lote, nome, canal, `${em} 00:00-03`]);

  const painel = () => um(db, `select public.preventivo_painel($1::uuid)`, [carteira]);

  it("os três cards saem da primeira e da última foto, dentro do recorte", async () => {
    await importar("F1", [t("2026000001", 100), t("2026000002", 200), t("2026000003", 300)], "2026-10-02");
    await importar("F2", [t("2026000001", 100)], "2026-10-06");
    // título de origem em setembro: fica na carteira e fora da conta
    await db.exec(`update public.prev_titulo set vencimento_origem = '2026-09-05'
                    where matricula_prime = '2026000003'`);

    const c = (await painel()).cards;
    expect(c.inicio.titulos).toBe(2);          // o 003 não entra
    expect(Number(c.inicio.saldo)).toBe(300);  // 100 + 200
    expect(c.saiu.titulos).toBe(1);            // o 002
    expect(Number(c.saiu.valor)).toBe(200);
    expect(c.hoje.titulos).toBe(1);
    expect(Number(c.hoje.saldo)).toBe(100);
    expect(c.remessas).toBe(2);
  });

  it("a conta de cada ação fecha: antes − saiu + entradas + ajuste = depois", async () => {
    // F1: 001(100) 002(200) 003(300).  F2: 001(130) 003(300) 004(50)
    //   002 saiu; 004 entrou; 001 subiu 30 -> ajuste +30
    const f1 = await importar("F1",
      [t("2026000001", 100), t("2026000002", 200), t("2026000003", 300)], "2026-10-02");
    await registrar(f1.lote_id, "Envio de 02/10", "WHATSAPP", "2026-10-02");
    await importar("F2",
      [t("2026000001", 130), t("2026000003", 300), t("2026000004", 50)], "2026-10-06");

    const [ac] = (await painel()).acoes;
    expect(ac.antes.titulos).toBe(3);
    expect(Number(ac.antes.saldo)).toBe(600);
    expect(ac.saiu.titulos).toBe(1);
    expect(Number(ac.saiu.valor)).toBe(200);
    expect(ac.entradas.titulos).toBe(1);
    expect(Number(ac.entradas.valor)).toBe(50);
    expect(Number(ac.ajuste_saldo)).toBe(30);
    expect(ac.depois.titulos).toBe(3);
    expect(Number(ac.depois.saldo)).toBe(480);

    // A IDENTIDADE, explicitamente
    expect(Number(ac.antes.saldo) - Number(ac.saiu.valor)
         + Number(ac.entradas.valor) + Number(ac.ajuste_saldo))
      .toBe(Number(ac.depois.saldo));
    expect(ac.antes.titulos - ac.saiu.titulos + ac.entradas.titulos).toBe(ac.depois.titulos);
  });

  it("queda de saldo de quem FICOU vira ajuste, nunca saída", async () => {
    const f1 = await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02");
    await registrar(f1.lote_id, "Envio", "EMAIL", "2026-10-02");
    // ninguém sai; o 001 cai de 100 para 40 (pagamento parcial, ou o que for)
    await importar("F2", [t("2026000001", 40), t("2026000002", 200)], "2026-10-06");

    const [ac] = (await painel()).acoes;
    expect(ac.saiu.titulos).toBe(0);
    expect(Number(ac.saiu.valor)).toBe(0);
    expect(Number(ac.ajuste_saldo)).toBe(-60);
    expect(Number(ac.depois.saldo)).toBe(240);
    // os R$ 60 NÃO viraram "saiu"
    expect(Number(ac.saiu.valor)).not.toBe(60);
  });

  it("alunos acionados conta cada aluno uma vez só", async () => {
    const f1 = await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02");
    await registrar(f1.lote_id, "WhatsApp", "WHATSAPP", "2026-10-02");
    await registrar(f1.lote_id, "E-mail", "EMAIL", "2026-10-02");
    await importar("F2", [t("2026000001", 100)], "2026-10-06");

    const p = await painel();
    expect(p.acoes).toHaveLength(2);
    // dois envios para os mesmos 2 alunos => 2, não 4
    expect(p.cards.alunos_acionados).toBe(2);
  });

  it("sem envio confirmado, alunos acionados é NULO — não zero", async () => {
    await importar("F1", [t("2026000001", 100)], "2026-10-02");
    await um(db, `select public.preventivo_acao_preparar_v2($1::uuid, 'Preparada', 'WHATSAPP',
                    '{}'::jsonb, 'BOLETO_VENCIDO')`, [carteira]);
    const p = await painel();
    expect(p.cards.alunos_acionados).toBeNull();
    expect(p.acoes[0].sem_envio_confirmado).toBe(true);
    expect(p.acoes[0].saiu.titulos).toBeNull();
  });

  it("ação sem remessa comprovadamente posterior não inventa resultado", async () => {
    const f1 = await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02");
    await registrar(f1.lote_id, "Envio", "WHATSAPP", "2026-10-02");
    const p = await painel();           // nenhuma foto depois ainda
    const ac = p.acoes[0];
    expect(ac.saiu.titulos).toBeNull();
    expect(ac.entradas.titulos).toBeNull();
    expect(ac.ajuste_saldo).toBeNull();
    expect(ac.depois.titulos).toBeNull();
    expect(ac.aguardando_remessa).toBe(true);
    expect(ac.antes.titulos).toBe(2);   // a base acionada é conhecida
  });

  it("a definição nunca chama saída de pagamento nem ajuste de recuperação", async () => {
    await importar("F1", [t("2026000001", 100)], "2026-10-02");
    const d = (await painel()).definicao;
    expect(d).toMatch(/NÃO pagamento confirmado/i);
    expect(d).toMatch(/NÃO é recuperação/i);
    expect(d).not.toMatch(/\brecuperad/i);
  });

  it("ordem ambígua entre duas fotos é avisada nos cards", async () => {
    // mesmo dia, mesma ordem no dia, nenhuma com hora: a fila existe, a prova não
    await importar("A", [t("2026000001", 100), t("2026000002", 200)], "2026-10-05", 1);
    await importar("B", [t("2026000001", 100)], "2026-10-05", 1);
    const p = await painel();
    expect(p.cards.ordem_ambigua).toBe(true);
  });

  it("declarar a ordem no dia tira o aviso", async () => {
    await importar("A", [t("2026000001", 100), t("2026000002", 200)], "2026-10-05", 1);
    await importar("B", [t("2026000001", 100)], "2026-10-05", 2);
    const p = await painel();
    expect(p.cards.ordem_ambigua).toBe(false);
    expect(p.cards.saiu.titulos).toBe(1);
  });

  it("dias diferentes nunca deixam a ordem ambígua", async () => {
    await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02");
    await importar("F2", [t("2026000001", 100)], "2026-10-06");
    expect((await painel()).cards.ordem_ambigua).toBe(false);
  });

  it("foto ambígua do mesmo dia NÃO mantém a ação pendente se há remessa posterior", async () => {
    const f1 = await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02");
    const a = await registrar(f1.lote_id, "Envio de 02/10", "EMAIL", "2026-10-02");
    // outra foto no MESMO dia do envio, sem hora: sozinha, deixaria pendente
    await importar("F1b", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02", 2);
    // mas existe uma posterior, e é contra ela que se compara
    await importar("F2", [t("2026000001", 100)], "2026-10-06");

    const ac = (await painel()).acoes.find((x) => x.id === a.id);
    expect(ac.sequencia_nao_comprovada).toBe(false);
    expect(ac.saiu.titulos).toBe(1);
    expect(Number(ac.saiu.valor)).toBe(200);

    // e as duas funções antigas concordam
    const r = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);
    expect(r.sequencia_nao_comprovada).toBe(false);
    expect(r.saiu_da_base).toBe(1);
    const ev = (await um(db, `select public.preventivo_evolucao($1::uuid)`, [carteira]))
      .acoes.find((x) => x.id === a.id);
    expect(ev.sequencia_nao_comprovada).toBe(false);
  });

  it("sem remessa posterior, a foto ambígua do mesmo dia mantém a pendência", async () => {
    const f1 = await importar("F1", [t("2026000001", 100), t("2026000002", 200)], "2026-10-02");
    const a = await registrar(f1.lote_id, "Envio", "EMAIL", "2026-10-02");
    await importar("F1b", [t("2026000001", 100)], "2026-10-02", 2);

    const ac = (await painel()).acoes.find((x) => x.id === a.id);
    expect(ac.sequencia_nao_comprovada).toBe(true);
    expect(ac.saiu.titulos).toBeNull();
  });

  it("quem não é da gestão não lê o painel", async () => {
    await importar("F1", [t("2026000001", 100)], "2026-10-02");
    await db.exec(`update public._jwt set email = '${OUTRA}'`);
    await expect(painel()).rejects.toThrow(/gest/i);
  });
});
