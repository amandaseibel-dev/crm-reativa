// VISÃO GERAL, MUDANÇAS DE VALOR E HISTÓRICO DO ALUNO — Preventivo.
//
// O que este arquivo protege:
//   1. DEDUPLICAÇÃO: reimportar não duplica aluno, título nem remessa de
//      presença; título com número (documento) mantém uma linha só.
//   2. HISTÓRICO: o título que deixa a base continua no histórico do aluno,
//      com a linha do tempo das remessas.
//   3. PAGAMENTOS: nada que sumiu do relatório é contado como pago.
//   4. PERMISSÕES: só a gestão lê; Amanda ADM e anon não.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const GESTAO = "amanda.seibel@aelbra.com.br";
const ADM = "cobranca07@aelbra.com.br";

// Todas as migrations do Preventivo, em ordem, mais a desta frente.
const MIGRATIONS = readdirSync(resolve(RAIZ, "supabase/migrations"))
  .filter((f) => /preventivo/.test(f) && f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(resolve(RAIZ, "supabase/migrations", f), "utf8"));

const TABELAS = [
  "prev_acao_destinatario", "prev_acao", "prev_evento", "prev_titulo_snapshot",
  "prev_sinc_fila", "prev_sinc", "prev_titulo_lote", "prev_titulo",
  "prev_lote_recusa", "prev_lote", "prev_carteira",
];

