// CONFERÊNCIA DE PAGAMENTOS POR ARQUIVO — num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (20261023210000) e o ROLLBACK REAL sobre a bancada da
// rodada incremental (21/10) + a migration da triagem da #737 (20261023000700)
// + o cenário desta frente.
//
// ESCOPO DECLARADO, para não haver dúvida sobre o que está provado:
//
//   Prova-se que o CLASSIFICADOR particiona os pagamentos de um arquivo em
//   categorias MUTUAMENTE EXCLUSIVAS, que a contagem e a soma por categoria
//   fecham com o total do arquivo, que nenhum pagamento aparece duas vezes, e
//   que os dois fenômenos medidos em produção (os 246 baixados com linha de
//   fila resolvida, e os 115 com fila de outro arquivo) são tratados.
//
//   NÃO se prova que a produção tem estes números: a base é sintética. As
//   medições de 23/10/2026 estão no cabeçalho da migration, com as consultas.
//
//   NÃO se prova regra financeira nenhuma, porque não há nenhuma nova: a view
//   LÊ. O teste de ausência de escrita abaixo é o que fixa isso.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que
// a executa, num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const BANCADA = ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.sql");
const TRIAGEM = ler("supabase/migrations/20261023000700_fila_pagamento_triagem.sql");
const CENARIO = ler("supabase/tests/fixtures/importacao_conferencia_cenario.sql");
const MIGRATION = ler("supabase/migrations/20261023210000_importacao_conferencia_por_arquivo.sql");
const ROLLBACK = ler("supabase/rollbacks/20261023210000_importacao_conferencia_por_arquivo.rollback.sql");

// `begin;`/`commit;` conflitam com o controle de transação do db.exec do PGlite.
const semTransacao = (sql) => sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

const ARQ_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const ARQ_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const ARQ_C = "cccccccc-0000-0000-0000-00000000000c";
const GESTAO = "amanda.seibel@aelbra.com.br";

let db;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  // O CENARIO vem ANTES da triagem de proposito: ele acrescenta as colunas que
  // a view da #737 le (`titulo_numero`) e que a bancada base nao tem. Na ordem
  // inversa a triagem nao compila.
  await db.exec(CENARIO);
  await db.exec(semTransacao(TRIAGEM));
  await db.exec(semTransacao(MIGRATION));
  await comoGestao();
});

const comoGestao = () =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"${GESTAO}"}', false)`);
const comoOperador = () =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"cobranca05@aelbra.com.br"}', false)`);
const semIdentidade = () =>
  db.exec(`select set_config('request.jwt.claims', '{}', false)`);

const linhas = async (sql, params = []) => (await db.query(sql, params)).rows;

const arquivos = async () =>
  linhas(`select * from public.importacao_conferencia_arquivos(30)`);
const arquivo = async (id) => (await arquivos()).find((a) => a.importacao_id === id);
const conferir = async (id, categoria = null, busca = null) =>
  linhas(`select * from public.importacao_conferencia_ler($1::uuid, $2, $3, 500)`, [id, categoria, busca]);

describe("a view: uma linha por pagamento, categoria exclusiva", () => {
  it("nenhum pagamento aparece duas vezes na view", async () => {
    const r = await linhas(
      `select count(*) total, count(distinct pagamento_id) distintos
         from public.vw_importacao_conferencia`
    );
    expect(Number(r[0].total)).toBe(Number(r[0].distintos));
  });

  it("todo pagamento com importacao recebe exatamente uma categoria", async () => {
    const r = await linhas(
      `select pagamento_id, count(*) c from public.vw_importacao_conferencia
        group by 1 having count(*) <> 1`
    );
    expect(r).toEqual([]);
  });

  it("nenhum pagamento cai em NAO_CLASSIFICADO neste cenario", async () => {
    const r = await linhas(
      `select pagamento_id from public.vw_importacao_conferencia where categoria = 'NAO_CLASSIFICADO'`
    );
    expect(r).toEqual([]);
  });

  it("cada pagamento do cenario cai na categoria esperada", async () => {
    const r = await linhas(
      `select pagamento_id::text id, categoria from public.vw_importacao_conferencia
        where importacao_id in ($1::uuid, $2::uuid) order by pagamento_id`, [ARQ_A, ARQ_B]
    );
    expect(r.map((x) => [x.id.slice(0, 8), x.categoria])).toEqual([
      ["11111111", "BAIXA_REGISTRADA_CRM"],
      ["22222222", "BAIXA_REGISTRADA_CRM"],
      ["33333333", "DIVERGENCIA"],
      ["44444444", "SEM_VINCULO"],
      ["55555555", "BAIXA_PENDENTE"],
      ["66666666", "FORA_DA_JANELA"],
      ["77777777", "DIVERGENCIA"],
    ]);
  });
});

