// TRIAGEM DA FILA DE PAGAMENTOS — num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (supabase/migrations/20261023000700_*.sql) e o ROLLBACK
// REAL sobre a bancada de producao da rodada incremental (21/10) mais a BASE DE
// REFERENCIA das 448 pendencias (22/10).
//
// ESCOPO DECLARADO, para nao haver duvida sobre o que esta provado:
//
//   Prova-se que O CLASSIFICADOR reproduz a particao declarada em
//   `_referencia_triagem` -- contagem e valor, subcategoria por subcategoria,
//   fechando em 448 / R$ 377.515,27 sem duplicidade e sem residuo.
//
//   NAO se prova que a producao tem esses numeros hoje: a base e sintetica e
//   reproduz uma medicao de 22/10/2026, registrada com as consultas em
//   docs/TRIAGEM-FILA-PAGAMENTO-2026-10-22.md. Se a producao mudar, muda a
//   medicao -- nao este teste.
//
//   NAO se prova regra financeira nenhuma. A triagem nao decide vinculo,
//   conciliacao nem baixa; ela LÊ. O teste de ausencia de escrita (abaixo) e o
//   que fixa isso.
//
// A migration NAO FOI APLICADA em banco nenhum. Este teste e a unica coisa que
// a executa, num banco efemero que morre no fim.
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
const MD5 = JSON.parse(ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.md5.json"));
const REFERENCIA = ler("supabase/tests/fixtures/fila_pagamento_triagem_referencia.sql");
const MIGRATION = ler("supabase/migrations/20261023000700_fila_pagamento_triagem.sql");
const ROLLBACK = ler("supabase/rollbacks/20261023000700_fila_pagamento_triagem.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";
const OPERADOR = "cobranca05@aelbra.com.br";

// O TOTAL MEDIDO EM PRODUCAO EM 22/10/2026. Escrito aqui como literal, de
// proposito: se a base de referencia for editada sem que a medicao mude, o
// fechamento quebra aqui em vez de passar com um total novo em silencio.
const TOTAL_PENDENCIAS = 448;
const TOTAL_VALOR = "377515.27";

const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);
const comoServico = (db) =>
  db.query("select set_config('request.jwt.claims','',false), set_config('request.jwt.role','service_role',false)");
const semLogin = (db) =>
  db.query("select set_config('request.jwt.claims','',false), set_config('request.jwt.role','',false)");

let db;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(REFERENCIA);
  await db.exec(MIGRATION);
  // O portao da funcao leitora chama `auth.role()`; fora dos testes de papel,
  // o default e "pessoa logada, nao servico".
  await db.query("select set_config('request.jwt.role','authenticated',false)");
});

