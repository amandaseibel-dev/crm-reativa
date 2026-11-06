// CENTRAL FINANCEIRA -- OS DOIS INDICADORES, SEPARADOS. COMPORTAMENTO.
//
// Roda a migration REAL num PostgreSQL real (PGlite), sobre a bancada minima
// que as duas views precisam. NENHUM DADO REAL.
//
// O QUE ESTE ARQUIVO PROVA, e que a ordem da gestao de 20/10/2026 exige:
//   A) a view separa as duas fontes -- nenhuma coluna mistura conciliacao com
//      baixa oficial, e `BAIXADO` convive com `baixa_oficial_existe = false`;
//   B) BAIXADO sem baixa oficial cai na classe CRITICA;
//   C) baixa oficial com conciliacao divergente cai na classe dela;
//   D) baixa DEVOLVIDA nao conta como baixa viva -- e uma baixa nova depois do
//      estorno volta a contar;
//   E) nenhum caminho da view escreve.
//
// POR QUE AS DATAS SAO RELATIVAS E NAO LITERAIS NO TESTE DO "PARADO HA N DIAS":
// a view compara com `current_date` (e o que a tela precisa). Ancorar o teste
// num literal como '2026-10-13' faria o resultado mudar conforme o dia em que o
// CI roda -- o erro que ja quebrou este CI duas vezes. Entao a ancora e a
// DISTANCIA: `current_date - interval '20 days'` e sempre 20 dias parado, em
// BRT, em UTC e em qualquer dia. Onde a data nao entra na comparacao, o teste
// usa literal fixo de proposito.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20261020183000_central_financeira_dois_indicadores.sql");
const ROLLBACK = ler("supabase/rollbacks/20261020183000_central_financeira_dois_indicadores.rollback.sql");

