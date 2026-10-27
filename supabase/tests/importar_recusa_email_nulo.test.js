// IMPORTAÇÃO DA PROJEÇÃO: A ALLOWLIST PASSA A RECUSAR E-MAIL NULO
// (migration 20261022131017, em PostgreSQL real — PGlite)
//
// Sobre os corpos VIVOS de produção das DUAS sobrecargas de
// `projecao_importar_pagamentos` (22/10/2026), conferidos por md5(prosrc).
//
// O DEFEITO. `v_email NOT IN (...allowlist...)` com `v_email` NULL avalia para
// NULL, que não é TRUE: o IF não dispara e a importação ACONTECE, com
// `auditoria.usuario` nulo. `anon` não tem EXECUTE; `authenticated` e
// `service_role` têm, nas duas sobrecargas.
//
// COMO ESTE ARQUIVO ESTÁ ORGANIZADO
//   1. fidelidade: os dois corpos são os de produção;
//   2. ANTES da correção: o furo é reproduzido, para não haver dúvida de que
//      existe e de que a correção é sobre ele;
//   3. DEPOIS: os quatro casos pedidos -- autorizado, não autorizado, JWT sem
//      e-mail, chave de serviço sem autoria humana -- e, em cada recusa, a
//      conferência de que NENHUMA das quatro tabelas financeiras foi tocada;
//   4. a allowlist preservada letra por letra;
//   5. idempotência da migration e volta pelo rollback.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, p), "utf8");
const BANCADA = ler("fixtures/importar_allowlist_prod_20261022.sql");
const MD5 = JSON.parse(ler("fixtures/importar_allowlist_prod_20261022.md5.json"));
const MIGRATION = ler("../migrations/20261022131017_importar_recusa_email_nulo.sql");
const ROLLBACK = ler("../rollbacks/20261022131017_importar_recusa_email_nulo.rollback.sql");

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const AUTORIZADA = "amanda.seibel@aelbra.com.br";
const NAO_AUTORIZADO = "cobranca99@aelbra.com.br";
const ALLOWLIST = ["amanda.seibel@aelbra.com.br", "cobranca04@aelbra.com.br", "cobranca07@aelbra.com.br"];

// `begin;`/`commit;` dentro de db.exec do PGlite conflitam com o controle de
// transação do próprio exec; o conteúdo entre eles é o que importa.
const semTransacao = (sql) => sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

const LINHAS = [
  {
    data_pagamento: "2026-10-01", valor_pago: 500, valor_honorario: 50, tipo_pagamento: "SANTANDER",
    titulo_numero: "50640", numero_parcela_completo: "50640510001",
    operador_email: "maria@aelbra.com.br", operador_nome: "MARIA", aluno_nome: "ALUNO UM", cpf: null,
  },
  {
    data_pagamento: "2026-10-01", valor_pago: 300, valor_honorario: 30, tipo_pagamento: "SANTANDER",
    titulo_numero: "50641", numero_parcela_completo: "50641510001",
    operador_email: "joao@aelbra.com.br", operador_nome: "JOAO", aluno_nome: "ALUNO DOIS", cpf: null,
  },
];

const md5De = async (db, args) => {
  const { rows } = await db.query(
    `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='projecao_importar_pagamentos'
        and pg_get_function_identity_arguments(p.oid) ${args === 7 ? "like" : "not like"} '%p_mes_referencia%'`
  );
  return rows[0].m;
};

async function novoBanco() {
  const db = new PGlite();
  await db.exec(BANCADA);
  // Fidelidade primeiro: sem isso, nada aqui fala sobre produção.
  expect(await md5De(db, 7)).toBe(MD5["7args"]);
  expect(await md5De(db, 4)).toBe(MD5["4args"]);
  return db;
}

