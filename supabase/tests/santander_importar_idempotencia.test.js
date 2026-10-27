// SANTANDER · ENTREGA B — IDEMPOTÊNCIA DA IMPORTAÇÃO, EM PostgreSQL REAL (PGlite)
//
// Sobre o corpo VIVO de produção de `projecao_importar_pagamentos` (22/10/2026),
// conferido por md5(prosrc) contra
// fixtures/projecao_importar_prod_20261022.md5.json. Se produção mudar, o teste
// quebra -- é para quebrar.
//
// A PERGUNTA. A Entrega B passa a ler a planilha no servidor, e a mesma
// confirmação pode ser repetida (rede caindo, duplo clique, reenvio da mesma
// remessa). Repetir não pode criar pagamento em dobro, porque pagamento em
// dobro vira baixa em dobro.
//
// A RESPOSTA TEM TRÊS CAMADAS, e os testes abaixo separam uma da outra:
//   1. no NOME: mesma competência + mesmo nome de arquivo já concluído -> a
//      função RECUSA com IMPORTACAO_DUPLICADA. É a trava que a tela usa hoje
//      para oferecer substituição.
//   2. na CHAVE DA PARCELA: se a trava do nome for contornada -- e basta
//      renomear o arquivo para contorná-la --, cada linha ainda é confrontada
//      com o que já existe por (numero_parcela_completo, valor). O mesmo
//      conteúdo sob outro nome grava ZERO. É esta camada que protege o dinheiro,
//      e é ela que o requisito manda conferir.
//   3. DENTRO do mesmo arquivo: linha repetida colapsa antes de inserir.
//
// POR QUE `titulo_numero` NÃO SERVE como chave, provado aqui: duas parcelas do
// MESMO título são pagamentos distintos e precisam entrar as duas.
//
// NÃO COBRE, de propósito: o motor de conciliação. Esta bancada não tem os
// gatilhos de `pagamentos`, então nada aqui afirma efeito sobre baixa,
// conciliação ou projeção. Ver o cabeçalho da fixture.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { impressaoDigital, normalizarPlanilha } from "../functions/santander-previa/planilha.ts";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, p), "utf8");
const BANCADA = ler("fixtures/projecao_importar_prod_20261022.sql");
const MD5 = JSON.parse(ler("fixtures/projecao_importar_prod_20261022.md5.json"));

// Cada teste sobe um PostgreSQL inteiro; com a suíte toda em paralelo, 5 s não
// bastam.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const GESTAO = "amanda.seibel@aelbra.com.br";
const FORA = "cobranca99@aelbra.com.br";

async function novoBanco(email = GESTAO) {
  const db = new PGlite();
  await db.exec(BANCADA);

  // Fidelidade antes de qualquer asserção: se o corpo não for o de produção, o
  // resto do arquivo não prova nada sobre produção.
  const { rows } = await db.query(
    `select 'public.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='projecao_importar_pagamentos'`
  );
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5)) {
    if (noBanco[nome] !== md5) {
      throw new Error(`fixture diverge de producao em ${nome}: ${noBanco[nome]} != ${md5}`);
    }
  }

  await db.exec(`set request.jwt.claim.email = '${email}'`);
  return db;
}

// Linhas no formato do extrato, como o parser do servidor as recebe.
const linhaBruta = ({ matricula, nome, titulo, parcela, operador = "MARIA.SILVA", valor, data = "01/10/2026" }) =>
  ["ULBRA", `${matricula} - ${nome}`, titulo, operador, parcela, "0272047", "10/09/2026", valor, valor * 0.1, data, valor];

const ARQUIVO = [
  linhaBruta({ matricula: "2026002333", nome: "ALUNO UM", titulo: "50640", parcela: "50640510001", valor: 500 }),
  linhaBruta({ matricula: "2026002334", nome: "ALUNO DOIS", titulo: "50641", parcela: "50641510001", valor: 300 }),
];

