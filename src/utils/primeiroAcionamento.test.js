// Regra do "Pendente de 1o acionamento" (22/10/2026).
//
// O que estas guardas protegem, na ordem dos criterios da gestao:
//   1. pendente = sem tabulacao VALIDA do responsavel ATUAL desde a atribuicao;
//   2. acionamento anterior a nova atribuicao NAO conta como primeiro contato,
//      nem quando foi o mesmo operador (os 274 casos auditados);
//   3. a referencia e a data EFETIVA da atribuicao -- atualizacao tecnica sem
//      troca real de responsavel nao reinicia o indicador;
//   4. so entram casos da carteira recebida (o modulo nao amplia universo).
import { describe, it, expect } from "vitest";
import {
  dataDaAtribuicao,
  acionouDesdeAtribuicao,
  idsPendentesPrimeiroAcionamento,
  agruparPorAluno,
  normalizarEmail,
} from "./primeiroAcionamento";

const OP = "cobranca06@aelbra.com.br";
const ANTERIOR = "cobranca05@aelbra.com.br";
const GIRO = "2026-10-16T12:00:00Z";

const caso = (extra) => ({ id: "a1", responsavel_atual_email: OP, responsavel_atual_em: GIRO, ...extra });
const tab = (extra) => ({ aluno_id: "a1", registrado_por_email: OP, registrado_em: "2026-10-20T12:00:00Z", ...extra });
const transf = (extra) => ({ aluno_id: "a1", operador_novo_email: OP, operador_anterior_email: ANTERIOR, registrado_em: GIRO, ...extra });

const pendentes = ({ casos, tabulacoes = [], transferencias = [] }) =>
  idsPendentesPrimeiroAcionamento({
    casos,
    tabulacoesPorAluno: agruparPorAluno(tabulacoes),
    transferenciasPorAluno: agruparPorAluno(transferencias),
  });

describe("dataDaAtribuicao: a data EFETIVA da troca de mao", () => {
  it("usa o registro de transferencia, nao o carimbo da ficha", () => {
    const quando = dataDaAtribuicao({
      transferencias: [transf({ registrado_em: "2026-10-16T12:00:00Z" })],
      responsavelAtualEm: "2026-07-01T12:00:00Z",
      operador: OP,
    });
    expect(quando).toBe(Date.parse("2026-10-16T12:00:00Z"));
  });

  it("CRITERIO 3: atualizacao tecnica posterior NAO empurra a atribuicao para frente", () => {
    // `responsavel_atual_em` reescrito depois, sem troca de dono. Se ele
    // mandasse, um caso ja trabalhado voltaria a aparecer como pendente.
    const quando = dataDaAtribuicao({
      transferencias: [transf({ registrado_em: "2026-10-16T12:00:00Z" })],
      responsavelAtualEm: "2026-10-21T23:00:00Z",
      operador: OP,
    });
    expect(quando).toBe(Date.parse("2026-10-16T12:00:00Z"));
  });

  it("sincronizacao com o mesmo operador dos dois lados nao e troca de mao", () => {
    const quando = dataDaAtribuicao({
      transferencias: [
        transf({ registrado_em: "2026-10-16T12:00:00Z" }),
        transf({ operador_anterior_email: OP, registrado_em: "2026-10-21T10:00:00Z" }),
      ],
      responsavelAtualEm: null,
      operador: OP,
    });
    expect(quando).toBe(Date.parse("2026-10-16T12:00:00Z"));
  });

  it("transferencia para OUTRO operador nao conta como atribuicao minha", () => {
    const quando = dataDaAtribuicao({
      transferencias: [transf({ operador_novo_email: ANTERIOR, operador_anterior_email: OP, registrado_em: "2026-10-21T10:00:00Z" })],
      responsavelAtualEm: GIRO,
      operador: OP,
    });
    expect(quando).toBe(Date.parse(GIRO));
  });

  it("com varias entradas, vale a mais recente", () => {
    const quando = dataDaAtribuicao({
      transferencias: [
        transf({ registrado_em: "2026-07-13T12:00:00Z" }),
        transf({ registrado_em: "2026-10-16T12:00:00Z" }),
        transf({ registrado_em: "2026-09-10T12:00:00Z" }),
      ],
      operador: OP,
    });
    expect(quando).toBe(Date.parse("2026-10-16T12:00:00Z"));
  });

  it("sem registro de troca, cai no carimbo da ficha (ultimo recurso)", () => {
    expect(dataDaAtribuicao({ transferencias: [], responsavelAtualEm: GIRO, operador: OP })).toBe(Date.parse(GIRO));
    expect(dataDaAtribuicao({ transferencias: [], responsavelAtualEm: null, operador: OP })).toBeNull();
  });

  it("ignora e-mail com caixa diferente e data invalida", () => {
    expect(dataDaAtribuicao({ transferencias: [transf({ operador_novo_email: OP.toUpperCase() })], operador: OP }))
      .toBe(Date.parse(GIRO));
    expect(dataDaAtribuicao({ transferencias: [transf({ registrado_em: "nao-e-data" })], responsavelAtualEm: null, operador: OP }))
      .toBeNull();
  });
});

