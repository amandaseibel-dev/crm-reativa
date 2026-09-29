// @vitest-environment jsdom
//
// Testes da seção "Situação acadêmica consultada no Prime".
//
// O que estes testes protegem, em ordem de gravidade:
//   1. nenhum status encontrado fica escondido atrás da mensagem de
//      correspondência não confirmada -- as duas coisas aparecem juntas;
//   2. os três desfechos (falha / sem resultado / nunca consultado) são textos
//      DIFERENTES, e nenhum deles diz "o aluno não tem vínculo";
//   3. linhas semelhantes com status diferentes são todas renderizadas;
//   4. status nulo aparece como "Não informado pelo Prime";
//   5. a tela não escreve nada em `alunos`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

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

const { default: SituacaoAcademicaPrime } = await import("./SituacaoAcademicaPrime");

const ALUNO = { id: "11111111-1111-1111-1111-111111111111" };

// Caso real da matrícula 222007757: três vínculos indistinguíveis pelos campos
// disponíveis, com status diferentes.
const TRES_IGUAIS = {
  resultado: "COM_VINCULOS",
  consultado_em: "2026-09-28T23:45:00Z",
  registration: "222007757",
  vinculos: [
    { linha_id: "a", ordem: 1, curso: "COMÉRCIO EXTERIOR", campus: "EAD", turno: "ENSINO A DISTANCIA", status: "Reopção de Curso", graduated: false, admission_year: 2025 },
    { linha_id: "b", ordem: 2, curso: "COMÉRCIO EXTERIOR", campus: "EAD", turno: "ENSINO A DISTANCIA", status: "Cancelado", graduated: false, admission_year: 2025 },
    { linha_id: "c", ordem: 3, curso: "COMÉRCIO EXTERIOR", campus: "EAD", turno: "ENSINO A DISTANCIA", status: null, graduated: false, admission_year: null },
  ],
};

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); from.mockReset(); });
afterEach(() => cleanup());

describe("SituacaoAcademicaPrime", () => {
  it("mostra a correspondência não confirmada SEM esconder os status", async () => {
    rpc.mockResolvedValue({ data: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    expect(await screen.findByText(/Correspondência com o curso desta dívida não confirmada/i)).toBeTruthy();
    // e os status continuam visíveis -- é o ponto
    expect(screen.getByText("Reopção de Curso")).toBeTruthy();
    expect(screen.getByText("Cancelado")).toBeTruthy();
  });

  it("preserva linhas semelhantes com situações diferentes", async () => {
    rpc.mockResolvedValue({ data: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    // três linhas de vínculo, mesmo com curso+campus+turno idênticos
    const celulasCurso = screen.getAllByText("COMÉRCIO EXTERIOR");
    expect(celulasCurso).toHaveLength(3);
    expect(screen.getByText(/3 vínculos de curso/i)).toBeTruthy();
  });

  it("status nulo aparece como 'Não informado pelo Prime', não como vazio", async () => {
    rpc.mockResolvedValue({ data: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    expect(await screen.findByText("Não informado pelo Prime")).toBeTruthy();
    expect(screen.getByText(/1 sem situação informada/i)).toBeTruthy();
  });

  it("mostra fonte e data da consulta", async () => {
    rpc.mockResolvedValue({ data: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const fonte = await screen.findByText(/Fonte: Prime/i);
    expect(fonte.textContent).toMatch(/students_search/);
    expect(fonte.textContent).toMatch(/consultado em/i);
    expect(fonte.textContent).toMatch(/222007757/);
  });

  it("FALHA DE COMUNICAÇÃO não diz que o aluno não tem vínculo", async () => {
    rpc.mockResolvedValue({
      data: { resultado: "FALHA_COMUNICACAO", detalhe_falha: "HTTP 500", consultado_em: "2026-09-28T23:45:00Z", vinculos: [] },
    });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const msg = await screen.findByText(/Não foi possível falar com o Prime/i);
    expect(msg.textContent).toMatch(/HTTP 500/);
    expect(msg.textContent).toMatch(/não significa que o aluno não tenha vínculo/i);
    // e não mostra a mensagem de "sem vínculo"
    expect(screen.queryByText(/não retornou nenhum vínculo/i)).toBeNull();
  });

  it("SEM RESULTADO é texto próprio, diferente da falha", async () => {
    rpc.mockResolvedValue({
      data: { resultado: "SEM_RESULTADO", consultado_em: "2026-09-28T23:45:00Z", vinculos: [] },
    });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const msg = await screen.findByText(/não retornou nenhum vínculo/i);
    expect(msg.textContent).toMatch(/Não é o mesmo que/i);
    expect(screen.queryByText(/Não foi possível falar com o Prime/i)).toBeNull();
    // não promete correspondência nenhuma
    expect(screen.queryByText(/Correspondência com o curso/i)).toBeNull();
  });

  it("sem dado local, consulta a API sozinho", async () => {
    rpc.mockResolvedValue({ data: null });          // nunca consultado
    invoke.mockResolvedValue({ data: { ok: true, leitura: TRES_IGUAIS }, error: null });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("prime-academico", { body: { aluno_id: ALUNO.id } }));
    expect(await screen.findByText("Reopção de Curso")).toBeTruthy();
  });

  it("o botão Atualizar consulta chama a API de novo", async () => {
    rpc.mockResolvedValue({ data: TRES_IGUAIS });
    invoke.mockResolvedValue({ data: { ok: true, leitura: TRES_IGUAIS }, error: null });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    expect(invoke).not.toHaveBeenCalled();           // já tinha dado local

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar consulta/i })); });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  });

  it("falha ao chamar a nossa função é distinguida da falha do Prime", async () => {
    rpc.mockResolvedValue({ data: null });
    invoke.mockRejectedValue(new Error("network down"));
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const msg = await screen.findByText(/Não foi possível consultar/i);
    expect(msg.textContent).toMatch(/network down/);
  });

  it("NUNCA escreve em alunos nem em nenhuma tabela", async () => {
    rpc.mockResolvedValue({ data: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    expect(from).not.toHaveBeenCalled();
    // a única RPC usada é a de leitura
    for (const chamada of rpc.mock.calls) expect(chamada[0]).toBe("prime_academico_ultima");
  });

  it("sem aluno, não renderiza nem consulta", () => {
    const { container } = render(<SituacaoAcademicaPrime aluno={null} />);
    expect(container.textContent).toBe("");
    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