async function importar(db, linhas, { arquivo = "extrato.xls", mes = "2026-10", retroativo = false, substituir = null, motivo = null } = {}) {
  const r = await db.query(
    `select * from public.projecao_importar_pagamentos(
       p_arquivo_nome => $1, p_usuario => $2, p_linhas => $3::jsonb,
       p_mes_referencia => $4, p_retroativo => $5,
       p_substituir_importacao_id => $6::uuid, p_motivo_substituicao => $7)`,
    [arquivo, GESTAO, JSON.stringify(normalizarPlanilha(linhas)), mes, retroativo, substituir, motivo]
  );
  return r.rows[0];
}

const contaPagamentos = async (db) =>
  Number((await db.query(`select count(*) n from public.pagamentos`)).rows[0].n);
const somaPaga = async (db) =>
  Number((await db.query(`select coalesce(sum(valor_pago),0) s from public.pagamentos`)).rows[0].s);
const parcelas = async (db) =>
  (await db.query(`select numero_parcela_completo p, valor_pago v, data_pagamento d
                     from public.pagamentos order by numero_parcela_completo, valor_pago`)).rows;

describe("importacao da projecao: idempotencia pela chave da parcela", () => {
  it("o corpo da funcao e o de producao (md5 do prosrc)", async () => {
    const db = await novoBanco();
    const { rows } = await db.query(
      `select md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='projecao_importar_pagamentos'`
    );
    expect(rows[0].md5).toBe(MD5["public.projecao_importar_pagamentos"]);
    await db.close();
  });

  it("primeira importacao grava as duas linhas", async () => {
    const db = await novoBanco();
    const r = await importar(db, ARQUIVO);
    expect(r.linhas_gravadas).toBe(2);
    expect(await contaPagamentos(db)).toBe(2);
    expect(await somaPaga(db)).toBe(800);
    await db.close();
  });

  // CAMADA 1 -- a trava do nome.
  it("repetir o MESMO arquivo com o MESMO nome e recusado", async () => {
    const db = await novoBanco();
    await importar(db, ARQUIVO);
    await expect(importar(db, ARQUIVO)).rejects.toThrow(/IMPORTACAO_DUPLICADA/);
    expect(await contaPagamentos(db)).toBe(2);
    await db.close();
  });

  // CAMADA 2 -- a que protege o dinheiro. Renomear contorna a camada 1 de
  // propósito, para deixar a chave da parcela sozinha em cena.
  it("mesmo conteudo com OUTRO nome de arquivo grava ZERO", async () => {
    const db = await novoBanco();
    await importar(db, ARQUIVO, { arquivo: "extrato.xls" });
    const antes = await parcelas(db);

    const r = await importar(db, ARQUIVO, { arquivo: "extrato-copia.xls" });
    expect(r.linhas_gravadas).toBe(0);
    expect(await contaPagamentos(db)).toBe(2);
    expect(await somaPaga(db)).toBe(800);
    // E nada mudou de lugar: as mesmas parcelas, nos mesmos valores e datas.
    expect(await parcelas(db)).toEqual(antes);
    await db.close();
  });

  it("repetir dez vezes sob nomes diferentes continua em duas linhas", async () => {
    const db = await novoBanco();
    await importar(db, ARQUIVO, { arquivo: "extrato.xls" });
    for (let i = 0; i < 10; i++) {
      const r = await importar(db, ARQUIVO, { arquivo: `copia-${i}.xls` });
      expect(r.linhas_gravadas).toBe(0);
    }
    expect(await contaPagamentos(db)).toBe(2);
    expect(await somaPaga(db)).toBe(800);
    await db.close();
  });

  // A chave é a PARCELA, e ela ignora a data: o mesmo boleto pago, relatado em
  // outro dia, não é um segundo pagamento.
  it("mesma parcela e mesmo valor em OUTRA data nao entra de novo", async () => {
    const db = await novoBanco();
    await importar(db, ARQUIVO, { arquivo: "dia1.xls" });
    const outroDia = ARQUIVO.map((l) => { const c = [...l]; c[9] = "02/10/2026"; return c; });
    const r = await importar(db, outroDia, { arquivo: "dia2.xls" });
    expect(r.linhas_gravadas).toBe(0);
    expect(await contaPagamentos(db)).toBe(2);
    await db.close();
  });

  // O outro lado da moeda: valor diferente na mesma parcela é complemento ou
  // juros, e TEM de entrar -- idempotência não pode virar perda de dinheiro.
  it("mesma parcela com valor DIFERENTE entra como linha nova", async () => {
    const db = await novoBanco();
    await importar(db, ARQUIVO, { arquivo: "dia1.xls" });
    const comJuros = [linhaBruta({ matricula: "2026002333", nome: "ALUNO UM", titulo: "50640", parcela: "50640510001", valor: 12.35 })];
    const r = await importar(db, comJuros, { arquivo: "juros.xls" });
    expect(r.linhas_gravadas).toBe(1);
    expect(await contaPagamentos(db)).toBe(3);
    expect(await somaPaga(db)).toBeCloseTo(812.35, 2);
    await db.close();
  });

  // Prova de que a chave NÃO pode ser `titulo_numero`: duas parcelas do mesmo
  // título são dois pagamentos. Se alguém "simplificar" a dedup para o título,
  // este teste cai.
  it("duas PARCELAS do mesmo titulo entram as duas", async () => {
    const db = await novoBanco();
    const duas = [
      linhaBruta({ matricula: "2026002333", nome: "ALUNO UM", titulo: "50640", parcela: "50640510001", valor: 250 }),
      linhaBruta({ matricula: "2026002333", nome: "ALUNO UM", titulo: "50640", parcela: "50640510002", valor: 250 }),
    ];
    const r = await importar(db, duas);
    expect(r.linhas_gravadas).toBe(2);
    const p = await parcelas(db);
    expect(p.map((x) => x.p)).toEqual(["50640510001", "50640510002"]);
    await db.close();
  });

  // CAMADA 3 -- dentro do próprio arquivo.
  it("linha repetida DENTRO do arquivo colapsa em uma", async () => {
    const db = await novoBanco();
    const comRepetida = [ARQUIVO[0], ARQUIVO[1], ARQUIVO[0]];
    const r = await importar(db, comRepetida);
    expect(r.linhas_gravadas).toBe(2);
    expect(await contaPagamentos(db)).toBe(2);
    expect(await somaPaga(db)).toBe(800);
    await db.close();
  });

  it("substituicao reescreve a importacao anterior sem somar pagamento", async () => {
    const db = await novoBanco();
    const primeira = await importar(db, ARQUIVO, { arquivo: "extrato.xls" });
    const r = await importar(db, ARQUIVO, {
      arquivo: "extrato.xls", substituir: primeira.importacao_id, motivo: "reenvio",
    });
    expect(r.linhas_gravadas).toBe(2);
    expect(await contaPagamentos(db)).toBe(2);
    expect(await somaPaga(db)).toBe(800);
    const { rows } = await db.query(`select status from public.importacoes where id = $1`, [primeira.importacao_id]);
    expect(rows[0].status).toBe("SUBSTITUIDA");
    await db.close();
  });
});

