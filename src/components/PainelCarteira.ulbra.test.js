// Garantia: o botao da Mensageria ULBRA aparece na ficha aberta pela carteira e
// pelo acionamento guiado (o modal do PainelCarteira), e nao so na pagina /aluno.
// Leitura do codigo-fonte: o componente e grande demais para montar em teste.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "PainelCarteira.jsx"), "utf8");

describe("PainelCarteira: Mensageria ULBRA na ficha da carteira", () => {
  it("importa o BlocoUlbra", () => {
    expect(SRC).toMatch(/import BlocoUlbra from "\.\/BlocoUlbra";/);
  });

  it("renderiza o BlocoUlbra dentro do modal da ficha, com o aluno aberto", () => {
    const inicio = SRC.indexOf("{modalAberto && alunoModal && (");
    expect(inicio).toBeGreaterThan(-1);
    // O modal termina antes de qualquer outro modal de nivel superior; o bloco tem
    // de estar no cabecalho dele, depois do resumo de contato.
    const trecho = SRC.slice(inicio, inicio + 9000);
    expect(trecho).toMatch(/<BlocoUlbra aluno=\{alunoModal\} sobDemanda \/>/);
    // Dentro do cabecalho: antes do botao de fechar do proprio cabecalho.
    expect(trecho.indexOf("<BlocoUlbra aluno={alunoModal} sobDemanda />")).toBeLessThan(
      trecho.indexOf("S.btnFechar} onClick={fecharModal}"),
    );
  });
});
