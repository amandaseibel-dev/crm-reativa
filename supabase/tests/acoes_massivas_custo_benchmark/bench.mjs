// BENCHMARK DO UNIVERSO DE ACOES MASSIVAS -- Postgres descartavel do CI (service container).
//
// Um unico banco, um unico conjunto de dados, tres estados em sequencia:
//   1) ANTES   = #941 + R5 v2 (885583bc)
//   2) DEPOIS  = ANTES + otimizacao de custo (8a92826b)
//   3) ROLLBACK = DEPOIS + rollback da otimizacao (deve voltar exatamente a 885583bc)
// Em cada estado: mede o tempo de cada cenario (mediana de REPS execucoes), compara o
// resultado por hash, registra o ACL de EXECUTE e o MD5 da definicao da funcao, e captura o
// plano interno (auto_explain). Falha (exit 1) se qualquer resultado divergir ou se o ACL/rollback
// nao bater.
//
// Limites (ler antes de usar o numero):
//   - tempo de CI NAO e garantia de producao; a meta de <8 s so e confirmada pelo caminho
//     autenticado real, em validacao controlada autorizada.
//   - o banco de teste NAO tem indices alem das PKs (como no fixture). Producao pode ter indices;
//     por isso o plano e comparado ANTES x DEPOIS no mesmo banco, nao contra producao.
//   - dados 100% sinteticos. Volume de movimentacoes padrao = 275.467, contagem de producao lida
//     em 14/11/2026 (somente leitura: select count(*) em public.aluno_movimentacoes). O numero de
//     alunos (BENCH_ALUNOS) nao foi medido em producao e e um parametro.
import pg from "pg";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  usarFabricaDeBanco, novoBanco, comoGestao, alunos, OP_A, OP_B,
} from "../fixtures/acoes_massivas_universo/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const md5 = (s) => createHash("md5").update(s).digest("hex");

const PUBLICADO = ler("../fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql");
const TIPO_PUBLICADO = ler("../fixtures/acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql");
const MIG941 = ler("../../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.sql.pendente");
const MIG_R5 = ler("../../aguardando_aprovacao/20261112235600_acoes_massivas_r5_sobre_valor.sql.pendente");
const MIG_OTIM = ler("../../aguardando_aprovacao/20261113230000_acoes_massivas_universo_custo.sql.pendente");
const ROLLBACK_OTIM = ler("../../aguardando_aprovacao/20261113230000_acoes_massivas_universo_custo.rollback.sql");

// Mesmas colunas extras que a bancada de equivalencia usa (COLUNAS em acoes_massivas_custo_equivalencia.test.js).
const COLUNAS = `
  alter table public.acordos add column if not exists saldo numeric default 0;
  alter table public.parcelas add column if not exists boleto text;
  alter table public.parcelas add column if not exists boleto_confiavel boolean default false;
  alter table public.parcelas add column if not exists renegociada_no_acordo_id uuid;
  alter table public.parcelas add column if not exists pago_em timestamptz;
  alter table public.acordos_titulos add column if not exists documento text;
  alter table public.prime_extrato add column if not exists cpf text;
  alter table public.prime_extrato add column if not exists boleto text;
  alter table public.prime_extrato add column if not exists liquidado_em timestamptz;
  create table if not exists public.pagamentos (aluno_id uuid, numero_parcela_completo text,
    titulo_numero text, data_pagamento timestamptz, valor_pago numeric);`;

// Mesmos cenarios de filtro da suite de equivalencia.
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

