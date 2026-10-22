// IDENTIDADE NULA NAS SETE FUNÇÕES SECURITY DEFINER
// (migrations 20261022170000 e 20261022170100, em PostgreSQL real — PGlite)
//
// O DEFEITO. `v_email NOT IN (...allowlist...)` com `v_email` NULL avalia para
// NULL, que não é TRUE: o IF não dispara e a função SEGUE. `v_email` vem de
// `lower(auth.email())`, que devolve NULL quando o token não traz claim de
// e-mail -- caso da chave de serviço.
//
// O QUE ESTE ARQUIVO PROVA, e o que NÃO prova -- dito aqui em vez de deixado
// implícito:
//
//   PROVA COMPORTAMENTAL COMPLETA para as DUAS prioritárias, sobre os corpos
//   VIVOS de produção conferidos por md5: identidade nula e não autorizada não
//   conseguem apagar pagamento, não conseguem mover atribuição e não produzem
//   NENHUMA escrita em nenhuma das tabelas que cada função toca.
//
//   NÃO PROVA comportamento das outras CINCO função por função: os corpos delas
//   não estão transcritos aqui. Para elas o arquivo prova (a) que a migration
//   declara as cinco assinaturas com md5 antes/depois, (b) que a troca ancorada
//   produz exatamente a condição pretendida, e (c) que a TRAVA DE CORPO recusa
//   aplicar sobre função diferente da medida -- que é o risco real da mecânica.
//   A propriedade da guarda em si é idêntica nas sete e está provada
//   comportamentalmente sobre QUATRO corpos reais (os dois daqui e os dois da
//   20261022131017).
//
//   Base estrutural que sustenta esse recorte, medida em produção: em seis das
//   sete a guarda é a PRIMEIRA instrução depois do BEGIN (só uma quebra de linha
//   antes), então recusar implica zero escrita por construção, não por sorte. A
//   sétima (registrar_decisao_suspeita_duplicidade) tem uma guarda ANTERIOR mais
//   forte, que isenta `service_role` de propósito -- documentado na migration B.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, p), "utf8");
const BANCADA = ler("fixtures/identidade_nula_prod_20261022.sql");
const MD5 = JSON.parse(ler("fixtures/identidade_nula_prod_20261022.md5.json"));
const MIG_A = ler("../migrations/20261022170000_identidade_nula_prioritarias.sql");
const MIG_B = ler("../migrations/20261022170100_identidade_nula_restantes.sql");
const ROLL_A = ler("../rollbacks/20261022170000_identidade_nula_prioritarias.rollback.sql");

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// `begin;`/`commit;` conflitam com o controle de transação do db.exec do PGlite.
const semTransacao = (sql) => sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

const GESTAO = "amanda.seibel@aelbra.com.br";
const C04 = "cobranca04@aelbra.com.br";
const C07 = "cobranca07@aelbra.com.br";
const FORA = "cobranca99@aelbra.com.br";

const PAG = "11111111-1111-1111-1111-111111111111";
const IMP = "22222222-2222-2222-2222-222222222222";

async function novoBanco() {
  const db = new PGlite();
  await db.exec(BANCADA);
  const m = async (nome) => (await db.query(
    `select md5(p.prosrc) x from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=$1`, [nome])).rows[0].x;
  // Fidelidade primeiro: sem isso nada aqui fala sobre produção.
  expect(await m("projecao_excluir_importacao")).toBe(MD5.excluir_importacao);
  expect(await m("projecao_alterar_operador")).toBe(MD5.alterar_operador);

  // Uma importação CONCLUIDA com dois pagamentos, e acumulado do operador.
  await db.exec(`
    insert into public.importacoes (id, tipo, arquivo_nome, usuario, qtd_registros, status, mes_referencia)
    values ('${IMP}', 'PROJECAO_DIARIA', 'extrato.xls', '${GESTAO}', 2, 'CONCLUIDO', '2026-10');
    insert into public.pagamentos (id, data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
      operador_email, operador_nome, aluno_nome, titulo_numero, numero_parcela_completo, importacao_id)
    values ('${PAG}', '2026-10-01', 500, 50, 'SANTANDER', 'maria@aelbra.com.br', 'MARIA',
            'ALUNO UM', '50640', '50640510001', '${IMP}'),
           (gen_random_uuid(), '2026-10-01', 300, 30, 'SANTANDER', 'joao@aelbra.com.br', 'JOAO',
            'ALUNO DOIS', '50641', '50641510001', '${IMP}');
    insert into public.rh_acompanhamento_diario (mes_referencia, operador_email, operador_nome,
      valor_recuperado_acumulado, alunos_pagos_qtd)
    values ('2026-10', 'maria@aelbra.com.br', 'MARIA', 500, 1);
  `);
  return db;
}

