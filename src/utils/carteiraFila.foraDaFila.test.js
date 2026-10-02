// CONFERENCIA PRIME SAI DA FILA DE COBRANCA, SEM PERDER NADA.
//
// Medido em producao em 01/10/2026: 261 casos ativos em AGUARDANDO_CONFIRMACAO,
// 168 ainda com operador, aparecendo como trabalho de cobranca com saldo zerado.
// O filtro da fila excluia por `status_jornada`, que nunca carrega esse valor
// (0 alunos), entao 272 alunos passavam.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { foraDaFilaOperacional, SITUACAO_FORA_DA_FILA_OPERACIONAL } from "./carteiraFila";

const AQUI = dirname(fileURLToPath(import.meta.url));

const aluno = (situacao, extra = {}) => ({
  id: "a1",
  situacao_operacional: situacao,
  responsavel_atual_email: "cobranca10@aelbra.com.br",
  responsavel_atual_nome: "Ana",
  saldo_total: 0,
  ...extra,
});

// A fila real roda no banco; aqui o predicado e aplicado sobre a lista, que e
// o mesmo criterio passado ao `.not()` da consulta.
const fila = (lista) => lista.filter((a) => !foraDaFilaOperacional(a));

describe("fila operacional — AGUARDANDO_CONFIRMACAO", () => {
  it("caso em AGUARDANDO_CONFIRMACAO não aparece na fila", () => {
    const a = aluno("AGUARDANDO_CONFIRMACAO");
    expect(foraDaFilaOperacional(a)).toBe(true);
    expect(fila([a])).toEqual([]);
  });

  it("o responsável permanece — a exclusão é de listagem, não apagamento", () => {
    const a = aluno("AGUARDANDO_CONFIRMACAO");
    fila([a]);
    expect(a.responsavel_atual_email).toBe("cobranca10@aelbra.com.br");
    expect(a.responsavel_atual_nome).toBe("Ana");
    expect(a.situacao_operacional).toBe("AGUARDANDO_CONFIRMACAO");
    expect(a.saldo_total).toBe(0);
  });

  it("ao voltar para situação cobrável, reaparece na fila", () => {
    const a = aluno("AGUARDANDO_CONFIRMACAO");
    expect(fila([a])).toEqual([]);
    // a conferencia resolveu: `recalcular_situacao_aluno` troca a situacao
    const depois = { ...a, situacao_operacional: "COBRANCA_VENCIDA", saldo_total: 2095.4 };
    expect(foraDaFilaOperacional(depois)).toBe(false);
    expect(fila([depois])).toEqual([depois]);
  });

  it("não tira ninguém além de AGUARDANDO_CONFIRMACAO", () => {
    const outros = ["COBRANCA_VENCIDA", "ACORDO_EM_DIA", "QUITADO", "SEM_PENDENCIA", "", null];
    for (const s of outros) expect(foraDaFilaOperacional(aluno(s))).toBe(false);
    expect(SITUACAO_FORA_DA_FILA_OPERACIONAL).toEqual(["AGUARDANDO_CONFIRMACAO"]);
  });

  it("a consulta da fila aplica a exclusão por situacao_operacional", () => {
    const pagina = readFileSync(resolve(AQUI, "..", "pages", "FilaOperacional.jsx"), "utf8");
    // a exclusao tem de sair da constante, nao de literal solto no meio da query
    expect(pagina).toMatch(/SITUACAO_FORA_DA_FILA_OPERACIONAL/);
    expect(pagina).toMatch(/\.not\(\s*"situacao_operacional"/);
    // e o filtro antigo por status_jornada continua de pe
    expect(pagina).toMatch(/"status_jornada"/);
  });

  it("a Conferência Prime continua enxergando esses casos", () => {
    // a exclusao vive SO na fila operacional; nada em filaConfirmacao/Conferencia
    // passa a depender dela.
    const conf = readFileSync(resolve(AQUI, "filaConfirmacao.js"), "utf8");
    expect(conf).not.toMatch(/SITUACAO_FORA_DA_FILA_OPERACIONAL|foraDaFilaOperacional/);
  });
});
