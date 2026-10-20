// @vitest-environment jsdom
//
// Painel de diagnóstico da integração Prime -- a TELA.
//
// O que estes testes prendem, em ordem de gravidade:
//   1. PRIVACIDADE: com o botão desligado, nada identificável aparece na
//      página. Nem valor de item, nem a `forma` que a sonda devolve (ela traz
//      valor de escalar curto -- nome e CPF). Ligado, a tela AVISA antes;
//   2. a sonda é chamada por `supabase.functions.invoke`, com a sessão que o
//      cliente anexa sozinho -- a tela não lê, não monta e não guarda
//      credencial nenhuma (conferido lendo o próprio arquivo);
//   3. caminho fora da allowlist é recusado ANTES de sair;
//   4. os quatro testes rodam exatamente os quatro caminhos pedidos, em ordem,
//      e a comparação 1×2 é explícita;
//   5. quem não é gestão não recebe botão nenhum, e nenhuma chamada sai;
//   6. a tela não tem nenhum caminho de escrita.
//
// A API de verdade NUNCA é chamada: o cliente Supabase é dublado.
// Datas das fixtures são fixas (máquina em BRT, CI em UTC).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const rpc = vi.fn();
const invoke = vi.fn();
const from = vi.fn();

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpc(...a),
    functions: { invoke: (...a) => invoke(...a) },
    from: (...a) => from(...a),
  },
}));

const { default: DiagnosticoPrime } = await import("./DiagnosticoPrime");

const MATRICULA = "232005643";

// Estrutura real documentada em docs/integracoes/prime-api.md; valores
// inventados, inclusive um nome de pessoa fictício que NÃO pode aparecer na
// tela com o botão desligado.
const ITEM_195 = {
  boleto: "4039712", documentNumber: "0104270450100",
  carrier: { id: 195, name: "REATIVA RECUPERACAO DE CREDITO" },
  dueDate: "2026-01-05", paymentDate: "2026-09-14",
  grossAmount: 550, discountAmount: 0, penaltyAmount: 0, interestAmount: null,
  honorariumAmount: 45, netAmount: 595, paidAmount: 1110.12, isAgreementInstallment: false,
};
const ITEM_166 = {
  boleto: "4039714", documentNumber: "0556290001",
  carrier: { id: 166, name: "CONVENIO ACORDO" },
  dueDate: "2026-03-05", paymentDate: "2026-03-01",
  grossAmount: 300, discountAmount: 0, penaltyAmount: 0, interestAmount: null,
  honorariumAmount: 0, netAmount: 300, paidAmount: 300, isAgreementInstallment: true,
};
const EXTRATO = { items: [ITEM_195, ITEM_166], totalItems: 2 };
const NOME_FICTICIO = "FULANA DE TESTE DA SILVA";

// A sonda responde assim: a FORMA sempre, o `cru` quando pedido. A `forma`
// abaixo carrega o nome de propósito -- é o risco que a tela tem de neutralizar.
function respostaDaSonda(caminho, corpo) {
  return {
    data: {
      caminho,
      status: 200,
      tipo: "application/json; charset=utf-8",
      tamanho: JSON.stringify(corpo).length,
      forma: { items: { _lista: (corpo.items || []).length, _item: { boleto: "4039712", nome: NOME_FICTICIO } }, totalItems: "2" },
      cru: corpo,
    },
    error: null,
  };
}

function comGestao(ehGestao) {
  rpc.mockImplementation(async (nome) => {
    if (nome === "usuario_e_gestao") return { data: ehGestao, error: null };
    return { data: null, error: null };
  });
}

const texto = () => document.body.textContent || "";
const caminhosChamados = () => invoke.mock.calls.map((c) => c[1]?.body?.caminho);

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); from.mockReset(); });
afterEach(() => cleanup());