// As três formas de sessão que importam. `comoServico` reproduz a chave de
// serviço pelo caminho real: claims com `role` e SEM `email`.
const comoPessoa = (db, email) => db.exec(`set request.jwt.claim.email = '${email}'`);
const semEmail = (db) => db.exec(`select set_config('request.jwt.claim.email', '', true)`);
const comoServico = (db) =>
  db.exec(`select set_config('request.jwt.claims', '{"role":"service_role","iss":"supabase"}', true)`);

const importar7 = (db) =>
  db.query(
    `select * from public.projecao_importar_pagamentos(
       p_arquivo_nome => 'extrato.xls', p_usuario => 'quem_disser', p_linhas => $1::jsonb,
       p_mes_referencia => '2026-10', p_retroativo => false,
       p_substituir_importacao_id => null, p_motivo_substituicao => null)`,
    [JSON.stringify(LINHAS)]
  );

const importar4 = (db, linhas = LINHAS) =>
  db.query(
    `select * from public.projecao_importar_pagamentos(
       p_arquivo_nome => 'legado.xls', p_usuario => 'quem_disser',
       p_linhas => $1::jsonb, p_retroativo => false)`,
    [JSON.stringify(linhas)]
  );

// Foto das QUATRO tabelas que a importação toca. "Não houve escrita financeira"
// só vale se for sobre todas elas -- conferir só `pagamentos` deixaria passar
// uma importação registrada, um acumulado de operador remexido ou uma linha de
// auditoria com autoria nula.
async function escritas(db) {
  const n = async (t) => Number((await db.query(`select count(*) c from public.${t}`)).rows[0].c);
  return {
    pagamentos: await n("pagamentos"),
    importacoes: await n("importacoes"),
    auditoria: await n("auditoria"),
    rh: await n("rh_acompanhamento_diario"),
  };
}
const ZERO = { pagamentos: 0, importacoes: 0, auditoria: 0, rh: 0 };

describe("ANTES da correcao: o furo existe mesmo", () => {
  it("JWT sem e-mail IMPORTA, e a auditoria fica com autoria nula", async () => {
    const db = await novoBanco();
    await semEmail(db);
    const r = await importar7(db);
    expect(r.rows[0].linhas_gravadas).toBe(2);
    const { rows } = await db.query(`select usuario from public.auditoria where acao='IMPORTOU'`);
    expect(rows[0].usuario).toBeNull();
    await db.close();
  });

  it("chave de servico (claims com role e sem email) tambem IMPORTA", async () => {
    const db = await novoBanco();
    await comoServico(db);
    expect((await importar7(db)).rows[0].linhas_gravadas).toBe(2);
    await db.close();
  });

  // A sobrecarga legada tem a MESMA guarda furada, mas não consegue gravar
  // pagamento: ela faz `ON CONFLICT (titulo_numero, data_pagamento)` e não
  // existe índice único para essa especificação -- nem aqui, nem em produção.
  // O INSERT falha e a transação inteira volta. É o que dimensiona o risco
  // dessa porta: furada na guarda, quebrada na escrita.
  it("a legada passa da guarda sem e-mail, mas QUEBRA no ON CONFLICT sem indice", async () => {
    const db = await novoBanco();
    await semEmail(db);
    await expect(importar4(db)).rejects.toThrow(/ON CONFLICT|unique|exclusion/i);
    expect(await escritas(db)).toEqual(ZERO);
    await db.close();
  });

  // O caso em que a legada chega ao fim: lista vazia não entra no loop. Não há
  // pagamento, mas sobra uma importação registrada por quem não tem autoria.
  it("a legada com lista vazia grava importacao de ninguem (sem pagamento)", async () => {
    const db = await novoBanco();
    await semEmail(db);
    await importar4(db, []);
    const e = await escritas(db);
    expect(e.pagamentos).toBe(0);
    expect(e.importacoes).toBe(1);
    await db.close();
  });
});