describe("a allowlist da RPC: por que o JWT da pessoa e obrigatorio", () => {
  // ACHADO 22/10/2026 -- A ALLOWLIST NAO BARRA TOKEN SEM E-MAIL.
  //
  // Eu esperava recusa aqui, e e o contrario: `auth.email()` devolve NULL sem
  // claim de e-mail (conferido na definicao viva de `auth.email()`), entao
  // `v_email` e NULL e `NULL NOT IN (...)` avalia para NULL -- que nao e TRUE.
  // O IF nao dispara e a funcao IMPORTA, gravando autoria nula.
  //
  // Alcance: `anon` nao tem EXECUTE, mas `authenticated` e `service_role` tem.
  // Ou seja, chave de servico importa sem passar pela allowlist.
  //
  // O teste fixa o comportamento REAL de propósito, para nao afirmar uma
  // protecao que nao existe. Quando producao for corrigida -- a correcao e
  // `IF v_email IS NULL OR v_email NOT IN (...)` -- este teste quebra, e e
  // assim que se descobre que ja pode passar a exigir recusa.
  //
  // Nada disso e corrigido nesta entrega: corrigir e migration, e migration
  // precisa de autorizacao propria. O que esta entrega faz e nao depender
  // dessa camada: a funcao que grava repassa o JWT da pessoa e recusa token de
  // rotina.
  it("ACHADO: sem e-mail no token a allowlist NAO barra, e grava com autoria nula", async () => {
    const db = new PGlite();
    await db.exec(BANCADA);
    const r = await importar(db, ARQUIVO);
    expect(r.linhas_gravadas).toBe(2);
    const { rows } = await db.query(`select usuario from public.auditoria where acao='IMPORTOU'`);
    expect(rows[0].usuario).toBeNull();
    await db.close();
  });

  // A correcao proposta, exercida sobre a MESMA bancada: com o IS NULL, o
  // mesmo caso passa a ser recusado. Serve para mostrar que a correcao e de
  // uma linha e que ela resolve, sem aplicar nada em producao.
  it("com a correcao de uma linha (IS NULL), o mesmo caso passa a ser recusado", async () => {
    const db = new PGlite();
    await db.exec(BANCADA);
    await db.exec(`
      create or replace function public.projecao_importar_pagamentos_corrigida(
        p_linhas jsonb) returns void language plpgsql security definer as $f$
      declare v_email text := lower(auth.email());
      begin
        if v_email is null or v_email not in ('amanda.seibel@aelbra.com.br',
             'cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then
          raise exception 'Sem permissão para importar a planilha de pagamentos.';
        end if;
      end $f$;`);
    await expect(
      db.query(`select public.projecao_importar_pagamentos_corrigida('[]'::jsonb)`)
    ).rejects.toThrow(/Sem permiss/);
    await db.close();
  });

  it("e-mail fora da allowlist e RECUSADO e nao grava nada", async () => {
    const db = await novoBanco(FORA);
    await expect(importar(db, ARQUIVO)).rejects.toThrow(/Sem permiss/);
    expect(await contaPagamentos(db)).toBe(0);
    const { rows } = await db.query(`select count(*) n from public.importacoes`);
    expect(Number(rows[0].n)).toBe(0);
    await db.close();
  });

  it("a autoria registrada e a do token, nao a do argumento p_usuario", async () => {
    const db = await novoBanco();
    await importar(db, ARQUIVO);
    const { rows } = await db.query(`select usuario, acao from public.auditoria where acao='IMPORTOU'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].usuario).toBe(GESTAO);
    await db.close();
  });
});

describe("a digital amarra a previa na confirmacao", () => {
  // Fecha o circuito da entrega: o que a digital protege é exatamente o
  // conteúdo que vai para `p_linhas`.
  it("a digital da previa e a mesma do conteudo importado", async () => {
    const digitalPrevia = await impressaoDigital(normalizarPlanilha(ARQUIVO));
    const digitalConfirmacao = await impressaoDigital(normalizarPlanilha(ARQUIVO));
    expect(digitalConfirmacao).toBe(digitalPrevia);
  });

  it("arquivo trocado produz digital diferente -- e a confirmacao recusaria", async () => {
    const outro = [...ARQUIVO, linhaBruta({ matricula: "2026002335", nome: "ALUNO TRES", titulo: "50642", parcela: "50642510001", valor: 100 })];
    expect(await impressaoDigital(normalizarPlanilha(outro)))
      .not.toBe(await impressaoDigital(normalizarPlanilha(ARQUIVO)));
  });
});
