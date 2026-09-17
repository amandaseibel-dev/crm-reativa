// ESTRUTURA da migration 20260917200000 (parcela paga antes da extracao):
// o que ela pode e o que ela nao pode mexer. O comportamento esta em
// parcela_paga_antes_da_extracao_comportamento.test.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ler = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const MIGRATION = ler("supabase/migrations/20260917200000_parcela_paga_antes_da_extracao.sql");
const ROLLBACK = ler("supabase/rollbacks/20260917200000_parcela_paga_antes_da_extracao.rollback.sql");

// corpo entre `as $fn$` e `$fn$` da definicao de public.<nome> no texto
function corpo(texto, nome) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, "gi");
  const achados = [...texto.matchAll(re)];
  expect(achados, `${nome} definida uma vez`).toHaveLength(1);
  const resto = texto.slice(achados[0].index);
  const ini = resto.indexOf("as $fn$") + "as $fn$".length;
  return resto.slice(ini, resto.indexOf("$fn$", ini));
}
const semComentario = (s) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const linhasSemBranco = (s) => s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
function removidas(antes, depois) {
  const sobra = new Map();
  for (const l of linhasSemBranco(depois)) sobra.set(l, (sobra.get(l) ?? 0) + 1);
  const fora = [];
  for (const l of linhasSemBranco(antes)) {
    if (sobra.get(l)) sobra.set(l, sobra.get(l) - 1);
    else fora.push(l.trim());
  }
  return fora;
}

const PRODUCAO = {
  _pagamentos_baixar_lote: "6a0a351ce133c8d5e1ab89050a12f456",
  fluxo_pagamentos_rodar: "8255c8d416683c59ddcaa28b5c5195a2",
  completar_parcelas_acordo: "1e4c6853005940da5048bb5e052f9153",
  importar_acordos: "1bb69aed2ed0b263ff43009e6b744691",
};

