// Garantias de fonte unica do D-2 no PainelCarteira (leitura do codigo-fonte; o componente e grande demais para montar em teste).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "PainelCarteira.jsx"), "utf8");

describe("PainelCarteira: D-2 vem so do alerta novo", () => {
  it("consome a RPC acordo_alertas_do_operador e renderiza AlertasParcelaAcordo", () => {
    expect(SRC).toMatch(/supabase\.rpc\("acordo_alertas_do_operador"\)/);
    expect(SRC).toMatch(/<AlertasParcelaAcordo/);
  });
  it("o card antigo 'Lembrete de parcela' (por data_retorno) nao e mais renderizado", () => {
    expect(SRC).not.toMatch(/🔔 Lembrete de parcela/);
    expect(SRC).not.toMatch(/\{lembreteParcelaDevido\(alunoModal\)\s*&&/);
  });
  it("abrir o aluno pelo card nao pre-seleciona nem induz status: setStatusNovo so usa statusTabulavel do status real", () => {
    expect(SRC).not.toMatch(/lembreteParcelaDevido/);
    expect(SRC).not.toMatch(/\?\s*"LEMBRETE_PARCELA"\s*:/);
    expect(SRC).toMatch(/setStatusNovo\(statusTabulavel\(a\.status_atual\)\);/);
    const card = SRC.slice(SRC.indexOf("<AlertasParcelaAcordo"), SRC.indexOf("<AlertasParcelaAcordo") + 700);
    expect(card).toMatch(/abrirModal\(/);
    expect(card).not.toMatch(/setStatusNovo|LEMBRETE_PARCELA|supabase\.(from|rpc)/);
  });
  it("nao cria status LEMBRETE_PARCELA novo nem ACORDO_FECHADO para o alerta", () => {
    const trecho = SRC.slice(SRC.indexOf("carregarAlertasParcela"), SRC.indexOf("carregarAlertasParcela") + 400);
    expect(trecho).not.toMatch(/LEMBRETE_PARCELA|ACORDO_FECHADO/);
  });
});
