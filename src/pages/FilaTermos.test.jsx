// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

// Dublês: a lista vem de `from(...).range()`, as decisões vão por RPC. Os
// utilitários de documento/PDF ficam de fora — nada aqui abre arquivo.
const rpcMock = vi.fn();
let termosFixture = [];
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } } }) },
    from: () => ({
      select: () => ({
        order: () => ({
          order: () => ({
            range: async () => ({ data: termosFixture, error: null }),
          }),
        }),
      }),
    }),
  },
}));
vi.mock("../utils/documentoFinanceiro", () => ({
  urlTermo: vi.fn(async () => null),
  enviarTermo: vi.fn(),
  concluirAssinaturaTermo: vi.fn(),
  desfazerAssinaturaConcluida: vi.fn(),
  descartarViaAluno: vi.fn(),
}));
vi.mock("../utils/juntarPdf", () => ({ juntarEmPdf: vi.fn(), nomeArquivoPdf: () => "x.pdf" }));

import FilaTermos from "./FilaTermos";

const base = {
  aluno_cpf: "12345678901", operador_email: "op@aelbra.com.br", operador_nome: "Op Teste",
  criado_em: "2026-09-01T10:00:00Z", validado_em: "2026-09-02T10:00:00Z", validado_por: "adm@x",
  arquivo_url: "a/b.pdf", tipo_assinatura: "MANUAL_RG",
};
const FIXTURE = [
  { ...base, id: "t1", aluno_id: "a1", aluno_nome: "Bia Pendente", status: "TERMO_RECEBIDO_LIBERADO", etapa_assinatura: "PENDENTE_ENVIO" },
  { ...base, id: "t2", aluno_id: "a2", aluno_nome: "Caio Assinado", status: "TERMO_LIBERADO_AUTOMATICO_GOV", validado_por: "LEGADO_GOV_PRE_AUDITORIA", etapa_assinatura: "COMPLETO", arquivo_final_url: "f.pdf" },
  { ...base, id: "t3", aluno_id: "a3", aluno_nome: "Dora Dispensada", status: "TERMO_RECEBIDO_LIBERADO", etapa_assinatura: "DISPENSADO", dispensa_motivo: "NAO_PAGOU", dispensado_em: "2026-09-03T10:00:00Z", dispensado_por: "adm@x" },
  { ...base, id: "t4", aluno_id: "a4", aluno_nome: "Edu Na Validacao", status: "TERMO_ENVIADO_ADM", etapa_assinatura: "NAO_APLICAVEL" },
];

function cardDe(nome) {
  return screen.getByRole("heading", { name: nome }).closest("div").parentElement.parentElement;
}

async function abrir(aba) {
  await act(async () => { render(<FilaTermos />); });
  if (aba) await act(async () => { fireEvent.click(screen.getByRole("button", { name: aba })); });
}

beforeEach(() => {
  termosFixture = FIXTURE;
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
  window.alert = vi.fn();
  window.confirm = vi.fn(() => true);
});
afterEach(cleanup);

describe("Fila ADM de Termos: não será assinado / devolver ao operador", () => {
  it("aba Assinaturas: 'Todas' não conta nem lista o dispensado; ele tem filtro próprio", async () => {
    await abrir(/^Assinaturas \(2\)$/);
    expect(screen.getByRole("heading", { name: "Bia Pendente" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Caio Assinado" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Dora Dispensada" })).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Não será assinado (1)" })); });
    expect(screen.getByRole("heading", { name: "Dora Dispensada" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Bia Pendente" })).toBeNull();
    const card = cardDe("Dora Dispensada");
    expect(card.textContent).toContain("Aluno não pagou / não cumpriu o acordo");
    expect(within(card).getByRole("button", { name: "Voltar para a fila" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Anexar via assinada" })).toBeNull();
  });

  it("'Não será assinado' pede motivo fechado e chama a RPC sem apagar nada", async () => {
    await abrir(/^Assinaturas/);
    const card = cardDe("Bia Pendente");
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Não será assinado" })); });

    // sem motivo não sai
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar: não será assinado" })); });
    expect(rpcMock).not.toHaveBeenCalled();

    // 'Outro' exige detalhe
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "OUTRO" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar: não será assinado" })); });
    expect(rpcMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "NAO_PAGOU" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar: não será assinado" })); });
    expect(rpcMock).toHaveBeenCalledWith("termo_dispensar_assinatura", {
      p_termo_id: "t1", p_motivo: "NAO_PAGOU", p_detalhe: null,
    });
  });

  it("'Devolver ao operador' só em termo liberado não assinado, e manda o motivo composto", async () => {
    await abrir("Todos");
    expect(within(cardDe("Bia Pendente")).getByRole("button", { name: "Devolver ao operador" })).toBeTruthy();
    expect(within(cardDe("Caio Assinado")).queryByRole("button", { name: "Devolver ao operador" })).toBeNull();
    expect(within(cardDe("Edu Na Validacao")).queryByRole("button", { name: "Devolver ao operador" })).toBeNull();

    await act(async () => { fireEvent.click(within(cardDe("Bia Pendente")).getByRole("button", { name: "Devolver ao operador" })); });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Valor do acordo incorreto" } });
    fireEvent.change(screen.getByLabelText("Detalhe do motivo"), { target: { value: "no termo está 1.200, no Prime 1.500" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar devolução" })); });
    expect(rpcMock).toHaveBeenCalledWith("termo_devolver_ao_operador", {
      p_termo_id: "t1", p_motivo: "Valor do acordo incorreto — no termo está 1.200, no Prime 1.500",
    });
  });

  it("'Voltar para a fila' reativa o dispensado", async () => {
    await abrir(/^Assinaturas/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Não será assinado (1)" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Voltar para a fila" })); });
    expect(rpcMock).toHaveBeenCalledWith("termo_reativar_assinatura", { p_termo_id: "t3" });
  });
});
