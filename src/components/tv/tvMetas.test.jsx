// @vitest-environment jsdom
//
// TELA DE METAS — apresentação modernizada.
//
// O modelo antigo empilhava um CardMeta por meta: três barras horizontais
// iguais, sem hierarquia. Agora a meta do mês é o número-herói no anel e as
// demais viram uma faixa compacta.
//
// O QUE ESTES TESTES PROTEGEM: que SÓ a apresentação mudou. Todo número exibido
// tem de sair de snap.metas como o snapshot entregou — alvo, realizado, pct,
// restante, excedente, situacao e ritmo_necessario já vêm prontos de
// _tv_meta_obj(). Os fixtures usam valores em que recalcular daria OUTRO
// resultado, então qualquer conta feita na tela quebra o teste.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const tela = () => CATALOGO_TELAS.find((t) => t.id === "metas");
const desenhar = (snap) => {
  const { Comp } = tela();
  return render(<Comp snap={snap} />);
};

// Formato exato de _tv_meta_obj(). Outubro/2026: meta piso 122.400.
const EMPRESA = {
  id: "empresa", nome: "Meta da empresa", tipo: "mensal",
  alvo: 122400, realizado: 70000, pct: 57.2, restante: 52400, excedente: 0,
  atingida: false, situacao: "No ritmo", ritmo_necessario: 2911, data_atingimento: null,
};
const SUPERAR = {
  id: "superar_mes_anterior", nome: "Superar o mês passado", tipo: "mensal",
  alvo: 98000, realizado: 70000, pct: 71.4, restante: 28000, excedente: 0,
  atingida: false, situacao: "Atenção", ritmo_necessario: 1556, data_atingimento: null,
};
const MARCO = {
  id: "marco", nome: "Marco histórico", tipo: "total",
  alvo: 3000000, realizado: 3400000, pct: 113.3, restante: 0, excedente: 400000,
  atingida: true, situacao: "Meta atingida", ritmo_necessario: null,
};

const snap = (metas = [EMPRESA, SUPERAR, MARCO]) => ({ metas });

describe("TV — Metas (catálogo)", () => {
  it("continua sendo o mesmo slide, com o mesmo id e o mesmo padrão de visibilidade", () => {
    const t = tela();
    expect(t).toBeTruthy();
    expect(t.nome).toBe("Metas");
    expect(t.ativa).toBe(false);            // quem liga é o painel da Mensagem da TV
    expect(t.grupo).toBe("operacao");
  });

  it("temConteudo segue exigindo ao menos uma meta no snapshot", () => {
    const { temConteudo } = tela();
    expect(temConteudo(snap())).toBe(true);
    expect(temConteudo({ metas: [] })).toBe(false);
    expect(temConteudo({})).toBe(false);
  });
});

describe("TV — Metas (apresentação)", () => {
  it("destaca meta do mês, realizado, percentual e quanto falta", () => {
    desenhar(snap());
    expect(screen.getByText("Meta do mês")).toBeTruthy();
    expect(screen.getByText("R$ 122.400")).toBeTruthy();
    expect(screen.getByText("Realizado")).toBeTruthy();
    expect(screen.getByText("R$ 70.000")).toBeTruthy();
    expect(screen.getByText("57%")).toBeTruthy();          // pct do snapshot, no anel
    expect(screen.getByText("Falta para a meta")).toBeTruthy();
    expect(screen.getByText("R$ 52.400")).toBeTruthy();
  });

  it("o percentual é o do snapshot — a tela não divide realizado por alvo", () => {
    // 70.000 / 122.400 = 57,19%. O fixture manda 61 de propósito: se a tela
    // recalculasse, apareceria 57.
    desenhar(snap([{ ...EMPRESA, pct: 61 }]));
    expect(screen.getByText("61%")).toBeTruthy();
    expect(screen.queryByText("57%")).toBeNull();
  });

  it("a falta é a do snapshot — a tela não subtrai alvo menos realizado", () => {
    // alvo - realizado daria 52.400; o fixture manda 40.000.
    desenhar(snap([{ ...EMPRESA, restante: 40000 }]));
    expect(screen.getByText("R$ 40.000")).toBeTruthy();
    expect(screen.queryByText("R$ 52.400")).toBeNull();
  });

  it("o ritmo por dia útil é o do snapshot, e vem rotulado", () => {
    desenhar(snap());
    expect(screen.getByText(/R\$ 2\.911 por dia útil/)).toBeTruthy();
  });

  it("a situação do snapshot acompanha o anel — nunca só cor", () => {
    desenhar(snap());
    expect(screen.getByText("No ritmo")).toBeTruthy();
    expect(screen.getByText("Meta da empresa")).toBeTruthy();  // rótulo do anel
  });

  it("meta batida troca falta por excedente e mostra a data de atingimento", () => {
    desenhar(snap([{
      ...EMPRESA, realizado: 150000, pct: 122.4, restante: 0, excedente: 27600,
      atingida: true, situacao: "Meta atingida", ritmo_necessario: null,
      data_atingimento: "28/10/2026",
    }]));
    expect(screen.getByText("Superamos em")).toBeTruthy();
    expect(screen.getByText("R$ 27.600")).toBeTruthy();
    expect(screen.getByText(/Atingida em 28\/10\/2026/)).toBeTruthy();
    expect(screen.getByText("122%")).toBeTruthy();             // passa de 100% sem travar
    expect(screen.queryByText("Falta para a meta")).toBeNull();
  });

  it("sem dias úteis restantes não inventa ritmo", () => {
    desenhar(snap([{ ...EMPRESA, ritmo_necessario: null }]));
    expect(screen.getByText(/Sem dias úteis restantes/)).toBeTruthy();
  });
});

