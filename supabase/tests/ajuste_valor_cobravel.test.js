// AJUSTE DE VALOR COBRAVEL -- prova estrutural da migration.
//
// POR QUE LER O .SQL. O CI deste projeto nao liga no Supabase (mesma premissa
// das catracas de lint e de migrations). Entao a prova aqui e sobre o texto que
// vai rodar: o que ele toca, o que ele NAO toca, e que os tres leitores sao o
// corpo de producao com UMA troca cirurgica cada.
//
// As fotos de producao de 14/09/2026 estao em supabase/audits/ e os md5 abaixo
// sao os que `pg_get_functiondef` devolveu no banco naquele dia.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = resolve(RAIZ, "supabase/migrations/20260914100000_ajuste_de_valor_cobravel.sql");
const sql = readFileSync(MIGRATION, "utf8");

const md5 = (t) => createHash("md5").update(t, "utf8").digest("hex");
const semComentarios = (t) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// nome -> [arquivo da foto, md5 em producao, trecho trocado, trecho novo, n]
const LEITORES = {
  aluno_saldo_pendente_detalhe: [
    "aluno_saldo_pendente_detalhe_producao_20260914.sql",
    "02b1a6d75cadcc1090e90dde82e0f6bb",
    "coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)",
    "coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)",
    2,
  ],
  recalcular_situacao_aluno: [
    "recalcular_situacao_aluno_producao_20260914.sql",
    "a2f727b34d53e2cc0ab50e439a982d64",
    "coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)",
    "coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)",
    2,
  ],
  resumo_carteira_operador: [
    "resumo_carteira_operador_producao_20260914.sql",
    "c9ec683d7a421c0f6a94699c334ff5e0",
    "sum(t.saldo_corrigido)",
    "sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido))",
    3,
  ],
};

// Recorta o CREATE OR REPLACE de uma funcao dentro da migration.
function blocoDaFuncao(nome) {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (i < 0) throw new Error(`nao achei ${nome} na migration`);
  const fim = sql.indexOf("$function$;", sql.indexOf("AS $function$", i) + 5);
  if (fim < 0) throw new Error(`nao achei o fim de ${nome}`);
  return sql.slice(i, fim + "$function$".length);
}