let banco = null;
async function novoBanco() {
  if (banco) {
    await banco.exec(`truncate ${TABELAS.map((t) => "public." + t).join(", ")} restart identity cascade`);
    await banco.exec(`update public._jwt set email = '${GESTAO}'`);
    return banco;
  }
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table public._jwt (email text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('email', (select email from public._jwt limit 1)) $$;
    create table public.usuarios (email text, ativo boolean default true);
    insert into public.usuarios values ('${GESTAO}', true), ('${ADM}', true);
    insert into public._jwt values ('${GESTAO}');
  `);
  for (const m of MIGRATIONS) await db.exec(m);
  banco = db;
  return db;
}
beforeAll(async () => { await novoBanco(); });

const um = async (db, sql, p = []) => {
  const r = await db.query(sql, p);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
};

// Datas relativas a hoje (America/Sao_Paulo): fixture absoluta venceria sozinha.
const hojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const deslocar = (dias) => {
  const d = new Date(`${hojeSP}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const VENCIDO = deslocar(-10);
const A_VENCER = deslocar(10);

const t = (matricula, documento, saldo, over = {}) => ({
  matricula, documento, cpf: `1234567${matricula.slice(-4)}`.slice(0, 11),
  aluno_nome: `Aluno ${matricula}`,
  vencimento: VENCIDO, vencimento_origem: "2026-09-05",
  valor: String(saldo), saldo: String(saldo), saldo_atualizado: String(saldo),
  situacao: "EM ABERTO",
  celular: `(51) 9${matricula.slice(-4)}-${matricula.slice(-4)}`,
  email: `a${matricula}@exemplo.com`,
  ...over,
});

describe("Preventivo — visão geral, mudanças e histórico", () => {
  let db, carteira;
  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Carteira', null, '2026-01-01'::date, '2027-12-31'::date)`);
  });
  const importar = (nome, linhas, ordem = null) => um(db,
    `select public.preventivo_lote_confirmar($1::uuid, $2, 'rel.csv', '{}'::jsonb, null, $3::jsonb)`,
    [carteira, nome, JSON.stringify(linhas)]);

  // ---------------------------------------------------------------- dedup
  describe("deduplicação", () => {
    it("reimportar o mesmo relatório não duplica título nem aluno", async () => {
      const linhas = [t("2026000001", "900001", 100), t("2026000002", "900002", 200)];
      await importar("Semana 1", linhas);
      await importar("Semana 2", linhas);
      expect(Number(await um(db, `select count(*) from public.prev_titulo`))).toBe(2);
      expect(Number(await um(db, `select count(distinct matricula_prime) from public.prev_titulo`))).toBe(2);
      // cada remessa registra a presença, mas o título é um só
      expect(Number(await um(db, `select count(*) from public.prev_titulo_lote`))).toBe(4);
    });

    it("o mesmo número de título repetido no arquivo é recusado, não duplicado", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100), t("2026000001", "900001", 100)]);
      expect(Number(await um(db, `select count(*) from public.prev_titulo`))).toBe(1);
    });

    it("reimportar atualiza o valor sem apagar o histórico da remessa anterior", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100)]);
      await importar("Semana 2", [t("2026000001", "900001", 130)]);
      const hist = await um(db, `select public.preventivo_aluno_historico('2026000001')`);
      expect(hist.titulos).toHaveLength(1);
      expect(hist.titulos[0].remessas.map((r) => Number(r.saldo))).toEqual([100, 130]);
    });
  });

  // ---------------------------------------------------------------- histórico
  describe("histórico do aluno", () => {
    it("o título que saiu da base continua no histórico, marcado fora da última remessa", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100), t("2026000002", "900002", 50)]);
      await importar("Semana 2", [t("2026000002", "900002", 50)]);
      const hist = await um(db, `select public.preventivo_aluno_historico('2026000001')`);
      expect(hist.titulos).toHaveLength(1);
      expect(hist.titulos[0].na_ultima_remessa).toBe(false);
      expect(hist.titulos[0].remessas).toHaveLength(1);
    });

    it("busca por CPF exato; nome nunca identifica", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100, { cpf: "12345678901" })]);
      const porCpf = await um(db, `select public.preventivo_aluno_historico('123.456.789-01')`);
      expect(porCpf.titulos).toHaveLength(1);
      // a resposta não repete CPF nem id interno de carteira
      expect(JSON.stringify(porCpf)).not.toMatch(/12345678901|carteira_id|"cpf"/);
      const porNome = await um(db, `select public.preventivo_aluno_historico('Aluno 2026000001')`);
      expect(porNome.titulos).toHaveLength(0);
    });

    it("passar de 31 dias muda só o status: o histórico fica", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100, { vencimento: deslocar(-40) })]);
      const hist = await um(db, `select public.preventivo_aluno_historico('2026000001')`);
      expect(hist.titulos).toHaveLength(1);
      expect(hist.titulos[0].dias_atraso).toBeGreaterThan(31);
    });
  });

  // ---------------------------------------------------------------- pagamentos
  describe("visão geral e pagamentos", () => {
    it("conta alunos, adimplentes, inadimplentes, a vencer e vencidos da última remessa", async () => {
      await importar("Semana 1", [
        t("2026000001", "900001", 100),                                  // vencido
        t("2026000002", "900002", 200, { vencimento: A_VENCER }),        // a vencer
        t("2026000003", "900003", 300, { vencimento: A_VENCER }),        // a vencer
        t("2026000003", "900004", 50),                                   // mesmo aluno, vencido
      ]);
      const g = await um(db, `select public.preventivo_visao_geral(null)`);
      expect(g.matriculados).toBe(3);
      expect(g.inadimplentes).toBe(2);
      expect(g.adimplentes).toBe(1);
      expect(Number(g.vencidos.valor)).toBe(150);
      expect(Number(g.a_vencer.valor)).toBe(500);
    });

    it("filtra por período acadêmico", async () => {
      await importar("Semana 1", [
        t("2026000001", "900001", 100, { vencimento_origem: "2026-09-05" }),   // 2026/2
        t("2026000002", "900002", 200, { vencimento_origem: "2027-02-05" }),   // 2027/1
      ]);
      const todos = await um(db, `select public.preventivo_visao_geral(null)`);
      expect(todos.periodos_disponiveis).toEqual(["2027/1", "2026/2"]);
      const so2026 = await um(db, `select public.preventivo_visao_geral('2026/2')`);
      expect(so2026.matriculados).toBe(1);
      expect(Number(so2026.vencidos.valor)).toBe(100);
    });

    it("título que sumiu do relatório NÃO é pago: fica a conferir, e pago confirmado é zero", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100), t("2026000002", "900002", 200)]);
      await importar("Semana 2", [t("2026000002", "900002", 200)]);
      const g = await um(db, `select public.preventivo_visao_geral(null)`);
      expect(g.pagos_confirmados.titulos).toBe(0);
      expect(Number(g.pagos_confirmados.valor)).toBe(0);
      expect(g.saiu_da_base_a_conferir.titulos).toBe(1);
      expect(Number(g.saiu_da_base_a_conferir.valor)).toBe(100);
      // o título que saiu não conta mais como devedor da última remessa
      expect(g.matriculados).toBe(1);
    });

    it("mudança de valor entre remessas aparece em 'mudaram'; igual não aparece", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100), t("2026000002", "900002", 200)]);
      // a Semana 1 foi extraída 7 dias antes: a ordem fica COMPROVADA por dia diferente
      await db.exec(`update public.prev_lote set extraido_em = now() - interval '7 days' where nome = 'Semana 1'`);
      const r2 = await importar("Semana 2", [t("2026000001", "900001", 130), t("2026000002", "900002", 200)]);
      const m = await um(db, `select public.preventivo_remessa_mudancas($1::uuid)`, [r2.lote_id]);
      expect(m.sequencia_nao_comprovada).toBe(false);
      expect(m.mudaram).toHaveLength(1);
      expect(Number(m.mudaram[0].valor_anterior)).toBe(100);
      expect(Number(m.mudaram[0].valor_atual)).toBe(130);
      expect(Number(m.mudaram[0].delta)).toBe(30);
    });

    it("sem ordem comprovada entre as remessas, não afirma mudança nenhuma", async () => {
      await importar("Semana 1", [t("2026000001", "900001", 100)]);
      // mesma data, hora não comprovada em uma delas: a ordem sai de desempate arbitrário
      await db.exec(`update public.prev_lote set extraido_precisao = 'NAO_COMPROVADA' where nome = 'Semana 1'`);
      const r2 = await importar("Semana 2", [t("2026000001", "900001", 130)]);
      await db.exec(`update public.prev_lote set ordem_no_dia = 1`);
      // a hora comprovada ordena ANTES da ausente: qual das duas "vem depois" é arbitrário.
      // Consultadas as duas, a que tem anterior recusa afirmar mudança.
      const lotes = (await db.query(`select id from public.prev_lote`)).rows.map((r) => r.id);
      const respostas = [];
      for (const id of lotes) {
        respostas.push(await um(db, `select public.preventivo_remessa_mudancas($1::uuid)`, [id]));
      }
      const comAnterior = respostas.find((m) => !m.primeira_remessa);
      expect(comAnterior.sequencia_nao_comprovada).toBe(true);
      expect(comAnterior.mudaram).toBe(null);
      void r2;
    });
  });

  // ---------------------------------------------------------------- permissões
  describe("permissões", () => {
    const CHAMADAS = [
      `select public.preventivo_visao_geral(null)`,
      `select public.preventivo_remessa_mudancas(gen_random_uuid())`,
      `select public.preventivo_aluno_historico('2026000001')`,
    ];
    for (const sql of CHAMADAS) {
      it(`Amanda ADM é barrada: ${sql.slice(0, 55)}`, async () => {
        await db.exec(`update public._jwt set email = '${ADM}'`);
        await expect(db.query(sql)).rejects.toThrow(/acesso restrito à gestão/);
      });
    }

    it("anon não tem EXECUTE em nenhuma das RPCs novas; authenticated tem", async () => {
      for (const fn of [
        "preventivo_visao_geral(text)", "preventivo_remessa_mudancas(uuid)",
        "preventivo_aluno_historico(text)",
      ]) {
        expect(await um(db, `select has_function_privilege('anon', 'public.${fn}', 'execute')`)).toBe(false);
        expect(await um(db, `select has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe(true);
      }
    });

    it("as RPCs são só de leitura: nenhuma tabela da cobrança é citada", () => {
      const sql = readFileSync(resolve(RAIZ, "supabase/migrations/20261112120000_preventivo_visao_geral_historico.sql"), "utf8");
      expect(sql).not.toMatch(/public\.(casos|acordos|acordos_titulos|alunos|pagamentos|borderos?)\b/);
    });
  });
});
