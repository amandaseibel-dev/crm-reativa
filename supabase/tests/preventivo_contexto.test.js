// CONTEXTO DA AÇÃO — a etapa da jornada que a ação endereça.
//
// O que este arquivo protege:
//
//   1. a v1 continua viva e continua aceitando 4 argumentos (é o que evita a
//      janela de incompatibilidade durante o deploy);
//   2. a v2 RECUSA ação sem contexto e com contexto fora do domínio;
//   3. o contexto é o campo tipado — nada é inferido do nome da ação;
//   4. canal e contexto são independentes: as 4 combinações valem;
//   5. a conferência contexto × vencimento INFORMA e NUNCA bloqueia;
//   6. ação antiga (sem contexto) sobrevive, muda de estado e reporta como
//      SEM_CONTEXTO;
//   7. o relatório por contexto separa os baldes e NUNCA chama regularização
//      de pagamento ou de recuperação.
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
  "supabase/migrations/20261005191400_preventivo_contexto_da_acao.sql",
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

// `dias` conta a partir de hoje: negativo = já venceu, positivo = ainda vai vencer.
const t = (matricula, dias, saldo = 100) => ({
  matricula,
  aluno_nome: `Aluno ${matricula}`,
  vencimento: new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10),
  vencimento_origem: "2026-06-05",
  valor: String(saldo), saldo: String(saldo), saldo_atualizado: String(saldo),
  situacao: "EM ABERTO",
  celular: `(51) 9${matricula.slice(-4)}-${matricula.slice(-4)}`,
  email: `a${matricula}@exemplo.com`,
});

