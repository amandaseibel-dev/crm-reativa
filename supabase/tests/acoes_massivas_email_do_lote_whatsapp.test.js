// ACOES MASSIVAS: E-MAIL EXATAMENTE DOS ALUNOS DE UM LOTE DE WHATSAPP -- COMPORTAMENTO.
//
// Roda num PostgreSQL real (PGlite), sobre a mesma bancada dos outros testes de
// acoes massivas (definicoes vivas de producao de 16/09 + as migrations do
// subsistema de lotes), mais a migration nova.
//
// O QUE ESTE TESTE PROVA
//   * o recorte sai dos aluno_ids GRAVADOS no lote de WhatsApp -- nao de filtro
//     refeito, nao de acionamento do dia;
//   * o UNICO motivo de exclusao e nao ter e-mail valido, contado e devolvido:
//     quem estaria indisponivel no universo (confirmacao de pagamento,
//     liquidado no Prime, acionado hoje, outro dono) continua saindo;
//   * o total exportado = alunos do lote com e-mail valido (a propria funcao
//     reconfere por outro caminho antes de gravar);
//   * o lote de WhatsApp de origem nao recebe UPDATE nenhum;
//   * a acao nova nasce como lote de canal EMAIL, com lote_origem_id, e grava
//     uma movimentacao ACAO_MASSIVA_EXTERNA_EMAIL por aluno, ligada a ela;
//   * nada muda em alunos e casos;
//   * um lote de WhatsApp gera um lote de e-mail (segunda chamada falha sem
//     escrever); lote de canal errado e lote descartado nao passam;
//   * gate de gestao e ACL (anon/public sem execute).
//
// NENHUM DADO REAL: a bancada inteira e inventada.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GESTAO, OP_A, ID, comoGestao, comoOperador, novoBanco } from "./fixtures/acoes_massivas_prod_20260916/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");
const MIGRATION_COBERTURA = ler("supabase/migrations/20260920100000_acoes_massivas_cobertura_estrutura.sql");
const MIGRATION = ler("supabase/migrations/20261006160000_acoes_massivas_email_do_lote_whatsapp.sql");

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// Bancada + estrutura de rastreabilidade + a migration nova.
async function banco() {
  const db = await novoBanco({ tipo: true });
  await db.exec(MIGRATION_COBERTURA);
  await db.exec(MIGRATION);
  await comoGestao(db);
  return db;
}