describe("DEPOIS da correcao: os quatro casos", () => {
  async function corrigido() {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    expect(await md5De(db, 7)).toBe(MD5["7args_corrigida"]);
    expect(await md5De(db, 4)).toBe(MD5["4args_corrigida"]);
    return db;
  }

  it("1. usuario AUTORIZADO importa, exatamente como antes", async () => {
    const db = await corrigido();
    await comoPessoa(db, AUTORIZADA);
    expect((await importar7(db)).rows[0].linhas_gravadas).toBe(2);
    const e = await escritas(db);
    expect(e.pagamentos).toBe(2);
    const { rows } = await db.query(`select usuario from public.auditoria where acao='IMPORTOU'`);
    expect(rows[0].usuario).toBe(AUTORIZADA);
    await db.close();
  });

  it("2. usuario NAO AUTORIZADO e recusado, sem nenhuma escrita", async () => {
    const db = await corrigido();
    await comoPessoa(db, NAO_AUTORIZADO);
    await expect(importar7(db)).rejects.toThrow(/Sem permiss/);
    expect(await escritas(db)).toEqual(ZERO);
    await db.close();
  });

  it("3. JWT SEM E-MAIL e recusado, sem nenhuma escrita", async () => {
    const db = await corrigido();
    await semEmail(db);
    await expect(importar7(db)).rejects.toThrow(/Sem permiss/);
    expect(await escritas(db)).toEqual(ZERO);
    await db.close();
  });

  it("4. CHAVE DE SERVICO sem autoria humana e recusada, sem nenhuma escrita", async () => {
    const db = await corrigido();
    await comoServico(db);
    await expect(importar7(db)).rejects.toThrow(/Sem permiss/);
    expect(await escritas(db)).toEqual(ZERO);
    await db.close();
  });

  // A legada passa a recusar na GUARDA, antes de chegar ao ON CONFLICT -- então
  // nem a importação de ninguém com lista vazia acontece mais.
  it("a legada recusa sem e-mail, inclusive com lista vazia", async () => {
    const db = await corrigido();
    await semEmail(db);
    await expect(importar4(db)).rejects.toThrow(/Sem permiss/);
    await expect(importar4(db, [])).rejects.toThrow(/Sem permiss/);
    expect(await escritas(db)).toEqual(ZERO);
    await db.close();
  });

  it("a legada segue atendendo quem esta na allowlist", async () => {
    const db = await corrigido();
    await comoPessoa(db, AUTORIZADA);
    // Falha no ON CONFLICT, como ANTES da correção: a correção não consertou
    // essa sobrecarga, só a guarda dela. Importa que o motivo da falha mudou de
    // "sem permissão" para o defeito antigo -- a allowlist deixou passar.
    await expect(importar4(db)).rejects.toThrow(/ON CONFLICT|unique|exclusion/i);
    await db.close();
  });
});

describe("a allowlist foi preservada letra por letra", () => {
  it("os tres e-mails continuam lá, nas duas sobrecargas, e nenhum foi somado", async () => {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    const { rows } = await db.query(
      `select pg_get_function_identity_arguments(p.oid) args, p.prosrc
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='projecao_importar_pagamentos'`
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      for (const email of ALLOWLIST) expect(r.prosrc).toContain(email);
      // Nenhum e-mail a mais: conta as ocorrências de '@aelbra.com.br' no
      // trecho da allowlist.
      const guarda = /NOT IN \(([^)]*)\)/.exec(r.prosrc)[1];
      expect(guarda.match(/@aelbra\.com\.br/g)).toHaveLength(3);
    }
    await db.close();
  });

  it("cada usuario da allowlist importa depois da correcao", async () => {
    for (const email of ALLOWLIST) {
      const db = await novoBanco();
      await db.exec(semTransacao(MIGRATION));
      await comoPessoa(db, email);
      expect((await importar7(db)).rows[0].linhas_gravadas).toBe(2);
      await db.close();
    }
  });
});

