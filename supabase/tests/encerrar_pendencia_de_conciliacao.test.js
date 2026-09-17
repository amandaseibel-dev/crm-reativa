// ESTRUTURA da migration 20260917210000 (encerrar pendencia de conciliacao):
// o que ela pode e o que ela nao pode tocar. O comportamento esta em
// encerrar_pendencia_de_conciliacao_comportamento.test.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ler = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const MIGRATION = ler("supabase/migrations/20260917210000_encerrar_pendencia_de_conciliacao.sql");
const ROLLBACK = ler("supabase/rollbacks/20260917210000_encerrar_pendencia_de_conciliacao.rollback.sql");
const TELA = ler("src/pages/PagamentosSemAluno.jsx");

function corpo(texto, nome) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, "gi");
  const achados = [...texto.matchAll(re)];
  expect(achados, `${nome} definida uma vez`).toHaveLength(1);
  const resto = texto.slice(achados[0].index);
  const ini = resto.indexOf("as $fn$") + "as $fn$".length;
  return resto.slice(ini, resto.indexOf("$fn$", ini));
}
const semComentario = (s) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const linhas = (s) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
function removidas(antes, depois) {
  const sobra = new Map();
  for (const l of linhas(depois)) sobra.set(l, (sobra.get(l) ?? 0) + 1);
  const fora = [];
  for (const l of linhas(antes)) {
    if (sobra.get(l)) sobra.set(l, sobra.get(l) - 1);
    else fora.push(l);
  }
  return fora;
}

const PRODUCAO = {
  fluxo_pagamentos_rodar: "418c15291cf912516d7f02304b4fdd2d",
  conciliacao_encerrar: "e41a43f4bfe1754c45570f3afd5e2ade",
  pagamentos_sem_aluno: "067e2b74c3f8ef3d52b60e42b8d5b93d",
};
const NOVAS = ["conciliacao_ja_paga_previa", "conciliacao_ja_paga_encerrar", "conciliacao_ja_paga_encerrar_pendentes"];
const FINANCEIRAS = /\b(insert\s+into|update|delete\s+from)\s+public\.(parcelas|acordos|pagamentos|acordos_titulos|baixas_pagamento|acordo_titulo_vinculo)\b/i;