// Lote de WhatsApp gravado na mao (o que a exportacao de WhatsApp deixa).
// Um lote tem UM desfecho (constraint da tabela): descartado nao e confirmado.
async function loteWhats(db, ids, extra = {}) {
  const descartado = extra.descartado_em ?? null;
  const r = await db.query(
    `insert into public.acoes_massivas_lotes
       (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca,
        confirmado_em, confirmado_por_email, descartado_em, descartado_por_email, recencia_dias)
     values ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [extra.canal ?? "WHATSAPP", extra.operador ?? null, extra.arquivo ?? "whats.xlsx",
     `{${ids.join(",")}}`, ids.length, GESTAO, extra.tipo_cobranca ?? "MENSALIDADES",
     descartado ? null : new Date().toISOString(), descartado ? null : GESTAO,
     descartado, descartado ? GESTAO : null, extra.recencia_dias ?? 10]);
  return r.rows[0].id;
}

const derivar = async (db, lote, arquivo = "email-do-lote.xlsx") =>
  (await db.query(
    `select public.acoes_massivas_exportar_emails_do_lote($1::uuid, $2) r`, [lote, arquivo])).rows[0].r;
const listar = async (db, dias = 7) =>
  (await db.query(`select public.acoes_massivas_lotes_whatsapp($1::integer) r`, [dias])).rows[0].r;
const linhaLote = async (db, id) =>
  (await db.query(`select * from public.acoes_massivas_lotes where id = $1`, [id])).rows[0];
const movs = async (db) =>
  (await db.query(`select aluno_id, tipo, lote_id, descricao from public.aluno_movimentacoes
                    order by aluno_id`)).rows;
const foto = async (db) => JSON.stringify([
  (await db.query(`select * from public.alunos order by id`)).rows,
  (await db.query(`select aluno_id, operador_email, total_em_aberto from public.casos
                    order by aluno_id, total_em_aberto`)).rows,
]);
// Zera o e-mail de alguns alunos: e o unico corte da funcao.
async function semEmail(db, ids, valor = null) {
  await db.query(`update public.alunos set email = $2 where id = any($1::uuid[])`,
    [`{${ids.join(",")}}`, valor]);
}

describe("e-mail do lote de WhatsApp: o recorte e o lote", () => {
  it("exporta os alunos do lote e exclui somente quem nao tem e-mail valido", async () => {
    const db = await banco();
    const ids = [ID.A1, ID.A2, ID.A3, ID.B1, ID.L1];
    await semEmail(db, [ID.A2]);               // sem e-mail
    await semEmail(db, [ID.A3], "   ");        // em branco
    await semEmail(db, [ID.B1], "semarroba");  // sem @
    const lote = await loteWhats(db, ids);

    const r = await derivar(db, lote);

    expect(r.total_lote_whatsapp).toBe(5);
    expect(r.com_email).toBe(2);
    expect(r.sem_email).toBe(3);
    expect(r.registrados).toBe(2);
    expect(r.contatos.map((c) => c.aluno_id).sort()).toEqual([ID.A1, ID.L1].sort());
    // nome e e-mail vem do cadastro, nada mascarado
    expect(r.contatos.every((c) => c.nome && c.email.includes("@"))).toBe(true);
    expect(r.ids_excluidos.map((e) => e.motivo_codigo)).toEqual(
      ["sem_email_valido", "sem_email_valido", "sem_email_valido"]);
  });

  it("nao revalida pelo universo: quem sairia como indisponivel continua no e-mail", async () => {
    const db = await banco();
    // A4 = confirmacao de pagamento pendente, A9 = liquidado no Prime,
    // A5 = jornada QUITADO, A8 = JURIDICO, B1 = de outro dono, A3 = acionado ha 2 dias.
    const ids = [ID.A4, ID.A9, ID.A5, ID.A8, ID.B1, ID.A3];
    const lote = await loteWhats(db, ids, { operador: OP_A });

    const r = await derivar(db, lote);

    expect(r.com_email).toBe(6);
    expect(r.sem_email).toBe(0);
    expect(r.registrados).toBe(6);
  });

  it("aluno repetido no lote conta uma vez; ficha inexistente conta como sem e-mail", async () => {
    const db = await banco();
    const fantasma = "00000000-0000-4000-8000-000000000999";
    const lote = await loteWhats(db, [ID.A1, ID.A1, fantasma]);

    const r = await derivar(db, lote);

    expect(r.total_lote_whatsapp).toBe(2);
    expect(r.com_email).toBe(1);
    expect(r.sem_email).toBe(1);
  });

  it("ninguem com e-mail: nao grava lote nem movimentacao", async () => {
    const db = await banco();
    await semEmail(db, [ID.A1, ID.A2]);
    const lote = await loteWhats(db, [ID.A1, ID.A2]);

    const r = await derivar(db, lote);

    expect(r.lote_id).toBe(null);
    expect(r.com_email).toBe(0);
    expect(r.sem_email).toBe(2);
    expect(await movs(db)).toEqual([]);
    expect(Number((await db.query(
      `select count(*) n from public.acoes_massivas_lotes where canal = 'EMAIL'`)).rows[0].n)).toBe(0);
  });
});

describe("e-mail do lote de WhatsApp: o que e gravado", () => {
  it("nasce lote de canal EMAIL ligado ao de origem, com os numeros do recorte", async () => {
    const db = await banco();
    await semEmail(db, [ID.A2]);
    const origem = await loteWhats(db, [ID.A1, ID.A2, ID.L1], { arquivo: "whats-06-10.xlsx" });

    const r = await derivar(db, origem, "email-06-10.xlsx");
    const novo = await linhaLote(db, r.lote_id);

    expect(novo.canal).toBe("EMAIL");
    expect(novo.lote_origem_id).toBe(origem);
    expect(novo.arquivo).toBe("email-06-10.xlsx");
    expect(novo.total).toBe(2);
    expect(novo.aluno_ids.sort()).toEqual([ID.A1, ID.L1].sort());
    expect(novo.solicitado).toBe(3);      // alunos do lote de WhatsApp
    expect(novo.encontrado).toBe(2);      // com e-mail valido
    expect(novo.selecionado).toBe(2);
    expect(novo.resumo_exclusoes).toEqual({ sem_email_valido: 1 });
    expect(novo.tipo_cobranca).toBe("MENSALIDADES");
    expect(novo.filtros.origem).toBe("LOTE_WHATSAPP");
    expect(novo.filtros.lote_origem_id).toBe(origem);
    expect(novo.filtros.arquivo_origem).toBe("whats-06-10.xlsx");
    // ja fechado: nao fica pendente de registro
    expect(novo.confirmado_em).not.toBe(null);
    expect(novo.registrados).toBe(2);
    expect(novo.registro_automatico).toBe(true);
  });

  it("grava uma movimentacao de e-mail por aluno, ligada ao lote novo", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1, ID.L1]);
    const r = await derivar(db, origem);

    const m = await movs(db);
    expect(m).toHaveLength(2);
    expect(m.every((x) => x.tipo === "ACAO_MASSIVA_EXTERNA_EMAIL")).toBe(true);
    expect(m.every((x) => x.lote_id === r.lote_id)).toBe(true);
    expect(m[0].descricao).toMatch(/derivada do lote de WhatsApp/);
  });

  it("nao altera o lote de WhatsApp de origem", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1, ID.L1]);
    const antes = JSON.stringify(await linhaLote(db, origem));

    await derivar(db, origem);

    expect(JSON.stringify(await linhaLote(db, origem))).toBe(antes);
  });

  it("nao toca em alunos nem em casos", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1, ID.A2, ID.L1]);
    const antes = await foto(db);

    await derivar(db, origem);

    expect(await foto(db)).toBe(antes);
  });
});

describe("e-mail do lote de WhatsApp: travas", () => {
  it("o mesmo lote nao gera e-mail duas vezes e a segunda tentativa nao escreve", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1, ID.L1]);
    await derivar(db, origem);
    const antes = JSON.stringify(await movs(db));

    await expect(derivar(db, origem)).rejects.toThrow(/ja gerou a acao de e-mail/);

    expect(JSON.stringify(await movs(db))).toBe(antes);
    expect(Number((await db.query(
      `select count(*) n from public.acoes_massivas_lotes where canal = 'EMAIL'`)).rows[0].n)).toBe(1);
  });

  it("lote de outro canal nao serve de origem", async () => {
    const db = await banco();
    const email = await loteWhats(db, [ID.A1], { canal: "EMAIL" });
    await expect(derivar(db, email)).rejects.toThrow(/canal EMAIL/);
  });

  it("lote descartado nao gera e-mail", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1], { descartado_em: new Date().toISOString() });
    await expect(derivar(db, origem)).rejects.toThrow(/descartado/);
  });

  it("lote inexistente falha sem escrever", async () => {
    const db = await banco();
    await expect(derivar(db, "00000000-0000-4000-8000-00000000dead"))
      .rejects.toThrow(/nao encontrado/);
    expect(await movs(db)).toEqual([]);
  });

  it("so gestao exporta e so gestao lista", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1]);
    await comoOperador(db, OP_A);
    await expect(derivar(db, origem)).rejects.toThrow(/Acesso negado/);
    await expect(listar(db)).rejects.toThrow(/Acesso negado/);
  });

  it("anon e public nao têm execute nas funcoes novas", async () => {
    const db = await banco();
    const r = await db.query(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') anon,
             has_function_privilege('public', p.oid, 'execute') pub,
             has_function_privilege('authenticated', p.oid, 'execute') auth
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('acoes_massivas_exportar_emails_do_lote','acoes_massivas_lotes_whatsapp',
                           'email_valido_para_acao_massiva')
       order by p.proname`);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((x) => x.anon === false && x.pub === false && x.auth === true)).toBe(true);
  });
});