describe("a migration e as travas", () => {
  it("aplicar duas vezes nao muda nada (idempotente)", async () => {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    const depois7 = await md5De(db, 7);
    const depois4 = await md5De(db, 4);
    await db.exec(semTransacao(MIGRATION));
    expect(await md5De(db, 7)).toBe(depois7);
    expect(await md5De(db, 4)).toBe(depois4);
    await db.close();
  });

  it("o md5 resultante e o PREVISTO, nao so 'diferente do anterior'", async () => {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    expect(await md5De(db, 7)).toBe("1e376707892d12ed66f77479371ece45");
    expect(await md5De(db, 4)).toBe("8ba7459a400ee4c489ed4147f3c76e95");
    await db.close();
  });

  // TRAVA 1: corpo diferente do medido -> recusa, em vez de aplicar sobre
  // função desconhecida.
  it("RECUSA aplicar se o corpo em producao tiver derivado", async () => {
    const db = await novoBanco();
    await db.exec(`
      create or replace function public.projecao_importar_pagamentos(
        p_arquivo_nome text, p_usuario text, p_linhas jsonb, p_mes_referencia text,
        p_retroativo boolean default false, p_substituir_importacao_id uuid default null,
        p_motivo_substituicao text default null)
       returns table(importacao_id uuid, linhas_gravadas integer)
       language plpgsql security definer set search_path to 'public'
      as $f$ begin return query select null::uuid, 0; end $f$;`);
    await expect(db.exec(semTransacao(MIGRATION))).rejects.toThrow(/CORPO INESPERADO/);
    await db.close();
  });

  it("a correcao preserva SECURITY DEFINER, search_path e statement_timeout", async () => {
    const db = await novoBanco();
    const antes = await db.query(
      `select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='projecao_importar_pagamentos'
          and pg_get_function_identity_arguments(p.oid) like '%p_mes_referencia%'`
    );
    await db.exec(semTransacao(MIGRATION));
    const depois = await db.query(
      `select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='projecao_importar_pagamentos'
          and pg_get_function_identity_arguments(p.oid) like '%p_mes_referencia%'`
    );
    expect(depois.rows[0].prosecdef).toBe(true);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
    await db.close();
  });

  it("a correcao nao mexe em mais nada do corpo: so a condicao do IF", async () => {
    const db = await novoBanco();
    const { rows: a } = await db.query(
      `select p.prosrc s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='projecao_importar_pagamentos'
          and pg_get_function_identity_arguments(p.oid) like '%p_mes_referencia%'`
    );
    await db.exec(semTransacao(MIGRATION));
    const { rows: d } = await db.query(
      `select p.prosrc s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='projecao_importar_pagamentos'
          and pg_get_function_identity_arguments(p.oid) like '%p_mes_referencia%'`
    );
    // Desfazendo só a troca, o corpo volta a ser IDÊNTICO ao original.
    expect(d[0].s.replace("IF v_email IS NULL OR v_email NOT IN (", "IF v_email NOT IN (")).toBe(a[0].s);
    await db.close();
  });
});

describe("rollback", () => {
  it("devolve os dois corpos ao estado original, por md5", async () => {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    await db.exec(semTransacao(ROLLBACK));
    expect(await md5De(db, 7)).toBe(MD5["7args"]);
    expect(await md5De(db, 4)).toBe(MD5["4args"]);
    await db.close();
  });

  it("depois do rollback o furo volta -- e e por isso que ele avisa", async () => {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    await db.exec(semTransacao(ROLLBACK));
    await semEmail(db);
    expect((await importar7(db)).rows[0].linhas_gravadas).toBe(2);
    await db.close();
  });

  it("rodar o rollback duas vezes nao quebra", async () => {
    const db = await novoBanco();
    await db.exec(semTransacao(MIGRATION));
    await db.exec(semTransacao(ROLLBACK));
    await db.exec(semTransacao(ROLLBACK));
    expect(await md5De(db, 7)).toBe(MD5["7args"]);
    await db.close();
  });
});
