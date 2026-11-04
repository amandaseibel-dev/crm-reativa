// @vitest-environment jsdom
//
// TV — PROJEÇÃO SÓ POR DIAS ÚTEIS FECHADOS (regra da gestão de 04/11/2026)
//
// A projeção usa numerador e divisor do mesmo período, encerrado até ontem. No
// 1º dia útil do mês não existe dia fechado, então não existe projeção — e a TV
// precisa dizer isso, em vez de mostrar R$ 0 ou um número sem lastro.
//
// Quem decide é o banco: `mes.projecao_aguardando_fechamento` vem pronto de
// tv_snapshot_calcular(). Os casos abaixo garantem que a TV só REPETE a decisão
// e nunca recalcula — se alguém um dia derivar isso aqui dentro (de
// dias_uteis_transcorridos, de data, do que for), a TV e o CRM voltam a ter
// duas contas para o mesmo número.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const desenhar = (id, snap) => {
  const { Comp } = CATALOGO_TELAS.find((t) => t.id === id);
  return render(<Comp snap={snap} />);
};

// Novembro/2026: 19 dias úteis, 1º dia útil em 03/11 (01 domingo, 02 Finados).
// Em 04/11 fechou só o dia 3, a 5.354,85 -> projeção 101.742.
const BASE_MES = {
  recuperado: 55063,
  honorarios: 5371,
  pagamentos_confirmados: 68,
  media_diaria: 55063,
  media_diaria_honorarios: 5355,
  proj_honorarios: 101742,
  proj_honorarios_pct: 83.1,
  projecao_fechamento: 1046197,
  meta_empresa: 122400,
  meta_pct: 4.4,
  meta_falta: 117029,
  meta_atingida: false,
  necessidade_diaria: 6159,
  dias_uteis_mes: 19,
  dias_uteis_transcorridos: 1,
  dias_uteis_restantes: 19,
};
const snap = (aguardando, extra = {}) => ({
  magic: { mes_referencia: "2026-11", valor: 142800 },
  mes: { ...BASE_MES, projecao_aguardando_fechamento: aguardando, ...extra },
});
// No 1º dia útil o banco manda a projeção nula.
const snapAguardando = () => snap(true, { proj_honorarios: null, proj_honorarios_pct: null });

describe("Resultado do Mês", () => {
  it("mostra a projeção dos dias fechados quando existe dia fechado", () => {
    desenhar("resultado", snap(false));
    expect(screen.getByText("R$ 101.742")).toBeTruthy();
    expect(screen.queryByText(/Aguardando fechamento/)).toBeNull();
  });

  it("no 1º dia útil troca o número pela mensagem, em vez de mostrar R$ 0", () => {
    desenhar("resultado", snapAguardando());
    expect(screen.getByText("Aguardando fechamento do 1º dia útil")).toBeTruthy();
    expect(screen.queryByText("R$ 0")).toBeNull();
  });

  it("snapshot antigo, sem o campo, segue mostrando o número", () => {
    desenhar("resultado", snap(undefined));
    expect(screen.getByText("R$ 101.742")).toBeTruthy();
  });

  it("o valor exibido é o do snapshot, não um recálculo da tela", () => {
    desenhar("resultado", snap(false, { proj_honorarios: 98528 }));
    expect(screen.getByText("R$ 98.528")).toBeTruthy();
  });
});

describe("Meta do Mês", () => {
  it("cita a projeção de fechamento quando ela existe", () => {
    desenhar("meta_do_mes", snap(false));
    expect(screen.getByText(/Projeção de fechamento/)).toBeTruthy();
    expect(screen.queryByText(/Aguardando fechamento/)).toBeNull();
  });

  it("no 1º dia útil diz que está aguardando, e não cita projeção", () => {
    desenhar("meta_do_mes", snapAguardando());
    expect(screen.getByText("Aguardando fechamento do 1º dia útil")).toBeTruthy();
    expect(screen.queryByText(/Projeção de fechamento/)).toBeNull();
  });
});

describe("Magic Number", () => {
  it("cita a projeção de fechamento quando ela existe", () => {
    desenhar("magic_number", snap(false));
    expect(screen.getByText(/Projeção de fechamento/)).toBeTruthy();
  });

  it("no 1º dia útil diz que está aguardando", () => {
    desenhar("magic_number", snapAguardando());
    expect(screen.getByText("Aguardando fechamento do 1º dia útil")).toBeTruthy();
    expect(screen.queryByText(/Projeção de fechamento/)).toBeNull();
  });
});

describe("os indicadores existentes não se mexem", () => {
  it("dias úteis vêm do snapshot: base fechada / total, e restantes contam hoje", () => {
    desenhar("resultado", snap(false));
    expect(screen.getByText("Dias úteis (1/19)")).toBeTruthy();
    expect(screen.getByText("19 restantes")).toBeTruthy();
  });

  it("necessário por dia útil não muda por causa da regra da projeção", () => {
    desenhar("meta_do_mes", snap(false));
    expect(screen.getByText("R$ 6.159")).toBeTruthy();
  });

  it("honorários recebidos seguem sendo o realizado, com o dinheiro de hoje", () => {
    desenhar("resultado", snap(false));
    expect(screen.getByText("R$ 5.371")).toBeTruthy();
  });
});