const md5De = async (db, nome) => (await db.query(
  `select md5(p.prosrc) x from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=$1`, [nome])).rows[0].x;

const comoPessoa = (db, email) => db.exec(`set request.jwt.claim.email = '${email}'`);
const semEmail = (db) => db.exec(`select set_config('request.jwt.claim.email', '', true)`);
// Chave de serviço pelo caminho real: claims com `role` e SEM `email`.
const comoServico = (db) =>
  db.exec(`select set_config('request.jwt.claims', '{"role":"service_role","iss":"supabase"}', true)`);

const excluir = (db) =>
  db.query(`select public.projecao_excluir_importacao($1::uuid, 'motivo')`, [IMP]);
const alterar = (db) =>
  db.query(`select public.projecao_alterar_operador($1::uuid, 'outro@aelbra.com.br', 'OUTRO', 'motivo')`, [PAG]);

// Foto de TUDO o que as duas tocam. "Zero escrita" só vale sobre todas.
async function foto(db) {
  const q = async (sql) => JSON.stringify((await db.query(sql)).rows);
  const n = async (t) => Number((await db.query(`select count(*) c from public.${t}`)).rows[0].c);
  return {
    pagamentos: await q(`select * from public.pagamentos order by id`),
    importacoes: await q(`select * from public.importacoes order by id`),
    rh: await q(`select * from public.rh_acompanhamento_diario order by id`),
    historico: await n("historico_operador_projecao"),
    auditoria: await n("auditoria"),
    snapshot: await n("_dub_snapshot"),
  };
}

async function corrigido() {
  const db = await novoBanco();
  await db.exec(semTransacao(MIG_A));
  expect(await md5De(db, "projecao_excluir_importacao")).toBe(MD5.excluir_importacao_corrigida);
  expect(await md5De(db, "projecao_alterar_operador")).toBe(MD5.alterar_operador_corrigida);
  return db;
}

describe("ANTES da correcao: as duas prioritarias cedem a identidade nula", () => {
  it("sem e-mail, projecao_excluir_importacao APAGA os dois pagamentos", async () => {
    const db = await novoBanco();
    await semEmail(db);
    await excluir(db);
    const f = await foto(db);
    expect(JSON.parse(f.pagamentos)).toHaveLength(0);
    expect(JSON.parse(f.importacoes)[0].status).toBe("EXCLUIDA");
    expect(JSON.parse(f.importacoes)[0].excluido_por).toBeNull();
    await db.close();
  });

  it("sem e-mail, projecao_alterar_operador MOVE a atribuicao", async () => {
    const db = await novoBanco();
    await semEmail(db);
    await alterar(db);
    const { rows } = await db.query(`select operador_email, operador_ajustado_manualmente from public.pagamentos where id=$1`, [PAG]);
    expect(rows[0].operador_email).toBe("outro@aelbra.com.br");
    expect(rows[0].operador_ajustado_manualmente).toBe(true);
    await db.close();
  });

  it("chave de servico consegue as duas coisas", async () => {
    const db = await novoBanco();
    await comoServico(db);
    await alterar(db);
    await excluir(db);
    expect(JSON.parse((await foto(db)).pagamentos)).toHaveLength(0);
    await db.close();
  });
});

describe("DEPOIS: identidade nula nao apaga pagamento nem move atribuicao", () => {
  // O requisito, caso a caso, com a foto INTEIRA conferida.
  for (const [quem, sessao] of [
    ["JWT sem e-mail", semEmail],
    ["chave de servico sem autoria humana", comoServico],
    ["e-mail fora da allowlist", (db) => comoPessoa(db, FORA)],
  ]) {
    it(`${quem}: projecao_excluir_importacao RECUSA e nao escreve nada`, async () => {
      const db = await corrigido();
      const antes = await foto(db);
      await sessao(db);
      await expect(excluir(db)).rejects.toThrow(/Sem permiss/);
      expect(await foto(db)).toEqual(antes);
      await db.close();
    });

    it(`${quem}: projecao_alterar_operador RECUSA e nao escreve nada`, async () => {
      const db = await corrigido();
      const antes = await foto(db);
      await sessao(db);
      await expect(alterar(db)).rejects.toThrow(/Sem permiss/);
      expect(await foto(db)).toEqual(antes);
      await db.close();
    });
  }

  // Sensibilidade: se a foto não detectasse escrita, os testes acima passariam
  // por engano. Aqui o autorizado escreve e a foto MUDA -- prova de que o
  // instrumento funciona.
  it("SENSIBILIDADE: com usuario autorizado a foto MUDA (o teste detecta escrita)", async () => {
    const db = await corrigido();
    const antes = await foto(db);
    await comoPessoa(db, GESTAO);
    await alterar(db);
    expect(await foto(db)).not.toEqual(antes);
    await db.close();
  });
});