describe("TV — Metas (as demais metas)", () => {
  it("as secundárias aparecem na faixa, com os números do snapshot", () => {
    desenhar(snap());
    expect(screen.getByText("Superar o mês passado")).toBeTruthy();
    expect(screen.getByText("71%")).toBeTruthy();
    expect(screen.getByText(/R\$ 70\.000 de R\$ 98\.000/)).toBeTruthy();
    expect(screen.getByText("Atenção")).toBeTruthy();
    expect(screen.getByText(/R\$ 1\.556\/dia útil/)).toBeTruthy();
  });

  it("o Marco histórico continua fora do slide", () => {
    desenhar(snap());
    expect(screen.queryByText("Marco histórico")).toBeNull();
    expect(screen.queryByText("113%")).toBeNull();
  });

  it("sem secundárias, a tela fica só com o anel — sem faixa vazia", () => {
    desenhar(snap([EMPRESA, MARCO]));
    expect(screen.getByText("Meta da empresa")).toBeTruthy();
    expect(screen.queryByText("Superar o mês passado")).toBeNull();
  });

  it("sem a meta da empresa, a primeira meta restante assume o anel", () => {
    desenhar(snap([SUPERAR, MARCO]));
    expect(screen.getByText("Superar o mês passado")).toBeTruthy();
    expect(screen.getByText("Meta do mês")).toBeTruthy();
    expect(screen.getByText("R$ 98.000")).toBeTruthy();
  });
});

describe("TV — Metas (sem Magic Number derivado)", () => {
  it("não existe alvo múltiplo da meta em lugar nenhum da tela", () => {
    // meta x 1,5 sobre 122.400 daria 183.600. A tela só repete o snapshot.
    desenhar(snap());
    expect(screen.queryByText(/R\$ 183\.600/)).toBeNull();
    expect(screen.queryByText(/Magic/i)).toBeNull();
    expect(screen.queryByText(/150%/)).toBeNull();
  });
});

describe("TV — Metas (bordas)", () => {
  it("snapshot sem metas avisa, não quebra", () => {
    expect(() => desenhar({ metas: [] })).not.toThrow();
    expect(screen.getByText(/Sem registro no snapshot atual/)).toBeTruthy();
  });

  it("snapshot sem a chave `metas` não derruba a tela", () => {
    expect(() => desenhar({})).not.toThrow();
    expect(screen.getByText(/Sem registro no snapshot atual/)).toBeTruthy();
  });

  it("só o Marco no snapshot equivale a não ter meta do mês", () => {
    desenhar(snap([MARCO]));
    expect(screen.getByText(/Sem registro no snapshot atual/)).toBeTruthy();
  });

  it("meta sem percentual não vira 0%", () => {
    desenhar(snap([{ ...EMPRESA, pct: null }]));
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
});
