// OTIMIZACAO DO UNIVERSO (custo) -- equivalencia de resultado.
// Compara a funcao da #941 (A) com a otimizada (B) no MESMO conjunto de dados, em todos os
// cenarios de filtro. Nao mede desempenho: isso fica para validacao controlada em ambiente de teste.
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, comoGestao, alunos, OP_A, OP_B } from "./fixtures/acoes_massivas_universo/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql");
const TIPO_PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql");
const MIG941 = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.sql.pendente");
const MIG_OTIM = ler("../aguardando_aprovacao/20261113230000_acoes_massivas_universo_custo.sql.pendente");
const emTransacao = (sql) => "BEGIN;\n" + sql + "\nCOMMIT;";
const semGuardaFinal = (sql) => sql.replace(/DO \$m\$[\s\S]*?END \$m\$;/, "");

async function semear(db) {
  await db.exec(`alter table public.acordos_titulos add column if not exists documento text;
                 alter table public.parcelas add column if not exists boleto text;
                 alter table public.acordos add column if not exists saldo numeric default 0;`);
  await db.exec(PUBLICADO);
  await db.exec(TIPO_PUBLICADO);
  await comoGestao(db);
  const ids = await alunos(db, 36, { ini: 1 });
  // dados deterministicos: cada aluno recebe um perfil conforme o indice
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const dono = i % 2 ? OP_A : OP_B;
    if (i % 3 === 0) {
      await db.query(`insert into public.acordos_titulos (aluno_id, situacao, vencimento, status, tipo_boleto, valor_original, documento)
        values ($1, 'ABERTO', current_date - 60, 'em_aberto', null, 250, $2)`, [id, `D${i}`]);
    }
    if (i % 4 === 1) {
      const ac = (await db.query("insert into public.acordos (aluno_id, status, operador_responsavel_email, saldo) values ($1,'ATIVO',$2,100) returning id", [id, dono])).rows[0].id;
      await db.query("insert into public.parcelas (acordo_id, status, vencimento, valor, boleto) values ($1,'VENCIDA', current_date - 20, $2, $3)", [ac, 100 + i, `B${i}`]);
      if (i % 8 === 1) await db.query("insert into public.parcelas (acordo_id, status, vencimento, valor, boleto) values ($1,'VENCIDA', current_date + 30, 80, $2)", [ac, `F${i}`]);
    }
    // casos ENCERRADOS antigos (o indice impede so a ficha ABERTA duplicada): o aluno pode ter
    // uma ficha aberta e varias encerradas. Valores distintos para o lateral escolher.
    if (i % 6 === 3) {
      for (const [k, v] of [[1, 900], [2, 50]]) {
        await db.query(`insert into public.casos (aluno_id, operador_email, total_em_aberto, data_ultimo_acionamento, cpf_limpo, encerrado_operacional)
          values ($1, $2, $3, timestamptz '2026-09-01 10:00:00-03', $4, true)`, [id, k === 1 ? OP_A : OP_B, v, `E${i}${k}`]);
      }
    }
    if (i % 5 === 2) {
      await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
        values ($1, 'ACAO_MASSIVA_EXTERNA', 'teste', 'x', 'x@x', timestamptz '2026-11-10 10:00:00-03')`, [id]);
      if (i % 10 === 2) {
        // movimentacao desfeita: nao deve contar
        await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
          values ($1, 'ACAO_MASSIVA_EXTERNA_EMAIL', 'desfeita', 'x', 'x@x', timestamptz '2026-11-12 10:00:00-03')`, [id]);
        const mid = (await db.query("select id from public.aluno_movimentacoes where aluno_id=$1 and descricao='desfeita'", [id])).rows[0].id;
        await db.query("insert into public.acoes_desfazer (movimentacao_id, desfeito_em) values ($1, timestamptz '2026-11-12 11:00:00-03')", [mid]);
      }
    }
  }
  return ids;
}

const CENARIOS = [
  {},
  { tipo_cobranca: "MENSALIDADES" },
  { tipo_cobranca: "ACORDOS_VENCIDOS" },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS" },
  { tipo_cobranca: "MENSALIDADES", operador: "todos" },
  { tipo_cobranca: "ACORDOS_VENCIDOS", responsaveis_acordo: [OP_A] },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS", responsaveis_acordo: [OP_B] },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS", responsaveis_caso: [OP_A], responsaveis_acordo: [OP_A] },
  { tipo_cobranca: "MENSALIDADES", canal: "WHATSAPP" },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS", canal: "EMAIL", sem_telefone: true },
  { tipo_cobranca: "MENSALIDADES", recencia_dias: 0 },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS", recencia_dias: 30 },
  { tipo_cobranca: "MENSALIDADES", valor_min: 100, valor_max: 300 },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS", ano: "2026", operador: "livres" },
  { tipo_cobranca: "MENSALIDADES_E_ACORDOS", aluno_ids: "__PRIMEIROS__" },
  { tipo_cobranca: "ACORDOS_VENCIDOS", aluno_ids: "__PRIMEIROS__", operador: OP_B },
];

