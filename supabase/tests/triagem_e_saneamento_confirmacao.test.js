// TRIAGEM POR EVIDENCIA DOS PENDENTE `C_SEM_PROVA`, E O SANEAMENTO QUE ELA AUTORIZA.
//
// Roda o arquivo REAL de
// `supabase/aguardando_aprovacao/20261009_TRIAGEM_E_SANEAMENTO_confirmacao.sql.pendente`
// contra a fixture de producao (PGlite), nos modos previa e aplicar.
//
// Regra 4 da gestao (09/10/2026): "separando pagamentos comprovados de entradas
// indevidas. Nao devolva titulos a cobranca sem validar as evidencias."
//
// O cenario reproduz, em miniatura, o que a medicao de producao achou:
//   t1  pagamento BAIXADO que cobre o titulo              -> classe 1, PROMOVIDO
//   t2a+t2b  UM pagamento reivindicado por DOIS titulos,
//            que nao cobre a soma                         -> classe 3, FICAM
//   t3  acordo ATIVO candidato, sem composicao            -> classe 3, FICA
//   t4  nada: sem pagamento, sem acordo                   -> classe 4, devolvivel
//   t5  igual ao t4, mas ANTES da janela de 08/10          -> fora do recorte
//
// O caso t2a/t2b e a correcao que a triagem acrescenta a funcao oficial de
// evidencias: `pagamento_cobre_o_titulo` e por titulo, e em producao um
// pagamento de base R$ 950,16 aparecia como prova dos quatro titulos 761248 a
// 761251 (R$ 2.388,27 somados).
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 90000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/grupo_a_prod_20260918.sql");
const GRUPO_A = ler("supabase/migrations/20260918150000_grupo_a_confirmacao_prime.sql");
const REGRA = ler("supabase/migrations/20260918230000_prime_liquidacao_regra_entrada.sql");
const MIGRATION = ler("supabase/migrations/20261009180000_confirmacao_exige_pagamento_comprovado.sql");
const TRIAGEM = ler("supabase/aguardando_aprovacao/20261009_TRIAGEM_E_SANEAMENTO_confirmacao.sql.pendente");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const VENC = "2025-11-10";
const IMPORTADO = "2026-01-10";
const LIQ = "2026-03-05";
const COLETA = "2026-03-10 12:00:00+00";

// Dentro da janela do saneamento (>= 08/10 03:00 UTC) e fora dela.
const DENTRO = "2026-10-08 10:00:00+00";
const FORA = "2026-10-01 10:00:00+00";

let BASE;

