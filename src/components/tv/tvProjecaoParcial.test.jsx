// @vitest-environment jsdom
//
// TV — PROJEÇÃO PARCIAL (regra da gestão de 03/11/2026)
//
// A projeção passou a existir desde o 1º dia útil do mês, com o dia corrente
// DENTRO da base do ritmo. Enquanto o dia não fecha, o número ainda vai mexer —
// e a TV precisa dizer isso, senão quem olha de longe lê um fechamento como se
// fosse definitivo.
//
// Quem decide é o banco: `mes.projecao_parcial` vem pronto de
// tv_snapshot_calcular(). Os casos abaixo garantem que a TV só REPETE a decisão
// e nunca recalcula — se alguém um dia derivar "parcial" aqui dentro (de
// dias_uteis_transcorridos, de data, do que for), a TV e o CRM voltam a ter duas
// contas para o mesmo número, que é exatamente o que a gestão pediu para evitar.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const desenhar = (id, snap) => {
  const { Comp } = CATALOGO_TELAS.find((t) => t.id === id);
  return render(<Comp snap={snap} />);
};

// Novembro/2026: 19 dias úteis, 1º dia útil em 03/11 (01 domingo, 02 Finados).
const BASE_MES = {
  recuperado: 55063,
  honorarios: 4074,
  pagamentos_confirmados: 68,
  media_diaria: 55063,
  media_diaria_honorarios: 4074,
  proj_honorarios: 77402,
  proj_honorarios_pct: 63.2,
  projecao_fechamento: 1046197,
  meta_empresa: 122400,
  meta_pct: 3.3,
  meta_falta: 118326,
  meta_atingida: false,
  necessidade_diaria: 6228,
  dias_uteis_mes: 19,
  dias_uteis_transcorridos: 1,
  dias_uteis_restantes: 19,
};
const snap = (parcial, extra = {}) => ({
  magic: { mes_referencia: "2026-11", valor: 142800 },
  mes: { ...BASE_MES, projecao_parcial: parcial, ...extra },
});

describe("Resultado do Mês", () => {
  it("marca PARCIAL no card da projeção enquanto o dia está em andamento", () => {
    desenhar("resultado", snap(true));
    expect(screen.getByText(/PARCIAL — o dia ainda está em andamento/)).toBeTruthy();
  });

  it("sem dia em andamento (feriado, fim de semana, mês fechado) não marca nada", () => {
    desenhar("resultado", snap(false));
    expect(screen.queryByText(/PARCIAL/)).toBeNull();
  });

  it("snapshot antigo, sem o campo, não inventa o selo", () => {
    desenhar("resultado", snap(undefined));
    expect(screen.queryByText(/PARCIAL/)).toBeNull();
  });

  it("o valor exibido é o do snapshot, não um recálculo da tela", () => {
    desenhar("resultado", snap(true));
    expect(screen.getByText("R$ 77.402")).toBeTruthy();
  });
});

describe("Meta do Mês", () => {
  it("escreve PARCIAL junto da projeção de fechamento", () => {
    desenhar("meta_do_mes", snap(true));
    expect(screen.getByText(/Projeção de fechamento/).parentElement.textContent).toMatch(/PARCIAL/);
  });

  it("dia fechado: a projeção aparece sem PARCIAL", () => {
    desenhar("meta_do_mes", snap(false));
    expect(screen.getByText(/Projeção de fechamento/)).toBeTruthy();
    expect(screen.queryByText(/PARCIAL/)).toBeNull();
  });
});

describe("Magic Number", () => {
  it("escreve PARCIAL junto da projeção de fechamento", () => {
    desenhar("magic_number", snap(true));
    expect(screen.getByText(/Projeção de fechamento/).parentElement.textContent).toMatch(/PARCIAL/);
  });

  it("dia fechado: nenhum selo", () => {
    desenhar("magic_number", snap(false));
    expect(screen.queryByText(/PARCIAL/)).toBeNull();
  });
});

describe("o selo não sequestra os outros números", () => {
  it("dias úteis restantes seguem vindo do snapshot (hoje conta como restante)", () => {
    desenhar("resultado", snap(true));
    expect(screen.getByText("Dias úteis (1/19)")).toBeTruthy();
    expect(screen.getByText("19 restantes")).toBeTruthy();
  });

  it("necessário por dia útil não muda por causa do selo", () => {
    desenhar("meta_do_mes", snap(true));
    expect(screen.getByText("R$ 6.228")).toBeTruthy();
  });
});