describe("o que a migration define", () => {
  it("só as três funções novas e as três trocadas; motor e reconstrução ficam de fora", () => {
    const nomes = [...MIGRATION.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map((m) => m[1]).sort();
    expect(nomes).toEqual(["conciliacao_encerrar", ...NOVAS, "fluxo_pagamentos_rodar", "pagamentos_sem_aluno"].sort());
    expect(semComentario(MIGRATION)).not.toMatch(/function\s+public\.(pagamento_conciliar_um|parcela_paga_antes_\w+|acordo_avista_\w+|reposicao_\w+)\s*\(/i);
    expect(semComentario(MIGRATION)).not.toMatch(/create\s+(or\s+replace\s+)?trigger|alter\s+table|cron\./i);
  });

  it("fora dos corpos, a única escrita é a etapa nova, DESLIGADA", () => {
    const fora = semComentario(MIGRATION).replace(/\$fn\$[\s\S]*?\$fn\$/g, "").replace(/\$prova\$[\s\S]*?\$prova\$/g, "");
    expect(fora.match(/\b(insert|update|delete)\b/gi)).toEqual(["insert"]);
    expect(fora).toMatch(/insert into public\.fluxo_pagamentos_config \(etapa, ligado, observacao, alterado_em, alterado_por\)\s+values \('encerrar_ja_paga_conferida', false,/);
    expect(fora).toMatch(/on conflict \(etapa\) do nothing;/);
    for (const f of ["conciliacao_ja_paga_previa(uuid)", "conciliacao_ja_paga_encerrar(uuid, boolean)", "conciliacao_ja_paga_encerrar_pendentes(integer)"]) {
      expect(fora).toContain(`revoke all on function public.${f} from public, anon, authenticated;`);
    }
    // a porta da gestao continua aberta: encerrar e a fila nao sao revogadas aqui
    expect(fora).not.toMatch(/revoke[^\n]*conciliacao_encerrar/);
    expect(fora).not.toMatch(/revoke[^\n]*pagamentos_sem_aluno/);
  });
});

describe("nenhuma função desta migration altera dado financeiro", () => {
  it("previa, encerramento automático, lote e encerramento da gestão só tocam fila e auditoria", () => {
    for (const nome of [...NOVAS, "conciliacao_encerrar"]) {
      const corpoSem = semComentario(corpo(MIGRATION, nome));
      expect(corpoSem, nome).not.toMatch(FINANCEIRAS);
      const dml = corpoSem.match(/\b(insert\s+into|update|delete\s+from)\s+public\.\w+/gi) ?? [];
      for (const d of dml) {
        expect(d.toLowerCase(), `${nome}: ${d}`).toMatch(/public\.(fila_pagamento_sem_vinculo|auditoria)$/);
      }
      // ler parcela e baixa e o trabalho da prova; escrever nelas, nao
      expect(corpoSem, nome).not.toMatch(/\bset\s+(status|pago_em|origem_baixa\w*|confirmado_por_email|saldo|valor|valor_total|qtd_parcelas|honorarios)\s*=/i);
    }
  });

  it("a prévia é SQL STABLE e não escreve nada", () => {
    const decl = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.conciliacao_ja_paga_previa"));
    expect(decl.slice(0, 260)).toMatch(/returns jsonb\s+language sql\s+stable security definer/);
    expect(semComentario(corpo(MIGRATION, "conciliacao_ja_paga_previa"))).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it("o encerramento automático grava uma decisão só, e com a linha ainda aberta", () => {
    const c = semComentario(corpo(MIGRATION, "conciliacao_ja_paga_encerrar"));
    expect(c.match(/update public\.fila_pagamento_sem_vinculo/g)).toHaveLength(1);
    expect(c).toMatch(/set decisao = 'RESOLVIDO_AUTOMATICO'/);
    expect(c).toMatch(/where pagamento_id = p_pagamento_id and decisao is null;/);
    expect(c).toMatch(/if v_n <> 1 then/);
    expect(c.match(/public\.conciliacao_ja_paga_previa\(p_pagamento_id\)/g)).toHaveLength(2);
    expect(c).toMatch(/pg_advisory_xact_lock/);
  });
});

describe("diff mínimo contra produção", () => {
  it("o rollback carrega os corpos exatos de produção e remove as funções novas", () => {
    for (const [nome, h] of Object.entries(PRODUCAO)) expect(md5(corpo(ROLLBACK, nome)), nome).toBe(h);
    for (const f of ["conciliacao_ja_paga_encerrar_pendentes(integer)", "conciliacao_ja_paga_encerrar(uuid, boolean)", "conciliacao_ja_paga_previa(uuid)"]) {
      expect(ROLLBACK).toContain(`drop function if exists public.${f};`);
    }
  });

  it("fluxo_pagamentos_rodar e pagamentos_sem_aluno só ganham linhas", () => {
    for (const nome of ["fluxo_pagamentos_rodar", "pagamentos_sem_aluno"]) {
      expect(removidas(corpo(ROLLBACK, nome), corpo(MIGRATION, nome)), nome).toEqual([]);
    }
    const fluxo = semComentario(corpo(MIGRATION, "fluxo_pagamentos_rodar"));
    expect(fluxo.indexOf("conciliacao_ja_paga_encerrar_pendentes(50)"))
      .toBeGreaterThan(fluxo.indexOf("parcela_paga_antes_reconstruir_pendentes(50)"));
    expect(fluxo).toMatch(/etapa='encerrar_ja_paga_conferida'/);
    const filaAtiva = semComentario(corpo(MIGRATION, "pagamentos_sem_aluno"));
    expect(filaAtiva).toMatch(/and not exists \(select 1 from public\.fila_pagamento_sem_vinculo fd\s+where fd\.pagamento_id = p\.id and fd\.decisao is not null\)/);
  });

  it("conciliacao_encerrar só perde a trava de estado e o retorno antigo", () => {
    expect(removidas(corpo(ROLLBACK, "conciliacao_encerrar"), corpo(MIGRATION, "conciliacao_encerrar")).filter((l) => !l.startsWith("--")))
      .toEqual([
        "declare v_email text; v_n int := 0; v_st text;",
        "if v_st <> 'PARCELA_JA_PAGA' then",
        "return jsonb_build_object('ok', false, 'motivo', 'SO_PARCELA_JA_PAGA',",
        "'explicacao', 'encerrar este estado tiraria o pagamento do reprocessamento automatico');",
        "return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n);",
      ]);
    const c = semComentario(corpo(MIGRATION, "conciliacao_encerrar"));
    // o portao da gestao continua antes de qualquer escrita
    expect(c.indexOf("usuario_e_gestao")).toBeLessThan(c.indexOf("update public.fila_pagamento_sem_vinculo"));
    expect(c).toMatch(/set decisao = 'ENCERRADO_GESTAO'/);
    expect(c).toMatch(/'CONCILIACAO_ENCERRADA_PELA_GESTAO'/);
    expect(c).toMatch(/'estado_anterior', v_antes/);
    expect(c).toMatch(/'JA_BAIXADO'/);
    expect(c).toMatch(/'SEM_PENDENCIA_ABERTA'/);
  });
});

describe("a tela oferece o encerramento sem prometer correção financeira", () => {
  it("chama só as RPCs da fila, e a de encerrar é a nova", () => {
    const rpcs = [...TELA.matchAll(/supabase\.rpc\(\s*"(\w+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["buscar_aluno", "conciliacao_encerrar", "pagamento_vincular_aluno", "pagamentos_sem_aluno", "pagamentos_trava"]);
    expect(TELA).toMatch(/ENCERRAR_PENDENCIA_AVISO/);
    expect(TELA).toMatch(/podeEncerrarPendencia\(item\)/);
    // a acao tecnica continua primeiro: encerrar e um botao separado
    const registrar = TELA.indexOf('acao.acao === "REGISTRAR_ACORDO_AVISTA"');
    expect(registrar).toBeGreaterThan(-1);
    expect(TELA.indexOf("podeEncerrarPendencia(item)")).toBeGreaterThan(registrar);
  });
});