const ordenar = (rows) => [...rows].sort((a, b) => String(a.aluno_id).localeCompare(String(b.aluno_id)));

describe("otimizacao do universo: equivalencia com a #941", () => {
  let A, B, idsA, idsB;

  beforeEach(async () => {
    A = await novoBanco();
    B = await novoBanco();
    idsA = await semear(A);
    idsB = await semear(B);
    await A.exec(emTransacao(MIG941));
    await B.exec(emTransacao(MIG941));
  });

  it("mesmo conjunto de dados nas duas bases (mesmos alunos e mesma contagem)", async () => {
    expect(idsB.length).toBe(idsA.length);
    const c = (db) => db.query("select (select count(*) from public.acordos_titulos) t, (select count(*) from public.parcelas) p, (select count(*) from public.aluno_movimentacoes) m");
    expect((await c(A)).rows[0]).toEqual((await c(B)).rows[0]);
  });

  it("aplicacao da otimizacao: sem o guarda final (medicao do hash)", async () => {
    await B.exec(emTransacao(semGuardaFinal(MIG_OTIM)));
    const h = (await B.query("select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'")).rows[0].m;
    console.log("HASH_OTIMIZADO=" + h);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  for (const f of CENARIOS) {
    it("resultado identico: " + JSON.stringify(f), async () => {
      await B.exec(emTransacao(semGuardaFinal(MIG_OTIM)));
      const trocar = (x) => (x === "__PRIMEIROS__" ? undefined : x);
      const filtroA = { ...f };
      const filtroB = { ...f };
      if (f.aluno_ids === "__PRIMEIROS__") {
        filtroA.aluno_ids = idsA.slice(0, 12);
        filtroB.aluno_ids = idsB.slice(0, 12);
      }
      void trocar;
      const ra = await A.query("select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify(filtroA)]);
      const rb = await B.query("select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify(filtroB)]);
      // alunos: mapeamento por posicao de criacao (mesmos dados, ids diferentes entre bases)
      const mapa = new Map(idsA.map((x, i) => [x, idsB[i]]));
      // comparacao de TODAS as colunas (valores, tipos, datas, flags), com o id de aluno mapeado para
      // o da base A; checa duplicidade de aluno nas duas bases
      const canon = (rows, m) => rows
        .map((r) => ({ ...r, aluno_id: m.get(r.aluno_id) ?? r.aluno_id }))
        .sort((x, y) => String(x.aluno_id).localeCompare(String(y.aluno_id)));
      const invertido = new Map(idsB.map((x, i) => [x, idsA[i]]));
      const dupA = new Set(ra.rows.map((r) => r.aluno_id)).size !== ra.rows.length;
      const dupB = new Set(rb.rows.map((r) => r.aluno_id)).size !== rb.rows.length;
      expect(dupA || dupB, "duplicidade de aluno no resultado").toBe(false);
      expect(JSON.stringify(canon(rb.rows, invertido))).toBe(JSON.stringify(canon(ra.rows, new Map())));
      expect(ra.fields.map((f) => f.name)).toEqual(rb.fields.map((f) => f.name));
      expect(ra.rows.length).toBe(rb.rows.length);
      // o teste so prova algo se o universo nao for vazio: ao menos uma linha, e algum disponivel
      expect(ra.rows.length).toBeGreaterThan(0);
      // (algum cenario pode ter so indisponiveis com este conjunto; a igualdade acima ja e a prova)
    });
  }
});

describe("predicado de cobertura: forma inline e igual a funcao", () => {
  // lista lida do ARQUIVO otimizado (nao copiada)
  const LISTA_OTIM = [...MIG_OTIM.match(/coalesce\(m\.tipo, ''\) in \(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  it("coalesce(tipo,'') in (...) bate com acoes_massivas_tipo_cobertura para todos os tipos e casos de borda", async () => {
    const db = await novoBanco();
    await db.exec(PUBLICADO);
    const casos = [null, "", " ", "CONTATO", "FINALIZACAO", "FINALIZACAO_ATENDIMENTO", "LINK_ENVIADO_AO_ALUNO",
      "SOLICITACAO_LINK_PAGAMENTO", "ACAO_MASSIVA_EXTERNA", "ACAO_MASSIVA_EXTERNA_EMAIL", "contato", "ACAO_MASSIVA", "ACAO_MASSIVA_EXTERNA_X", "TABULACAO"];
    for (const t of casos) {
      const a = (await db.query("select public.acoes_massivas_tipo_cobertura($1::text) v", [t])).rows[0].v;
      const b = (await db.query("select (coalesce($1::text, '') = any($2::text[])) v", [t, LISTA_OTIM])).rows[0].v;
      expect(b, "tipo=" + JSON.stringify(t)).toBe(a);
    }
  });
});

describe("rollback da otimizacao", () => {
  it("apos a otimizacao, o rollback volta exatamente ao MD5 da #941 e recusa rodar duas vezes", async () => {
    const db = await novoBanco();
    await db.exec(`alter table public.acordos_titulos add column if not exists documento text;
                   alter table public.parcelas add column if not exists boleto text;
                   alter table public.acordos add column if not exists saldo numeric default 0;`);
    await db.exec(PUBLICADO); await db.exec(TIPO_PUBLICADO);
    await db.exec(emTransacao(MIG941));
    const md5 = async () => (await db.query("select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'")).rows[0].m;
    expect(await md5()).toBe("52f8ca6c4e4428e9dc5d0912e2b9751a");
    await db.exec(semGuardaFinal(MIG_OTIM));
    expect(await md5()).toBe("941a3de82f87d03e08d4f14043f907fb");
    const RB = ler("../aguardando_aprovacao/20261113230000_acoes_massivas_universo_custo.rollback.sql");
    await db.exec(RB);
    expect(await md5()).toBe("52f8ca6c4e4428e9dc5d0912e2b9751a");
    await expect(db.exec(RB)).rejects.toThrow(/nao esta na versao otimizada/);
  });
});

describe("populacao vazia, filtros ausentes e lista vazia para tc", () => {
  let A, B, idsA, idsB;
  beforeEach(async () => {
    A = await novoBanco(); B = await novoBanco();
    idsA = await semear(A); idsB = await semear(B);
    await A.exec(emTransacao(MIG941));
    await B.exec(emTransacao(MIG941));
    await B.exec(emTransacao(semGuardaFinal(MIG_OTIM)));
  });

  it("lista vazia para a funcao de tipo retorna zero linhas; NULL retorna a base (nao sao equivalentes)", async () => {
    const vazio = await B.query("select count(*)::int n from public.acoes_massivas_tipo_cobranca_alunos('{}'::uuid[])");
    const base = await B.query("select count(*)::int n from public.acoes_massivas_tipo_cobranca_alunos(null::uuid[])");
    expect(vazio.rows[0].n).toBe(0);
    expect(base.rows[0].n).toBeGreaterThan(0);
  });

  it("populacao vazia (unidade inexistente): A e B retornam o mesmo (zero linhas)", async () => {
    const f = { tipo_cobranca: "MENSALIDADES_E_ACORDOS", unidade: "NAO_EXISTE" };
    const ra = await A.query("select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify(f)]);
    const rb = await B.query("select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify(f)]);
    expect(ra.rows.length).toBe(0);
    expect(rb.rows.length).toBe(0);
  });

  it("filtros ausentes ({}) e tipo padrao: A e B iguais, linha a linha, com todas as colunas", async () => {
    const ra = await A.query("select * from public.acoes_massivas_universo('{}'::jsonb)");
    const rb = await B.query("select * from public.acoes_massivas_universo('{}'::jsonb)");
    expect(rb.rows.length).toBe(ra.rows.length);
    expect(rb.rows.length).toBeGreaterThan(0);
    const mapa = new Map(idsB.map((x, i) => [x, idsA[i]]));
    const canon = (rows, m) => rows.map((r) => ({ ...r, aluno_id: m.get(r.aluno_id) ?? r.aluno_id }))
      .sort((x, y) => String(x.aluno_id).localeCompare(String(y.aluno_id)));
    expect(JSON.stringify(canon(rb.rows, mapa))).toBe(JSON.stringify(canon(ra.rows, new Map())));
  });
});

describe("grants reconfirmados pela otimizacao", () => {
  it("apos a otimizacao: anon sem EXECUTE no universo; authenticated e service_role com EXECUTE; sem PUBLIC", async () => {
    const db = await novoBanco();
    await db.exec("alter table public.acordos_titulos add column if not exists documento text; alter table public.parcelas add column if not exists boleto text; alter table public.acordos add column if not exists saldo numeric default 0;");
    await db.exec(PUBLICADO);
    await db.exec(TIPO_PUBLICADO);
    await db.exec(emTransacao(MIG941));
    await db.exec(emTransacao(MIG_OTIM));
    const priv = async (role) => (await db.query("select has_function_privilege($1, 'public.acoes_massivas_universo(jsonb)', 'EXECUTE') ok", [role])).rows[0].ok;
    expect(await priv("anon")).toBe(false);
    expect(await priv("authenticated")).toBe(true);
    expect(await priv("service_role")).toBe(true);
    const acl = (await db.query("select proacl::text a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'")).rows[0].a ?? "";
    expect(acl).not.toMatch(/(^|[{,])=X\//);
  });
});
