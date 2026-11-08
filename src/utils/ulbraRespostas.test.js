import { describe, it, expect } from "vitest";
import {
  DIRECAO_CLIENTE,
  LIMITE_DIARIO_MENSAGERIA,
  normalizarMensagem,
  normalizarConversa,
  mensagemRecebida,
  alunoRespondeu,
  doResponsavel,
  naoLidas,
  contarNaoLidas,
  orcamentoSincronizacao,
  amostraSimulada,
} from "./ulbraRespostas";

// Instante fixo, datas DERIVADAS dele: data absoluta em fixture vence e
// derruba o CI — já aconteceu neste repositório.
const AGORA = 1_800_000_000_000;
const min = (n) => new Date(AGORA - n * 60_000).toISOString();
const EMAIL = "cobranca05@aelbra.com.br";

// Forma REAL medida em 08/11/2026 contra listar_conversas.
function conversa(extra = {}, meta = {}) {
  return normalizarConversa(
    {
      id: "6aee8e2f9ab1d6401c7e7986",
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "6aee89779ab1d6401c7e4da9", nome: "Manoelle" },
      equipe: "Única",
      ultimaMensagemEm: min(5),
      ultimaMensagem: { quem: "cliente", em: min(5), trecho: "Quanto ficaria?" },
      ...extra,
    },
    { responsavel_email: EMAIL, aluno_id: "aluno-1", ...meta },
  );
}

describe("normalizarMensagem (contrato de ler_conversa)", () => {
  const bruta = {
    id: "6af0453f9ab1d6401cd6bf53",
    quem: "cliente",
    autor: null,
    em: min(3),
    tipo: "text",
    texto: "Quanto ficaria?",
  };

  it("guarda id, direção e horário", () => {
    const m = normalizarMensagem(bruta);
    expect(m.mensagem_id).toBe("6af0453f9ab1d6401cd6bf53");
    expect(m.quem).toBe("cliente");
    expect(m.recebida_em).toBe(min(3));
  });

  it("NÃO guarda o texto da mensagem — conteúdo fica na Mensageria", () => {
    expect(normalizarMensagem(bruta)).not.toHaveProperty("texto");
  });

  it("recusa direção desconhecida, em vez de deixar passar", () => {
    expect(normalizarMensagem({ ...bruta, quem: "alien" })).toBeNull();
  });

  it("recusa sem id e sem horário válido — falha fechado", () => {
    expect(normalizarMensagem({ ...bruta, id: null })).toBeNull();
    expect(normalizarMensagem({ ...bruta, em: "nao-e-data" })).toBeNull();
    expect(normalizarMensagem(null)).toBeNull();
  });

  it("aceita as quatro direções medidas", () => {
    for (const quem of ["cliente", "operador", "bot", "sistema"]) {
      expect(normalizarMensagem({ ...bruta, quem })?.quem).toBe(quem);
    }
  });
});

describe("mensagemRecebida", () => {
  it("só 'cliente' é mensagem recebida do aluno", () => {
    expect(mensagemRecebida({ quem: DIRECAO_CLIENTE })).toBe(true);
    for (const quem of ["operador", "bot", "sistema"]) {
      expect(mensagemRecebida({ quem })).toBe(false);
    }
  });
});

describe("normalizarConversa (contrato de listar_conversas)", () => {
  it("lê quem falou por último e quando, sem abrir a conversa", () => {
    const c = conversa();
    expect(c.ultima_de).toBe("cliente");
    expect(c.ultima_em).toBe(min(5));
    expect(c.ulbra_cliente_id).toBe("6aee89779ab1d6401c7e4da9");
  });

  it("NÃO filtra por equipe: a conversa real veio como 'Única'", () => {
    expect(conversa({ equipe: "Única" })).not.toBeNull();
    expect(conversa({ equipe: "Financeiro" })).not.toBeNull();
  });

  it("última mensagem ausente não vira aviso", () => {
    const c = conversa({ ultimaMensagem: undefined, ultimaMensagemEm: undefined });
    expect(c.ultima_de).toBeNull();
    expect(alunoRespondeu(c)).toBe(false);
  });
});

describe("alunoRespondeu", () => {
  it("é o ALUNO quem falou por último", () => {
    expect(alunoRespondeu(conversa())).toBe(true);
  });

  it("nós falamos por último: ninguém está esperando", () => {
    for (const quem of ["operador", "bot", "sistema"]) {
      expect(alunoRespondeu(conversa({ ultimaMensagem: { quem, em: min(5) } }))).toBe(false);
    }
  });

  it("não usa mais `situacao` como sinal — conversa fechada com resposta do aluno ainda conta", () => {
    expect(alunoRespondeu(conversa({ situacao: "closed" }))).toBe(true);
  });
});

