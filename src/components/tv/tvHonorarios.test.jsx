// @vitest-environment jsdom
//
// O INDICADOR FINANCEIRO PRINCIPAL DO TELÃO É O HONORÁRIO RECEBIDO.
//
// Estes casos travam a hierarquia, não a aritmética: o honorário tem de ser o
// número em destaque, o bruto pago pelo aluno tem de continuar na tela e DITO
// bruto, e os destaques de operador têm de vir do honorário atribuído a ele.
//
// A trava que mais importa é a última de cada bloco: quando o snapshot é
// ANTIGO e não traz honorário por pagamento, a tela NÃO pode cair no bruto —
// honorário nunca é estimado por percentual nem substituído pelo valor pago.
// Ou vem o valor registrado, ou o card não aparece.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const desenhar = (id, snap) => {
  const { Comp } = CATALOGO_TELAS.find((t) => t.id === id);
  return render(<Comp snap={snap} />);
};

// Fatia do payload como tv_snapshot_calcular() entrega depois de 20261014.
function snapHoje(extra = {}) {
  return {
    hoje: {
      recuperado: 120000,
      honorarios: 24000,
      pagamentos_confirmados: 7,
      maior_pagamento: { operador: "NATALY", valor: 40000, honorario: 8000 },
      top_qtd: { operador: "JOAO", qtd: 4 },
      ...extra,
    },
    rank: { top_hon_dia: [{ nome: "Nataly", valor: 9000 }, { nome: "João", valor: 3000 }] },
  };
}

describe("Hoje na Operação — honorário é o herói", () => {
  it("o número em destaque é o honorário do dia, e o bruto aparece identificado como bruto", () => {
    desenhar("hoje", snapHoje());
    expect(screen.getByText("Honorários recebidos hoje")).toBeTruthy();
    // herói = honorários; satélite = bruto, com a palavra "brutos" ao lado.
    expect(screen.getByText("R$ 24.000")).toBeTruthy();
    expect(screen.getByText("R$ 120.000")).toBeTruthy();
    expect(screen.getByText(/brutos recuperados/)).toBeTruthy();
    // o rótulo antigo não pode sobrar em lugar nenhum da tela
    expect(screen.queryByText("Recuperado hoje")).toBeNull();
  });

  it("o maior pagamento do dia aparece pelo NOME, sem o valor de honorário", () => {
    desenhar("hoje", snapHoje());
    expect(screen.getByText("Maior honorário num pagamento")).toBeTruthy();
    expect(screen.getByText("NATALY")).toBeTruthy();
    // valor individual de colega não vai ao telão: nem o honorário, nem o bruto
    expect(screen.queryByText("R$ 8.000")).toBeNull();
    expect(screen.queryByText("R$ 40.000 brutos")).toBeNull();
  });

  it("o destaque de operador vem do honorário do dia (rank.top_hon_dia), não do valor recuperado", () => {
    desenhar("hoje", snapHoje({ top_recuperador: { operador: "QUEM_SO_TEM_BRUTO", valor: 99999 } }));
    expect(screen.getByText("Maior honorário do dia")).toBeTruthy();
    expect(screen.getByText("Nataly")).toBeTruthy();
    expect(screen.queryByText("QUEM_SO_TEM_BRUTO")).toBeNull();
    expect(screen.queryByText("R$ 9.000")).toBeNull(); // o honorário dela não aparece
  });

  it("snapshot antigo (sem honorário no pagamento): o card SOME — não mostra o bruto no lugar", () => {
    const snap = snapHoje({ maior_pagamento: { operador: "NATALY", valor: 40000 } });
    desenhar("hoje", snap);
    expect(screen.queryByText("Maior honorário num pagamento")).toBeNull();
    expect(screen.queryByText("R$ 40.000 brutos")).toBeNull();
    // os demais cards seguem normais
    expect(screen.getByText("Maior honorário do dia")).toBeTruthy();
  });

  it("sem pagamento confirmado, a mensagem padrão continua no lugar de zero enganoso", () => {
    desenhar("hoje", { hoje: { sem_pagamentos: true } });
    expect(screen.getByText(/Ainda não há pagamentos confirmados/)).toBeTruthy();
  });
});