describe("acionouDesdeAtribuicao", () => {
  const atribuidoEm = Date.parse(GIRO);

  it("tabulacao do operador atual depois da atribuicao conta", () => {
    expect(acionouDesdeAtribuicao({ tabulacoes: [tab()], operador: OP, atribuidoEm })).toBe(true);
  });

  it("CRITERIO 2: tabulacao do operador ANTERIOR nao conta, mesmo recente", () => {
    expect(acionouDesdeAtribuicao({
      tabulacoes: [tab({ registrado_por_email: ANTERIOR, registrado_em: "2026-10-21T12:00:00Z" })],
      operador: OP, atribuidoEm,
    })).toBe(false);
  });

  it("CRITERIO 2: tabulacao do MESMO operador ANTES da atribuicao nao conta (os 274 casos)", () => {
    expect(acionouDesdeAtribuicao({
      tabulacoes: [tab({ registrado_em: "2026-10-01T12:00:00Z" })],
      operador: OP, atribuidoEm,
    })).toBe(false);
  });

  it("tabulacao no instante exato da atribuicao conta", () => {
    expect(acionouDesdeAtribuicao({ tabulacoes: [tab({ registrado_em: GIRO })], operador: OP, atribuidoEm })).toBe(true);
  });

  it("tabulacao sem autor nao conta -- nao da para afirmar de quem foi", () => {
    expect(acionouDesdeAtribuicao({
      tabulacoes: [tab({ registrado_por_email: null }), tab({ registrado_por_email: "" })],
      operador: OP, atribuidoEm,
    })).toBe(false);
  });

  it("sem data de atribuicao, qualquer tabulacao do dono atual vale", () => {
    expect(acionouDesdeAtribuicao({ tabulacoes: [tab({ registrado_em: "2026-01-01T12:00:00Z" })], operador: OP, atribuidoEm: null })).toBe(true);
    expect(acionouDesdeAtribuicao({ tabulacoes: [tab({ registrado_por_email: ANTERIOR })], operador: OP, atribuidoEm: null })).toBe(false);
  });
});

describe("idsPendentesPrimeiroAcionamento", () => {
  it("CRITERIO 1: pendente e quem nao recebeu tabulacao do atual desde a atribuicao", () => {
    const casos = [
      caso({ id: "nunca" }),
      caso({ id: "so-anterior" }),
      caso({ id: "mesmo-op-antes" }),
      caso({ id: "feito" }),
    ];
    const tabulacoes = [
      tab({ aluno_id: "so-anterior", registrado_por_email: ANTERIOR, registrado_em: "2026-10-20T12:00:00Z" }),
      tab({ aluno_id: "mesmo-op-antes", registrado_em: "2026-10-01T12:00:00Z" }),
      tab({ aluno_id: "feito", registrado_em: "2026-10-20T12:00:00Z" }),
    ];
    const transferencias = casos.map((c) => transf({ aluno_id: c.id }));
    expect(pendentes({ casos, tabulacoes, transferencias })).toEqual(["nunca", "so-anterior", "mesmo-op-antes"]);
  });

  it("CRITERIO 3: carimbo tecnico depois da atribuicao nao devolve o caso para a fila", () => {
    const casos = [caso({ id: "trabalhado", responsavel_atual_em: "2026-10-21T23:00:00Z" })];
    const tabulacoes = [tab({ aluno_id: "trabalhado", registrado_em: "2026-10-20T12:00:00Z" })];
    const transferencias = [transf({ aluno_id: "trabalhado", registrado_em: GIRO })];
    expect(pendentes({ casos, tabulacoes, transferencias })).toEqual([]);
    // Sem o registro de troca, o carimbo manda e o caso apareceria pendente --
    // e a diferenca que o criterio 3 pede.
    expect(pendentes({ casos, tabulacoes, transferencias: [] })).toEqual(["trabalhado"]);
  });

  it("CRITERIO 4: so devolve id que veio na carteira recebida", () => {
    const casos = [caso({ id: "meu" })];
    const tabulacoes = [tab({ aluno_id: "de-fora", registrado_em: "2026-10-20T12:00:00Z" })];
    const fora = pendentes({ casos, tabulacoes, transferencias: [transf({ aluno_id: "meu" })] });
    expect(fora).toEqual(["meu"]);
    expect(fora).not.toContain("de-fora");
  });

  it("caso sem responsavel nao entra: nao ha primeiro acionamento do atual a cobrar", () => {
    expect(pendentes({ casos: [caso({ id: "orfao", responsavel_atual_email: null })] })).toEqual([]);
  });

  it("carteira vazia devolve lista vazia", () => {
    expect(pendentes({ casos: [] })).toEqual([]);
    expect(idsPendentesPrimeiroAcionamento()).toEqual([]);
  });

  it("cada caso usa a propria atribuicao e o proprio dono", () => {
    const casos = [
      caso({ id: "a", responsavel_atual_email: OP }),
      caso({ id: "b", responsavel_atual_email: ANTERIOR }),
    ];
    const tabulacoes = [
      tab({ aluno_id: "a", registrado_por_email: OP, registrado_em: "2026-10-20T12:00:00Z" }),
      tab({ aluno_id: "b", registrado_por_email: OP, registrado_em: "2026-10-20T12:00:00Z" }),
    ];
    const transferencias = [
      transf({ aluno_id: "a" }),
      transf({ aluno_id: "b", operador_novo_email: ANTERIOR, operador_anterior_email: OP }),
    ];
    // "b" foi tabulado pelo OP, mas o dono dele e o ANTERIOR: segue pendente.
    expect(pendentes({ casos, tabulacoes, transferencias })).toEqual(["b"]);
  });
});

describe("agruparPorAluno / normalizarEmail", () => {
  it("agrupa por aluno_id e descarta linha sem aluno", () => {
    const m = agruparPorAluno([tab(), tab({ aluno_id: "a2" }), tab({ aluno_id: null })]);
    expect([...m.keys()]).toEqual(["a1", "a2"]);
    expect(m.get("a1")).toHaveLength(1);
  });

  it("normaliza caixa e espaco", () => {
    expect(normalizarEmail("  Cobranca06@AELBRA.com.br ")).toBe("cobranca06@aelbra.com.br");
    expect(normalizarEmail(null)).toBe("");
  });
});
