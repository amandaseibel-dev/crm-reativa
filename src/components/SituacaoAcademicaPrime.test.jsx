// @vitest-environment jsdom
//
// Testes da seção "Situação acadêmica consultada no Prime".
//
// O que estes testes protegem, em ordem de gravidade:
//   1. operador NÃO dispara consulta -- nem pelo botão (que não existe para
//      ele), nem automaticamente. Sem isso, abrir uma ficha nunca consultada
//      como operador gerava uma chamada que só podia terminar em 403;
//   2. nenhum status encontrado fica escondido atrás da mensagem de
//      correspondência não confirmada -- as duas coisas aparecem juntas;
//   3. os estados são textos DIFERENTES, e nenhum deles diz "o aluno não tem
//      vínculo": erro de leitura, nunca consultado, sem resultado, falha;
//   4. falha ao ATUALIZAR não apaga a última consulta boa;
//   5. linhas semelhantes com status diferentes são todas renderizadas, e a
//      matrícula por linha aparece quando elas divergem;
//   6. a tela não escreve nada em `alunos`.

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

// A ESTRUTURA do caso documentado na caso documentado em docs/integracoes/prime-mapa-identificadores.md (ver
// docs/integracoes/prime-mapa-identificadores.md): três vínculos
// indistinguíveis pelos campos disponíveis, com status diferentes.
// Matrícula fictícia -- o que o teste precisa é da forma, não do identificador.
const TRES_IGUAIS = {
  resultado: "COM_VINCULOS",
  consultado_em: "2026-09-28T23:45:00Z",
  registration: "990100004",
  vinculos: [
    { linha_id: "a", ordem: 1, registration: "990100004", curso: "COMÉRCIO EXTERIOR", campus: "EAD", turno: "ENSINO A DISTANCIA", status: "Reopção de Curso", graduated: false, admission_year: 2025 },
    { linha_id: "b", ordem: 2, registration: "990100004", curso: "COMÉRCIO EXTERIOR", campus: "EAD", turno: "ENSINO A DISTANCIA", status: "Cancelado", graduated: false, admission_year: 2025 },
    { linha_id: "c", ordem: 3, registration: "990100004", curso: "COMÉRCIO EXTERIOR", campus: "EAD", turno: "ENSINO A DISTANCIA", status: null, graduated: false, admission_year: null },
  ],
};