describe("Preventivo — contexto da ação", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Carteira', null, '2020-01-01'::date, '2030-12-31'::date)`);
  });

  const importar = (nome, linhas) => um(db,
    `select public.preventivo_lote_confirmar($1::uuid, $2, 'rel.csv', '{}'::jsonb, null, $3::jsonb)`,
    [carteira, nome, JSON.stringify(linhas)]);

  const preparar = (nome, canal, contexto) => um(db,
    `select public.preventivo_acao_preparar_v2($1::uuid, $2, $3, '{}'::jsonb, $4)`,
    [carteira, nome, canal, contexto]);

  it("a v1 continua viva e aceita 4 argumentos", async () => {
    await importar("R1", [t("2026000001", 5)]);
    const r = await um(db,
      `select public.preventivo_acao_preparar($1::uuid, 'Pela v1', 'WHATSAPP', '{}'::jsonb)`, [carteira]);
    expect(r.id).toBeTruthy();
    expect(r.contexto).toBe(null);
  });

  it("a v2 recusa ação sem contexto", async () => {
    await importar("R1", [t("2026000001", 5)]);
    await expect(preparar("Sem contexto", "WHATSAPP", null)).rejects.toThrow(/contexto/i);
    await expect(preparar("Vazio", "WHATSAPP", "   ")).rejects.toThrow(/contexto/i);
    expect(await um(db, `select count(*)::int from public.prev_acao`)).toBe(0);
  });

  it("a v2 recusa contexto fora do domínio", async () => {
    await importar("R1", [t("2026000001", 5)]);
    await expect(preparar("Inventado", "WHATSAPP", "COBRANCA_PESADA")).rejects.toThrow(/inválido/i);
    expect(await um(db, `select count(*)::int from public.prev_acao`)).toBe(0);
  });

  it("o banco recusa contexto fora do domínio mesmo por escrita direta", async () => {
    await importar("R1", [t("2026000001", 5)]);
    const a = await preparar("Válida", "WHATSAPP", "PROXIMO_VENCIMENTO");
    await expect(
      db.exec(`update public.prev_acao set contexto = 'QUALQUER' where id = '${a.id}'`)
    ).rejects.toThrow();
  });

  it("o contexto não vem do nome da ação", async () => {
    await importar("R1", [t("2026000001", 5)]);
    // nome diz uma coisa, contexto diz outra: vale o campo tipado.
    const a = await preparar("boleto em atraso urgente", "WHATSAPP", "PROXIMO_VENCIMENTO");
    expect(a.contexto).toBe("PROXIMO_VENCIMENTO");
  });

  it("canal e contexto são independentes: as 4 combinações valem", async () => {
    await importar("R1", [t("2026000001", 5), t("2026000002", 6), t("2026000003", 7), t("2026000004", 8)]);
    const combos = [
      ["WHATSAPP", "PROXIMO_VENCIMENTO"], ["WHATSAPP", "BOLETO_VENCIDO"],
      ["EMAIL", "PROXIMO_VENCIMENTO"],    ["EMAIL", "BOLETO_VENCIDO"],
    ];
    for (const [canal, ctx] of combos) {
      const a = await preparar(`${canal}-${ctx}`, canal, ctx);
      expect(a.canal).toBe(canal);
      expect(a.contexto).toBe(ctx);
    }
    expect(await um(db, `select count(*)::int from public.prev_acao`)).toBe(4);
  });

  it("a conferência informa o divergente e NÃO bloqueia", async () => {
    // 2 já vencidos e 1 a vencer, rotulados como PROXIMO_VENCIMENTO
    await importar("R1", [t("2026000001", -3), t("2026000002", -5), t("2026000003", 4)]);
    const a = await preparar("Mistura", "WHATSAPP", "PROXIMO_VENCIMENTO");

    expect(a.id).toBeTruthy();                       // preparou mesmo divergindo
    expect(a.conferencia_contexto.contexto).toBe("PROXIMO_VENCIMENTO");
    expect(a.conferencia_contexto.titulos_incluidos).toBe(3);
    expect(a.conferencia_contexto.divergentes).toBe(2);
    expect(a.conferencia_contexto.rotulo_divergencia).toMatch(/JÁ venceram/);
  });

  it("a conferência de BOLETO_VENCIDO conta os que ainda não venceram", async () => {
    await importar("R1", [t("2026000001", -3), t("2026000002", 4), t("2026000003", 6)]);
    const a = await preparar("Vencidos", "WHATSAPP", "BOLETO_VENCIDO");
    expect(a.conferencia_contexto.divergentes).toBe(2);
    expect(a.conferencia_contexto.rotulo_divergencia).toMatch(/AINDA não venceram/);
  });

  it("ação sem divergência nenhuma reporta zero", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6)]);
    const a = await preparar("Limpa", "WHATSAPP", "PROXIMO_VENCIMENTO");
    expect(a.conferencia_contexto.divergentes).toBe(0);
  });

  it("ação antiga sem contexto sobrevive, muda de estado e não ganha conferência", async () => {
    await importar("R1", [t("2026000001", 5)]);
    const antiga = await um(db,
      `select public.preventivo_acao_preparar($1::uuid, 'Antiga', 'WHATSAPP', '{}'::jsonb)`, [carteira]);

    // a máquina de estados continua funcionando para ela
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'EXPORTADA')`, [antiga.id]);
    const depois = await um(db, `select public.preventivo_acao_resumo($1::uuid)`, [antiga.id]);
    expect(depois.estado).toBe("EXPORTADA");
    expect(depois.contexto).toBe(null);
    expect(depois.conferencia_contexto).toBe(null);
  });

  it("o relatório separa os baldes e inclui SEM_CONTEXTO", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6), t("2026000003", -2)]);
    await preparar("A", "WHATSAPP", "PROXIMO_VENCIMENTO");
    await um(db, `select public.preventivo_acao_preparar($1::uuid, 'Antiga', 'EMAIL', '{}'::jsonb)`, [carteira]);

    const r = await um(db, `select public.preventivo_resultados_por_contexto($1::uuid)`, [carteira]);
    expect(Object.keys(r).sort()).toEqual(["PROXIMO_VENCIMENTO", "SEM_CONTEXTO"]);
    expect(r.PROXIMO_VENCIMENTO.acoes).toBe(1);
    expect(r.SEM_CONTEXTO.acoes).toBe(1);
    expect(r.PROXIMO_VENCIMENTO.titulos_acionados).toBeGreaterThan(0);
  });

  it("o relatório NUNCA chama regularização de pagamento ou recuperação", async () => {
    await importar("R1", [t("2026000001", 4)]);
    await preparar("A", "WHATSAPP", "PROXIMO_VENCIMENTO");
    const r = await um(db, `select public.preventivo_resultados_por_contexto($1::uuid)`, [carteira]);
    const texto = JSON.stringify(r).toLowerCase();

    expect(texto).toContain("regularizado");
    expect(texto).not.toMatch(/"pago"|valor_pago|recebido|valor_recuperado|recuperado_/);
    expect(r.PROXIMO_VENCIMENTO.definicao).toMatch(/NÃO é pagamento confirmado/);
    expect(r.PROXIMO_VENCIMENTO.definicao).toMatch(/NÃO é valor recuperado/);
  });

  it("a ação cancelada fica fora do relatório", async () => {
    await importar("R1", [t("2026000001", 4)]);
    const a = await preparar("A", "WHATSAPP", "PROXIMO_VENCIMENTO");
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'CANCELADA')`, [a.id]);
    const r = await um(db, `select public.preventivo_resultados_por_contexto($1::uuid)`, [carteira]);
    expect(r).toEqual({});
  });

  it("as duas portas novas continuam fechadas para quem não é gestão", async () => {
    await importar("R1", [t("2026000001", 4)]);
    await db.exec(`update public._jwt set email = '${OUTRA}'`);
    await expect(preparar("Da outra", "WHATSAPP", "PROXIMO_VENCIMENTO")).rejects.toThrow(/gestão/i);
    await expect(
      um(db, `select public.preventivo_resultados_por_contexto($1::uuid)`, [carteira])
    ).rejects.toThrow(/gestão/i);
    await db.exec(`update public._jwt set email = '${GESTAO}'`);
  });
});