// Indices de PRODUCAO nas tabelas que o universo le (pg_indexes, somente leitura, 14/11/2026).
// Sem eles o plano do benchmark nao representa producao (o fixture so tem PKs).
// Replicados apenas os que o universo usa; colunas conferidas contra o fixture.
// NAO replicados: indices das demais tabelas e colunas de producao ausentes no fixture
// (ex.: acoes_desfazer.criado_em); acoes_desfazer nao tem indice por movimentacao_id em producao.
const INDICES_PRODUCAO = [
  "create index idx_aluno_movimentacoes_aluno_id on public.aluno_movimentacoes (aluno_id)",
  "create index idx_aluno_mov_registrado_em on public.aluno_movimentacoes (registrado_em)",
  "create index ix_aluno_mov_tipo_data on public.aluno_movimentacoes (tipo, registrado_em)",
  "create index idx_aluno_mov_reg_por on public.aluno_movimentacoes (registrado_por_email, registrado_em)",
  "create index idx_casos_aluno_id on public.casos (aluno_id)",
  "create index idx_casos_operador_email on public.casos (operador_email)",
  "create unique index ux_casos_uma_ficha_aberta_por_aluno on public.casos (aluno_id) where ((aluno_id is not null) and (not coalesce(encerrado_operacional, false)))",
  "create index acordos_aluno_id_idx on public.acordos (aluno_id)",
  "create index acordos_status_idx on public.acordos (status)",
  "create index idx_acordos_aluno_operador on public.acordos (aluno_id, lower(operador_responsavel_email))",
  "create index ix_acordos_titulos_aluno_venc on public.acordos_titulos (aluno_id, vencimento)",
  "create index parcelas_acordo_id_idx on public.parcelas (acordo_id)",
  "create index ix_parcelas_acordo_status_venc on public.parcelas (acordo_id, status, vencimento)",
  "create index ix_vinculo_acordo on public.acordo_titulo_vinculo (acordo_id)",
  "create index idx_acordo_titulo_vinculo_titulo on public.acordo_titulo_vinculo (titulo_id)",
  "create index idx_alunos_responsavel_atual_email on public.alunos (responsavel_atual_email)",
  "create index idx_alunos_curso on public.alunos (curso)",
  "create index idx_alunos_unidade on public.alunos (unidade)",
  "create index idx_alunos_situacao_academica on public.alunos (situacao_academica)",
  "create index idx_alunos_data_ultimo_acionamento on public.alunos (data_ultimo_acionamento)",
];

const ACL_SQL = `select coalesce(array(
  select distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where n.nspname = 'public' and p.proname = 'acoes_massivas_universo' and a.privilege_type = 'EXECUTE'
    and a.grantee <> p.proowner
  order by 1), '{}') q`;
// Atributos de seguranca da funcao: SECURITY DEFINER e search_path fixo (checklist de deploy §C).
const SEGURANCA_SQL = `select p.prosecdef as definer, coalesce(array_to_string(p.proconfig, ','), '') as config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'acoes_massivas_universo'`;
const DEF_SQL = `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'acoes_massivas_universo'`;

const N = Number(process.env.BENCH_ALUNOS ?? 30000);
const MOVS = Number(process.env.BENCH_MOVS ?? 275467);
const REPS = Number(process.env.BENCH_REPS ?? 3);
const SAIDA = resolve(process.env.BENCH_SAIDA ?? "benchmark-resultado");
mkdirSync(SAIDA, { recursive: true });

// TRAVA DE DESTINO (fail-closed): o benchmark so roda contra um Postgres descartavel local.
// Recusa host que nao seja localhost, banco que nao seja "teste", e banco que ja tenha o schema auth
// (sinal de banco de verdade). Nunca aponta para producao.
const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1"]);
if (!HOSTS_LOCAIS.has(process.env.PGHOST ?? "") || process.env.PGDATABASE !== "teste") {
  console.error(`RECUSADO: destino nao e o Postgres descartavel (PGHOST=${process.env.PGHOST}, PGDATABASE=${process.env.PGDATABASE}).`);
  process.exit(2);
}
const cliente = new pg.Client({
  host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER,
  password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
});
const avisos = [];
cliente.on("notice", (n) => avisos.push(n.message));
const q = (sql, v) => cliente.query(sql, v);

