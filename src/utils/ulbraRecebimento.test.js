// @vitest-environment jsdom
// Garantias deste módulo, em ordem de importância:
// 1. a tela não oferece o que o banco vai recusar;
// 2. carteira de outro e conferência não aparecem para o operador;
// 3. preferência de som é por operador e nunca derruba a tela.
import { describe, it, expect, beforeEach } from "vitest";
import {
  PREFS_PADRAO,
  contarNovidades,
  marcarNaoLidas,
  conversasVisiveis,
  leadsVisiveis,
  lerPrefs,
  ordenarPorRecencia,
  podeAssumir,
  salvarPrefs,
} from "./ulbraRecebimento";

const LEAD = {
  ulbra_atendimento_id: "a1",
  aluno_status: "vinculado",
  destino_email: "op1@x",
  destino_motivo: "RODIZIO",
  responsavel_email: null,
  dispensado_em: null,
};

describe("podeAssumir", () => {
  it("lead do rodízio sugerido a mim pode ser assumido", () => {
    expect(podeAssumir(LEAD, "op1@x")).toEqual({ pode: true, motivo: null });
  });

  it("email compara sem diferenciar maiúscula", () => {
    expect(podeAssumir(LEAD, "OP1@X").pode).toBe(true);
  });

  it("identidade não confirmada não se assume", () => {
    expect(podeAssumir({ ...LEAD, aluno_status: "nao_confirmado" }, "op1@x")).toEqual({
      pode: false,
      motivo: "IDENTIDADE_NAO_CONFIRMADA",
    });
  });

  it("carteira de outro é recusada para o operador", () => {
    const outro = { ...LEAD, destino_motivo: "CARTEIRA", destino_email: "op2@x" };
    expect(podeAssumir(outro, "op1@x").motivo).toBe("E_DA_CARTEIRA_DE_OUTRO");
  });

  it("gestão passa pela trava da carteira", () => {
    const outro = { ...LEAD, destino_motivo: "CARTEIRA", destino_email: "op2@x" };
    expect(podeAssumir(outro, "op1@x", true).pode).toBe(true);
  });

  it("já assumido por outro não vira botão", () => {
    expect(podeAssumir({ ...LEAD, responsavel_email: "op2@x" }, "op1@x").motivo).toBe("JA_ASSUMIDO");
  });

  it("já é meu não vira botão de assumir de novo", () => {
    expect(podeAssumir({ ...LEAD, responsavel_email: "op1@x" }, "op1@x").motivo).toBe("JA_E_MEU");
  });

  it("dispensado não se assume", () => {
    expect(podeAssumir({ ...LEAD, dispensado_em: "2026-11-08T06:00:00Z" }, "op1@x").motivo).toBe(
      "DISPENSADO",
    );
  });
});