describe("quem entra", () => {
  it("quem NÃO é gestão não vê botão e nada é chamado", async () => {
    comGestao(false);
    render(<DiagnosticoPrime />);
    expect(await screen.findByText(/restrita à gestão/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("erro ao perguntar quem é fecha a porta, em vez de oferecer 403", async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: "falhou" } }));
    render(<DiagnosticoPrime />);
    expect(await screen.findByText(/restrita à gestão/i)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("gestão vê os dois botões", async () => {
    comGestao(true);
    render(<DiagnosticoPrime />);
    expect(await screen.findByRole("button", { name: /Consultar este caminho/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rodar os quatro testes/i })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled(); // abrir a tela não consulta nada
  });
});

describe("o caminho sai do seletor, não de texto livre", () => {
  it("monta a partir da forma escolhida, da matrícula e da query", async () => {
    comGestao(true);
    invoke.mockImplementation(async (_fn, { body }) => respostaDaSonda(body.caminho, EXTRATO));
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Consultar este caminho/i });

    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.change(screen.getByLabelText("query string"), { target: { value: "carrierId=166" } });
    // a prévia mostra o caminho ANTES de qualquer chamada
    expect(texto()).toContain("/students/232005643/financial-statement?carrierId=166");

    fireEvent.click(screen.getByRole("button", { name: /Consultar este caminho/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("prime-sonda", {
      body: { caminho: "/students/232005643/financial-statement?carrierId=166", cru: true },
    });
  });

  it("troca de forma troca o caminho (agreements, sem query)", async () => {
    comGestao(true);
    invoke.mockImplementation(async (_fn, { body }) => respostaDaSonda(body.caminho, { items: [], totalItems: 0 }));
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Consultar este caminho/i });

    fireEvent.change(screen.getByLabelText("forma do caminho"), { target: { value: "agreements" } });
    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.click(screen.getByRole("button", { name: /Consultar este caminho/i }));
    await waitFor(() => expect(caminhosChamados()).toEqual(["/students/232005643/agreements"]));
  });

  it("caminho fora da allowlist NÃO sai: a tela recusa antes", async () => {
    comGestao(true);
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Consultar este caminho/i });

    // o composto não aceita query string -- o padrão do servidor é `^/students/{reg}$`
    fireEvent.change(screen.getByLabelText("forma do caminho"), { target: { value: "student_composite" } });
    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.change(screen.getByLabelText("query string"), { target: { value: "take=1" } });
    fireEvent.click(screen.getByRole("button", { name: /Consultar este caminho/i }));

    await waitFor(() => expect(texto()).toMatch(/não aceita query string/i));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("matrícula vazia não dispara os quatro testes", async () => {
    comGestao(true);
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Rodar os quatro testes/i });
    fireEvent.click(screen.getByRole("button", { name: /Rodar os quatro testes/i }));
    await waitFor(() => expect(texto()).toMatch(/Informe a matrícula/i));
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("o resultado vem agregado -- requisito de privacidade", () => {
  async function consultarExtrato() {
    comGestao(true);
    invoke.mockImplementation(async (_fn, { body }) => respostaDaSonda(body.caminho, EXTRATO));
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Consultar este caminho/i });
    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.click(screen.getByRole("button", { name: /Consultar este caminho/i }));
    await waitFor(() => expect(texto()).toMatch(/status da Prime/i));
  }

  it("mostra status, tamanho, contagens e NOMES de campo", async () => {
    await consultarExtrato();
    const t = texto();
    // os dois status aparecem separados: o da Edge Function e o da ULBRA
    expect(t).toMatch(/resposta da sonda\s*HTTP 2xx/);
    expect(t).toMatch(/status da Prime\s*200/);
    expect(t).toMatch(/tamanho/);
    expect(t).toMatch(/contagem por carrier\.id/);
    expect(t).toContain("195");
    expect(t).toContain("166");
    expect(t).toMatch(/isAgreementInstallment = true/);
    // nomes de campo do primeiro item
    expect(t).toContain("documentNumber");
    expect(t).toContain("paidAmount");
  });

  it("com o botão DESLIGADO, nenhum valor identificável aparece", async () => {
    await consultarExtrato();
    const t = texto();
    // nome vindo da `forma` da própria sonda -- o jeito mais fácil de vazar
    expect(t).not.toContain(NOME_FICTICIO);
    // valores de item
    for (const valor of ["4039712", "0104270450100", "1110.12", "2026-09-14"]) {
      expect(t).not.toContain(valor);
    }
  });

  it("o botão começa DESLIGADO", async () => {
    await consultarExtrato();
    expect(screen.getByRole("checkbox").checked).toBe(false);
  });

  it("LIGADO, avisa que exibe dado pessoal -- e só então exibe", async () => {
    await consultarExtrato();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(texto()).toMatch(/contém dado pessoal|inclui.*dado pessoal/i));
    expect(texto()).toMatch(/Desligue antes de compartilhar a tela/i);
    expect(texto()).toContain("4039712"); // agora sim, por decisão explícita
  });

  it("desligar de novo esconde o conteúdo", async () => {
    await consultarExtrato();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(texto()).toContain("4039712"));
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(texto()).not.toContain("4039712"));
  });
});