const mediana = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function semearVolume() {
  // Dados sinteticos com volume representativo. Padroes espelham a bancada de equivalencia:
  // acordo ATIVO para 1 em 4 alunos (dono alternado), casos encerrados para 1 em 6,
  // movimentacoes de tipos de cobertura, fora da lista e nulas, e desfeitas.
  return [
    `insert into public.acordos (aluno_id, status, operador_responsavel_email, saldo)
     select id, 'ATIVO', case when n % 2 = 0 then '${OP_A}' else '${OP_B}' end, 100
     from (select id, row_number() over (order by id) n from public.alunos) x where n % 4 = 1;`,
    `insert into public.parcelas (acordo_id, status, vencimento, valor, boleto)
     select ac.id, 'VENCIDA', current_date - 20, 100 + (row_number() over ()) % 50, 'B' || row_number() over ()
     from public.acordos ac;`,
    `insert into public.casos (aluno_id, operador_email, total_em_aberto, data_ultimo_acionamento, cpf_limpo, encerrado_operacional)
     select x.id, case when k = 1 then '${OP_A}' else '${OP_B}' end, case when k = 1 then 900 else 50 end,
            timestamptz '2026-09-01 10:00:00-03', 'E' || x.n || '-' || k, true
     from (select id, row_number() over (order by id) n from public.alunos) x
     cross join generate_series(1, 2) as k where x.n % 6 = 4;`,
    `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
     select '00000000-0000-4000-8000-' || lpad((((g.i * 7919::bigint) % ${N}::bigint) + 1)::text, 12, '0'),
       (array['FINALIZACAO_ATENDIMENTO','CONTATO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO',
              'ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL','TIPO_FORA_DA_LISTA','FINALIZACAO',
              'OBSERVACAO','CONTATO_NAO_EFETIVO', null])[1 + (g.i % 11)],
       'bench', 'x', 'x@x',
       timestamptz '2026-08-01 10:00:00-03' + ((g.i % 120) || ' days')::interval + ((g.i % 24) || ' hours')::interval
     from generate_series(1::bigint, ${MOVS}::bigint) g(i);`,
    `insert into public.acoes_desfazer (movimentacao_id, desfeito_em)
     select id, timestamptz '2026-11-12 11:00:00-03' from public.aluno_movimentacoes where id % 100 = 0;`,
  ];
}

async function estado(rotulo) {
  const acl = (await q(ACL_SQL)).rows[0].q;
  const def = (await q(DEF_SQL)).rows[0].m;
  const seg = (await q(SEGURANCA_SQL)).rows[0];
  return {
    rotulo, md5_funcao: def, acl_execute: acl,
    security_definer: seg.definer,
    search_path_fixo: /search_path=public/.test(seg.config),
  };
}

async function resolverFiltro(f, ids) {
  if (f.aluno_ids === "__PRIMEIROS__") return { ...f, aluno_ids: ids.slice(0, 12) };
  return f;
}

