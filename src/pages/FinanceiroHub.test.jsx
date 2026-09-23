// @vitest-environment jsdom
//
// "PAGAMENTOS SEM VINCULO" DENTRO DO FINANCEIRO (23/09/2026).
//
// A regra do proprio hub, na voz da gestao: "tudo que tiver de confirmacao
// deveria aparecer na aba de confirmacao e nao em outro lugar, vai confundir
// tudo". A fila tinha voltado a ser item solto no menu Gestao; virou aba.
//
// O que se prova aqui:
//   1. a aba existe para os TRES e-mails da gestao financeira;
//   2. ela NAO existe para mais ninguem -- e o conteudo tambem nao monta,
//      nem se o estado for forcado, porque a RPC recusaria de qualquer jeito;
//   3. a fila so monta quando a aba e escolhida (nao carrega escondida);
//   4. as abas que ja existiam continuam todas la.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Cada aba do hub e uma tela pesada que fala com o banco. Aqui interessa a
// NAVEGACAO do hub, entao cada uma entra como duble que so diz o proprio nome.
// A fabrica vai INLINE em cada vi.mock: a chamada e icada para o topo do
// arquivo, entao um helper declarado aqui em cima ainda nao existiria.
vi.mock("./ConsultaFinanceira", () => ({ default: () => <div>tela: ConsultaFinanceira</div> }));
vi.mock("./ConferenciaPagamentos", () => ({ default: () => <div>tela: ConferenciaPagamentos</div> }));
vi.mock("./PainelAdm", () => ({ default: () => <div>tela: PainelAdm</div> }));
vi.mock("./ConferenciaPrime", () => ({ default: () => <div>tela: ConferenciaPrime</div> }));
vi.mock("../components/AcordosSemResponsavel", () => ({ default: () => <div>tela: AcordosSemResponsavel</div> }));
vi.mock("../components/ForaDaCobranca", () => ({ default: () => <div>tela: ForaDaCobranca</div> }));
vi.mock("./MinhaFilaPagamentos", () => ({ default: () => <div>tela: MinhaFilaPagamentos</div> }));
vi.mock("./HistoricoConfirmacoes", () => ({ default: () => <div>tela: HistoricoConfirmacoes</div> }));
vi.mock("./AcordosSemVinculo", () => ({ default: () => <div>tela: AcordosSemVinculo</div> }));
vi.mock("./PagamentosSemAluno", () => ({ default: () => <div>tela: PagamentosSemAluno</div> }));

import FinanceiroHub from "./FinanceiroHub";

const comEmail = (email) => ({ perfil: { email } });
const ABA = "Pagamentos sem vínculo";

afterEach(cleanup);

describe("a fila de pagamentos virou aba do Financeiro", () => {
  it.each([
    "amanda.seibel@aelbra.com.br",
    "cobranca04@aelbra.com.br",
    "cobranca07@aelbra.com.br",
  ])("a aba aparece para %s", (email) => {
    render(<FinanceiroHub usuario={comEmail(email)} />);
    expect(screen.getByRole("button", { name: ABA })).toBeTruthy();
  });

  it("aceita o e-mail com espaço e em maiúscula, como vem do cadastro", () => {
    render(<FinanceiroHub usuario={comEmail("  Amanda.Seibel@Aelbra.com.BR ")} />);
    expect(screen.getByRole("button", { name: ABA })).toBeTruthy();
  });

  it("abre a fila ao escolher a aba", () => {
    render(<FinanceiroHub usuario={comEmail("amanda.seibel@aelbra.com.br")} />);
    // nao monta escondida: o hub abre no Painel ADM
    expect(screen.queryByText("tela: PagamentosSemAluno")).toBeNull();
    expect(screen.getByText("tela: PainelAdm")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: ABA }));
    expect(screen.getByText("tela: PagamentosSemAluno")).toBeTruthy();
    expect(screen.queryByText("tela: PainelAdm")).toBeNull();
  });

  it("quem não é da gestão financeira não vê a aba nem o conteúdo", () => {
    render(<FinanceiroHub usuario={comEmail("cobranca03@aelbra.com.br")} />);
    expect(screen.queryByRole("button", { name: ABA })).toBeNull();
    expect(screen.queryByText("tela: PagamentosSemAluno")).toBeNull();
    // e as outras abas do Financeiro continuam abrindo normalmente
    fireEvent.click(screen.getByRole("button", { name: "Conferência Prime" }));
    expect(screen.getByText("tela: ConferenciaPrime")).toBeTruthy();
  });

  it("sem usuário nenhum, a aba não aparece", () => {
    render(<FinanceiroHub />);
    expect(screen.queryByRole("button", { name: ABA })).toBeNull();
  });

  it("as abas que já existiam continuam todas lá", () => {
    render(<FinanceiroHub usuario={comEmail("amanda.seibel@aelbra.com.br")} />);
    for (const rotulo of [
      "Painel ADM", "Financeiro", "Confirmação de Pagamento", "Fila de Baixas",
      "Conferência Prime", "Acordos sem vínculo", "Histórico de Confirmações",
      "Acordos sem responsável", "Fora da cobrança",
    ]) {
      expect(screen.getByRole("button", { name: rotulo })).toBeTruthy();
    }
  });
});