async function montar() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo) values
      ('Luana', '${OP1}', 'operador', true), ('Amanda', '${GESTAO}', 'gestao', true);
  `);
  await db.exec(GRUPO_A);
  await db.exec(REGRA);
  // A MIGRATION entra DEPOIS, dentro do cenario: os PENDENTE tem de nascer pela
  // regra de 18/09, que e o que produziu os 301 em producao.
  return db;
}

beforeAll(async () => {
  const db = await montar();
  BASE = await db.dumpDataDir("none");
  await db.close();
}, 180000);

const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: { unaccent } });
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

async function novoAluno(db, n) {
  const id = U(n);
  const cpf = String(10000000000 + n);
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, status_atual, status_jornada, responsavel_atual_email)
     values ($1, $2, $3, $4, 'MENSAGEM_ENVIADA', 'MENSAGEM_ENVIADA', $5)`,
    [id, `Aluno ${n}`, cpf, `M${n}`, OP1]
  );
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, matricula, operador_email, operador_nome,
                               status_atual, total_em_aberto)
     values ($1, $2, $3, $3, $4, $5, $6, 'OP', 'Mensagem enviada', 1000)`,
    [U(100000 + n), id, cpf, `Aluno ${n}`, `M${n}`, OP1]
  );
  return { id, cpf, matricula: `M${n}` };
}

async function titulo(db, al, doc, valor) {
  return (await q1(db,
    `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
                                         situacao, status, tipo_boleto, created_at)
     values ($1, $2, $3, $4, $5, $5, 'ABERTO', 'em_aberto', 'Mensalidade', $6) returning id`,
    [al.id, al.cpf, doc, VENC, valor, IMPORTADO])).id;
}

async function extrato(db, al, doc, valor) {
  await db.query(
    `insert into public.prime_extrato (matricula, boleto, cpf, vencimento, liquidado_em, portador,
                                       valor_bruto, valor_pago, coletado_em)
     values ($1, $2, $3, $4, $5, 195, $6, $7, $8)`,
    [al.matricula, doc, al.cpf, VENC, LIQ, valor, valor * 3, COLETA]
  );
}

async function pagamento(db, al, valor, status = "BAIXADO") {
  return (await q1(db,
    `insert into public.pagamentos (aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao)
     values ($1, $2, $3, $4, $5) returning id`,
    [al.id, al.cpf, LIQ, valor, status])).id;
}

async function acordoSimples(db, al, o = {}) {
  const r = await q1(db,
    `insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, criado_em, forma_pagamento)
     values ($1, $2, $3, 1, $4, $5, 'AVISTA') returning id, numero_acordo`,
    [al.id, al.cpf, o.valor ?? 1000, o.status ?? "ATIVO", o.criado ?? "2026-03-06"]);
  await db.query(
    `insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, titulos_origem)
     values ($1, 1, $2, '2027-01-10', 'A_VENCER', $3, $4)`,
    [r.id, o.valor ?? 1000, `5${String(r.numero_acordo).padStart(6, "0")}0001`, o.origem ?? null]);
  return r;
}

const tit = (db, id) => q1(db, `select * from public.acordos_titulos where id = $1`, [id]);
const decisao = (db, id) => q1(db, `select * from public.prime_conferencia_decisao where titulo_id = $1`, [id]);
const foto = (db) =>
  q1(db, `select (select count(*)::int from public.pagamentos) pag,
                 (select count(*)::int from public.parcelas) parc,
                 (select count(*)::int from public.acordos) ac,
                 (select count(*)::int from public.acordo_titulo_vinculo) vinc,
                 (select count(*)::int from public.baixas_pagamento) baixas,
                 (select count(*)::int from public.solicitacoes_confirmacao_pagamento) sol,
                 (select count(*)::int from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') em_conf,
                 (select count(*)::int from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') pagos,
                 (select count(*)::int from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes`);

// O cenario: nasce pela regra de 18/09, e so depois a migration de 09/10 entra.
async function cenario(db) {
  // t1 -- pagamento BAIXADO que cobre: base 1080/1.08 = 1000 >= 0,95 * 1000
  const a1 = await novoAluno(db, 1);
  const t1 = await titulo(db, a1, "910001", 1000);
  await extrato(db, a1, "910001", 1000);
  await pagamento(db, a1, 1080);

  // t2a + t2b -- UM pagamento (base 1000) reivindicado por dois titulos de
  // 1000 cada: cobre cada um isoladamente, nao cobre a soma de 2000.
  const a2 = await novoAluno(db, 2);
  const t2a = await titulo(db, a2, "920001", 1000);
  const t2b = await titulo(db, a2, "920002", 1000);
  await extrato(db, a2, "920001", 1000);
  await extrato(db, a2, "920002", 1000);
  await pagamento(db, a2, 1080);

  // t3 -- acordo ATIVO candidato (sem composicao: titulos_origem null)
  const a3 = await novoAluno(db, 3);
  const t3 = await titulo(db, a3, "930001", 500);
  await extrato(db, a3, "930001", 500);
  await acordoSimples(db, a3, { valor: 500 });

  // t4 -- nada
  const a4 = await novoAluno(db, 4);
  const t4 = await titulo(db, a4, "940001", 700);
  await extrato(db, a4, "940001", 700);

  // t5 -- igual ao t4, mas vai ficar fora da janela
  const a5 = await novoAluno(db, 5);
  const t5 = await titulo(db, a5, "950001", 300);
  await extrato(db, a5, "950001", 300);

  // a rotina de 18/09 suspende todos
  const claims = JSON.stringify({ email: GESTAO, sub: U(900001), role: "authenticated" });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
  await db.query(`select public.prime_liquidacao_classificar_novas(500, true)`);

  // a janela: todos dentro, menos o t5
  await db.query(`update public.prime_conferencia_decisao set detectado_em = $1`, [DENTRO]);
  await db.query(`update public.prime_conferencia_decisao set detectado_em = $1 where titulo_id = $2`, [FORA, t5]);

  const c = { t1, t2a, t2b, t3, t4, t5, a1, a2, a3, a4, a5 };
  for (const [nome, id] of Object.entries({ t1, t2a, t2b, t3, t4, t5 })) {
    const d = await decisao(db, id);
    if (!d) throw new Error(`cenario: ${nome} nao entrou na fila`);
    if (d.subgrupo !== "C_SEM_PROVA") throw new Error(`cenario: ${nome} entrou como ${d.subgrupo}`);
  }

  await db.exec(MIGRATION);
  return c;
}

// Travas no tamanho do cenario: 1 a promover (t1) e 1 a devolver (t4) na janela.
async function travas(db, o = {}) {
  await db.query(`select set_config('saneamento.esperado_promover', $1, false)`, [String(o.promover ?? 1)]);
  await db.query(`select set_config('saneamento.esperado_devolver', $1, false)`, [String(o.devolver ?? 0)]);
  if (o.devolverOn) await db.query(`select set_config('saneamento.devolver','on',false)`);
  if (o.promoverOff) await db.query(`select set_config('saneamento.promover','off',false)`);
  if (o.janelaToda) await db.query(`select set_config('saneamento.janela_toda','on',false)`);
}

const aplicar = async (db) => {
  await db.query(`select set_config('saneamento.aplicar','on',false)`);
  await db.exec(TRIAGEM);
};

// Depois de uma excecao dentro do `begin` do script, a sessao fica em transacao
// abortada; encerrar e parte do cenario -- e e o que desfaz a escrita.
const desfazer = async (db) => { try { await db.exec("rollback"); } catch { /* nada aberto */ } };

describe("a triagem classifica por evidencia", () => {
  it("1 pagamento comprovado, 3 a validar (inclusive o pagamento compartilhado), 1 sem evidencia na janela", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db);
    await aplicar(db);

    // t1 promovido: tem pagamento que cobre
    expect(await decisao(db, c.t1)).toMatchObject({ subgrupo: "A_PAGAMENTO_COMPROVADO", decisao: "PENDENTE" });
    // t2a/t2b NAO promovidos: o pagamento nao cobre a soma dos dois
    for (const t of [c.t2a, c.t2b]) {
      expect((await decisao(db, t)).subgrupo).toBe("C_SEM_PROVA");
      expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    }
    // t3 (acordo candidato) e t4 (sem evidencia) seguem como estavam: a acao de
    // devolver esta desligada por default
    expect((await decisao(db, c.t3)).subgrupo).toBe("C_SEM_PROVA");
    expect((await tit(db, c.t4)).situacao).toBe("EM_CONFIRMACAO");
    expect((await decisao(db, c.t4)).decisao).toBe("PENDENTE");
  });

  it("o promovido CONTINUA protegido: EM_CONFIRMACAO, PENDENTE e fora do saldo cobravel", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db);
    const antes = await foto(db);
    await aplicar(db);

    expect((await tit(db, c.t1)).situacao).toBe("EM_CONFIRMACAO");
    expect((await decisao(db, c.t1)).decisao).toBe("PENDENTE");
    expect(Number((await q1(db, `select public.aluno_saldo_pendente_detalhe($1) s`, [c.a1.id])).s.titulos_abertos)).toBe(0);
    // e a promocao nao tira ninguem da fila
    const depois = await foto(db);
    expect(depois.em_conf).toBe(antes.em_conf);
    expect(depois.pendentes).toBe(antes.pendentes);
  });

  it("registra a trilha da promocao, com o rateio do pagamento", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db);
    await aplicar(db);

    const ev = (await decisao(db, c.t1)).evidencia;
    expect(ev.classificacao).toBe("PAGAMENTO_COMPROVADO");
    expect(ev.nivel_evidencia).toBe("FINANCEIRA");
    expect(Number(ev.rateio.base_pagamento)).toBe(1000);
    expect(Number(ev.rateio.soma_titulos)).toBe(1000);
    expect(Number(ev.rateio.titulos_no_pagamento)).toBe(1);

    const k = await q(db, `select classificacao, origem_decisao, resultado_titulo
                             from public.prime_liquidacao_classificacao
                            where titulo_id = $1 order by id`, [c.t1]);
    expect(k.at(-1)).toMatchObject({
      classificacao: "PAGAMENTO_COMPROVADO", origem_decisao: "GESTAO", resultado_titulo: "EM_CONFIRMACAO",
    });

    const bk = await q(db, `select acao, classe from public._backup_triagem_confirmacao_20261009
                             where lote = 'triagem_20261009180000' order by id`);
    expect(bk).toEqual([{ acao: "PROMOVER", classe: "1_PAGAMENTO_COMPROVADO" }]);
  });
});

describe("previa (default): nada e gravado", () => {
  it("aborta com PREVIA_SEM_ESCRITA e deixa tudo exatamente como estava", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db);
    const antes = await foto(db);

    await expect(db.exec(TRIAGEM)).rejects.toThrow(/PREVIA_SEM_ESCRITA/);
    await desfazer(db);

    expect(await foto(db)).toEqual(antes);
    expect((await decisao(db, c.t1)).subgrupo).toBe("C_SEM_PROVA");
    expect((await q1(db, `select to_regclass('public._backup_triagem_confirmacao_20261009') r`)).r).toBeNull();
  });
});

describe("devolver: so a classe 4, e so quando ligado", () => {
  it("com saneamento.devolver = on, o t4 volta para a cobranca e mais ninguem", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db, { devolver: 1, devolverOn: true });
    const antes = await foto(db);
    await aplicar(db);

    expect(await tit(db, c.t4)).toMatchObject({ situacao: "ABERTO", status: "em_aberto" });
    expect(await decisao(db, c.t4)).toMatchObject({ decisao: "REJEITADO", decidido_por: "triagem@gestao" });
    expect((await decisao(db, c.t4)).motivo).toMatch(/SEM_EVIDENCIA_DE_PAGAMENTO/);

    // os com evidencia ficam
    for (const t of [c.t1, c.t2a, c.t2b, c.t3]) {
      expect((await tit(db, t)).situacao).toBe("EM_CONFIRMACAO");
    }
    // o t5 esta fora da janela
    expect((await tit(db, c.t5)).situacao).toBe("EM_CONFIRMACAO");

    const depois = await foto(db);
    expect(depois.em_conf).toBe(antes.em_conf - 1);
    expect(depois.pendentes).toBe(antes.pendentes - 1);
    expect(depois.pagos).toBe(antes.pagos);

    // a divida do t4 volta a ser cobravel -- efeito pedido, nao acidente
    expect(Number((await q1(db, `select public.aluno_saldo_pendente_detalhe($1) s`, [c.a4.id])).s.titulos_abertos)).toBe(700);
  });

  it("janela_toda = on alcanca tambem o anterior a 08/10", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db, { devolver: 2, devolverOn: true, janelaToda: true });
    await aplicar(db);
    expect((await tit(db, c.t4)).situacao).toBe("ABERTO");
    expect((await tit(db, c.t5)).situacao).toBe("ABERTO");
    expect((await tit(db, c.t1)).situacao).toBe("EM_CONFIRMACAO");
  });

  it("nao toca dinheiro nenhum nem a Fila Confirmacao de Pagamento", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await db.query(
      `insert into public.solicitacoes_confirmacao_pagamento
         (aluno_id, aluno_nome, valor_informado, data_pagamento, status, motivo)
       values ($1, 'Aluno', 500, '2026-10-08', 'AGUARDANDO_CONFIRMACAO', 'Gerado do import de pagamentos Santander')`,
      [c.a4.id]);
    await travas(db, { devolver: 1, devolverOn: true });
    const antes = await foto(db);

    await aplicar(db);

    const depois = await foto(db);
    expect(depois.pag).toBe(antes.pag);
    expect(depois.parc).toBe(antes.parc);
    expect(depois.ac).toBe(antes.ac);
    expect(depois.vinc).toBe(antes.vinc);
    expect(depois.baixas).toBe(antes.baixas);
    expect(depois.sol).toBe(antes.sol);
    expect(Number((await q1(db,
      `select count(*)::int n from public.solicitacoes_confirmacao_pagamento
        where status = 'AGUARDANDO_CONFIRMACAO' and aluno_id = $1`, [c.a4.id])).n)).toBe(1);
  });
});

describe("as travas recusam a transacao inteira", () => {
  it("T5: quantidade a promover diferente da medicao aborta e nao grava nada", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await travas(db, { promover: 7 });
    const antes = await foto(db);
    await db.query(`select set_config('saneamento.aplicar','on',false)`);
    await expect(db.exec(TRIAGEM)).rejects.toThrow(/TRAVA T5/);
    await desfazer(db);
    expect(await foto(db)).toEqual(antes);
    expect((await decisao(db, c.t1)).subgrupo).toBe("C_SEM_PROVA");
  });

  it("T5: quantidade a devolver diferente da medicao aborta", async () => {
    const db = await abrir(BASE);
    await cenario(db);
    await travas(db, { devolver: 5, devolverOn: true });
    await db.query(`select set_config('saneamento.aplicar','on',false)`);
    await expect(db.exec(TRIAGEM)).rejects.toThrow(/TRAVA T5/);
    await desfazer(db);
  });

  it("T1: titulo com marca de pagamento no universo aborta tudo", async () => {
    const db = await abrir(BASE);
    const c = await cenario(db);
    await db.query(`update public.acordos_titulos set origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL' where id = $1`,
      [c.t4]);
    await travas(db, { devolver: 1, devolverOn: true });
    const antes = await foto(db);
    await db.query(`select set_config('saneamento.aplicar','on',false)`);
    await expect(db.exec(TRIAGEM)).rejects.toThrow(/TRAVA T1/);
    await desfazer(db);
    expect(await foto(db)).toEqual(antes);
  });
});