// `rpc` atende duas funções: o portão e a leitura. Cada teste diz quem é o
// usuário e o que está gravado.
function comBanco({ gestao = true, leitura = null, erroLeitura = null }) {
  rpc.mockImplementation(async (nome) => {
    if (nome === "usuario_e_gestao") return { data: gestao, error: null };
    if (nome === "prime_academico_ultima") {
      return erroLeitura
        ? { data: null, error: { message: erroLeitura } }
        : { data: leitura, error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); from.mockReset(); });
afterEach(() => cleanup());

describe("quem pode consultar", () => {
  it("OPERADOR não vê botão e NÃO dispara consulta automática", async () => {
    comBanco({ gestao: false, leitura: null });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    // a orientação é o que ele consegue seguir -- não um botão que daria 403
    expect(await screen.findByText(/restrita à gestão/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Atualizar consulta/i })).toBeNull();
    // e, acima de tudo: nenhuma chamada à Edge Function
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("OPERADOR vê normalmente os dados já gravados", async () => {
    comBanco({ gestao: false, leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    expect(await screen.findByText("Reopção de Curso")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Atualizar consulta/i })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("erro ao perguntar quem é o usuário fecha a porta, em vez de oferecer 403", async () => {
    rpc.mockImplementation(async (nome) => {
      if (nome === "usuario_e_gestao") return { data: null, error: { message: "falhou" } };
      return { data: null, error: null };
    });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText(/restrita à gestão/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("GESTÃO sem dado local consulta a API sozinha", async () => {
    comBanco({ gestao: true, leitura: null });
    invoke.mockResolvedValue({ data: { ok: true, leitura: TRES_IGUAIS }, error: null });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("prime-academico", { body: { aluno_id: ALUNO.id } }));
    expect(await screen.findByText("Reopção de Curso")).toBeTruthy();
  });

  it("GESTÃO com dado local NÃO consulta sozinha; o botão é que consulta", async () => {
    comBanco({ gestao: true, leitura: TRES_IGUAIS });
    invoke.mockResolvedValue({ data: { ok: true, leitura: TRES_IGUAIS }, error: null });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    expect(invoke).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar consulta/i })); });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  });
});

describe("o que a tela mostra", () => {
  it("mostra a correspondência não confirmada SEM esconder os status", async () => {
    comBanco({ leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    expect(await screen.findByText(/Correspondência com o curso desta dívida não confirmada/i)).toBeTruthy();
    expect(screen.getByText("Reopção de Curso")).toBeTruthy();
    expect(screen.getByText("Cancelado")).toBeTruthy();
  });

  it("preserva linhas semelhantes com situações diferentes", async () => {
    comBanco({ leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    expect(screen.getAllByText("COMÉRCIO EXTERIOR")).toHaveLength(3);
    expect(screen.getByText(/3 vínculos de curso/i)).toBeTruthy();
  });

  it("status nulo aparece como 'Não informado pelo Prime', não como vazio", async () => {
    comBanco({ leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    expect(await screen.findByText("Não informado pelo Prime")).toBeTruthy();
    expect(screen.getByText(/1 sem situação informada/i)).toBeTruthy();
  });

  it("matrículas DIFERENTES na mesma resposta aparecem linha a linha", async () => {
    const misto = {
      ...TRES_IGUAIS,
      registration: null, // cabeçalho nulo porque divergem
      vinculos: [
        { ...TRES_IGUAIS.vinculos[0], registration: "111111111" },
        { ...TRES_IGUAIS.vinculos[1], registration: "222222222" },
      ],
    };
    comBanco({ leitura: misto });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    expect(await screen.findByText(/matrícula 111111111/i)).toBeTruthy();
    expect(screen.getByText(/matrícula 222222222/i)).toBeTruthy();
    expect(screen.getByText(/2 matrículas diferentes/i)).toBeTruthy();
  });

  it("matrícula repetida não vira ruído linha a linha", async () => {
    comBanco({ leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    expect(screen.queryByText(/matrícula 990100004/i)?.tagName).not.toBe("SPAN");
    expect(screen.queryByText(/matrículas diferentes/i)).toBeNull();
  });

  it("mostra fonte e data da consulta", async () => {
    comBanco({ leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const fonte = await screen.findByText(/Fonte: Prime/i);
    expect(fonte.textContent).toMatch(/students_search/);
    expect(fonte.textContent).toMatch(/consultado em/i);
  });
});

describe("os estados que não podem se confundir", () => {
  it("ERRO DE LEITURA não é 'nunca consultado'", async () => {
    comBanco({ gestao: true, erroLeitura: "permission denied" });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    const msg = await screen.findByText(/Não foi possível ler as consultas já gravadas/i);
    expect(msg.textContent).toMatch(/permission denied/);
    expect(msg.textContent).toMatch(/não quer dizer que o aluno nunca tenha sido consultado/i);
    // e NÃO dispara consulta nova por cima de um dado que talvez exista
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByText(/Nenhuma consulta gravada/i)).toBeNull();
  });

  it("FALHA DE COMUNICAÇÃO não diz que o aluno não tem vínculo", async () => {
    comBanco({ leitura: { resultado: "FALHA_COMUNICACAO", detalhe_falha: "HTTP 500", consultado_em: "2026-09-28T23:45:00Z", vinculos: [] } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const msg = await screen.findByText(/Não foi possível falar com o Prime/i);
    expect(msg.textContent).toMatch(/HTTP 500/);
    expect(msg.textContent).toMatch(/não significa que o aluno não tenha vínculo/i);
    expect(screen.queryByText(/não retornou nenhum vínculo/i)).toBeNull();
  });

  it("SEM RESULTADO é texto próprio, diferente da falha", async () => {
    comBanco({ leitura: { resultado: "SEM_RESULTADO", consultado_em: "2026-09-28T23:45:00Z", vinculos: [] } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    const msg = await screen.findByText(/não retornou nenhum vínculo/i);
    expect(msg.textContent).toMatch(/Não é o mesmo que/i);
    expect(screen.queryByText(/Não foi possível falar com o Prime/i)).toBeNull();
    expect(screen.queryByText(/Correspondência com o curso/i)).toBeNull();
  });

  it("falha ao ATUALIZAR mantém a última consulta boa, com a data dela", async () => {
    comBanco({ gestao: true, leitura: TRES_IGUAIS });
    invoke.mockRejectedValue(new Error("network down"));
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar consulta/i })); });

    const aviso = await screen.findByText(/Não foi possível consultar agora/i);
    expect(aviso.textContent).toMatch(/network down/);
    expect(aviso.textContent).toMatch(/consulta anterior, abaixo, continua valendo/i);
    // o dado bom continua na tela, com a fonte e a data
    expect(screen.getByText("Reopção de Curso")).toBeTruthy();
    expect(screen.getAllByText("COMÉRCIO EXTERIOR")).toHaveLength(3);
    expect(screen.getByText(/Fonte: Prime/i).textContent).toMatch(/consultado em/i);
  });
});

describe("limites", () => {
  it("NUNCA escreve em alunos nem em nenhuma tabela", async () => {
    comBanco({ leitura: TRES_IGUAIS });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText("Reopção de Curso");
    expect(from).not.toHaveBeenCalled();
    for (const chamada of rpc.mock.calls) {
      expect(["usuario_e_gestao", "prime_academico_ultima"]).toContain(chamada[0]);
    }
  });

  it("sem aluno, não renderiza nem lê ficha nenhuma", () => {
    comBanco({ leitura: TRES_IGUAIS });
    const { container } = render(<SituacaoAcademicaPrime aluno={null} />);
    expect(container.textContent).toBe("");
    expect(invoke).not.toHaveBeenCalled();
    for (const chamada of rpc.mock.calls) expect(chamada[0]).toBe("usuario_e_gestao");
  });
});

describe("paginação incompleta e última consulta boa", () => {
  it("PAGINAÇÃO INCOMPLETA mostra os vínculos com a ressalva, não como lista completa", async () => {
    comBanco({ leitura: { ...TRES_IGUAIS, resultado: "PAGINACAO_INCOMPLETA",
      detalhe_falha: "paginacao interrompida no teto de 500 linhas -- a lista pode estar incompleta" } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    const aviso = await screen.findByText(/pode estar/i);
    expect(aviso.textContent).toMatch(/incompleta/i);
    expect(aviso.textContent).toMatch(/não há garantia de que sejam todos/i);
    // e os vínculos aparecem assim mesmo -- é dado de verdade
    expect(screen.getAllByText("COMÉRCIO EXTERIOR")).toHaveLength(3);
    expect(screen.getByText("Reopção de Curso")).toBeTruthy();
  });

  it("falha recente mostra a ÚLTIMA CONSULTA BOA vinda do banco, com a data dela", async () => {
    // Vem do banco (`ultima_boa`), não da memória da tela -- então sobrevive a
    // recarregar a página e a fechar e reabrir a ficha.
    comBanco({ leitura: {
      resultado: "FALHA_COMUNICACAO", detalhe_falha: "HTTP 503",
      consultado_em: "2026-09-29T10:00:00Z", vinculos: [],
      ultima_boa: { ...TRES_IGUAIS, consultado_em: "2026-09-28T23:45:00Z" },
    } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    expect(await screen.findByText(/Não foi possível falar com o Prime/i)).toBeTruthy();
    // o dado bom continua visível, identificado como a consulta anterior
    const titulo = screen.getByText(/Última consulta completa/i);
    expect(titulo.textContent).toMatch(/28\/09\/2026/);
    expect(screen.getAllByText("COMÉRCIO EXTERIOR")).toHaveLength(3);
    expect(screen.getByText("Cancelado")).toBeTruthy();
  });

  it("só falhas: não inventa consulta boa", async () => {
    comBanco({ leitura: {
      resultado: "FALHA_COMUNICACAO", detalhe_falha: "HTTP 503",
      consultado_em: "2026-09-29T10:00:00Z", vinculos: [], ultima_boa: null,
    } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText(/Não foi possível falar com o Prime/i);
    expect(screen.queryByText(/Última consulta completa/i)).toBeNull();
  });

  it("última boa que era SEM_RESULTADO diz isso, em vez de tabela vazia", async () => {
    comBanco({ leitura: {
      resultado: "FALHA_COMUNICACAO", detalhe_falha: "HTTP 503",
      consultado_em: "2026-09-29T10:00:00Z", vinculos: [],
      ultima_boa: { resultado: "SEM_RESULTADO", consultado_em: "2026-09-28T23:45:00Z", vinculos: [] },
    } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);
    await screen.findByText(/Última consulta completa/i);
    expect(screen.getByText(/Naquela consulta o Prime respondeu e não retornou nenhum vínculo/i)).toBeTruthy();
  });

  it("PARCIAL e COMPLETA aparecem SEPARADAS, sem misturar numa tabela só", async () => {
    // Os vínculos parciais e os da consulta completa são de momentos
    // diferentes. Juntá-los numa tabela faria parecer uma lista só.
    comBanco({ leitura: {
      resultado: "PAGINACAO_INCOMPLETA",
      detalhe_falha: "paginacao interrompida no teto de 500 linhas",
      consultado_em: "2026-09-29T10:00:00Z",
      vinculos: [{ linha_id: "p1", ordem: 1, registration: "990100009", curso: "DIREITO", campus: "CEULP", turno: "MANHA", status: "Trancado", graduated: false, admission_year: 2021 }],
      ultima_boa: { ...TRES_IGUAIS, consultado_em: "2026-09-28T23:45:00Z" },
    } });
    render(<SituacaoAcademicaPrime aluno={ALUNO} />);

    const aviso = await screen.findByText(/pode estar/i);
    expect(aviso.textContent).toMatch(/última consulta completa aparece separada/i);

    // duas tabelas, cada uma com sua contagem
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getByText(/^1 vínculo de curso$/)).toBeTruthy();   // a parcial
    expect(screen.getByText(/3 vínculos de curso/)).toBeTruthy();    // a completa

    // e a completa tem data própria, diferente da parcial
    const titulo = screen.getByText(/^Última consulta completa/i);
    expect(titulo.textContent).toMatch(/28\/09\/2026/);
    expect(screen.getByText("DIREITO")).toBeTruthy();
    expect(screen.getAllByText("COMÉRCIO EXTERIOR")).toHaveLength(3);
  });
});