describe("DEPOIS: quem esta na allowlist continua podendo", () => {
  it("os tres autorizados excluem importacao", async () => {
    for (const email of [GESTAO, C04, C07]) {
      const db = await corrigido();
      await comoPessoa(db, email);
      await excluir(db);
      const f = await foto(db);
      expect(JSON.parse(f.pagamentos)).toHaveLength(0);
      expect(JSON.parse(f.importacoes)[0].excluido_por).toBe(email);
      await db.close();
    }
  });

  // A allowlist de projecao_alterar_operador tem DOIS e-mails, nao tres. A
  // correcao nao pode ter uniformizado para tres -- isso seria conceder acesso
  // que nao existia.
  it("alterar_operador: amanda e cobranca04 podem; cobranca07 NAO, como antes", async () => {
    for (const email of [GESTAO, C04]) {
      const db = await corrigido();
      await comoPessoa(db, email);
      await alterar(db);
      const { rows } = await db.query(`select alterado_por from public.historico_operador_projecao`);
      expect(rows[0].alterado_por).toBe(email);
      await db.close();
    }
    const db = await corrigido();
    await comoPessoa(db, C07);
    await expect(alterar(db)).rejects.toThrow(/Sem permiss/);
    await db.close();
  });

  it("as allowlists seguem com 2 e 3 e-mails, nao uniformizadas", async () => {
    const db = await corrigido();
    const { rows } = await db.query(
      `select p.proname, substring(p.prosrc from 'NOT IN \\(([^)]*)\\)') g
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname in ('projecao_excluir_importacao','projecao_alterar_operador')`
    );
    const por = Object.fromEntries(rows.map((r) => [r.proname, r.g.match(/@aelbra\.com\.br/g).length]));
    expect(por.projecao_excluir_importacao).toBe(3);
    expect(por.projecao_alterar_operador).toBe(2);
    await db.close();
  });
});

describe("a mecanica das duas migrations", () => {
  it("A: aplicar duas vezes nao muda nada (idempotente)", async () => {
    const db = await corrigido();
    await db.exec(semTransacao(MIG_A));
    expect(await md5De(db, "projecao_excluir_importacao")).toBe(MD5.excluir_importacao_corrigida);
    expect(await md5De(db, "projecao_alterar_operador")).toBe(MD5.alterar_operador_corrigida);
    await db.close();
  });

  it("A: o md5 resultante e o PREVISTO, nao so 'diferente'", async () => {
    const db = await corrigido();
    expect(await md5De(db, "projecao_excluir_importacao")).toBe("8af3ebfb4728dc7cb0c6872845247941");
    expect(await md5De(db, "projecao_alterar_operador")).toBe("ded13d5b3cfec35ca0e86d26c7854c49");
    await db.close();
  });

  it("A: desfazer so a troca devolve o corpo IDENTICO ao original", async () => {
    const db = await novoBanco();
    const antes = (await db.query(
      `select p.prosrc s from pg_proc p where p.proname='projecao_excluir_importacao'`)).rows[0].s;
    await db.exec(semTransacao(MIG_A));
    const depois = (await db.query(
      `select p.prosrc s from pg_proc p where p.proname='projecao_excluir_importacao'`)).rows[0].s;
    expect(depois.replace("IF v_email IS NULL OR v_email NOT IN (", "IF v_email NOT IN (")).toBe(antes);
    await db.close();
  });

  it("A: preserva SECURITY DEFINER e search_path nas duas", async () => {
    const db = await novoBanco();
    const ler = async () => (await db.query(
      `select p.proname, p.prosecdef, p.proconfig from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in
          ('projecao_excluir_importacao','projecao_alterar_operador') order by p.proname`)).rows;
    const antes = await ler();
    await db.exec(semTransacao(MIG_A));
    expect(await ler()).toEqual(antes);
    expect(antes.every((r) => r.prosecdef)).toBe(true);
    await db.close();
  });

  // TRAVA 1 -- o risco real da mecânica: aplicar sobre corpo que não é o medido.
  it("A: RECUSA aplicar se o corpo tiver derivado", async () => {
    const db = await novoBanco();
    await db.exec(`
      create or replace function public.projecao_alterar_operador(
        p_pagamento_id uuid, p_novo_operador_email text, p_novo_operador_nome text, p_motivo text)
       returns void language plpgsql security definer set search_path to 'public'
      as $f$ begin return; end $f$;`);
    await expect(db.exec(semTransacao(MIG_A))).rejects.toThrow(/CORPO INESPERADO/);
    await db.close();
  });

  it("A: rollback devolve os dois corpos ao original, e o furo volta", async () => {
    const db = await corrigido();
    await db.exec(semTransacao(ROLL_A));
    expect(await md5De(db, "projecao_excluir_importacao")).toBe(MD5.excluir_importacao);
    expect(await md5De(db, "projecao_alterar_operador")).toBe(MD5.alterar_operador);
    await semEmail(db);
    await excluir(db); // volta a ceder -- e e por isso que o rollback avisa
    expect(JSON.parse((await foto(db)).pagamentos)).toHaveLength(0);
    await db.close();
  });
});