describe("as contas FECHAM: categorias somam o total do arquivo", () => {
  it("contagem das categorias = total de pagamentos do arquivo", async () => {
    const a = await arquivo(ARQ_A);
    const soma =
      a.baixa_registrada_crm + a.baixa_pendente + a.divergencia +
      a.sem_vinculo + a.fora_da_janela + a.nao_classificado;
    expect(a.pagamentos).toBe(6);
    expect(soma).toBe(a.pagamentos);
  });

  it("soma dos valores das categorias = total financeiro do arquivo", async () => {
    const a = await arquivo(ARQ_A);
    const n = (v) => Number(v || 0);
    const soma =
      n(a.baixa_registrada_valor) + n(a.baixa_pendente_valor) + n(a.divergencia_valor) +
      n(a.sem_vinculo_valor) + n(a.fora_da_janela_valor);
    expect(n(a.valor_total)).toBe(2100);
    expect(soma).toBe(n(a.valor_total));
  });

  it("os valores por categoria sao os esperados, um a um", async () => {
    const a = await arquivo(ARQ_A);
    const n = (v) => Number(v || 0);
    expect(n(a.baixa_registrada_valor)).toBe(300); // P1 100 + P2 200
    expect(n(a.divergencia_valor)).toBe(300);      // P3
    expect(n(a.sem_vinculo_valor)).toBe(400);      // P4
    expect(n(a.baixa_pendente_valor)).toBe(500);   // P5
    expect(n(a.fora_da_janela_valor)).toBe(600);   // P6
  });

  // SENSIBILIDADE: se o fechamento das contas fosse trivialmente verdadeiro,
  // os testes acima passariam mesmo com o classificador errado. Aqui um
  // pagamento novo entra e o total TEM de mudar -- prova que a conta mede.
  it("SENSIBILIDADE: pagamento novo no arquivo muda o total", async () => {
    const antes = await arquivo(ARQ_A);
    await db.exec(`
      insert into public.pagamentos (id, importacao_id, data_pagamento, valor_pago, status_conciliacao)
      values ('99999999-0000-0000-0000-000000000099', '${ARQ_A}', '2026-08-01', 50, null)`);
    const depois = await arquivo(ARQ_A);
    expect(depois.pagamentos).toBe(antes.pagamentos + 1);
    expect(Number(depois.valor_total)).toBe(Number(antes.valor_total) + 50);
    await db.exec(`delete from public.pagamentos where id = '99999999-0000-0000-0000-000000000099'`);
  });
});

describe("os dois fenomenos medidos em producao", () => {
  // Em producao: 246 baixados COM linha de fila, ZERO com a fila aberta.
  it("baixado com fila JA RESOLVIDA continua baixa registrada, e nao e pendencia", async () => {
    const r = await linhas(
      `select categoria, fila_aberta from public.vw_importacao_conferencia
        where pagamento_id = '22222222-0000-0000-0000-000000000002'`
    );
    expect(r[0].categoria).toBe("BAIXA_REGISTRADA_CRM");
    expect(r[0].fila_aberta).toBe(false);
  });

  // Em producao: 115 linhas de fila com importacao_id divergente do pagamento.
  it("pendencia de OUTRO arquivo fica destacada e FORA das contagens do arquivo", async () => {
    const a = await arquivo(ARQ_A);
    // P7 nao entra nas 6 contagens do arquivo A...
    expect(a.pagamentos).toBe(6);
    // ...mas aparece como pendencia historica relacionada
    expect(a.pendencias_historicas_relacionadas).toBe(1);
    // e pertence, de fato, ao arquivo B
    const b = await arquivo(ARQ_B);
    expect(b.pagamentos).toBe(1);
    const linhasB = await conferir(ARQ_B);
    expect(linhasB).toHaveLength(1);
    expect(linhasB[0].fila_de_outro_arquivo).toBe(true);
  });

  it("nenhum pagamento e atribuido ao arquivo errado", async () => {
    // a view atribui SEMPRE por pagamentos.importacao_id
    const r = await linhas(
      `select count(*) c from public.vw_importacao_conferencia v
         join public.pagamentos p on p.id = v.pagamento_id
        where v.importacao_id is distinct from p.importacao_id`
    );
    expect(Number(r[0].c)).toBe(0);
  });
});