function snapMes(extra = {}) {
  return {
    mes: {
      recuperado: 980000,
      honorarios: 140000,
      pagamentos_confirmados: 52,
      media_diaria: 98000,
      media_diaria_honorarios: 14000,
      proj_honorarios: 280000,
      dias_uteis_mes: 22, dias_uteis_transcorridos: 10, dias_uteis_restantes: 12,
      meta_empresa: 200000, meta_atingida: false, necessidade_diaria: 5000,
      ...extra,
    },
  };
}

describe("Resultado do Mês — honorário na frente do bruto", () => {
  it("honorário é o card grande; o bruto fica secundário e identificado como bruto", () => {
    desenhar("resultado", snapMes());
    expect(screen.getByText("Honorários recebidos no mês")).toBeTruthy();
    expect(screen.getByText("Bruto recuperado no mês")).toBeTruthy();
    expect(screen.queryByText("Recuperado no mês")).toBeNull();
  });

  it("a média diária exibida é de honorário, não de recuperação", () => {
    desenhar("resultado", snapMes());
    expect(screen.getByText("Média diária de honorários")).toBeTruthy();
    expect(screen.getByText("R$ 14.000")).toBeTruthy();
    // a média de BRUTO existe no snapshot e não pode aparecer no card
    expect(screen.queryByText("R$ 98.000")).toBeNull();
  });

  it("a média de bruto continua visível, como linha secundária e dita bruto", () => {
    desenhar("resultado", snapMes());
    expect(screen.getByText("R$ 98.000 de bruto recuperado")).toBeTruthy();
  });

  it("snapshot antigo: 'Sem registro' em vez de reaproveitar a média de bruto", () => {
    desenhar("resultado", snapMes({ media_diaria_honorarios: null }));
    expect(screen.getByText("Sem registro")).toBeTruthy();
    // o bruto segue na linha secundária; o que NÃO pode é virar o valor do card
    expect(screen.queryByText("R$ 98.000")).toBeNull();
  });

  it("meta, falta e necessário por dia continuam vindo prontos do snapshot", () => {
    desenhar("resultado", snapMes());
    expect(screen.getByText("R$ 5.000/dia útil")).toBeTruthy();
    expect(screen.getByText("Projeção de fechamento (honorários)")).toBeTruthy();
  });
});

describe("Meta do Mês — o realizado é dito honorário", () => {
  it("o card do realizado diz 'Honorários recebidos', não 'Realizado'", () => {
    desenhar("meta_do_mes", snapMes({ meta_pct: 70, meta_falta: 60000 }));
    expect(screen.getByText("Honorários recebidos")).toBeTruthy();
    expect(screen.queryByText("Realizado")).toBeNull();
  });
});

function snapRankings(extra = {}) {
  return {
    rankings: {
      base: "honorario",
      melhor_mes: { operador: "NATALY", honorario: 60000 },
      melhor_dia: { operador: "JOAO", honorario: 3000 },
      mais_pagos_dia: { operador: "OLGA", qtd: 9 },
      top3_mes: [
        { operador: "NATALY", honorario: 60000 },
        { operador: "JOAO", honorario: 21000 },
        { operador: "OLGA", honorario: 12000 },
      ],
      maior_pagamento_mes: { operador: "NATALY", valor: 70000, honorario: 14000 },
      ...extra,
    },
  };
}

describe("Rankings — o critério é honorário recebido", () => {
  it("o herói é o maior honorário do mês — nome e rótulo, sem valor", () => {
    desenhar("rankings", snapRankings());
    expect(screen.getByText("Maior honorário recebido no mês")).toBeTruthy();
    // NATALY aparece no herói E no card do maior pagamento — por isso getAllBy
    expect(screen.getAllByText("NATALY").length).toBeGreaterThan(0);
    expect(screen.queryByText("R$ 60.000")).toBeNull();
    expect(screen.queryByText("Melhor recuperador do mês")).toBeNull();
  });

  it("2º e 3º aparecem por posição e nome, sem o honorário de cada um", () => {
    desenhar("rankings", snapRankings());
    expect(screen.getByText("2º")).toBeTruthy();
    expect(screen.getByText("3º")).toBeTruthy();
    expect(screen.queryByText(/R\$ 21\.000/)).toBeNull();
    expect(screen.queryByText(/R\$ 12\.000/)).toBeNull();
  });

  it("melhor do dia e maior pagamento do mês: rótulo de honorário, nenhum valor", () => {
    desenhar("rankings", snapRankings());
    expect(screen.getByText("Melhor em honorários hoje")).toBeTruthy();
    expect(screen.getByText("Maior honorário num pagamento")).toBeTruthy();
    for (const v of ["R$ 3.000", "R$ 14.000", "R$ 70.000 brutos"]) {
      expect(screen.queryByText(v), v).toBeNull();
    }
  });

  it("A TELA INTEIRA não tem cifrão: nenhum valor individual escapa", () => {
    const { container } = desenhar("rankings", snapRankings());
    expect(container.textContent).not.toContain("R$");
  });
});

