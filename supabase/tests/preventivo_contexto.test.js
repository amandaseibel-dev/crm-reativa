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

  // A âncora oficial é o ENVIO CONFIRMADO. A máquina de estados é obrigatória:
  // PREPARADA -> EXPORTADA -> ENVIO_CONFIRMADO.
  const confirmarEnvio = async (id) => {
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'EXPORTADA')`, [id]);
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'ENVIO_CONFIRMADO')`, [id]);
    // A régua é ESTRITAMENTE posterior ao envio, de propósito: remessa gerada
    // no mesmo instante da comunicação não pode medi-la. Aqui dentro o banco é
    // rápido o bastante para os dois caírem no mesmo timestamp, então o teste
    // separa os instantes de forma explícita em vez de depender da sorte.
    await db.query(`select pg_sleep(0.02)`);
  };

  const porAcao = (de = null, ate = null) => um(db,
    `select public.preventivo_resultados_por_acao($1::uuid, $2::date, $3::date)`,
    [carteira, de, ate]);

  const relatorio = (de = null, ate = null) => um(db,
    `select public.preventivo_resultados_por_contexto($1::uuid, $2::date, $3::date)`,
    [carteira, de, ate]);

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

    const r = await relatorio();
    expect(Object.keys(r.contextos).sort()).toEqual(["PROXIMO_VENCIMENTO", "SEM_CONTEXTO"]);
    expect(r.contextos.PROXIMO_VENCIMENTO.acoes).toBe(1);
    expect(r.contextos.SEM_CONTEXTO.acoes).toBe(1);
    expect(r.contextos.PROXIMO_VENCIMENTO.titulos_acionados).toBeGreaterThan(0);
  });

  it("separa por contexto E por canal dentro do contexto", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6), t("2026000003", 7), t("2026000004", 8)]);
    await preparar("wpp 1", "WHATSAPP", "BOLETO_VENCIDO");
    await preparar("wpp 2", "WHATSAPP", "BOLETO_VENCIDO");
    await preparar("mail 1", "EMAIL", "BOLETO_VENCIDO");
    await preparar("outro ctx", "WHATSAPP", "PROXIMO_VENCIMENTO");

    const r = await relatorio();
    const bv = r.contextos.BOLETO_VENCIDO;
    expect(bv.acoes).toBe(3);                          // total do contexto
    expect(Object.keys(bv.canais).sort()).toEqual(["EMAIL", "WHATSAPP"]);
    expect(bv.canais.WHATSAPP.acoes).toBe(2);
    expect(bv.canais.EMAIL.acoes).toBe(1);
    // o total do contexto é a soma dos canais
    expect(bv.canais.WHATSAPP.acoes + bv.canais.EMAIL.acoes).toBe(bv.acoes);
    // e o outro contexto não se mistura
    expect(r.contextos.PROXIMO_VENCIMENTO.acoes).toBe(1);
    expect(Object.keys(r.contextos.PROXIMO_VENCIMENTO.canais)).toEqual(["WHATSAPP"]);
  });

  it("o filtro de período corta pela data de criação da ação", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6)]);
    const dentro = await preparar("Dentro", "WHATSAPP", "BOLETO_VENCIDO");
    const fora = await preparar("Fora", "EMAIL", "PROXIMO_VENCIMENTO");
    // empurra uma delas para o passado, direto na tabela
    await db.exec(`update public.prev_acao set criada_em = '2026-09-01 10:00-03'
                    where id = '${fora.id}'`);

    const hoje = await um(db, `select public.preventivo_hoje()::text`);

    const soHoje = await relatorio(hoje, hoje);
    expect(Object.keys(soHoje.contextos)).toEqual(["BOLETO_VENCIDO"]);
    expect(soHoje.periodo).toEqual({ de: hoje, ate: hoje });

    const soSetembro = await relatorio("2026-09-01", "2026-09-30");
    expect(Object.keys(soSetembro.contextos)).toEqual(["PROXIMO_VENCIMENTO"]);

    const tudo = await relatorio();
    expect(Object.keys(tudo.contextos).sort()).toEqual(["BOLETO_VENCIDO", "PROXIMO_VENCIMENTO"]);
    expect(tudo.periodo).toEqual({ de: null, ate: null });
    expect(dentro.id).toBeTruthy();
  });

  it("um dos lados do período pode ficar aberto", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6)]);
    const velha = await preparar("Velha", "WHATSAPP", "BOLETO_VENCIDO");
    await preparar("Nova", "EMAIL", "PROXIMO_VENCIMENTO");
    await db.exec(`update public.prev_acao set criada_em = '2026-09-01 10:00-03' where id = '${velha.id}'`);

    const daquiPraFrente = await relatorio("2026-10-01", null);
    expect(Object.keys(daquiPraFrente.contextos)).toEqual(["PROXIMO_VENCIMENTO"]);

    const ateSetembro = await relatorio(null, "2026-09-30");
    expect(Object.keys(ateSetembro.contextos)).toEqual(["BOLETO_VENCIDO"]);
  });

  it("período invertido é recusado", async () => {
    await expect(relatorio("2026-10-31", "2026-10-01")).rejects.toThrow(/Período inválido/i);
  });

  it("período que não pega nada devolve contextos vazio, não erro", async () => {
    await importar("R1", [t("2026000001", 4)]);
    await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    const r = await relatorio("2020-01-01", "2020-12-31");
    expect(r.contextos).toEqual({});
    expect(r.definicao).toMatch(/NÃO é pagamento confirmado/);
  });

  it("o relatório NUNCA chama regularização de pagamento ou recuperação", async () => {
    await importar("R1", [t("2026000001", 4)]);
    await preparar("A", "WHATSAPP", "PROXIMO_VENCIMENTO");
    const r = await relatorio();
    const texto = JSON.stringify(r).toLowerCase();

    expect(texto).toContain("regularizado");
    expect(texto).not.toMatch(/"pago"|valor_pago|recebido|valor_recuperado|recuperado_/);
    expect(r.definicao).toMatch(/NÃO é pagamento confirmado/);
    expect(r.definicao).toMatch(/NÃO é valor recuperado/);
  });

  it("o resultado por ação individual continua igual ao que já existia", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6)]);
    const a = await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    const r = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a.id]);

    // a forma que a aba Ações já consome, intacta
    for (const k of ["acao", "remessa", "remessa_seguinte", "alunos_acionados",
                     "titulos_acionados", "valor_acionado", "continuam_em_aberto",
                     "regularizados_entre_remessas", "valor_regularizado",
                     "taxa_regularizacao", "aguardando_proxima_remessa", "definicao"]) {
      expect(Object.keys(r)).toContain(k);
    }
    expect(r.acao).toBe(a.id);
    expect(r.aguardando_envio_confirmado).toBe(true);  // envio não confirmado
    expect(r.titulos_acionados).toBe(2);
    expect(r.definicao).toMatch(/NÃO é pagamento confirmado/);
  });

  it("o agregado por contexto é a soma dos resultados por ação", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6), t("2026000003", 7)]);
    const a1 = await preparar("A1", "WHATSAPP", "BOLETO_VENCIDO");
    const a2 = await preparar("A2", "EMAIL", "BOLETO_VENCIDO");

    const r1 = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a1.id]);
    const r2 = await um(db, `select public.preventivo_acao_resultado($1::uuid)`, [a2.id]);
    const r = await relatorio();
    const bv = r.contextos.BOLETO_VENCIDO;

    expect(bv.titulos_acionados).toBe(r1.titulos_acionados + r2.titulos_acionados);
    expect(Number(bv.valor_acionado)).toBe(Number(r1.valor_acionado) + Number(r2.valor_acionado));
    expect(bv.canais.WHATSAPP.titulos_acionados).toBe(r1.titulos_acionados);
    expect(bv.canais.EMAIL.titulos_acionados).toBe(r2.titulos_acionados);
    // sem remessa seguinte, a taxa não é inventada
    expect(bv.taxa_regularizacao).toBe(null);
    expect(bv.aguardando_envio_confirmado).toBe(2);
    expect(bv.aguardando_proxima_remessa).toBe(0);
  });

  it("a lista por ação traz as nove métricas, uma linha por ação", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6), t("2026000003", 7)]);
    const a1 = await preparar("Wpp", "WHATSAPP", "BOLETO_VENCIDO");
    const a2 = await preparar("Mail", "EMAIL", "PROXIMO_VENCIMENTO");

    const lista = await porAcao();
    expect(lista.length).toBe(2);
    expect(lista.map((x) => x.id)).toEqual([a1.id, a2.id]);   // ordem de criação

    for (const l of lista) {
      for (const k of ["alunos_acionados", "alunos_regularizados",
                       "titulos_acionados", "regularizados_entre_remessas",
                       "valor_acionado", "valor_regularizado",
                       "taxa_regularizacao_alunos", "taxa_regularizacao",
                       "taxa_regularizacao_valor"]) {
        expect(Object.keys(l)).toContain(k);
      }
      // identificação da ação vem junto
      expect(l.nome).toBeTruthy();
      expect(["WHATSAPP", "EMAIL"]).toContain(l.canal);
      expect(l.estado).toBe("PREPARADA");
      expect(l.remessa_nome).toBe("R1");
    }
    expect(lista[0].contexto).toBe("BOLETO_VENCIDO");
    expect(lista[1].contexto).toBe("PROXIMO_VENCIMENTO");
  });

  it("sem ENVIO CONFIRMADO não há régua: aguarda envio e nada é estimado", async () => {
    await importar("R1", [t("2026000001", 4)]);
    const a = await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    // uma remessa posterior existe, mas o envio não foi confirmado
    await importar("R2", []);

    const [l] = await porAcao();
    expect(l.aguardando_envio_confirmado).toBe(true);
    expect(l.aguardando_proxima_remessa).toBe(false);   // o que falta é o envio
    expect(l.comparado_a_partir_de).toBe(null);
    expect(l.remessa_seguinte).toBe(null);
    expect(l.alunos_regularizados).toBe(null);
    expect(l.valor_regularizado).toBe(null);
    expect(l.taxa_regularizacao_alunos).toBe(null);
    expect(l.taxa_regularizacao).toBe(null);
    expect(l.taxa_regularizacao_valor).toBe(null);
    expect(a.id).toBeTruthy();
  });

  it("com envio confirmado e sem remessa depois, aguarda a próxima remessa", async () => {
    await importar("R1", [t("2026000001", 4)]);
    const a = await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    await confirmarEnvio(a.id);

    const [l] = await porAcao();
    expect(l.aguardando_envio_confirmado).toBe(false);
    expect(l.aguardando_proxima_remessa).toBe(true);
    expect(l.comparado_a_partir_de).not.toBe(null);
    expect(l.alunos_regularizados).toBe(null);
  });

  it("aluno só é regularizado quando NENHUM título dele volta", async () => {
    // aluno 1: dois títulos, um volta  -> NÃO regularizado
    // aluno 2: dois títulos, nenhum volta -> regularizado
    await importar("R1", [
      { ...t("2026000001", 4, 100), vencimento_origem: "2026-01-05" },
      { ...t("2026000001", 4, 200), vencimento_origem: "2026-02-05" },
      { ...t("2026000002", 5, 300), vencimento_origem: "2026-03-05" },
      { ...t("2026000002", 5, 400), vencimento_origem: "2026-04-05" },
    ]);
    const a = await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    const antes = await porAcao();
    expect(antes[0].alunos_acionados).toBe(2);
    expect(antes[0].titulos_acionados).toBe(2);   // 1 título por aluno no público

    await confirmarEnvio(a.id);
    // a remessa seguinte traz de volta só UM título do aluno 1
    await importar("R2", [{ ...t("2026000001", 4, 100), vencimento_origem: "2026-01-05" }]);

    const [l] = await porAcao();
    expect(l.titulos_acionados).toBe(2);
    expect(l.regularizados_entre_remessas).toBe(1);        // o título do aluno 2
    expect(l.alunos_regularizados).toBe(1);                // só o aluno 2
    expect(l.taxa_regularizacao_alunos).toBe(50.0);
    expect(l.taxa_regularizacao).toBe(50.0);
    expect(Number(l.valor_regularizado)).toBe(300);        // saldo do aluno 2 na remessa
    expect(Number(l.valor_acionado)).toBe(400);            // 100 + 300
    expect(l.taxa_regularizacao_valor).toBe(75.0);
    expect(a.id).toBeTruthy();
  });

  it("compara com a PRÓXIMA remessa válida depois da ação, não com qualquer futura", async () => {
    await importar("R1", [t("2026000001", 4, 100), t("2026000002", 5, 200)]);
    const a = await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    await confirmarEnvio(a.id);

    // R2 é a próxima válida depois do envio: traz o aluno 1 de volta, o 2 não
    await importar("R2", [t("2026000001", 4, 100)]);
    // R3 vem depois e traz os dois de volta — NÃO deve ser a régua
    await importar("R3", [t("2026000001", 4, 100), t("2026000002", 5, 200)]);

    const [l] = await porAcao();
    const r2 = await um(db, `select id from public.prev_lote where nome = 'R2'`);
    expect(l.remessa_seguinte).toBe(r2);
    expect(l.regularizados_entre_remessas).toBe(1);   // pela R2, não pela R3
    expect(l.alunos_regularizados).toBe(1);
    expect(a.id).toBeTruthy();
  });

  it("remessa CANCELADA não serve de régua", async () => {
    await importar("R1", [t("2026000001", 4, 100), t("2026000002", 5, 200)]);
    const aa = await preparar("A", "WHATSAPP", "BOLETO_VENCIDO");
    await confirmarEnvio(aa.id);

    const r2 = await importar("R2 cancelada", [t("2026000001", 4, 100), t("2026000002", 5, 200)]);
    await db.exec(`update public.prev_lote set status = 'CANCELADO' where id = '${r2.lote_id}'`);

    // só a cancelada existe depois da ação: não há régua, e nada é inventado
    const [semRegua] = await porAcao();
    expect(semRegua.aguardando_proxima_remessa).toBe(true);
    expect(semRegua.alunos_regularizados).toBe(null);

    // uma válida depois dela passa a ser a régua
    await importar("R3", [t("2026000001", 4, 100)]);
    const [comRegua] = await porAcao();
    const r3 = await um(db, `select id from public.prev_lote where nome = 'R3'`);
    expect(comRegua.remessa_seguinte).toBe(r3);
    expect(comRegua.alunos_regularizados).toBe(1);
  });

  it("remessa que entrou ANTES do envio confirmado não mede a ação", async () => {
    // R1 -> ação -> R2 -> envio confirmado -> R3.
    // A régua tem de ser a R3: a R2 é anterior ao envio.
    await importar("R1", [t("2026000001", 4, 100)]);
    const r1 = await um(db, `select id from public.prev_lote where nome = 'R1'`);
    const a = await um(db,
      `select public.preventivo_acao_preparar_v2($1::uuid, 'Sobre a R1', 'WHATSAPP',
         jsonb_build_object('lote_id', $2::text), 'BOLETO_VENCIDO')`, [carteira, r1]);
    expect(a.filtros.lote_id).toBe(r1);

    await importar("R2", [t("2026000001", 4, 100)]);   // antes do envio
    await confirmarEnvio(a.id);
    await importar("R3", []);                          // depois do envio

    const [l] = await porAcao();
    const r3 = await um(db, `select id from public.prev_lote where nome = 'R3'`);
    expect(l.remessa).toBe(r1);
    expect(l.remessa_seguinte).toBe(r3);               // não a R2
    expect(new Date(l.comparado_a_partir_de).getTime())
      .toBeGreaterThanOrEqual(new Date(l.criada_em).getTime());
    expect(l.alunos_regularizados).toBe(1);            // sumiu na R3
  });

  it("a lista por ação respeita o período e a ação cancelada aparece com o estado", async () => {
    await importar("R1", [t("2026000001", 4), t("2026000002", 6)]);
    const velha = await preparar("Velha", "WHATSAPP", "BOLETO_VENCIDO");
    const nova = await preparar("Nova", "EMAIL", "PROXIMO_VENCIMENTO");
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'CANCELADA')`, [nova.id]);
    await db.exec(`update public.prev_acao set criada_em = '2026-09-01 10:00-03' where id = '${velha.id}'`);

    const setembro = await porAcao("2026-09-01", "2026-09-30");
    expect(setembro.length).toBe(1);
    expect(setembro[0].nome).toBe("Velha");

    const tudo = await porAcao();
    expect(tudo.length).toBe(2);
    const cancelada = tudo.find((x) => x.nome === "Nova");
    expect(cancelada.estado).toBe("CANCELADA");
    expect(cancelada.cancelada_em).not.toBe(null);
  });

  it("a lista por ação está fechada para quem não é gestão", async () => {
    await importar("R1", [t("2026000001", 4)]);
    await db.exec(`update public._jwt set email = '${OUTRA}'`);
    await expect(porAcao()).rejects.toThrow(/gestão/i);
    await db.exec(`update public._jwt set email = '${GESTAO}'`);
  });

  it("a ação cancelada fica fora do relatório", async () => {
    await importar("R1", [t("2026000001", 4)]);
    const a = await preparar("A", "WHATSAPP", "PROXIMO_VENCIMENTO");
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'CANCELADA')`, [a.id]);
    const r = await relatorio();
    expect(r.contextos).toEqual({});
  });

  it("as duas portas novas continuam fechadas para quem não é gestão", async () => {
    await importar("R1", [t("2026000001", 4)]);
    await db.exec(`update public._jwt set email = '${OUTRA}'`);
    await expect(preparar("Da outra", "WHATSAPP", "PROXIMO_VENCIMENTO")).rejects.toThrow(/gestão/i);
    await expect(relatorio()).rejects.toThrow(/gestão/i);
    await db.exec(`update public._jwt set email = '${GESTAO}'`);
  });
});