describe("o que a migration define", () => {
  it("só as quatro funções novas e as quatro trocadas; motor, à vista e reposição ficam de fora", () => {
    const nomes = [...MIGRATION.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map((m) => m[1]).sort();
    expect(nomes).toEqual(["_pagamentos_baixar_lote", "completar_parcelas_acordo", "fluxo_pagamentos_rodar", "importar_acordos",
      "parcela_paga_antes_apos_importar_acordos", "parcela_paga_antes_previa", "parcela_paga_antes_reconstruir",
      "parcela_paga_antes_reconstruir_pendentes"]);
    expect(semComentario(MIGRATION)).not.toMatch(/function\s+public\.(pagamento_conciliar_um|acordo_avista_\w+|reposicao_\w+|parcelas_amarrar_boleto)\s*\(/i);
    expect(semComentario(MIGRATION)).not.toMatch(/create\s+(or\s+replace\s+)?trigger|alter\s+table|cron\./i);
  });

  it("fora dos corpos, a única escrita é a etapa nova, DESLIGADA; nenhuma parcela antiga é atualizada", () => {
    const fora = semComentario(MIGRATION).replace(/\$fn\$[\s\S]*?\$fn\$/g, "").replace(/\$prova\$[\s\S]*?\$prova\$/g, "");
    expect(fora.match(/\b(insert|update|delete)\b/gi)).toEqual(["insert"]);
    expect(fora).toMatch(/insert into public\.fluxo_pagamentos_config \(etapa, ligado, observacao, alterado_em, alterado_por\)\s+values \('reconstruir_parcela_paga_antes', false,/);
    expect(fora).toMatch(/on conflict \(etapa\) do nothing;/);
    expect(semComentario(MIGRATION)).not.toMatch(/update\s+public\.parcelas/i);
    expect(fora).toMatch(/revoke all on function public\.parcela_paga_antes_previa\(uuid\) from public, anon, authenticated;/);
    expect(fora).toMatch(/revoke all on function public\.parcela_paga_antes_reconstruir\(uuid, boolean\) from public, anon, authenticated;/);
    expect(fora).toMatch(/revoke all on function public\.parcela_paga_antes_reconstruir_pendentes\(integer, uuid\[\]\) from public, anon, authenticated;/);
    expect(fora).toMatch(/revoke all on function public\.parcela_paga_antes_apos_importar_acordos\(uuid\) from public, anon, authenticated;/);
  });
});

describe("diff mínimo contra produção", () => {
  it("o rollback carrega os corpos exatos de produção", () => {
    for (const [nome, h] of Object.entries(PRODUCAO)) expect(md5(corpo(ROLLBACK, nome)), nome).toBe(h);
    expect(ROLLBACK).toMatch(/drop function if exists public\.parcela_paga_antes_apos_importar_acordos\(uuid\);/);
    expect(ROLLBACK).toMatch(/drop function if exists public\.parcela_paga_antes_reconstruir_pendentes\(integer, uuid\[\]\);/);
    expect(ROLLBACK).toMatch(/drop function if exists public\.parcela_paga_antes_reconstruir\(uuid, boolean\);/);
    expect(ROLLBACK).toMatch(/drop function if exists public\.parcela_paga_antes_previa\(uuid\);/);
  });

  it("_pagamentos_baixar_lote e fluxo_pagamentos_rodar só ganham linhas; a etapa vem depois da reconciliação e lê a configuração", () => {
    for (const nome of ["_pagamentos_baixar_lote", "fluxo_pagamentos_rodar"]) {
      const novo = corpo(MIGRATION, nome);
      const prod = corpo(ROLLBACK, nome);
      const trocadas = removidas(prod, novo);
      // o lote so troca a declaracao (ganha v_liga); o fluxo nao remove nada
      expect(trocadas, nome).toEqual(nome === "_pagamentos_baixar_lote" ? ["declare v_res jsonb;"] : []);
      const s = semComentario(novo);
      expect(s.indexOf("parcela_paga_antes_reconstruir_pendentes(50)")).toBeGreaterThan(s.lastIndexOf("baixa_pelo_relatorio_pagamento(true"));
      expect(s).toMatch(/etapa\s*=\s*'reconstruir_parcela_paga_antes'/);
    }
  });

  it("importar_acordos só ganha o bloco final, depois de completar as parcelas e sem derrubar a importação", () => {
    const novo = corpo(MIGRATION, "importar_acordos");
    expect(removidas(corpo(ROLLBACK, "importar_acordos"), novo)).toEqual([]);
    const s = semComentario(novo);
    const gancho = s.indexOf("perform public.parcela_paga_antes_apos_importar_acordos(p_importacao_id);");
    expect(gancho).toBeGreaterThan(s.indexOf("public.completar_parcelas_acordo("));
    expect(s.slice(s.lastIndexOf("begin", gancho), s.indexOf("return json_build_object(", gancho)))
      .toMatch(/^begin\s+perform public\.parcela_paga_antes_apos_importar_acordos\(p_importacao_id\);\s+exception when others then\s+insert into public\.auditoria/);
    expect(MIGRATION).toMatch(/create or replace function public\.importar_acordos\(p_linhas jsonb, p_importacao_id uuid\)\n returns json\n language plpgsql\n security definer\n set search_path to 'public'\n set statement_timeout to '180000'\nas \$fn\$/);
  });

  it("completar_parcelas_acordo só troca o INSERT e o SELECT para gravar boleto_confiavel com a guarda do prefixo", () => {
    const novo = corpo(MIGRATION, "completar_parcelas_acordo");
    const prod = corpo(ROLLBACK, "completar_parcelas_acordo");
    expect(removidas(prod, novo)).toEqual([
      "select a.id, a.aluno_id, a.numero_acordo, a.valor_total",
      "select alvo.id, alvo.aluno_id, alvo.numero_acordo, alvo.valor_total, qb.base, qb.qtd, qb.soma",
      "insert into public.parcelas(id,acordo_id,numero,valor,vencimento,status,is_entrada,boleto,observacao,criado_em,atualizado_em)",
    ]);
    expect(semComentario(novo)).toMatch(/\(t\.boleto ~ '\^5\\d\{10\}\$' and r\.numero_ulbra is not null\s+and substr\(t\.boleto, 2, 6\) = lpad\(r\.numero_ulbra, 6, '0'\)\),/);
  });
});

describe("a reconstrução não baixa por conta própria", () => {
  it("prévia é SQL STABLE sem escrita; reconstrução só insere a parcela, ajusta o acordo e chama o motor uma vez", () => {
    const previa = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.parcela_paga_antes_previa"));
    expect(previa.slice(0, 300)).toMatch(/returns jsonb\s+language sql\s+stable security definer/);
    expect(semComentario(corpo(MIGRATION, "parcela_paga_antes_previa"))).not.toMatch(/\b(insert|update|delete)\b/i);
    // a identidade e a da recuperacao do a vista, chamada e nao copiada
    expect(corpo(MIGRATION, "parcela_paga_antes_previa")).toContain("public.acordo_avista_previa(p_pagamento_id, null) -> 'identificacao'");

    const r = semComentario(corpo(MIGRATION, "parcela_paga_antes_reconstruir"));
    expect(r.match(/\b(insert\s+into|update|delete\s+from)\s+public\.\w+/gi)).toEqual([
      "insert into public.parcelas", "update public.acordos", "insert into public.auditoria"]);
    expect(r.match(/public\.pagamento_conciliar_um\(/g)).toHaveLength(1);
    expect(r).toMatch(/where id = v_acordo and qtd_parcelas = v_qtd and valor_total = v_total;/);
    expect(r).toMatch(/pg_advisory_xact_lock\(hashtextextended\('parcela_paga_antes:pagamento:'/);
    expect(r).toMatch(/pg_advisory_xact_lock\(hashtextextended\('parcela_paga_antes:acordo:'/);
    // releitura da previa depois dos cadeados
    expect(r.match(/public\.parcela_paga_antes_previa\(p_pagamento_id\)/g)).toHaveLength(2);
    expect(r.indexOf("pg_advisory_xact_lock")).toBeLessThan(r.lastIndexOf("public.parcela_paga_antes_previa(p_pagamento_id)"));

    const p = semComentario(corpo(MIGRATION, "parcela_paga_antes_reconstruir_pendentes"));
    expect(p.match(/\b(insert\s+into|update|delete\s+from)\s+public\.\w+/gi)).toEqual([
      "update public.fila_pagamento_sem_vinculo", "update public.fila_pagamento_sem_vinculo", "insert into public.auditoria"]);
    // na fila, so o motivo, e so linha sem decisao quando e recusa
    expect(p.match(/update public\.fila_pagamento_sem_vinculo f\s+set motivo = [^;]*?\s+where f\.pagamento_id = v_id\s+and /g)).toHaveLength(2);
    expect(p).not.toMatch(/set\s+(decisao|status_conciliacao|decidido_\w+|observacao)\b/i);
    expect(p).toMatch(/and f\.decisao is null\s+and not starts_with\(f\.motivo, v_prefixo\);/);
    expect(p).toMatch(/public\.parcela_paga_antes_reconstruir\(v_id, true\)/);

    const h = semComentario(corpo(MIGRATION, "parcela_paga_antes_apos_importar_acordos"));
    expect(h.match(/\b(insert\s+into|update|delete\s+from)\s+public\.\w+/gi)).toBeNull();
    expect(h.match(/public\.pagamento_conciliar_um\(v_id, true\)/g)).toHaveLength(1);
    expect(h).toMatch(/public\.parcela_paga_antes_reconstruir_pendentes\(50, v_acordos\)/);
    expect(h.indexOf("etapa = 'reconstruir_parcela_paga_antes'")).toBeLessThan(h.indexOf("return jsonb_build_object('ligado', false)"));
    expect(h.indexOf("etapa = 'baixa_pelo_relatorio'")).toBeLessThan(h.indexOf("public.pagamento_conciliar_um("));
  });

  it("a prévia devolve um diagnóstico com código estável e descrição curta, sem barra vertical", () => {
    const previa = corpo(MIGRATION, "parcela_paga_antes_previa");
    const mapa = [...previa.matchAll(/\((\d+), '([A-Z_]+)', '(PARCELA_PAGA_ANTES_[A-Z_]+)', '([^']+)'\)/g)];
    expect(mapa.map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const validacoes = [...previa.matchAll(/\((\d+), '([A-Z_]+)',\n/g)].map((m) => m[2]).sort();
    expect(mapa.map((m) => m[2]).sort()).toEqual(validacoes);
    for (const m of mapa) expect(m[4]).not.toContain("|");
    expect(previa).toContain("'diagnostico', (select jsonb_build_object('codigo', diag.codigo, 'descricao', diag.descricao) from diag)");
  });
});