async function medirCenarios(rotulo, ids) {
  const out = [];
  for (const [i, f] of CENARIOS.entries()) {
    const filtro = await resolverFiltro(f, ids);
    const tempos = [];
    let rows = [];
    for (let r = 0; r < REPS; r++) {
      const t0 = performance.now();
      rows = (await q("select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify(filtro)])).rows;
      tempos.push(performance.now() - t0);
    }
    const canon = JSON.stringify([...rows].sort((x, y) => String(x.aluno_id).localeCompare(String(y.aluno_id))));
    out.push({
      cenario: i, filtro: f, linhas: rows.length,
      mediana_ms: Math.round(mediana(tempos)), tempos_ms: tempos.map(Math.round), md5_resultado: md5(canon),
    });
    console.log(`[${rotulo}] cenario ${i}: ${rows.length} linhas, mediana ${Math.round(mediana(tempos))} ms`);
  }
  return out;
}

async function capturarPlano(rotulo, ids) {
  // auto_explain com log_analyze: o plano interno da funcao chega como NOTICE (client_min_messages=log).
  avisos.length = 0;
  await q("load 'auto_explain'");
  await q("set auto_explain.log_min_duration = 0; set auto_explain.log_analyze = on; set auto_explain.log_nested_statements = on; set client_min_messages = 'log'");
  await q("select * from public.acoes_massivas_universo($1::jsonb)", [JSON.stringify(await resolverFiltro({}, ids))]);
  await q("set auto_explain.log_min_duration = -1; set client_min_messages = 'notice'");
  const planos = avisos.filter((m) => m.includes("duration:") || m.includes("Seq Scan") || m.includes("->") || m.includes("Function"));
  writeFileSync(resolve(SAIDA, `plano_${rotulo}.txt`), planos.join("\n"));
  return planos.length;
}

async function main() {
  const t0 = Date.now();
  await cliente.connect();
  const jaTemAuth = (await cliente.query("select exists(select 1 from pg_namespace where nspname = 'auth') as ok")).rows[0].ok;
  if (jaTemAuth) {
    throw new Error("RECUSADO: o banco ja tem o schema auth (nao e o banco descartavel do benchmark).");
  }
  usarFabricaDeBanco(async () => ({
    exec: (sql) => q(sql),
    query: (sql, v) => q(sql, v),
  }));

  // Base: producao simulada + migrations ate a R5 (mesma ordem da suite de equivalencia).
  const db = await novoBanco();
  await db.exec(COLUNAS);
  await db.exec(PUBLICADO);
  await db.exec(TIPO_PUBLICADO);
  await comoGestao(db);
  const ids = await alunos(db, N, { ini: 1 });
  for (const sql of semearVolume()) await db.exec(sql);
  // Indices de producao antes do ANALYZE: o plano medido precisa refletir o acesso real.
  for (const sql of INDICES_PRODUCAO) await db.exec(sql);
  await db.exec("analyze;");
  const estados = [];
  estados.push(await estado("sem_941_R5"));

  await db.exec("BEGIN;\n" + MIG941 + "\nCOMMIT;");
  await db.exec("BEGIN;\n" + MIG_R5 + "\nCOMMIT;");
  estados.push(await estado("antes_941_R5"));
  const antes = await medirCenarios("antes", ids);
  const planoAntes = await capturarPlano("antes", ids);

  await db.exec(MIG_OTIM);
  estados.push(await estado("depois_otimizacao"));
  const depois = await medirCenarios("depois", ids);
  const planoDepois = await capturarPlano("depois", ids);

  await db.exec(ROLLBACK_OTIM);
  estados.push(await estado("rollback"));
  const rollback = await medirCenarios("rollback", ids);

  // Conferencias
  const iguais = antes.map((a, i) => a.md5_resultado === depois[i].md5_resultado && a.linhas === depois[i].linhas);
  const rbIguais = antes.map((a, i) => a.md5_resultado === rollback[i].md5_resultado && a.linhas === rollback[i].linhas);
  const aclOk = (e) => JSON.stringify(e.acl_execute) === JSON.stringify(["authenticated", "service_role"]);
  const defAntes = estados.find((e) => e.rotulo === "antes_941_R5").md5_funcao;
  const defDepois = estados.find((e) => e.rotulo === "depois_otimizacao").md5_funcao;
  const defRollback = estados.find((e) => e.rotulo === "rollback").md5_funcao;
  const checks = {
    resultados_identicos_antes_depois: iguais.every(Boolean),
    resultados_identicos_rollback_antes: rbIguais.every(Boolean),
    rollback_restaura_definicao_exata: defRollback === defAntes,
    definicao_otimizada_difere_de_antes: defDepois !== defAntes,
    acl_antes_ok: aclOk(estados.find((e) => e.rotulo === "antes_941_R5")),
    acl_depois_ok: aclOk(estados.find((e) => e.rotulo === "depois_otimizacao")),
    acl_rollback_ok: aclOk(estados.find((e) => e.rotulo === "rollback")),
    seguranca_depois_ok: estados.filter((e) => e.rotulo !== "sem_941_R5").every((e) => e.security_definer && e.search_path_fixo),
  };
  const sumario = antes.map((a, i) => ({
    cenario: i,
    antes_ms: a.mediana_ms,
    depois_ms: depois[i].mediana_ms,
    rollback_ms: rollback[i].mediana_ms,
    linhas: a.linhas,
    identico: iguais[i],
  }));
  const relatorio = {
    gerado_em: new Date().toISOString(),
    parametros: { alunos: N, movimentacoes: MOVS, repeticoes: REPS, indices_producao_replicados: INDICES_PRODUCAO.length },
    checks, estados, sumario, antes, depois, rollback,
    plano_linhas: { antes: planoAntes, depois: planoDepois },
    duracao_total_s: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(resolve(SAIDA, "benchmark.json"), JSON.stringify(relatorio, null, 2));

  const linhasMd = [
    "| cenario | linhas | antes (ms) | depois (ms) | rollback (ms) | identico |",
    "|---|---|---|---|---|---|",
    ...sumario.map((s) => `| ${s.cenario} | ${s.linhas} | ${s.antes_ms} | ${s.depois_ms} | ${s.rollback_ms} | ${s.identico ? "sim" : "NAO"} |`),
  ].join("\n");
  console.log(linhasMd);
  console.log(JSON.stringify(checks, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Benchmark do universo (ações massivas)\n\nParâmetros: ${N} alunos, ${MOVS} movimentações, ${REPS} repetições. Tempo de CI, não garantia de produção.\n\n${linhasMd}\n\n\`\`\`json\n${JSON.stringify(checks, null, 2)}\n\`\`\`\n`);
  }
  const falhou = Object.values(checks).some((v) => v === false);
  if (falhou) {
    console.error("FALHA: algum check nao bateu (ver checks acima).");
    process.exitCode = 1;
  }
  await cliente.end();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await cliente.end().catch(() => {});
});