const INDICADORES = "public.vw_central_financeira_pagamento_indicadores";
const EXCECOES = "public.vw_central_financeira_pagamento_excecoes";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}
async function linhas(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows;
}
// PGlite devolve `count(*)` as vezes como bigint e as vezes como number --
// comparar com 0n quebraria por detalhe do driver, nao por comportamento.
async function conta(db, sql, params = []) {
  return Number(await um(db, sql, params));
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;

    create table public.acordos (id uuid primary key default gen_random_uuid());

    create table public.parcelas (
      id uuid primary key default gen_random_uuid(),
      acordo_id uuid,
      numero int,
      status text default 'A_VENCER',
      valor numeric,
      boleto text,
      origem_baixa text,
      origem_baixa_ref text,
      origem_baixa_em timestamptz);

    create table public.pagamentos (
      id uuid primary key default gen_random_uuid(),
      aluno_id uuid,
      aluno_nome text,
      cpf text,
      data_pagamento date,
      valor_pago numeric,
      titulo_numero text,
      numero_parcela_completo text,
      origem_vinculo text,
      origem_vinculo_ref text,
      origem_vinculo_em timestamptz,
      status_conciliacao text,
      conciliacao_motivo text,
      conciliacao_em timestamptz);

    create table public.baixas_pagamento (
      id uuid primary key default gen_random_uuid(),
      aluno_id text,
      aluno_nome text,
      aluno_cpf text,
      parcela_id uuid references public.parcelas(id),
      acordo_id uuid,
      valor_pago numeric,
      data_pagamento date,
      status_baixa text,
      operador_origem_email text,
      responsavel_baixa_email text,
      baixado_por_email text,
      baixado_por_nome text,
      recebido_em timestamptz,
      atualizado_em timestamptz,
      baixado_em timestamptz,
      devolvido_em timestamptz,
      devolvido_por_email text,
      motivo_devolucao text);
  `);
  await db.exec(MIGRATION);
  return db;
}

// Cria um pagamento e, opcionalmente, a parcela que ele baixou pela referencia
// do gatilho de importacao (a chave forte: parcelas.origem_baixa_ref = pagamentos.id).
async function pagamentoComParcela(db, {
  conciliacao = "BAIXADO", motivo = null, conciliacaoEm = "'2026-03-05 10:00-03'",
  parcelaStatus = "PAGO", origemBaixa = "GATILHO_IMPORTACAO", boleto = null,
  valor = 500, cpf = "00011122233", nome = "Fulano de Teste",
} = {}) {
  const pagamentoId = await um(db, `
    insert into public.pagamentos
      (aluno_id, aluno_nome, cpf, data_pagamento, valor_pago, titulo_numero,
       numero_parcela_completo, origem_vinculo, origem_vinculo_ref,
       status_conciliacao, conciliacao_motivo, conciliacao_em)
    values (gen_random_uuid(), $1, $2, date '2026-03-05', $3, '500001',
            '500001/1', case when $4::text is null then 'SEM_VINCULO' else 'BOLETO_EXATO' end, $4,
            $5, $6, ${conciliacaoEm})
    returning id`, [nome, cpf, valor, boleto, conciliacao, motivo]);

  let parcelaId = null;
  if (parcelaStatus !== null) {
    parcelaId = await um(db, `
      insert into public.parcelas (numero, status, valor, boleto, origem_baixa, origem_baixa_ref, origem_baixa_em)
      values (1, $1, $2, $3, $4, $5, timestamptz '2026-03-06 09:00-03')
      returning id`, [parcelaStatus, valor, boleto, origemBaixa, pagamentoId]);
  }
  return { pagamentoId, parcelaId };
}

async function baixa(db, parcelaId, { devolvidaEm = null, status = "REALIZADA", email = "amanda.seibel@aelbra.com.br", valor = 500 } = {}) {
  return um(db, `
    insert into public.baixas_pagamento
      (aluno_id, aluno_cpf, parcela_id, valor_pago, data_pagamento, status_baixa,
       baixado_por_email, responsavel_baixa_email, recebido_em, baixado_em, devolvido_em, motivo_devolucao)
    values (gen_random_uuid()::text, '00011122233', $1, $2, date '2026-03-05', $3,
            $4, $4, timestamptz '2026-03-06 08:00-03', timestamptz '2026-03-06 10:00-03', $5,
            case when $5::timestamptz is null then null else 'comprovante ilegivel' end)
    returning id`, [parcelaId, valor, status, email, devolvidaEm]);
}

describe("Central Financeira: a view separa conciliacao de baixa oficial", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("A1 -- cria SO views: nenhuma tabela, funcao, gatilho ou sequencia nova", async () => {
    const objetos = await linhas(db, `
      select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'vw_central_financeira%' order by 1`);
    expect(objetos).toEqual([
      { relname: "vw_central_financeira_pagamento_excecoes", relkind: "v" },
      { relname: "vw_central_financeira_pagamento_indicadores", relkind: "v" },
    ]);
    // Nada de gatilho e nada de funcao desta frente.
    expect(await conta(db, `select count(*) from pg_trigger where not tgisinternal`)).toBe(0);
    expect(await conta(db, `
      select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like '%central_financeira%'`)).toBe(0);
  });

  it("A2 -- toda coluna declara UMA fonte: nenhuma mistura conciliacao com baixa", async () => {
    const cols = (await linhas(db, `
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'vw_central_financeira_pagamento_indicadores'`))
      .map((r) => r.column_name);

    // Identidade do pagamento: nao pertence a nenhuma das duas fontes de status.
    const identidade = ["pagamento_id", "aluno_id", "aluno_nome", "cpf", "data_pagamento",
      "valor_pago", "titulo_numero", "numero_parcela_completo"];
    const semFonte = cols.filter((c) => !identidade.includes(c)
      && !c.startsWith("crm_") && !c.startsWith("baixa_") && !c.startsWith("parcela_")
      && !c.startsWith("vinculo_"));
    expect(semFonte).toEqual([]);

    // A regra dura: nao existe coluna-sintese do tipo "esta baixado".
    expect(cols.filter((c) => /^(esta_|ja_|status_final|situacao|baixado$|conciliado$)/.test(c))).toEqual([]);
    expect(cols).toContain("crm_status_conciliacao");
    expect(cols).toContain("baixa_oficial_existe");
    expect(cols).toContain("parcela_status");
  });

  it("A3 -- BAIXADO no CRM e 'sem baixa oficial' convivem na MESMA linha, sem se anular", async () => {
    await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    const l = (await linhas(db, `select * from ${INDICADORES}`))[0];
    expect(l.crm_status_conciliacao).toBe("BAIXADO");
    expect(l.baixa_oficial_existe).toBe(false);   // fonte B, independente
    expect(l.parcela_status).toBe("PAGO");        // fonte C, independente
    expect(l.parcela_origem_baixa).toBe("GATILHO_IMPORTACAO");
    expect(l.baixa_oficial_id).toBeNull();
  });

  it("A4 -- uma linha por pagamento, mesmo com as duas regras de vinculo casando", async () => {
    await pagamentoComParcela(db, { boleto: "50372980004" }); // casa por ref E por boleto
    const l = await linhas(db, `select pagamento_id, vinculo_parcela_confianca, vinculo_parcela_regras_casadas from ${INDICADORES}`);
    expect(l).toHaveLength(1);
    expect(l[0].vinculo_parcela_confianca).toBe("ALTA_REF_E_BOLETO");
    expect(l[0].vinculo_parcela_regras_casadas).toBe(2);
  });

  it("A5 -- sem parcela resolvida: confianca SEM_PARCELA e a chave fraca so CONTA, nao vincula", async () => {
    const { pagamentoId } = await pagamentoComParcela(db, { conciliacao: "AGUARDANDO_ACORDO", parcelaStatus: null });
    // Duas baixas com o mesmo CPF+data+valor: a chave fraca e ambigua.
    const soltaA = await um(db, `insert into public.parcelas (numero, status, valor) values (9, 'PAGO', 500) returning id`);
    const soltaB = await um(db, `insert into public.parcelas (numero, status, valor) values (9, 'PAGO', 500) returning id`);
    await baixa(db, soltaA);
    await baixa(db, soltaB);

    const l = (await linhas(db, `select * from ${INDICADORES} where pagamento_id = $1`, [pagamentoId]))[0];
    expect(l.vinculo_parcela_confianca).toBe("SEM_PARCELA");
    expect(l.parcela_id).toBeNull();
    expect(l.baixa_oficial_existe).toBe(false);          // nao inventa vinculo
    expect(Number(l.baixa_candidata_fraca_qtd)).toBe(2); // mas avisa que ha 2 candidatos
  });

  it("A6 -- regras discordando viram CONFLITO em vez de serem escondidas por coalesce", async () => {
    const pagamentoId = await um(db, `
      insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, origem_vinculo, origem_vinculo_ref, status_conciliacao)
      values (gen_random_uuid(), '00011122233', date '2026-03-05', 500, 'BOLETO_EXATO', '50372980004', 'BAIXADO')
      returning id`);
    await db.query(`insert into public.parcelas (numero, status, valor, origem_baixa, origem_baixa_ref)
                    values (1, 'PAGO', 500, 'GATILHO_IMPORTACAO', $1)`, [pagamentoId]);
    await db.query(`insert into public.parcelas (numero, status, valor, boleto) values (2, 'A_VENCER', 500, '50372980004')`);

    const l = (await linhas(db, `select * from ${INDICADORES}`))[0];
    expect(l.vinculo_parcela_confianca).toBe("CONFLITO_REF_X_BOLETO");
    expect(l.vinculo_parcela_regras_casadas).toBe(2);
  });
});

describe("Central Financeira: as classes de excecao", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("B -- BAIXADO sem baixa oficial cai na classe CRITICA, e o motivo diz por que", async () => {
    const { pagamentoId } = await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    const e = await linhas(db, `select classe, risco, risco_rotulo, classe_motivo from ${EXCECOES} where pagamento_id = $1`, [pagamentoId]);
    expect(e).toHaveLength(1);
    expect(e[0].classe).toBe("BAIXADO_SEM_BAIXA_OFICIAL");
    expect(e[0].risco).toBe(1);
    expect(e[0].risco_rotulo).toBe("CRITICO");
    // Decompor importa: "parcela PAGO por gatilho, falta trilha" nao e o mesmo
    // risco que "a obrigacao nao esta quitada".
    expect(e[0].classe_motivo).toContain("GATILHO_IMPORTACAO");
    expect(e[0].classe_motivo).toContain("falta a trilha");
  });

  it("B2 -- BAIXADO com a obrigacao NAO quitada muda o motivo, nao a classe", async () => {
    const { pagamentoId } = await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "A_VENCER" });
    const e = (await linhas(db, `select classe, classe_motivo from ${EXCECOES} where pagamento_id = $1`, [pagamentoId]))[0];
    expect(e.classe).toBe("BAIXADO_SEM_BAIXA_OFICIAL");
    expect(e.classe_motivo).toContain("nao esta quitada");
  });

  it("B3 -- BAIXADO COM baixa oficial viva nao e excecao nenhuma", async () => {
    const { pagamentoId, parcelaId } = await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    await baixa(db, parcelaId);
    const l = (await linhas(db, `select * from ${INDICADORES} where pagamento_id = $1`, [pagamentoId]))[0];
    expect(l.baixa_oficial_existe).toBe(true);
    expect(l.baixa_oficial_por_email).toBe("amanda.seibel@aelbra.com.br");
    expect(await conta(db, `select count(*) from ${EXCECOES} where pagamento_id = $1`, [pagamentoId])).toBe(0);
  });

  it("C -- baixa oficial viva com conciliacao divergente cai na classe dela", async () => {
    const { pagamentoId, parcelaId } = await pagamentoComParcela(db, {
      conciliacao: "PARCELA_JA_PAGA", motivo: "parcela ja estava paga", parcelaStatus: "PAGO" });
    await baixa(db, parcelaId);

    const e = await linhas(db, `select classe, risco, risco_rotulo from ${EXCECOES} where pagamento_id = $1 order by risco`, [pagamentoId]);
    // Cai nas DUAS classes que a definicao alcanca -- uma linha por classe.
    expect(e.map((x) => x.classe)).toEqual(["PARCELA_JA_PAGA", "BAIXA_OFICIAL_SEM_CONCILIACAO_BAIXADO"]);
    expect(e.map((x) => x.risco_rotulo)).toEqual(["ALTO", "BAIXO"]);
  });

  it("D -- baixa DEVOLVIDA nao e baixa viva; baixa nova depois do estorno volta a contar", async () => {
    const { pagamentoId, parcelaId } = await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    await baixa(db, parcelaId, { devolvidaEm: "2026-03-07 11:00-03", status: "DEVOLVIDA" });

    let l = (await linhas(db, `select * from ${INDICADORES} where pagamento_id = $1`, [pagamentoId]))[0];
    expect(l.baixa_oficial_existe).toBe(false);          // devolvida NAO conta
    expect(Number(l.baixa_devolvida_qtd)).toBe(1);
    expect(l.baixa_devolvida_motivo).toBe("comprovante ilegivel");

    let classes = (await linhas(db, `select classe from ${EXCECOES} where pagamento_id = $1 order by risco`, [pagamentoId]))
      .map((x) => x.classe);
    expect(classes).toEqual(["BAIXADO_SEM_BAIXA_OFICIAL", "BAIXA_DEVOLVIDA_SEM_NOVA"]);

    // Agora a gestao refaz a baixa. A devolvida continua registrada, mas a
    // parcela volta a ter baixa viva -- e sai das duas classes.
    await baixa(db, parcelaId);
    l = (await linhas(db, `select * from ${INDICADORES} where pagamento_id = $1`, [pagamentoId]))[0];
    expect(l.baixa_oficial_existe).toBe(true);
    expect(Number(l.baixa_devolvida_qtd)).toBe(1);       // o historico nao e apagado
    expect(await conta(db, `select count(*) from ${EXCECOES} where pagamento_id = $1`, [pagamentoId])).toBe(0);
  });

  it("D2 -- status_baixa REALIZADA com devolvido_em preenchido NAO conta como viva", async () => {
    // Existem 5 linhas assim em producao (20/10/2026). A regra viva e
    // devolvido_em, nunca o status_baixa.
    const { pagamentoId, parcelaId } = await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    await baixa(db, parcelaId, { devolvidaEm: "2026-03-07 11:00-03", status: "REALIZADA" });
    const l = (await linhas(db, `select * from ${INDICADORES} where pagamento_id = $1`, [pagamentoId]))[0];
    expect(l.baixa_oficial_existe).toBe(false);
    expect(Number(l.baixa_devolvida_qtd)).toBe(1);
  });

  it("E -- AGUARDANDO_ACORDO: entra acima de 7 dias parado, nao entra abaixo", async () => {
    // Ancora pela DISTANCIA, nunca pelo dia do calendario (ver cabecalho).
    const parado = await um(db, `
      insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, origem_vinculo, status_conciliacao, conciliacao_em)
      values (gen_random_uuid(), '00011122233', date '2026-03-05', 700, 'SEM_VINCULO', 'AGUARDANDO_ACORDO',
              current_date - interval '20 days') returning id`);
    const recente = await um(db, `
      insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, origem_vinculo, status_conciliacao, conciliacao_em)
      values (gen_random_uuid(), '00011122233', date '2026-03-05', 800, 'SEM_VINCULO', 'AGUARDANDO_ACORDO',
              current_date - interval '2 days') returning id`);

    expect(await um(db, `select classe from ${EXCECOES} where pagamento_id = $1`, [parado]))
      .toBe("AGUARDANDO_ACORDO_PARADO");
    expect(await conta(db, `select count(*) from ${EXCECOES} where pagamento_id = $1`, [recente])).toBe(0);
    expect(Number(await um(db, `select crm_dias_parado from ${INDICADORES} where pagamento_id = $1`, [parado]))).toBe(20);
  });

  it("E2 -- NAO existe classe de parcela/acordo CANCELADO (e da PR #694, bloqueada)", async () => {
    const { pagamentoId } = await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "CANCELADA" });
    const classes = (await linhas(db, `select distinct classe from ${EXCECOES}`)).map((x) => x.classe);
    expect(classes.some((c) => /CANCELAD/i.test(c))).toBe(false);
    // Ele segue na classe CRITICA porque atende a DEFINICAO dela -- o que esta
    // fora de escopo e a fila por cancelamento, nao este pagamento.
    expect(await um(db, `select classe from ${EXCECOES} where pagamento_id = $1`, [pagamentoId]))
      .toBe("BAIXADO_SEM_BAIXA_OFICIAL");
  });

  it("E3 -- as cinco classes, e so elas, com a ordem de risco declarada", async () => {
    const texto = MIGRATION.replace(/--[^\n]*/g, "");
    const declaradas = [...texto.matchAll(/'([A-Z_]{8,})'\s+AS\s+classe|,\s*\d,\s*'(?:CRITICO|ALTO|MEDIO|BAIXO)',\s*\n?\s*'([A-Z_]{8,})'/g)]
      .map((m) => m[1] || m[2]);
    expect(new Set(declaradas)).toEqual(new Set([
      "BAIXADO_SEM_BAIXA_OFICIAL", "BAIXA_DEVOLVIDA_SEM_NOVA", "PARCELA_JA_PAGA",
      "AGUARDANDO_ACORDO_PARADO", "BAIXA_OFICIAL_SEM_CONCILIACAO_BAIXADO",
    ]));
  });
});

describe("Central Financeira: nenhum caminho escreve", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("F1 -- a migration nao tem nenhuma escrita de dado nem baixa automatica", async () => {
    // Tira comentarios e literais antes de procurar: o cabecalho FALA de insert
    // e de baixa automatica de proposito, e isso nao pode reprovar o arquivo.
    const codigo = MIGRATION
      .replace(/--[^\n]*/g, " ")
      .replace(/'(?:[^']|'')*'/g, " '' ");
    expect(codigo).not.toMatch(/\b(insert\s+into|update\s+|delete\s+from|truncate|merge\s+into)\b/i);
    expect(codigo).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(function|procedure|trigger)\b/i);
    expect(codigo).not.toMatch(/\bsecurity\s+definer\b/i);
    // Permissao concedida: SELECT, e so.
    const grants = [...codigo.matchAll(/grant\s+([a-z, ]+?)\s+on\b/gi)].map((m) => m[1].trim().toLowerCase());
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g === "select")).toBe(true);
  });

  it("F2 -- as views nao sao atualizaveis: insert e update nelas falham", async () => {
    await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    await expect(db.query(`update ${INDICADORES} set valor_pago = 1`)).rejects.toThrow();
    await expect(db.query(`update ${EXCECOES} set risco = 9`)).rejects.toThrow();
    await expect(db.query(`insert into ${INDICADORES} (valor_pago) values (1)`)).rejects.toThrow();
    // E o dado de origem segue intacto.
    expect(Number(await um(db, `select valor_pago from public.pagamentos`))).toBe(500);
  });

  it("F3 -- authenticated recebe SELECT e nada mais nas duas views", async () => {
    const g = await linhas(db, `
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'authenticated'
         and table_name like 'vw_central_financeira%' order by 1, 2`);
    expect(g).toEqual([
      { table_name: "vw_central_financeira_pagamento_excecoes", privilege_type: "SELECT" },
      { table_name: "vw_central_financeira_pagamento_indicadores", privilege_type: "SELECT" },
    ]);
  });

  it("F4 -- as views respeitam a RLS de quem consulta (security_invoker)", async () => {
    const op = await linhas(db, `
      select c.relname, c.reloptions::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'vw_central_financeira%' order by 1`);
    expect(op.every((r) => /security_invoker=(true|on)/.test(r.reloptions || ""))).toBe(true);
  });

  it("F5 -- o rollback derruba as duas views e nao toca em dado", async () => {
    await pagamentoComParcela(db, { conciliacao: "BAIXADO", parcelaStatus: "PAGO" });
    await db.exec(ROLLBACK);
    expect(await conta(db, `
      select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'vw_central_financeira%'`)).toBe(0);
    expect(await conta(db, `select count(*) from public.pagamentos`)).toBe(1);
    expect(await conta(db, `select count(*) from public.parcelas`)).toBe(1);
    // E a migration volta a aplicar em cima do rollback (idempotente).
    await db.exec(MIGRATION);
    expect(await conta(db, `select count(*) from ${INDICADORES}`)).toBe(1);
  });
});
