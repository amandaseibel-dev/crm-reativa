// Reagendar sem data e recusado ANTES de qualquer upload ou escrita, nos dois fronts
// que finalizam atendimento. Prova de ordem no fonte (mesmo padrao do teste de prioridade).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ALUNO = readFileSync(resolve(AQUI, "Aluno.jsx"), "utf8");
const PAINEL = readFileSync(resolve(AQUI, "../components/PainelCarteira.jsx"), "utf8");
const GUARDA = "Informe a data e a hora do retorno para reagendar";

describe("Reagendar sem data: recusa antes de qualquer escrita", () => {
  it("Aluno.finalizarAtendimento: recusa antes do upload do print e do registrarMovimentacao", () => {
    const ini = ALUNO.indexOf("async function finalizarAtendimento()");
    const guarda = ALUNO.indexOf(GUARDA, ini);
    expect(guarda).toBeGreaterThan(ini);
    expect(guarda).toBeLessThan(ALUNO.indexOf("supabase.storage", ini));
    expect(guarda).toBeLessThan(ALUNO.indexOf("await registrarMovimentacao", ini));
  });

  it("PainelCarteira.finalizarAtendimento: recusa antes da RPC e do setSalvando", () => {
    const ini = PAINEL.indexOf("const desfecho = desfechoDaTabulacao(catalogo, statusNovo");
    const guarda = PAINEL.indexOf(GUARDA, ini);
    expect(guarda).toBeGreaterThan(ini);
    expect(guarda).toBeLessThan(PAINEL.indexOf("setSalvando(true);", ini));
    expect(guarda).toBeLessThan(PAINEL.indexOf('supabase.rpc("atendimento_reagendar_com_status"', ini));
  });
});
