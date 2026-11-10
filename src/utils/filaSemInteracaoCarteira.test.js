import { describe, it, expect } from "vitest";
import { filaSemInteracaoCarteira, faixaDeDias } from "./filaSemInteracaoCarteira";

const DIA = 86400000;
const AGORA = Date.parse("2026-11-10T12:00:00Z");
const ha = (d) => new Date(AGORA - d * DIA).toISOString();

describe("faixas do prazo (mesmas de seloPrazo)", () => {
  it("7 dias dentro do prazo; 8 atenção; 9-10 crítico; 11+ perdendo", () => {
    expect(faixaDeDias(7)).toBeNull();
    expect(faixaDeDias(8)).toBe("ATENCAO");
    expect(faixaDeDias(9)).toBe("CRITICO");
    expect(faixaDeDias(10)).toBe("CRITICO");
    expect(faixaDeDias(11)).toBe("PERDENDO");
  });
});

describe("fila pela carteira", () => {
  it("lista só casos fora do prazo, com mais dias primeiro", () => {
    const f = filaSemInteracaoCarteira([
      { aluno_id: "a1", nome: "Um", data_ultimo_acionamento: ha(3) },
      { aluno_id: "a2", nome: "Dois", data_ultimo_acionamento: ha(12) },
      { aluno_id: "a3", nome: "Três", data_ultimo_acionamento: ha(9) },
    ], AGORA);
    expect(f.map((x) => x.aluno_id)).toEqual(["a2", "a3"]);
    expect(f.map((x) => x.faixa)).toEqual(["PERDENDO", "CRITICO"]);
  });

  it("caso da carteira SEM vínculo ULBRA entra normalmente (vínculo não é exigido)", () => {
    const f = filaSemInteracaoCarteira([{ aluno_id: "sem-vinculo", nome: "Sem CPF na Mensageria", data_ultimo_acionamento: ha(20) }], AGORA);
    expect(f).toHaveLength(1);
    expect(f[0].aluno_id).toBe("sem-vinculo");
  });

  it("caso sem data de acionamento não entra (é 'novo', outra fila)", () => {
    expect(filaSemInteracaoCarteira([{ aluno_id: "n", data_ultimo_acionamento: null }], AGORA)).toEqual([]);
  });

  it("um caso por aluno, mesmo se a carteira repetir a linha", () => {
    const f = filaSemInteracaoCarteira([
      { aluno_id: "a1", data_ultimo_acionamento: ha(15) },
      { aluno_id: "a1", data_ultimo_acionamento: ha(15) },
    ], AGORA);
    expect(f).toHaveLength(1);
  });

  it("ordem total: empate de dias desempata por aluno_id, sempre igual", () => {
    const base = [
      { aluno_id: "b", data_ultimo_acionamento: ha(12) },
      { aluno_id: "a", data_ultimo_acionamento: ha(12) },
    ];
    expect(filaSemInteracaoCarteira(base, AGORA).map((x) => x.aluno_id)).toEqual(["a", "b"]);
    expect(filaSemInteracaoCarteira([...base].reverse(), AGORA).map((x) => x.aluno_id)).toEqual(["a", "b"]);
  });

  it("não chama a ULBRA: é função pura sobre a carteira já visível", () => {
    expect(filaSemInteracaoCarteira([], AGORA)).toEqual([]);
  });
});
