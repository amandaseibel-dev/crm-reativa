// @vitest-environment jsdom
// Dados FICTÍCIOS: a tela de período não pode exibir CPF nem campo fora da lista conhecida.
// O CPF de teste (000.000.000-00 / 00000000000) é inventado; o teste garante que a tela
// renderiza só os campos que o contrato da RPC ulbra_central_conversas define.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MensageriaPeriodo from "./MensageriaPeriodo";

const rpc = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpc(...a) } }));

const CPF_FICTICIO = "000.000.000-00";
const CPF_FICTICIO_DIGITOS = "00000000000";

const PERIODO_FICTICIO = {
  ok: true, eh_gestao: true, operador: "operador-teste@exemplo.invalid", desde: "2026-11-01T03:00:00+00:00",
  limite: 100, pagina: 0, totais: { conversas: 1, aguardando: 0, sem_cpf: 0 },
  conversas: [
    {
      conversa_id: "conv-fict-1", aluno_id: "aluno-fict-1", nome: "Aluno Fictício", previa: "mensagem fictícia",
      mensagem_em: "2026-11-10T13:00:00Z", quem: "operador", direcao: "enviada", aguardando: false,
      responsabilidade: "CARTEIRA", responsavel_reativa: "operador-teste@exemplo.invalid", minha: true, lida: false,
      // Campo que NÃO faz parte do contrato: simula vazamento. A tela não pode mostrar.
      cpf: CPF_FICTICIO, documento: CPF_FICTICIO_DIGITOS,
    },
  ],
};

afterEach(() => cleanup());

describe("tela de período — máscara de CPF (dados fictícios)", () => {
  it("não renderiza CPF nem campo fora do contrato, mesmo que a RPC devolva", async () => {
    rpc.mockResolvedValue({ data: PERIODO_FICTICIO, error: null });
    const { container } = render(
      <MemoryRouter>
        <MensageriaPeriodo respostas={[]} coleta={null} aoAbrirFicha={() => {}} historicoDisponivel={true} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("mensageria-conversas").querySelectorAll("li").length).toBe(1));
    const texto = container.textContent || "";
    expect(texto).not.toContain(CPF_FICTICIO);
    expect(texto).not.toContain(CPF_FICTICIO_DIGITOS);
    expect(texto).toContain("Aluno Fictício");
  });
});

describe("tela de período — CPF na prévia de texto livre (dados fictícios)", () => {
  it("prévia com CPF (com e sem pontuação) sai mascarada; o resto do texto fica", async () => {
    rpc.mockResolvedValue({
      data: {
        ...PERIODO_FICTICIO,
        conversas: [
          { ...PERIODO_FICTICIO.conversas[0], conversa_id: "c-p1", previa: "meu cpf 529.982.247-25 pode ver?", cpf: undefined, documento: undefined },
          { ...PERIODO_FICTICIO.conversas[0], conversa_id: "c-p2", aluno_id: "aluno-fict-2", nome: "Outro Fictício", previa: "cpf 52998224725 obrigada", cpf: undefined, documento: undefined },
        ],
        totais: { conversas: 2, aguardando: 0, sem_cpf: 0 },
      },
      error: null,
    });
    const { container } = render(
      <MemoryRouter>
        <MensageriaPeriodo respostas={[]} coleta={null} aoAbrirFicha={() => {}} historicoDisponivel={false} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("mensageria-conversas").querySelectorAll("li").length).toBe(2));
    const texto = container.textContent || "";
    expect(texto).toContain("meu cpf ***.***.***-25 pode ver?");
    expect(texto).toContain("cpf ***.***.***-25 obrigada");
    expect(texto).not.toContain("529.982.247-25");
    expect(texto).not.toContain("52998224725");
  });
});
