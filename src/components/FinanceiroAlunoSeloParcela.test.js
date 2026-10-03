// O SELO DA PARCELA NA FICHA.
//
// 29/09/2026: a ficha da Keyla mostrava 8 parcelas com vencimento de fev a set
// e o selo "A vencer" em todas. O texto saia de parcelas.status, que nasce
// 'A_VENCER' e so vira VENCIDA no cron das 03:05; a COR da mesma linha ja saia
// da data. Resultado: badge vermelho de vencida com o texto "A vencer".
//
// Estes testes prendem a regra nova: em aberto quem decide e a data, estado
// terminal vem do status, e status desconhecido nao pode ser mascarado.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rotuloParcela } from "../utils/statusParcela";

describe("selo da parcela: em aberto quem manda e a data", () => {
  // `vencida` e o mesmo booleano que ja pinta a cor do selo (diasAtraso > 0).
  it("parcela ainda A_VENCER no banco mas com vencimento passado mostra Vencida", () => {
    expect(rotuloParcela("A_VENCER", true)).toBe("Vencida");
  });

  it("parcela futura mostra A vencer", () => {
    expect(rotuloParcela("A_VENCER", false)).toBe("A vencer");
  });

  it("parcela ja VENCIDA no banco continua Vencida", () => {
    expect(rotuloParcela("VENCIDA", true)).toBe("Vencida");
  });

  // O cron tem um segundo passo que devolve para A_VENCER a parcela cuja data
  // foi corrigida para o futuro. Ate ele rodar, a tela ja conta a verdade.
  it("parcela VENCIDA no banco com data corrigida para o futuro mostra A vencer", () => {
    expect(rotuloParcela("VENCIDA", false)).toBe("A vencer");
  });
});

describe("selo da parcela: estado terminal vem do status, nao da data", () => {
  it("paga continua Paga mesmo com vencimento passado", () => {
    expect(rotuloParcela("PAGO", true)).toBe("Paga");
    expect(rotuloParcela("PAGO", false)).toBe("Paga");
  });

  it("cancelada continua Cancelada", () => {
    expect(rotuloParcela("CANCELADA", true)).toBe("Cancelada");
    expect(rotuloParcela("CANCELADA", false)).toBe("Cancelada");
  });

  // Parcela substituida por re-acordo. Antes caia no fallback e aparecia como
  // "A vencer" -- dizia que havia algo a cobrar numa parcela ja substituida.
  it("renegociada aparece como Renegociada, nunca como A vencer", () => {
    expect(rotuloParcela("RENEGOCIADA", true)).toBe("Renegociada");
    expect(rotuloParcela("RENEGOCIADA", false)).toBe("Renegociada");
  });
});

describe("selo da parcela: status desconhecido nao e mascarado", () => {
  it("status fora do catalogo aparece explicito, e nao como A vencer", () => {
    const r = rotuloParcela("STATUS_NOVO", false);
    expect(r).not.toBe("A vencer");
    expect(r).toContain("STATUS_NOVO");
  });

  it("status null ou vazio aparece como Sem status", () => {
    expect(rotuloParcela(null, false)).toBe("Sem status");
    expect(rotuloParcela(undefined, true)).toBe("Sem status");
    expect(rotuloParcela("", false)).toBe("Sem status");
  });
});

// A funcao pode estar certa e o JSX continuar chamando a regra velha. Esta
// ancora olha o arquivo de verdade. Comentario nao conta.
describe("a ficha usa a funcao no selo da parcela", () => {
  const codigo = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "FinanceiroAluno.jsx"),
    "utf8",
  ).split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("o JSX chama rotuloParcela com o status e o vencida ja calculado", () => {
    expect(codigo).toMatch(/\{rotuloParcela\(p\.status, vencida\)\}/);
  });

  it("nao sobrou o fallback silencioso para A vencer", () => {
    expect(codigo).not.toMatch(/STATUS_PARCELA_LABEL\[p\.status\] \|\| "A vencer"/);
  });
});
