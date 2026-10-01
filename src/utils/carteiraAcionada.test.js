import { describe, it, expect, vi } from "vitest";
import {
  TIPOS_ACIONAMENTO_INDIVIDUAL,
  classificarVinculo,
  percentual,
  carregarIndicadoresCarteira,
} from "./carteiraAcionada";

// Cliente supabase de mentira: cada `from()` devolve um encadeador que ignora
// os filtros e entrega a lista combinada para aquela tabela. O teto de 1.000
// da API nunca e atingido aqui, entao `buscarTudo` para na primeira pagina.
function clienteFalso(tabelas) {
  return {
    from(tabela) {
      const encadeador = {
        select: () => encadeador,
        eq: () => encadeador,
        in: () => encadeador,
        ilike: () => encadeador,
        gte: () => encadeador,
        order: () => encadeador,
        range: () => Promise.resolve({ data: tabelas[tabela] || [], error: null }),
      };
      return encadeador;
    },
  };
}

describe("tipos de acionamento", () => {
  it("nao inclui acao massiva, rotina de sistema nem movimentacao de posse", () => {
    for (const proibido of [
      "ACAO_MASSIVA_EXTERNA",
      "ACAO_MASSIVA_EXTERNA_EMAIL",
      "REDISTRIBUICAO_SINCRONIZACAO",
      "ASSUMIU_ATENDIMENTO",
      "ATRIBUICAO_ACORDO",
      "ALTERACAO_RESPONSAVEL_ACORDO",
      "DEVOLUCAO_DONO",
      "REABERTURA_DIVIDA_NOVA",
      "TITULO_EM_CONFIRMACAO_PRIME",
      "ZERADO_REAL_SEM_SALDO",
    ]) {
      expect(TIPOS_ACIONAMENTO_INDIVIDUAL).not.toContain(proibido);
    }
  });

  it("inclui a tabulacao de atendimento, que e o acionamento principal", () => {
    expect(TIPOS_ACIONAMENTO_INDIVIDUAL).toContain("FINALIZACAO_ATENDIMENTO");
  });
});

describe("classificarVinculo", () => {
  it("rotula as tres formas de entrada e o nada", () => {
    expect(classificarVinculo({ casoAtivo: true, acordoAtivo: false })).toBe("CASO");
    expect(classificarVinculo({ casoAtivo: false, acordoAtivo: true })).toBe("ACORDO");
    expect(classificarVinculo({ casoAtivo: true, acordoAtivo: true })).toBe("CASO_ACORDO");
    expect(classificarVinculo({})).toBe(null);
  });
});

describe("percentual", () => {
  it("uma casa decimal e zero sem carteira", () => {
    expect(percentual(462, 500)).toBe(92.4);
    expect(percentual(0, 0)).toBe(0);
  });
});

describe("carregarIndicadoresCarteira", () => {
  const email = "cobranca05@aelbra.com.br";

  it("conta como acionado so o que o proprio responsavel fez DEPOIS de receber", async () => {
    const cliente = clienteFalso({
      casos: [
        { id: "c1", aluno_id: "a1" }, // acionado depois de receber -> conta
        { id: "c2", aluno_id: "a2" }, // acionado ANTES de receber  -> nao conta
        { id: "c3", aluno_id: "a3" }, // nenhum acionamento do dono  -> nao conta
      ],
      alunos: [
        { id: "a1", responsavel_atual_em: "2026-09-10T12:00:00Z" },
        { id: "a2", responsavel_atual_em: "2026-09-20T12:00:00Z" },
        { id: "a3", responsavel_atual_em: "2026-09-15T12:00:00Z" },
      ],
      aluno_movimentacoes: [
        { aluno_id: "a1", registrado_em: "2026-09-16T09:00:00Z" },
        { aluno_id: "a2", registrado_em: "2026-09-12T09:00:00Z" },
      ],
      acordos: [],
    });

    const r = await carregarIndicadoresCarteira(cliente, email);
    expect(r.total).toBe(3);
    expect(r.acionada).toBe(1);
    expect(r.semAcionamento).toBe(2);
    expect(r.pctAcionada).toBe(33.3);
  });

  it("caso sem responsavel_atual_em nunca entra na carteira acionada", async () => {
    const cliente = clienteFalso({
      casos: [{ id: "c1", aluno_id: "a1" }],
      alunos: [{ id: "a1", responsavel_atual_em: null }],
      aluno_movimentacoes: [{ aluno_id: "a1", registrado_em: "2026-09-16T09:00:00Z" }],
      acordos: [],
    });
    const r = await carregarIndicadoresCarteira(cliente, email);
    expect(r.total).toBe(1);
    expect(r.acionada).toBe(0);
  });

  it("somente acordo e unidade ALUNO e exclui quem ja tem caso ativo", async () => {
    const cliente = clienteFalso({
      casos: [{ id: "c1", aluno_id: "a1" }],
      alunos: [{ id: "a1", responsavel_atual_em: "2026-09-10T12:00:00Z" }],
      aluno_movimentacoes: [],
      acordos: [
        { aluno_id: "a1" }, // tem caso ativo -> nao e "somente acordo"
        { aluno_id: "a9" },
        { aluno_id: "a9" }, // dois acordos do mesmo aluno contam 1 aluno
      ],
    });
    const r = await carregarIndicadoresCarteira(cliente, email);
    expect(r.somenteAcordo).toBe(1);
  });

  it("sem e-mail nao consulta o banco", async () => {
    const from = vi.fn();
    const r = await carregarIndicadoresCarteira({ from }, "");
    expect(from).not.toHaveBeenCalled();
    expect(r.total).toBe(0);
  });
});