describe("migration: ajuste de valor cobravel", () => {
  it("as fotos de producao conferem com o md5 do banco", () => {
    for (const [nome, [arq, esperado]] of Object.entries(LEITORES)) {
      const foto = readFileSync(resolve(RAIZ, "supabase/audits", arq), "utf8");
      expect(`${nome}=${md5(foto)}`).toBe(`${nome}=${esperado}`);
    }
  });

  it("cada leitor e a foto de producao com UMA troca ciruragica", () => {
    for (const [nome, [arq, , de, para, n]] of Object.entries(LEITORES)) {
      const foto = readFileSync(resolve(RAIZ, "supabase/audits", arq), "utf8").trimEnd();
      const bloco = blocoDaFuncao(nome).trimEnd();
      expect(`${nome}:${bloco.split(para).length - 1}`).toBe(`${nome}:${n}`);
      // desfazendo a troca, tem de voltar byte a byte para a foto
      expect(`${nome}:${bloco.split(para).join(de)}`).toBe(`${nome}:${foto}`);
    }
  });

  it("os leitores mantem as travas que deixam os 50 titulos historicos fora", () => {
    // Sem estas clausulas, o boleto do proprio acordo entraria no saldo.
    expect(blocoDaFuncao("aluno_saldo_pendente_detalhe")).toContain("coalesce(t.tipo_boleto,'') <> 'Acordo'");
    expect(blocoDaFuncao("recalcular_situacao_aluno")).toContain("coalesce(t.tipo_boleto,'') <> 'Acordo'");
    expect(blocoDaFuncao("resumo_carteira_operador"))
      .toContain("not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id=t.id)");
    // e o proprio portao de elegibilidade recusa tipo_boleto='Acordo'
    expect(semComentarios(sql)).toContain("then 'TITULO_DE_ACORDO'");
  });

  it("nao escreve em valor_original, valor_em_aberto nem saldo_corrigido", () => {
    const corpo = semComentarios(sql);
    for (const campo of ["valor_original", "valor_em_aberto", "saldo_corrigido"]) {
      expect(corpo).not.toMatch(new RegExp(`set[\\s\\S]{0,400}?\\b${campo}\\s*=`, "i"));
    }
  });

  it("nao toca em acordo, parcela, pagamento, Prime, Santander nem cron", () => {
    const corpo = semComentarios(sql);
    for (const alvo of [
      /(insert into|update|delete from)\s+public\.acordos\b/i,
      /(insert into|update|delete from)\s+public\.parcelas\b/i,
      /(insert into|update|delete from)\s+public\.pagamentos\b/i,
      /(insert into|update|delete from)\s+public\.baixas_pagamento\b/i,
      /\bcron\.(schedule|unschedule|alter_job)\b/i,
      /prime_/i,
      /santander/i,
    ]) {
      expect(corpo).not.toMatch(alvo);
    }
  });

  it("o que a migration ACRESCENTA so escreve em acordos_titulos, historico e auditoria", () => {
    // Escopo: so a parte nova. Os tres leitores sao reproducao byte a byte de
    // producao (provado acima) e ja escreviam em casos/alunos/retorno_acordo_auto
    // antes desta migration -- nao e escrita nova.
    const parteNova = semComentarios(sql.slice(0, sql.indexOf("-- 7. LEITORES")));
    const alvos = [...parteNova.matchAll(/(?:insert\s+into|update)\s+(public\.[a-z_]+)/gi)]
      .map((m) => m[1].toLowerCase());
    expect([...new Set(alvos)].sort()).toEqual([
      "public.acordos_titulos",
      "public.auditoria",
      "public.titulo_valor_ajuste_historico",
    ]);
  });

  it("os leitores nao ganharam nem perderam alvo de escrita", () => {
    // Cada leitor so pode escrever exatamente onde a foto de producao escrevia.
    for (const [nome, [arq]] of Object.entries(LEITORES)) {
      const foto = readFileSync(resolve(RAIZ, "supabase/audits", arq), "utf8");
      const alvo = (t) => [...new Set(
        [...semComentarios(t).matchAll(/(?:insert\s+into|update)\s+(public\.[a-z_]+)/gi)].map((m) => m[1].toLowerCase()),
      )].sort().join(",");
      expect(`${nome}:${alvo(blocoDaFuncao(nome))}`).toBe(`${nome}:${alvo(foto)}`);
    }
  });

  it("o portao tem exatamente Amanda e Fernanda", () => {
    const i = sql.indexOf("function public.crm_usuario_pode_ajustar_valor()");
    const gate = sql.slice(i, sql.indexOf("$function$;", i));
    const emails = [...gate.matchAll(/'([a-z0-9._%+-]+@[a-z0-9.-]+)'/g)].map((m) => m[1]);
    expect(emails).toEqual(["amanda.seibel@aelbra.com.br", "cobranca04@aelbra.com.br"]);
    expect(gate).toContain("'postgres', 'supabase_admin', 'service_role'");
  });

  it("a guarda de tabela cobre as 4 colunas, em INSERT e UPDATE", () => {
    expect(sql).toMatch(
      /create trigger trg_titulo_ajuste_valor_protegido\s+before insert or update of valor_cobranca_ajustado, motivo_ajuste_valor, valor_ajustado_por, valor_ajustado_em\s+on public\.acordos_titulos/,
    );
    expect(sql).toContain("SEM_PERMISSAO_AJUSTAR_VALOR_COBRAVEL");
  });

  it("valor zero ou negativo e recusado no RPC e na tabela", () => {
    expect(semComentarios(sql)).toContain("p_valor is not null and p_valor <= 0");
    expect(semComentarios(sql)).toContain("VALOR_DEVE_SER_MAIOR_QUE_ZERO");
    expect(semComentarios(sql)).toContain("check (valor_cobranca_ajustado is null or valor_cobranca_ajustado > 0)");
  });

  it("definir E remover geram historico, antes da escrita", () => {
    const i = sql.indexOf("function public.titulo_ajustar_valor_cobravel(");
    const rpc = sql.slice(i, sql.indexOf("$function$;", i));
    expect(rpc).toContain("insert into public.titulo_valor_ajuste_historico");
    // o insert do historico vem ANTES do update do titulo
    expect(rpc.indexOf("insert into public.titulo_valor_ajuste_historico"))
      .toBeLessThan(rpc.indexOf("update public.acordos_titulos"));
    // e a acao distingue os dois eventos
    expect(rpc).toContain("case when p_valor is null then 'REMOVER' else 'DEFINIR' end");
    expect(sql).toContain("check (acao in ('DEFINIR','REMOVER'))");
  });

  it("o RPC exige o portao e nao confia na tela", () => {
    const i = sql.indexOf("function public.titulo_ajustar_valor_cobravel(");
    const rpc = sql.slice(i, sql.indexOf("$function$;", i));
    expect(rpc).toContain("if not public.crm_usuario_pode_ajustar_valor() then");
    expect(rpc).toContain("errcode = '42501'");
  });

  it("nao faz backfill: nenhum UPDATE sem WHERE de id", () => {
    const corpo = semComentarios(sql);
    const updates = [...corpo.matchAll(/update\s+public\.acordos_titulos[\s\S]*?;/gi)].map((m) => m[0]);
    expect(updates.length).toBe(1);
    expect(updates[0]).toContain("where id = p_titulo_id");
  });

  it("nao le nem escreve os campos de ajuste que ficaram em casos", () => {
    expect(semComentarios(sql)).not.toMatch(/public\.casos[\s\S]{0,200}valor_cobranca_ajustado/i);
  });
});