describe("migration B: as cinco restantes, no nivel da mecanica", () => {
  // Deliberadamente sem bancada comportamental das cinco -- ver o cabeçalho.
  const ESPERADAS = [
    ["public.projecao_reprocessar_importacao(uuid)", "4b3d3e4792f61c7d660d1a3d38f09b58", "914d6f1246b3005aedd979f8a9b5af80"],
    ["public.registrar_decisao_suspeita_duplicidade(uuid,text,uuid,uuid,text)", "5c91e1545c85a850471e533831e01b1c", "3caee080465ea1da3992eac032dfe453"],
    ["public.projecao_definir_meta(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)", "fa0b6f76caca6a1f3b70b5660c10206a", "ecb5a8560012fde8bf6b95335afb2b90"],
    ["public.projecao_definir_meta(text,numeric,numeric)", "51f402b6b805c46157ed23e41576a377", "0d652f76597fc8115ff9ab03db13f2a2"],
    ["public.projecao_definir_meta_operador(text,text,numeric)", "1c06b879be23e360a2b41e24e47993db", "e36033aa65cdf4618a2c76b08f4d73ad"],
  ];

  it("declara exatamente as cinco assinaturas, com md5 antes e depois", () => {
    for (const [assinatura, antes, depois] of ESPERADAS) {
      expect(MIG_B).toContain(assinatura);
      expect(MIG_B).toContain(antes);
      expect(MIG_B).toContain(depois);
    }
    // e nenhuma das duas prioritárias, que são da migration A
    expect(MIG_B).not.toContain("projecao_excluir_importacao");
    expect(MIG_B.match(/^      \('public\./gm)).toHaveLength(5);
  });

  it("usa a mesma ancora e a mesma troca da A, e as tres travas", () => {
    for (const texto of [MIG_A, MIG_B]) {
      expect(texto).toContain("'IF v_email NOT IN ('");
      expect(texto).toContain("'IF v_email IS NULL OR v_email NOT IN ('");
      expect(texto).toContain("CORPO INESPERADO");
      expect(texto).toContain("ANCORA NAO UNICA");
      expect(texto).toContain("RESULTADO INESPERADO");
      expect(texto).toContain("pg_get_functiondef");
    }
  });

  it("nenhuma das duas migrations retypa corpo de funcao", () => {
    for (const texto of [MIG_A, MIG_B]) {
      // o unico create function do arquivo e o do proprio bloco do$$ (nenhum)
      expect(texto).not.toMatch(/create\s+or\s+replace\s+function/i);
    }
  });

  it("a troca ancorada produz a condicao pretendida, em qualquer corpo", async () => {
    const db = await novoBanco();
    const { rows } = await db.query(
      `select replace(
                'IF v_email NOT IN (''a@x'', ''b@x'') THEN',
                'IF v_email NOT IN (', 'IF v_email IS NULL OR v_email NOT IN (') r`);
    expect(rows[0].r).toBe("IF v_email IS NULL OR v_email NOT IN ('a@x', 'b@x') THEN");
    await db.close();
  });

  it("B: RECUSA aplicar sobre funcao diferente da medida", async () => {
    const db = await novoBanco();
    await db.exec(`
      create or replace function public.projecao_reprocessar_importacao(p_importacao_id uuid)
       returns void language plpgsql security definer set search_path to 'public'
      as $f$ begin return; end $f$;`);
    await expect(db.exec(semTransacao(MIG_B))).rejects.toThrow(/CORPO INESPERADO|FUNCAO AUSENTE/);
    await db.close();
  });

  it("B documenta a isencao de service_role da suspeita de duplicidade", () => {
    expect(MIG_B).toMatch(/service_role/);
    expect(MIG_B).toMatch(/PASSA A BLOQUEAR a chave/);
  });
});