describe("baixa registrada: prova por registro, nunca por status", () => {
  it("quem e baixa registrada tem parcela e evidencia", async () => {
    const r = await conferir(ARQ_A, "BAIXA_REGISTRADA_CRM");
    expect(r).toHaveLength(2);
    for (const l of r) {
      expect(l.parcela_baixada_id).toBeTruthy();
      expect(l.baixa_origem).toBe("GATILHO_IMPORTACAO");
      expect(l.baixa_em).toBeTruthy();
    }
  });

  // O teste que fixa a regra: status PAGO sozinho NAO vira baixa confirmada.
  it("parcela PAGO sem apontar para o pagamento NAO vira baixa registrada", async () => {
    await db.exec(`
      insert into public.parcelas (id, numero, valor, vencimento, status)
      values ('aa888888-0000-0000-0000-000000000008', 1, 300, '2026-10-10', 'PAGO')`);
    const r = await linhas(
      `select categoria from public.vw_importacao_conferencia
        where pagamento_id = '33333333-0000-0000-0000-000000000003'`
    );
    expect(r[0].categoria).toBe("DIVERGENCIA");
    await db.exec(`delete from public.parcelas where id = 'aa888888-0000-0000-0000-000000000008'`);
  });

  it("FORA_DA_JANELA nunca e apresentado como baixa pendente", async () => {
    const r = await conferir(ARQ_A, "FORA_DA_JANELA");
    expect(r).toHaveLength(1);
    expect(r[0].status_conciliacao).toBeNull();
    const pendentes = await conferir(ARQ_A, "BAIXA_PENDENTE");
    expect(pendentes.map((l) => l.pagamento_id)).not.toContain(r[0].pagamento_id);
  });
});

describe("duplicidade: sinal, nao categoria", () => {
  it("a suspeita aparece como sinal sem tirar o pagamento da sua categoria", async () => {
    const r = await linhas(
      `select categoria, tem_suspeita_duplicidade from public.vw_importacao_conferencia
        where pagamento_id = '66666666-0000-0000-0000-000000000006'`
    );
    expect(r[0].tem_suspeita_duplicidade).toBe(true);
    expect(r[0].categoria).toBe("FORA_DA_JANELA");
  });

  it("o resumo conta a suspeita sem somar numa categoria propria", async () => {
    const a = await arquivo(ARQ_A);
    expect(a.com_suspeita_duplicidade).toBe(1);
    // e o fechamento das contas segue valendo
    const soma = a.baixa_registrada_crm + a.baixa_pendente + a.divergencia +
      a.sem_vinculo + a.fora_da_janela + a.nao_classificado;
    expect(soma).toBe(a.pagamentos);
  });
});

describe("o motivo vem da triagem da #737, nao de regra nova", () => {
  it("cada pendencia traz subcategoria e motivo da triagem", async () => {
    const div = await conferir(ARQ_A, "DIVERGENCIA");
    expect(div[0].triagem_subcategoria).toBe("acordo_cancelado_fluxo_proprio");
    const sem = await conferir(ARQ_A, "SEM_VINCULO");
    expect(sem[0].triagem_subcategoria).toBe("acordo_ausente_no_crm");
    const pend = await conferir(ARQ_A, "BAIXA_PENDENTE");
    expect(pend[0].triagem_subcategoria).toBe("escolher_aluno_sugerido");
    expect(pend[0].acao_sugerida).toBe("ESCOLHER_ALUNO");
  });

  it("baixa registrada nao carrega motivo de pendencia", async () => {
    const r = await conferir(ARQ_A, "BAIXA_REGISTRADA_CRM");
    for (const l of r) expect(l.triagem_subcategoria).toBeNull();
  });
});

describe("a lista de arquivos", () => {
  it("arquivo SEM pagamento aparece com zero, em vez de desaparecer", async () => {
    const c = await arquivo(ARQ_C);
    expect(c).toBeTruthy();
    expect(c.pagamentos).toBe(0);
    expect(Number(c.valor_total)).toBe(0);
  });

  it("vem em ordem do mais recente para o mais antigo", async () => {
    const todos = await arquivos();
    const datas = todos.map((a) => new Date(a.importado_em).getTime());
    expect([...datas].sort((x, y) => y - x)).toEqual(datas);
  });
});