// A JANELA DA TRANSIÇÃO. Entre o deploy desta tela e a aplicação da migration, a
// tela NOVA lê um snapshot VELHO: ordenado por bruto e sem o marcador `base`.
// Nenhum rótulo pode dizer honorário nesse estado. É o que estes casos travam.
describe("transição deploy→migration: nada de bruto vestido de honorário", () => {
  // snapshot velho: ordenado por valor_pago, sem `base` e sem `honorario`
  const velho = {
    rankings: {
      melhor_mes: { operador: "QUEM_TEM_BRUTO" },
      melhor_dia: { operador: "QUEM_TEM_BRUTO" },
      mais_pagos_dia: { operador: "OLGA", qtd: 9 },
      top3_mes: [{ operador: "QUEM_TEM_BRUTO" }, { operador: "OUTRO" }],
      maior_pagamento_mes: { operador: "QUEM_TEM_BRUTO", valor: 70000 },
    },
  };

  it("Rankings: o herói é dito 'por valor bruto', nunca honorário", () => {
    desenhar("rankings", velho);
    expect(screen.getByText("Melhor do mês por valor bruto")).toBeTruthy();
    expect(screen.queryByText("Maior honorário recebido no mês")).toBeNull();
  });

  it("Rankings: melhor do dia e maior pagamento também são ditos bruto, e sem valor", () => {
    desenhar("rankings", velho);
    expect(screen.getByText("Melhor do dia por valor bruto")).toBeTruthy();
    expect(screen.getByText("Maior pagamento do mês (valor bruto)")).toBeTruthy();
    expect(screen.queryByText("Maior honorário num pagamento")).toBeNull();
    // nem no estado antigo o valor individual aparece
    expect(screen.queryByText("R$ 70.000")).toBeNull();
  });

  it("Rankings: a palavra 'honorário' não aparece em NENHUM lugar da tela", () => {
    const { container } = desenhar("rankings", velho);
    expect(container.textContent.toLowerCase()).not.toContain("honorário");
  });

  it("Destaque da Semana: snapshot velho (valor sem base) é dito valor bruto", () => {
    desenhar("destaque_semana", { ranking_semana_valor: [{ operador: "QUEM_TEM_BRUTO", valor: 90000 }] });
    expect(screen.getByText("Maior valor bruto recuperado na semana")).toBeTruthy();
    expect(screen.queryByText("Maior honorário recebido na semana")).toBeNull();
  });

  it("Destaque da Semana: snapshot novo (com base) é dito honorário, sem valor", () => {
    const { container } = desenhar("destaque_semana",
      { ranking_semana_valor: [{ operador: "NATALY", valor: 12000, base: "honorario" },
                               { operador: "JOAO", valor: 7500, base: "honorario" }] });
    expect(screen.getByText("Maior honorário recebido na semana")).toBeTruthy();
    expect(screen.getByText("NATALY")).toBeTruthy();
    expect(screen.getByText("JOAO")).toBeTruthy();   // 2º segue aparecendo
    expect(container.textContent).not.toContain("R$"); // nenhum valor, de ninguém
  });

  it("Destaque da Semana: fallback por quantidade segue dizendo quantidade", () => {
    desenhar("destaque_semana", { dados: { ranking_semana: [{ operador: "OLGA", pagos: 22 }] } });
    expect(screen.getByText("Mais pagamentos únicos da semana")).toBeTruthy();
    expect(screen.queryByText(/honorário/i)).toBeNull();
  });
});