describe("os quatro testes e a comparação 1 × 2", () => {
  async function rodarOsQuatro(porCaminho) {
    comGestao(true);
    invoke.mockImplementation(async (_fn, { body }) => respostaDaSonda(body.caminho, porCaminho(body.caminho)));
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Rodar os quatro testes/i });
    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.click(screen.getByRole("button", { name: /Rodar os quatro testes/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
  }

  const COMPOSTO = {
    registrationData: { registration: MATRICULA, fullName: NOME_FICTICIO },
    contracts: { items: [], totalItems: 0 },
    financialStatement: EXTRATO,
    agreements: { items: [], totalItems: 0 },
  };

  const MESMA_COISA = (caminho) =>
    caminho.endsWith("/agreements") ? { items: [], totalItems: 0 }
      : caminho === `/students/${MATRICULA}` ? COMPOSTO
        : EXTRATO;

  it("roda exatamente os quatro caminhos pedidos, nesta ordem", async () => {
    await rodarOsQuatro(MESMA_COISA);
    expect(caminhosChamados()).toEqual([
      "/students/232005643/financial-statement",
      "/students/232005643/financial-statement?carrierId=166",
      "/students/232005643/agreements",
      "/students/232005643",
    ]);
    // todas com `cru: true` e nada além disso no corpo
    for (const c of invoke.mock.calls) expect(Object.keys(c[1].body).sort()).toEqual(["caminho", "cru"]);
  });

  it("extrato igual com e sem carrierId: diz SIM, explicitamente", async () => {
    await rodarOsQuatro(MESMA_COISA);
    await waitFor(() => expect(texto()).toMatch(/Resposta 1 e 2 são idênticas:\s*sim/i));
    expect(texto()).toMatch(/não é filtrado por escopo de portador/i);
  });

  it("extrato diferente com carrierId: diz NÃO e mostra a diferença por contagem", async () => {
    await rodarOsQuatro((caminho) => {
      if (caminho.includes("carrierId=166")) return { items: [ITEM_166], totalItems: 1 };
      if (caminho.endsWith("/agreements")) return { items: [], totalItems: 0 };
      if (caminho === `/students/${MATRICULA}`) return COMPOSTO;
      return EXTRATO;
    });
    await waitFor(() => expect(texto()).toMatch(/Resposta 1 e 2 são idênticas:\s*não/i));
    expect(texto()).toMatch(/itens: 2 × 1/);
    expect(texto()).toMatch(/precisa entrar em/i); // manda documentar o achado
    expect(texto()).not.toContain(NOME_FICTICIO);
  });

  it("uma das duas falhando NÃO vira 'idênticas'", async () => {
    comGestao(true);
    invoke.mockImplementation(async (_fn, { body }) => {
      if (body.caminho.includes("carrierId=166")) {
        return { data: null, error: { message: "Edge Function returned a non-2xx status code", context: { status: 500 } } };
      }
      return respostaDaSonda(body.caminho, MESMA_COISA(body.caminho));
    });
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Rodar os quatro testes/i });
    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.click(screen.getByRole("button", { name: /Rodar os quatro testes/i }));
    await waitFor(() => expect(texto()).toMatch(/não se sabe/i));
    expect(texto()).toMatch(/HTTP 500/);
    expect(texto()).not.toMatch(/idênticas:\s*sim/i);
  });

  it("no composto, conta os blocos e não mostra o nome do aluno", async () => {
    await rodarOsQuatro(MESMA_COISA);
    const t = texto();
    expect(t).toContain("registrationData");
    expect(t).toContain("financialStatement");
    expect(t).toMatch(/agreements\s*—\s*0 itens/);
    expect(t).not.toContain(NOME_FICTICIO);
  });
});

describe("em execução, a tela não escreve nada", () => {
  it("nenhuma tabela é tocada e a única RPC é o portão", async () => {
    comGestao(true);
    invoke.mockImplementation(async (_fn, { body }) => respostaDaSonda(body.caminho, EXTRATO));
    render(<DiagnosticoPrime />);
    await screen.findByRole("button", { name: /Rodar os quatro testes/i });
    fireEvent.change(screen.getByLabelText("matrícula"), { target: { value: MATRICULA } });
    fireEvent.click(screen.getByRole("button", { name: /Rodar os quatro testes/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    expect(from).not.toHaveBeenCalled();
    expect(rpc.mock.calls.every((c) => c[0] === "usuario_e_gestao")).toBe(true);
    // e a única Edge Function chamada é a sonda
    expect([...new Set(invoke.mock.calls.map((c) => c[0]))]).toEqual(["prime-sonda"]);
  });
});