describe("busca e filtro", () => {
  it("busca por nome, matricula, acordo e parcela encontra o mesmo pagamento", async () => {
    for (const termo of ["ALUNO TRES", "2026000003", "50003", "50003510001"]) {
      const r = await conferir(ARQ_A, null, termo);
      expect(r.map((l) => l.pagamento_id)).toEqual(["33333333-0000-0000-0000-000000000003"]);
    }
  });

  it("busca vazia nao filtra nada", async () => {
    expect(await conferir(ARQ_A, null, "   ")).toHaveLength(6);
    expect(await conferir(ARQ_A, null, null)).toHaveLength(6);
  });

  it("a ordem de trabalho poe o que precisa de gente primeiro", async () => {
    const r = await conferir(ARQ_A);
    expect(r.map((l) => l.categoria)).toEqual([
      "DIVERGENCIA", "SEM_VINCULO", "BAIXA_PENDENTE",
      "FORA_DA_JANELA", "BAIXA_REGISTRADA_CRM", "BAIXA_REGISTRADA_CRM",
    ]);
  });
});

describe("portao de acesso", () => {
  it("operador NAO autorizado e recusado nas duas funcoes", async () => {
    await comoOperador();
    await expect(arquivos()).rejects.toThrow(/gestao financeira/i);
    await expect(conferir(ARQ_A)).rejects.toThrow(/gestao financeira/i);
    await comoGestao();
  });

  // A licao de 22/10: sem o `coalesce(..., false)`, identidade nula passaria.
  it("identidade NULA e recusada", async () => {
    await semIdentidade();
    await expect(arquivos()).rejects.toThrow(/gestao financeira/i);
    await expect(conferir(ARQ_A)).rejects.toThrow(/gestao financeira/i);
    await comoGestao();
  });

  it("a view nao e legivel por authenticated: o acesso e pelas funcoes", async () => {
    const r = await linhas(
      `select has_table_privilege('authenticated', 'public.vw_importacao_conferencia', 'SELECT') as pode`
    );
    expect(r[0].pode).toBe(false);
  });

  it("authenticated nao escreve na view", async () => {
    for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
      const r = await linhas(
        `select has_table_privilege('authenticated', 'public.vw_importacao_conferencia', $1) as pode`, [priv]
      );
      expect(r[0].pode).toBe(false);
    }
  });

  it("a view usa security_invoker, para nao contornar a RLS das tabelas base", async () => {
    const r = await linhas(
      `select array_to_string(c.reloptions, ',') opts from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='vw_importacao_conferencia'`
    );
    expect(r[0].opts || "").toContain("security_invoker=true");
  });
});

describe("NAO ESCREVE: a conferencia so le", () => {
  it("chamar as duas funcoes nao muda nenhuma tabela financeira", async () => {
    const foto = async () => {
      const q = async (sql) => JSON.stringify((await db.query(sql)).rows);
      return [
        await q(`select * from public.pagamentos order by id`),
        await q(`select * from public.parcelas order by id`),
        await q(`select * from public.fila_pagamento_sem_vinculo order by id`),
        await q(`select * from public.importacoes order by id`),
        await q(`select * from public.pagamento_suspeita_duplicidade order by id`),
      ].join("\n");
    };
    const antes = await foto();
    await arquivos();
    await conferir(ARQ_A);
    await conferir(ARQ_A, "DIVERGENCIA", "ALUNO");
    expect(await foto()).toBe(antes);
  });

  it("a migration nao contem DML nem DDL de tabela", () => {
    const corpo = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(corpo).not.toMatch(/\binsert\s+into\b/i);
    expect(corpo).not.toMatch(/\bupdate\s+public\./i);
    expect(corpo).not.toMatch(/\bdelete\s+from\b/i);
    expect(corpo).not.toMatch(/\bcreate\s+table\b/i);
    expect(corpo).not.toMatch(/\balter\s+table\b/i);
    expect(corpo).not.toMatch(/\bcreate\s+trigger\b/i);
    expect(corpo).not.toMatch(/cron\.schedule/i);
  });
});

describe("rollback", () => {
  it("remove os tres objetos e nao toca na triagem da #737", async () => {
    await db.exec(semTransacao(ROLLBACK));
    const r = await linhas(
      `select
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname='vw_importacao_conferencia') as view_minha,
         (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname like 'importacao_conferencia%') as funcoes_minhas,
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname='vw_fila_pagamento_triagem') as view_737,
         (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='fila_pagamento_triagem_ler') as funcao_737`
    );
    expect(Number(r[0].view_minha)).toBe(0);
    expect(Number(r[0].funcoes_minhas)).toBe(0);
    // a #737 fica INTACTA -- apagar ela aqui derrubaria a tela dela
    expect(Number(r[0].view_737)).toBe(1);
    expect(Number(r[0].funcao_737)).toBe(1);
  });

  it("rodar o rollback duas vezes nao quebra", async () => {
    await db.exec(semTransacao(ROLLBACK));
    await db.exec(semTransacao(ROLLBACK));
  });
});