describe("a bancada e os corpos de producao", () => {
  it("usa o corpo EXATO de producao de usuario_e_gestao e do gatilho de tentativas", async () => {
    for (const [nome, esperado] of Object.entries(MD5)) {
      const alvo = nome.replace(/^public\./, "");
      const r = await q1(
        db,
        `select md5(p.prosrc) as md5 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [alvo],
      );
      expect(r?.md5, `corpo de ${nome} divergiu do de producao`).toBe(esperado);
    }
  });

  it("a base de referencia declara 448 pendencias e R$ 377.515,27", async () => {
    const r = await q1(
      db,
      `select sum(quantidade)::int as n, sum(valor_total)::numeric(14,2)::text as valor
         from public._referencia_triagem`,
    );
    expect(r.n).toBe(TOTAL_PENDENCIAS);
    expect(r.valor).toBe(TOTAL_VALOR);
  });
});

describe("fechamento dos 448", () => {
  it("a view devolve exatamente 448 linhas e R$ 377.515,27", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n, sum(valor_pago)::numeric(14,2)::text as valor
         from public.vw_fila_pagamento_triagem`,
    );
    expect(r.n).toBe(TOTAL_PENDENCIAS);
    expect(r.valor).toBe(TOTAL_VALOR);
  });

  it("uma linha por pagamento: distintos = total", async () => {
    const r = await q1(
      db,
      `select count(*)::int as linhas, count(distinct pagamento_id)::int as distintos
         from public.vw_fila_pagamento_triagem`,
    );
    expect(r.linhas).toBe(TOTAL_PENDENCIAS);
    expect(r.distintos).toBe(r.linhas);
  });

  it("cada subcategoria fecha na contagem e no valor declarados", async () => {
    const linhas = await qn(
      db,
      `select r.subcategoria,
              r.quantidade                          as esperado_n,
              r.valor_total::text                   as esperado_valor,
              count(t.pagamento_id)::int            as obtido_n,
              coalesce(sum(t.valor_pago),0)::numeric(14,2)::text as obtido_valor,
              r.categoria                           as esperada_categoria,
              coalesce(max(t.categoria), '(nenhuma)') as obtida_categoria
         from public._referencia_triagem r
         left join public.vw_fila_pagamento_triagem t
                on t.subcategoria = r.subcategoria
        group by r.subcategoria, r.quantidade, r.valor_total, r.categoria
        order by r.subcategoria`,
    );
    expect(linhas.length).toBe(10);
    for (const l of linhas) {
      expect(l.obtido_n, `contagem de ${l.subcategoria}`).toBe(l.esperado_n);
      expect(l.obtido_valor, `valor de ${l.subcategoria}`).toBe(l.esperado_valor);
      expect(l.obtida_categoria, `categoria de ${l.subcategoria}`).toBe(l.esperada_categoria);
    }
  });

  it("as 4 categorias somam o total, e sao exatamente quatro", async () => {
    const linhas = await qn(
      db,
      `select categoria, count(*)::int as n, sum(valor_pago)::numeric(14,2)::text as valor
         from public.vw_fila_pagamento_triagem group by 1 order by 1`,
    );
    expect(linhas.map((l) => l.categoria)).toEqual([
      "ACIONAVEL_ADMINISTRATIVO",
      "AGUARDANDO_INFORMACAO_ACORDO",
      "BLOQUEADO_ETAPA_DESATIVADA",
      "CONFERENCIA_HUMANA",
    ]);
    expect(linhas.map((l) => l.n)).toEqual([87, 22, 265, 74]);
    expect(linhas.map((l) => l.valor)).toEqual([
      "63730.17",
      "27564.25",
      "186318.47",
      "99902.38",
    ]);
  });

  it("nenhuma pendencia cai em nao_classificado", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n from public.vw_fila_pagamento_triagem
        where subcategoria = 'nao_classificado'`,
    );
    expect(r.n).toBe(0);
  });
});

describe("a fronteira de 14/09 e o que nao e pendencia", () => {
  it("pagamento com status_conciliacao nulo NAO entra (os 8.955 historicos)", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n from public.vw_fila_pagamento_triagem
        where pagamento_id = '11111111-0000-0000-0000-999999999999'`,
    );
    expect(r.n).toBe(0);
  });

  it("pagamento BAIXADO NAO entra", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n from public.vw_fila_pagamento_triagem
        where pagamento_id = '11111111-0000-0000-0000-888888888888'`,
    );
    expect(r.n).toBe(0);
  });
});

describe("os 33 decididos e ainda pendentes aparecem", () => {
  it("estao na triagem, em CONFERENCIA_HUMANA, com a decisao visivel", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n,
              sum(valor_pago)::numeric(14,2)::text as valor,
              count(*) filter (where decisao is not null)::int as com_decisao,
              count(*) filter (where categoria = 'CONFERENCIA_HUMANA')::int as na_conferencia
         from public.vw_fila_pagamento_triagem
        where subcategoria = 'decidida_mas_ainda_pendente'`,
    );
    expect(r.n).toBe(33);
    expect(r.valor).toBe("83203.30");
    expect(r.com_decisao).toBe(33);
    expect(r.na_conferencia).toBe(33);
  });

  it("nao ganham acao sugerida: o que falta ali e conferencia", async () => {
    const r = await q1(
      db,
      `select count(*) filter (where acao_sugerida is not null)::int as com_acao
         from public.vw_fila_pagamento_triagem
        where subcategoria = 'decidida_mas_ainda_pendente'`,
    );
    expect(r.com_acao).toBe(0);
  });

  it("o predicado que os esconde na tela os traria a ZERO -- e a razao de nao herda-lo", async () => {
    // Reproduz literalmente o predicado de `pagamentos_sem_aluno` e de
    // `fluxo_pagamentos_incremental`. Se a view voltar a herda-lo, a categoria
    // CONFERENCIA_HUMANA perde os 33 e este teste cai.
    const r = await q1(
      db,
      `select count(*)::int as n
         from public.vw_fila_pagamento_triagem t
        where not exists (select 1 from public.fila_pagamento_sem_vinculo fd
                           where fd.pagamento_id = t.pagamento_id
                             and fd.decisao is not null)
          and t.subcategoria = 'decidida_mas_ainda_pendente'`,
    );
    expect(r.n).toBe(0);
  });
});