describe("doResponsavel", () => {
  it("o operador vê só a própria carteira", () => {
    const lista = [
      conversa({ id: "meu" }, { responsavel_email: EMAIL }),
      conversa({ id: "alheio" }, { responsavel_email: "cobranca12@aelbra.com.br" }),
    ];
    expect(doResponsavel(lista, { email: EMAIL }).map((c) => c.conversa_id)).toEqual(["meu"]);
  });

  it("cliente sem vínculo por CPF não tem responsável, e é só da gestão", () => {
    const semVinculo = [conversa({ id: "sem" }, { responsavel_email: null })];
    expect(doResponsavel(semVinculo, { email: EMAIL })).toEqual([]);
    expect(doResponsavel(semVinculo, { gestao: true })).toHaveLength(1);
  });
});

describe("naoLidas", () => {
  it("conta a resposta posterior ao marcador de leitura", () => {
    const lista = [
      conversa({ id: "nova", ultimaMensagem: { quem: "cliente", em: min(2) } }),
      conversa({ id: "velha", ultimaMensagem: { quem: "cliente", em: min(90) } }),
    ];
    expect(naoLidas(lista, { lidoAte: min(30) }).map((c) => c.conversa_id)).toEqual(["nova"]);
  });

  it("sem marcador devolve tudo — melhor avisar demais que engolir", () => {
    expect(naoLidas([conversa({ id: "a" }), conversa({ id: "b" })], {})).toHaveLength(2);
  });

  it("empate no horário não conta: lido é lido", () => {
    const quando = min(5);
    expect(naoLidas([conversa({ ultimaMensagem: { quem: "cliente", em: quando } })], { lidoAte: quando })).toEqual([]);
  });

  it("mensagem nossa nunca entra, por mais recente que seja", () => {
    const lista = [conversa({ ultimaMensagem: { quem: "operador", em: min(1) } })];
    expect(naoLidas(lista, { lidoAte: min(60) })).toEqual([]);
  });
});

describe("contarNaoLidas", () => {
  it("combina carteira e marcador", () => {
    const lista = [
      conversa({ id: "meu-novo", ultimaMensagem: { quem: "cliente", em: min(2) } }, { responsavel_email: EMAIL }),
      conversa({ id: "meu-velho", ultimaMensagem: { quem: "cliente", em: min(99) } }, { responsavel_email: EMAIL }),
      conversa({ id: "alheio" }, { responsavel_email: "cobranca12@aelbra.com.br" }),
    ];
    expect(contarNaoLidas(lista, { email: EMAIL, lidoAte: min(30) })).toBe(1);
    expect(contarNaoLidas(lista, { gestao: true, lidoAte: min(30) })).toBe(2);
  });
});

describe("orcamentoSincronizacao", () => {
  it("centralizada (1 job) cabe com folga: 72/dia", () => {
    const o = orcamentoSincronizacao({ intervaloMin: 10, horasPorDia: 12, operadores: 1 });
    expect(o.sincronizacao).toBe(72);
    expect(o.cabe).toBe(true);
  });

  it("ESTOURA com polling por navegador: 9 operadores x 72 = 648 > 500", () => {
    const o = orcamentoSincronizacao({ intervaloMin: 10, horasPorDia: 12, operadores: 9 });
    expect(o.sincronizacao).toBe(648);
    expect(o.cabe).toBe(false);
    expect(o.folga).toBeLessThan(0);
  });

  it("cada abertura de ficha custa 2: ulbra-consultar + ulbra-atendimento", () => {
    const o = orcamentoSincronizacao({ operadores: 1, aberturasFicha: 100 });
    expect(o.fichas).toBe(200);
    expect(o.total).toBe(272);
    expect(o.cabe).toBe(true);
  });

  it("o teto é o limite medido", () => {
    expect(orcamentoSincronizacao().limiteDiario).toBe(LIMITE_DIARIO_MENSAGERIA);
  });
});

describe("amostraSimulada", () => {
  it("duas esperando resposta, uma não — a que nós respondemos por último", () => {
    const a = amostraSimulada(AGORA);
    expect(a).toHaveLength(3);
    expect(a.filter(alunoRespondeu)).toHaveLength(2);
  });

  it("as datas acompanham o `agora` — não envelhecem", () => {
    const a = amostraSimulada(AGORA);
    const b = amostraSimulada(AGORA + 86_400_000);
    expect(a[0].ultima_em).not.toBe(b[0].ultima_em);
    expect(contarNaoLidas(b, { email: EMAIL, lidoAte: new Date(AGORA).toISOString() })).toBe(2);
  });
});