describe("listagem dos lotes de WhatsApp", () => {
  it("conta quantos daquele lote tem e-mail valido, antes de exportar", async () => {
    const db = await banco();
    await semEmail(db, [ID.A2, ID.A3]);
    const origem = await loteWhats(db, [ID.A1, ID.A2, ID.A3, ID.L1]);

    const l = (await listar(db)).find((x) => x.id === origem);

    expect(l.total).toBe(4);
    expect(l.com_email).toBe(2);
    expect(l.sem_email).toBe(2);
    expect(l.email_lote_id).toBe(null);
  });

  it("depois de derivar, a listagem aponta o lote de e-mail que saiu", async () => {
    const db = await banco();
    const origem = await loteWhats(db, [ID.A1]);
    const r = await derivar(db, origem);

    const l = (await listar(db)).find((x) => x.id === origem);
    expect(l.email_lote_id).toBe(r.lote_id);
    expect(l.email_exportado_em).not.toBe(null);
  });

  it("lista so WhatsApp, so nao descartados e so dentro da janela", async () => {
    const db = await banco();
    const whats = await loteWhats(db, [ID.A1]);
    await loteWhats(db, [ID.A2], { canal: "EMAIL" });
    await loteWhats(db, [ID.A3], { descartado_em: new Date().toISOString() });
    const antigo = await loteWhats(db, [ID.L1]);
    await db.query(`update public.acoes_massivas_lotes set exportado_em = now() - interval '30 days'
                     where id = $1`, [antigo]);

    const ids = (await listar(db, 7)).map((x) => x.id);
    expect(ids).toEqual([whats]);
    expect((await listar(db, 60)).map((x) => x.id).sort()).toEqual([whats, antigo].sort());
  });
});

describe("regra do e-mail valido", () => {
  it("e a mesma do universo: tem texto e tem @ depois do primeiro caractere", async () => {
    const db = await banco();
    const casos = [
      [null, false], ["", false], ["   ", false], ["semarroba", false],
      ["@x.com", false], ["a@x.com", true], [" a@x.com ", true],
    ];
    for (const [valor, esperado] of casos) {
      const r = await db.query(`select public.email_valido_para_acao_massiva($1) v`, [valor]);
      expect([valor, r.rows[0].v]).toEqual([valor, esperado]);
    }
  });
});