describe("dado estruturado manda; texto livre so onde nao ha coluna", () => {
  it("as 42 com sugestao entram por `sugestoes`, nao pelo texto do motivo", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n,
              count(*) filter (where motivo ilike '%sugestao%')::int as texto_menciona
         from public.vw_fila_pagamento_triagem
        where subcategoria = 'escolher_aluno_sugerido'`,
    );
    expect(r.n).toBe(42);
    // O molde da base de referencia NAO menciona sugestao -- e o caso de
    // producao em que 31 de 42 ficariam invisiveis a quem lesse o texto.
    expect(r.texto_menciona).toBe(0);
  });

  it("sugestao vazia nao promove a acionavel -- cai para o que o resto do caso diz", async () => {
    // Os 5 alvos sao guardados por id: a restauracao devolve EXATAMENTE eles, e
    // o fechamento dos 448 e reconferido no fim para provar que a ida e a volta
    // nao deixaram resto.
    const alvos = (
      await qn(
        db,
        `select pagamento_id from public.vw_fila_pagamento_triagem
          where subcategoria = 'escolher_aluno_sugerido'
          order by pagamento_id limit 5`,
      )
    ).map((l) => l.pagamento_id);
    expect(alvos.length).toBe(5);

    await db.query(
      "update public.fila_pagamento_sem_vinculo set sugestoes = '[]'::jsonb where pagamento_id = any($1::uuid[])",
      [alvos],
    );
    const r = await q1(
      db,
      `select count(*) filter (where subcategoria = 'escolher_aluno_sugerido')::int as com_sugestao,
              count(*) filter (where pagamento_id = any($1::uuid[])
                                 and categoria = 'BLOQUEADO_ETAPA_DESATIVADA')::int as foram_bloqueados,
              count(*) filter (where pagamento_id = any($1::uuid[])
                                 and categoria = 'ACIONAVEL_ADMINISTRATIVO')::int as seguem_acionaveis
         from public.vw_fila_pagamento_triagem`,
      [alvos],
    );
    expect(r.com_sugestao).toBe(37);
    expect(r.seguem_acionaveis).toBe(0);
    // O molde destas 42 diz "sem CPF no pagamento", nao promete a API: sem a
    // sugestao elas caem em AGUARDANDO_INFORMACAO_ACORDO, nao em bloqueadas.
    expect(r.foram_bloqueados).toBe(0);

    await db.query(
      `update public.fila_pagamento_sem_vinculo f
          set sugestoes = jsonb_build_array(jsonb_build_object('aluno_id', p.aluno_id,
                                                               'nome', 'ALUNO SINTETICO'))
         from public.pagamentos p
        where p.id = f.pagamento_id and f.pagamento_id = any($1::uuid[])`,
      [alvos],
    );
    const volta = await q1(
      db,
      `select count(*)::int as n, sum(valor_pago)::numeric(14,2)::text as valor,
              count(*) filter (where subcategoria = 'escolher_aluno_sugerido')::int as com_sugestao
         from public.vw_fila_pagamento_triagem`,
    );
    expect(volta.com_sugestao).toBe(42);
    expect(volta.n).toBe(TOTAL_PENDENCIAS);
    expect(volta.valor).toBe(TOTAL_VALOR);
  });
});

describe("a etapa bloqueadora vem da configuracao, nao do nome fixo", () => {
  it("as 265 nomeiam `consulta_portador` como etapa desligada", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n,
              count(*) filter (where etapa_desligada = 'consulta_portador')::int as nomeia,
              count(*) filter (where consulta_portador_em is null)::int as nunca_consultada
         from public.vw_fila_pagamento_triagem
        where categoria = 'BLOQUEADO_ETAPA_DESATIVADA'`,
    );
    expect(r.n).toBe(265);
    expect(r.nomeia).toBe(265);
    // O numero de consultas de fato tentadas e ZERO, nao o do contador de toques.
    expect(r.nunca_consultada).toBe(265);
  });

  it("religar a etapa reclassifica sozinho: as 265 viram AGUARDANDO_INFORMACAO_ACORDO", async () => {
    await db.query(
      "update public.fluxo_pagamentos_config set ligado = true where etapa = 'consulta_portador'",
    );
    const depois = await qn(
      db,
      `select categoria, count(*)::int as n from public.vw_fila_pagamento_triagem
        group by 1 order by 1`,
    );
    const mapa = Object.fromEntries(depois.map((l) => [l.categoria, l.n]));
    expect(mapa.BLOQUEADO_ETAPA_DESATIVADA ?? 0).toBe(0);
    expect(mapa.AGUARDANDO_INFORMACAO_ACORDO).toBe(22 + 265);

    // O total nao muda: reclassificar nao cria nem perde pendencia.
    const t = await q1(
      db,
      `select count(*)::int as n, sum(valor_pago)::numeric(14,2)::text as valor
         from public.vw_fila_pagamento_triagem`,
    );
    expect(t.n).toBe(TOTAL_PENDENCIAS);
    expect(t.valor).toBe(TOTAL_VALOR);

    await db.query(
      "update public.fluxo_pagamentos_config set ligado = false where etapa = 'consulta_portador'",
    );
  });

  it("a etapa desligada so vale enquanto a consulta nao aconteceu", async () => {
    const alvo = await q1(
      db,
      `select pagamento_id from public.vw_fila_pagamento_triagem
        where categoria = 'BLOQUEADO_ETAPA_DESATIVADA' order by pagamento_id limit 1`,
    );
    await db.query(
      `update public.fila_pagamento_sem_vinculo set consulta_portador_em = now()
        where pagamento_id = $1`,
      [alvo.pagamento_id],
    );
    const r = await q1(
      db,
      `select categoria, subcategoria from public.vw_fila_pagamento_triagem
        where pagamento_id = $1`,
      [alvo.pagamento_id],
    );
    // Consultada, a pendencia deixa de estar "parada pela etapa": o que falta
    // passa a ser a informacao do acordo.
    expect(r.categoria).toBe("AGUARDANDO_INFORMACAO_ACORDO");
    expect(r.subcategoria).toBe("acordo_ausente_no_crm");

    await db.query(
      `update public.fila_pagamento_sem_vinculo set consulta_portador_em = null
        where pagamento_id = $1`,
      [alvo.pagamento_id],
    );
  });
});

