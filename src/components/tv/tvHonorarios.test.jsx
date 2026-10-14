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

  it("o maior pagamento do dia mostra o honorário recebido, com o bruto como linha secundária", () => {
    desenhar("hoje", snapHoje());
    expect(screen.getByText("Maior honorário num pagamento")).toBeTruthy();
    expect(screen.getByText("NATALY")).toBeTruthy();
    expect(screen.getByText("R$ 8.000")).toBeTruthy();
    expect(screen.getByText("R$ 40.000 brutos")).toBeTruthy();
  });

  it("o destaque de operador vem do honorário do dia (rank.top_hon_dia), não do valor recuperado", () => {
    desenhar("hoje", snapHoje({ top_recuperador: { operador: "QUEM_SO_TEM_BRUTO", valor: 99999 } }));
    expect(screen.getByText("Maior honorário do dia")).toBeTruthy();
    expect(screen.getByText("Nataly")).toBeTruthy();
    expect(screen.queryByText("QUEM_SO_TEM_BRUTO")).toBeNull();
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
  it("o herói é o maior honorário do mês, com o valor de honorário ao lado", () => {
    desenhar("rankings", snapRankings());
    expect(screen.getByText("Maior honorário recebido no mês")).toBeTruthy();
    expect(screen.getByText("R$ 60.000")).toBeTruthy();
    expect(screen.queryByText("Melhor recuperador do mês")).toBeNull();
  });

  it("2º e 3º lugares trazem o honorário de cada um", () => {
    desenhar("rankings", snapRankings());
    expect(screen.getByText(/R\$ 21\.000/)).toBeTruthy();
    expect(screen.getByText(/R\$ 12\.000/)).toBeTruthy();
  });

  it("o melhor do dia é por honorário e o maior pagamento do mês mostra honorário + bruto", () => {
    desenhar("rankings", snapRankings());
    expect(screen.getByText("Melhor em honorários hoje")).toBeTruthy();
    expect(screen.getByText("R$ 3.000")).toBeTruthy();
    expect(screen.getByText("Maior honorário num pagamento")).toBeTruthy();
    expect(screen.getByText("R$ 14.000")).toBeTruthy();
    expect(screen.getByText("R$ 70.000 brutos")).toBeTruthy();
  });

  it("snapshot antigo: sem honorário no pagamento, o card do maior pagamento não aparece", () => {
    desenhar("rankings", snapRankings({ maior_pagamento_mes: { operador: "NATALY", valor: 70000 } }));
    expect(screen.queryByText("Maior honorário num pagamento")).toBeNull();
    expect(screen.queryByText("R$ 70.000 brutos")).toBeNull();
    // o resto da tela segue de pé
    expect(screen.getByText("Maior honorário recebido no mês")).toBeTruthy();
  });
});