describe("leadsVisiveis", () => {
  const lista = [
    LEAD,
    { ...LEAD, ulbra_atendimento_id: "a2", destino_email: "op2@x" },
    { ...LEAD, ulbra_atendimento_id: "a3", destino_motivo: "CONFERENCIA", destino_email: null },
    { ...LEAD, ulbra_atendimento_id: "a4", destino_motivo: "SEM_OPERADOR", destino_email: null },
    { ...LEAD, ulbra_atendimento_id: "a5", responsavel_email: "op1@x" },
    { ...LEAD, ulbra_atendimento_id: "a6", dispensado_em: "2026-11-08T06:00:00Z" },
  ];

  it("operador vê o que é dele e o que já assumiu", () => {
    expect(leadsVisiveis(lista, "op1@x").map((a) => a.ulbra_atendimento_id)).toEqual(["a1", "a5"]);
  });

  it("gestão vê tudo que não foi dispensado", () => {
    expect(leadsVisiveis(lista, "amanda@x", true).map((a) => a.ulbra_atendimento_id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });
});

describe("leitura por usuário", () => {
  const CONVERSA = {
    ulbra_conversa_id: "c1",
    aluno_id: "aluno-1",
    ultima_mensagem_cliente_em: "2026-11-08T05:00:00Z",
  };

  it("sem marcador, a conversa com resposta do cliente é não lida", () => {
    const [c] = marcarNaoLidas([CONVERSA], new Map());
    expect(c.nao_lida).toBe(true);
  });

  it("quem leu não vê mais como não lida; quem não leu continua vendo", () => {
    const eu = marcarNaoLidas([CONVERSA], new Map([["c1", "2026-11-08T05:00:00Z"]]));
    const outro = marcarNaoLidas([CONVERSA], new Map());
    expect(eu[0].nao_lida).toBe(false);
    expect(outro[0].nao_lida).toBe(true);
  });

  it("resposta nova depois da leitura volta a ser não lida para quem leu", () => {
    const nova = { ...CONVERSA, ultima_mensagem_cliente_em: "2026-11-08T06:00:00Z" };
    const [c] = marcarNaoLidas([nova], new Map([["c1", "2026-11-08T05:00:00Z"]]));
    expect(c.nao_lida).toBe(true);
  });

  it("conversa sem resposta do cliente nunca é não lida", () => {
    const [c] = marcarNaoLidas([{ ...CONVERSA, ultima_mensagem_cliente_em: null }], new Map());
    expect(c.nao_lida).toBe(false);
  });

  it("um operador ler a conversa não zera o aviso do responsável", () => {
    // A regra por usuário é a mesma função com o mapa de CADA pessoa. O que
    // muda entre um operador e outro é só o mapa de leitura.
    const mapaOperadorA = new Map([["c1", "2026-11-08T05:00:00Z"]]);
    const mapaResponsavel = new Map();
    expect(marcarNaoLidas([CONVERSA], mapaOperadorA)[0].nao_lida).toBe(false);
    expect(marcarNaoLidas([CONVERSA], mapaResponsavel)[0].nao_lida).toBe(true);
  });
});

describe("conversasVisiveis", () => {
  const conversas = [
    { ulbra_conversa_id: "c1", nao_lida: true, aluno_id: "aluno-1" },
    { ulbra_conversa_id: "c2", nao_lida: true, aluno_id: "aluno-9" },
    { ulbra_conversa_id: "c3", nao_lida: false, aluno_id: "aluno-1" },
  ];

  it("operador vê só conversa de aluno da carteira dele, e só não lida para ele", () => {
    const meus = new Set(["aluno-1"]);
    expect(conversasVisiveis(conversas, "op1@x", false, meus).map((c) => c.ulbra_conversa_id)).toEqual(
      ["c1"],
    );
  });

  it("gestão vê todas as não lidas", () => {
    expect(conversasVisiveis(conversas, "amanda@x", true).map((c) => c.ulbra_conversa_id)).toEqual([
      "c1",
      "c2",
    ]);
  });
});

describe("contarNovidades", () => {
  it("conta conversas com resposta pendente, não mensagens", () => {
    const c = contarNovidades({
      conversas: [
        { ulbra_conversa_id: "c1", nao_lida: true, aluno_id: "aluno-1" },
        { ulbra_conversa_id: "c4", nao_lida: true, aluno_id: "aluno-1" },
      ],
      atendimentos: [LEAD, { ...LEAD, ulbra_atendimento_id: "a5", responsavel_email: "op1@x" }],
      email: "op1@x",
      alunosDoOperador: new Set(["aluno-1"]),
    });
    expect(c.nao_lidas).toBe(2);
    expect(c.leads.map((a) => a.ulbra_atendimento_id)).toEqual(["a1"]);
    expect(c.total).toBe(3);
  });

  it("sem nada, total é zero e não quebra com lista nula", () => {
    expect(contarNovidades({ conversas: null, atendimentos: null, email: "op1@x" }).total).toBe(0);
  });
});

describe("ordenarPorRecencia", () => {
  it("mais recente primeiro, com desempate estável", () => {
    const linhas = [
      { ulbra_conversa_id: "b", ultima_mensagem_em: "2026-11-08T05:00:00Z" },
      { ulbra_conversa_id: "a", ultima_mensagem_em: "2026-11-08T05:00:00Z" },
      { ulbra_conversa_id: "c", ultima_mensagem_em: "2026-11-08T06:00:00Z" },
    ];
    expect(ordenarPorRecencia(linhas, "ultima_mensagem_em").map((l) => l.ulbra_conversa_id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("preferência de som", () => {
  beforeEach(() => localStorage.clear());

  it("padrão vem com som desligado", () => {
    expect(lerPrefs("op1@x")).toEqual(PREFS_PADRAO);
  });

  it("cada operador tem a sua", () => {
    salvarPrefs("op1@x", { som: true, visual: true });
    expect(lerPrefs("op1@x").som).toBe(true);
    expect(lerPrefs("op2@x").som).toBe(false);
  });

  it("conteúdo inválido no armazenamento não derruba a leitura", () => {
    localStorage.setItem("rv_ulbra_prefs_op1_x", "{quebrado");
    expect(lerPrefs("op1@x")).toEqual(PREFS_PADRAO);
  });
});