describe("acordo cancelado e contado, nunca acionado (frente da PR #694)", () => {
  it("os 7 ficam em CONFERENCIA_HUMANA e sem acao sugerida", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n, sum(valor_pago)::numeric(14,2)::text as valor,
              count(*) filter (where categoria = 'CONFERENCIA_HUMANA')::int as na_conferencia,
              count(*) filter (where acao_sugerida is not null)::int as com_acao
         from public.vw_fila_pagamento_triagem
        where subcategoria = 'acordo_cancelado_fluxo_proprio'`,
    );
    expect(r.n).toBe(7);
    expect(r.valor).toBe("4511.23");
    expect(r.na_conferencia).toBe(7);
    expect(r.com_acao).toBe(0);
  });

  it("uma sugestao de aluno NAO promove acordo cancelado a acionavel", async () => {
    const alvo = await q1(
      db,
      `select pagamento_id from public.vw_fila_pagamento_triagem
        where subcategoria = 'acordo_cancelado_fluxo_proprio' order by pagamento_id limit 1`,
    );
    await db.query(
      `update public.fila_pagamento_sem_vinculo
          set sugestoes = jsonb_build_array(jsonb_build_object('aluno_id',
                '22222222-0000-0000-0000-000000000001', 'nome', 'QUALQUER'))
        where pagamento_id = $1`,
      [alvo.pagamento_id],
    );
    const r = await q1(
      db,
      `select categoria, subcategoria, acao_sugerida
         from public.vw_fila_pagamento_triagem where pagamento_id = $1`,
      [alvo.pagamento_id],
    );
    expect(r.categoria).toBe("CONFERENCIA_HUMANA");
    expect(r.subcategoria).toBe("acordo_cancelado_fluxo_proprio");
    expect(r.acao_sugerida).toBeNull();

    await db.query(
      `update public.fila_pagamento_sem_vinculo set sugestoes = '[]'::jsonb
        where pagamento_id = $1`,
      [alvo.pagamento_id],
    );
  });
});

describe("acao sugerida existe so onde ha caminho declarado", () => {
  it("as duas unicas acoes sao ESCOLHER_ALUNO e CONFERIR_E_ENCERRAR", async () => {
    const linhas = await qn(
      db,
      `select coalesce(acao_sugerida,'(nula)') as acao, count(*)::int as n
         from public.vw_fila_pagamento_triagem group by 1 order by 1`,
    );
    const mapa = Object.fromEntries(linhas.map((l) => [l.acao, l.n]));
    expect(mapa.CONFERIR_E_ENCERRAR).toBe(45);
    expect(mapa.ESCOLHER_ALUNO).toBe(42);
    expect(mapa["(nula)"]).toBe(TOTAL_PENDENCIAS - 87);
  });

  it("toda linha com acao esta em ACIONAVEL_ADMINISTRATIVO", async () => {
    const r = await q1(
      db,
      `select count(*)::int as n from public.vw_fila_pagamento_triagem
        where acao_sugerida is not null and categoria <> 'ACIONAVEL_ADMINISTRATIVO'`,
    );
    expect(r.n).toBe(0);
  });
});

describe("o portao da funcao leitora", () => {
  it("gestao le as 448", async () => {
    await como(db, GESTAO);
    const r = await q1(
      db,
      "select count(*)::int as n from public.fila_pagamento_triagem_ler(null, 1000)",
    );
    expect(r.n).toBe(TOTAL_PENDENCIAS);
  });

  it("filtra por categoria", async () => {
    await como(db, GESTAO);
    const r = await q1(
      db,
      "select count(*)::int as n from public.fila_pagamento_triagem_ler('BLOQUEADO_ETAPA_DESATIVADA', 1000)",
    );
    expect(r.n).toBe(265);
  });

  it("operador e recusado com 42501", async () => {
    await como(db, OPERADOR);
    await expect(
      db.query("select * from public.fila_pagamento_triagem_ler(null, 10)"),
    ).rejects.toThrow(/gestao financeira/i);
  });

  it("sem login -- identidade nula -- e recusado, nao liberado", async () => {
    await semLogin(db);
    await expect(
      db.query("select * from public.fila_pagamento_triagem_ler(null, 10)"),
    ).rejects.toThrow(/gestao financeira/i);
  });

  it("service_role le, porque a rotina de leitura precisa", async () => {
    await comoServico(db);
    const r = await q1(
      db,
      "select count(*)::int as n from public.fila_pagamento_triagem_ler(null, 1000)",
    );
    expect(r.n).toBe(TOTAL_PENDENCIAS);
    await db.query("select set_config('request.jwt.role','authenticated',false)");
  });

  it("authenticated NAO tem SELECT na view: seria a fila financeira por cima do RLS", async () => {
    const r = await q1(
      db,
      `select has_table_privilege('authenticated','public.vw_fila_pagamento_triagem','SELECT') as pode`,
    );
    expect(r.pode).toBe(false);
  });

  it("authenticated tem EXECUTE na funcao leitora, senao a tela nao carregaria", async () => {
    const r = await q1(
      db,
      `select has_function_privilege('authenticated',
         'public.fila_pagamento_triagem_ler(text,integer)','EXECUTE') as pode`,
    );
    expect(r.pode).toBe(true);
  });
});

describe("leitura e leitura: nada e escrito", () => {
  it("ler a triagem nao muda pagamento, fila, etapa nem contador de toques", async () => {
    await como(db, GESTAO);
    const antes = await q1(
      db,
      `select (select md5(string_agg(p.id::text || coalesce(p.status_conciliacao,'') ||
                                     p.valor_pago::text, '|' order by p.id))
                 from public.pagamentos p) as pagamentos,
              (select md5(string_agg(f.pagamento_id::text || coalesce(f.decisao,'') ||
                                     f.quantidade_tentativas::text ||
                                     coalesce(f.ultima_tentativa_em::text,''), '|' order by f.pagamento_id))
                 from public.fila_pagamento_sem_vinculo f) as fila,
              (select md5(string_agg(c.etapa || c.ligado::text, '|' order by c.etapa))
                 from public.fluxo_pagamentos_config c) as cfg,
              (select count(*)::int from public.baixas_pagamento) as baixas`,
    );

    await db.query("select * from public.fila_pagamento_triagem_ler(null, 1000)");
    await db.query("select count(*) from public.vw_fila_pagamento_triagem");
    await db.query("select * from public.fila_pagamento_triagem_ler('CONFERENCIA_HUMANA', 500)");

    const depois = await q1(
      db,
      `select (select md5(string_agg(p.id::text || coalesce(p.status_conciliacao,'') ||
                                     p.valor_pago::text, '|' order by p.id))
                 from public.pagamentos p) as pagamentos,
              (select md5(string_agg(f.pagamento_id::text || coalesce(f.decisao,'') ||
                                     f.quantidade_tentativas::text ||
                                     coalesce(f.ultima_tentativa_em::text,''), '|' order by f.pagamento_id))
                 from public.fila_pagamento_sem_vinculo f) as fila,
              (select md5(string_agg(c.etapa || c.ligado::text, '|' order by c.etapa))
                 from public.fluxo_pagamentos_config c) as cfg,
              (select count(*)::int from public.baixas_pagamento) as baixas`,
    );

    expect(depois.pagamentos).toBe(antes.pagamentos);
    expect(depois.fila).toBe(antes.fila);
    expect(depois.cfg).toBe(antes.cfg);
    expect(depois.baixas).toBe(antes.baixas);
  });

  it("a funcao leitora nao tem escrita no corpo", async () => {
    const r = await q1(
      db,
      `select p.prosrc ~* '\\m(insert|update|delete|truncate)\\M' as tem_escrita
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fila_pagamento_triagem_ler'`,
    );
    expect(r.tem_escrita).toBe(false);
  });
});

