// Tabulações informativas de TERMO FÍSICO (gestão, 13/11/2026).
//
// O que este teste trava: as duas opções existem nos dois <select> que gravam
// tabulação (ficha e Minha Carteira), têm rótulo humano, qualquer operador
// pode escolher, e NÃO carregam efeito nenhum além do registro no histórico.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { rotuloStatus } from "./rotulosStatus";
import { ehQuitado, labelStatus } from "./carteiraFila";
import {
  FALLBACK_TABULACOES,
  desfechoDaTabulacao,
  tabulacaoDisponivel,
  tabulacaoEhSoGestao,
} from "./tabulacoes";

const aqui = dirname(fileURLToPath(import.meta.url));
const ler = (rel) => readFileSync(resolve(aqui, rel), "utf8");

const CODIGOS = ["TERMO_FISICO_EM_ANDAMENTO", "TERMO_FISICO_ARQUIVADO"];

// Só o literal do array STATUS_FINALIZACAO, sem o resto do arquivo.
function listaDoSelect(fonte) {
  const m = /const STATUS_FINALIZACAO = \[([\s\S]*?)\n\];/.exec(fonte);
  return m ? m[1] : "";
}

describe("tabulações de termo físico", () => {
  it("aparecem nos dois <select> que gravam tabulação", () => {
    for (const arquivo of ["../pages/Aluno.jsx", "../components/PainelCarteira.jsx"]) {
      const lista = listaDoSelect(ler(arquivo));
      for (const codigo of CODIGOS) expect(lista, `${codigo} em ${arquivo}`).toContain(`"${codigo}"`);
    }
  });

  it("têm o rótulo pedido pela gestão, na ficha e na carteira", () => {
    expect(rotuloStatus("TERMO_FISICO_EM_ANDAMENTO")).toBe("Possui termo físico assinado, em andamento");
    expect(rotuloStatus("TERMO_FISICO_ARQUIVADO")).toBe("Termo físico arquivado, quitado");
    expect(labelStatus("TERMO_FISICO_ARQUIVADO")).toBe("Termo físico arquivado, quitado");
  });

  it("qualquer operador pode escolher", () => {
    for (const codigo of CODIGOS) {
      expect(tabulacaoEhSoGestao(codigo)).toBe(false);
      expect(tabulacaoDisponivel(codigo, false)).toBe(true);
    }
  });

  it("são informativas: não agendam retorno e não mudam a próxima ação", () => {
    for (const codigo of CODIGOS) {
      expect(desfechoDaTabulacao(FALLBACK_TABULACOES, codigo)).toEqual({ proxima_acao: "CONTATAR", motivo: "NENHUMA" });
    }
  });

  it("'arquivado, quitado' NÃO vira caso quitado: o código não casa com a régua de QUITAD", () => {
    for (const codigo of CODIGOS) {
      expect(codigo).not.toMatch(/QUITAD|QUITACAO/);
      expect(ehQuitado({ status_atual: codigo, status_jornada: codigo, status_acionamento: codigo })).toBe(false);
    }
  });

  it("não disparam nenhum desvio da ficha: sem baixa, sem bloqueio, sem bloco automático", () => {
    const ficha = ler("../pages/Aluno.jsx");
    // Fora da lista do <select>, os códigos não podem aparecer em mais lugar
    // nenhum da ficha -- nem em STATUS_BLOQUEADOS_ACIONAMENTO, nem no mapa que
    // abre formulário, nem no ramo que cria solicitação de confirmação de
    // pagamento (que é exclusivo de AGUARDANDO_BAIXA).
    for (const codigo of CODIGOS) {
      expect(ficha.split(`"${codigo}"`).length - 1, codigo).toBe(1);
      expect(ficha).not.toContain(`${codigo}:`);
    }
    const carteira = ler("../components/PainelCarteira.jsx");
    for (const codigo of CODIGOS) expect(carteira.split(`"${codigo}"`).length - 1, codigo).toBe(1);
  });
});
