// BOLETO DA PARCELA NA IMPORTACAO -- ESTRUTURA (o texto da migration).
//
// O arquivo irmao EXECUTA a funcao num Postgres real. Este le o texto e prova
// que a correcao e uma transferencia literal da linha-fonte, e que nada do
// comportamento anterior foi removido no caminho.
//
// O QUE ESTE TESTE NAO PROVA, de proposito: que `parcelas.numero` esteja
// correto. A regra `right(documento,2)` continua como estava e esta fora do
// escopo desta fase.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(AQUI, "..", "..",
  "supabase/migrations/20260915200000_preserva_boleto_da_parcela_na_importacao.sql");
const fonte = readFileSync(MIG, "utf8").replace(/\r/g, "");
// o corpo, sem os comentarios de cabecalho -- que citam de proposito o que a
// migration NAO faz, e envenenariam as assercoes de ausencia
const corpo = fonte.slice(fonte.indexOf("create or replace function"));
const semComentario = corpo.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const insertParcela = semComentario.slice(
  semComentario.indexOf("insert into public.parcelas("),
  semComentario.indexOf("insert into public._backup_completar_parcelas_lote"),
);

describe("1. o boleto passa a ser gravado", () => {
  it("a coluna boleto entra na lista do INSERT em public.parcelas", () => {
    expect(insertParcela).toMatch(/insert into public\.parcelas\([^)]*\bboleto\b[^)]*\)/);
  });

  it("o valor gravado vem de t.boleto -- a propria linha-fonte", () => {
    expect(insertParcela).toContain("t.boleto");
  });

  it("o cursor define boleto como ltrim do documento, nao de outro campo", () => {
    expect(semComentario).toMatch(
      /ltrim\(regexp_replace\(tt\.documento,'\\D','','g'\),'0'\)\s+as\s+boleto/,
    );
  });

  it("o boleto NAO e composto a partir de numero, valor ou vencimento", () => {
    const linhaBoleto = semComentario.split("\n").find((l) => /as\s+boleto\s*,/.test(l)) ?? "";
    expect(linhaBoleto).toContain("tt.documento");
    for (const proibido of ["t.numero", "tt.valor", "tt.vencimento", "numero_acordo"]) {
      expect(linhaBoleto).not.toContain(proibido);
    }
  });

  it("normaliza para 11 digitos: usa ltrim de zero, nao o documento cru", () => {
    expect(insertParcela).not.toMatch(/values\([^)]*regexp_replace\(tt\.documento/);
  });
});

describe("2. nada do comportamento anterior saiu", () => {
  it("as colunas que ja estavam no INSERT continuam todas la", () => {
    for (const col of ["id", "acordo_id", "numero", "valor", "vencimento",
                       "status", "is_entrada", "observacao", "criado_em", "atualizado_em"]) {
      expect(insertParcela).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("o gate de permissao continua", () => {
    expect(semComentario).toContain("_gate_completar_parcelas()");
    expect(semComentario).toContain("42501");
  });

  it("os dois backups continuam", () => {
    expect(semComentario).toContain("_backup_completar_parcelas_lote");
    expect(semComentario).toContain("_backup_parcelas_acordo_erro_import");
    expect(semComentario).toContain("PARCELA_CRIADA");
    expect(semComentario).toContain("TITULO_QUARENTENA");
  });

  it("o dry-run, o limite e a guarda de divergencia continuam", () => {
    expect(semComentario).toContain("if p_dry_run then");
    expect(semComentario).toContain("exit when v_n >= coalesce(p_limite");
    expect(semComentario).toMatch(/abs\(v_soma-r\.valor_total\)>0\.02/);
  });

  it("a assinatura, o SECURITY DEFINER e o search_path sao preservados", () => {
    expect(semComentario).toContain("security definer");
    expect(semComentario).toContain("set search_path to 'public'");
    expect(semComentario).toMatch(/returns table\(acordo_id uuid, numero_acordo bigint, aluno_id uuid,\s*\n?\s*qtd_parcelas integer, valor_total numeric, acao text\)/);
    expect(semComentario).toContain("p_limite integer default 5");
    expect(semComentario).toContain("p_dry_run boolean default true");
  });

  it("a regra de numero permanece exatamente como estava", () => {
    expect(semComentario).toMatch(/right\(regexp_replace\(tt\.documento,'\\D','','g'\),2\)::int as numero/);
  });
});

describe("3. escopo: nao encosta em nada alem da funcao", () => {
  it("nao toca o motor de conciliacao nem estados", () => {
    for (const proibido of ["pagamento_conciliar_um", "status_conciliacao",
                            "consulta_portador", "fila_pagamento_sem_vinculo"]) {
      expect(semComentario).not.toContain(proibido);
    }
  });

  it("nao atualiza parcela historica -- nenhum UPDATE em parcelas", () => {
    expect(semComentario).not.toMatch(/update\s+public\.parcelas/i);
  });

  it("nao mexe em acordos_titulos.dados", () => {
    expect(semComentario).not.toMatch(/acordos_titulos\s+set/i);
  });

  it("a migration cria/substitui UMA funcao so", () => {
    expect(semComentario.match(/create or replace function/g)).toHaveLength(1);
    expect(semComentario).toContain("public.completar_parcelas_acordo(");
  });
});