describe("o rollback", () => {
  it("remove os dois objetos e deixa a fila exatamente como estava", async () => {
    const antes = await q1(
      db,
      `select (select count(*)::int from public.pagamentos) as pagamentos,
              (select count(*)::int from public.fila_pagamento_sem_vinculo) as fila,
              (select md5(string_agg(c.etapa || c.ligado::text, '|' order by c.etapa))
                 from public.fluxo_pagamentos_config c) as cfg`,
    );

    await db.exec(ROLLBACK);

    const existe = await q1(
      db,
      `select (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = 'vw_fila_pagamento_triagem') as view_,
              (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'fila_pagamento_triagem_ler') as func_`,
    );
    expect(existe.view_).toBe(0);
    expect(existe.func_).toBe(0);

    const depois = await q1(
      db,
      `select (select count(*)::int from public.pagamentos) as pagamentos,
              (select count(*)::int from public.fila_pagamento_sem_vinculo) as fila,
              (select md5(string_agg(c.etapa || c.ligado::text, '|' order by c.etapa))
                 from public.fluxo_pagamentos_config c) as cfg`,
    );
    expect(depois).toEqual(antes);
  });

  it("a ida e idempotente: roda duas vezes e o fechamento continua em 448", async () => {
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
    const r = await q1(
      db,
      `select count(*)::int as n, sum(valor_pago)::numeric(14,2)::text as valor
         from public.vw_fila_pagamento_triagem`,
    );
    expect(r.n).toBe(TOTAL_PENDENCIAS);
    expect(r.valor).toBe(TOTAL_VALOR);
  });
});
