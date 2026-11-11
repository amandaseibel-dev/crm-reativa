// @vitest-environment jsdom
//
// Garantias desta tela:
// 1. não chama a Mensageria: nenhum `fetch`; só RPC do banco;
// 2. três filas na ordem certa, com motivo, tempo e os DOIS responsáveis separados;
// 3. "lida" e "acionamento posterior" são informação: a resposta continua na fila;
// 4. "Abrir ficha" só com vínculo confirmado; filtros vão na URL e a posição volta;
// 5. gestão filtra por operador (o pedido vai ao banco); operador não tem o seletor;
// 6. atualização manual, falha e coleta incompleta ficam visíveis e são distintas;
// 7. oferta, aceite e assumir aparecem como indisponíveis — nenhum botão ativo;
// 8. função ausente = "ainda não disponível", nunca fila vazia.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import CentralUlbra from "./CentralUlbra";

const rpc = vi.fn();
const fromMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpc(...a), from: (...a) => fromMock(...a) } }));

// Consulta da carteira falsa: registra os filtros e devolve as linhas dadas.
const DIA = 86400000;
function carteiraCom(linhas) {
  const b = {};
  for (const m of ["select", "eq", "not", "lte", "order"]) b[m] = () => b;
  b.range = () => Promise.resolve({ data: linhas, error: null });
  return b;
}
const ha = (d) => new Date(Date.now() - d * DIA).toISOString().slice(0, 10);
const CARTEIRA_OPERADOR = [
  { aluno_id: "al-1", nome: "Helena Dantas", data_ultimo_acionamento: ha(12), operador_email: "cobranca10@aelbra.com.br" },
  { aluno_id: "al-3", nome: "Bruno Leal", data_ultimo_acionamento: ha(9), operador_email: "cobranca10@aelbra.com.br" },
];

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fromMock.mockImplementation(() => carteiraCom(CARTEIRA_OPERADOR));
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(cleanup);

const GESTAO = { perfil: { email: "amanda.seibel@aelbra.com.br" } };
const OPERADOR = { perfil: { email: "cobranca10@aelbra.com.br" } };

function resposta(extra = {}) {
  return {
    ok: true, gerado_em: "2026-11-09T12:00:00Z", eh_gestao: false, operador: "cobranca10@aelbra.com.br", operadores: null,
    coleta: { estado: "MANUAL", atualizacao: "manual", ultima_execucao: "2026-11-08T21:23:00Z", ultimo_ciclo: "OK", ultimo_erro: null, atraso_min: 660 },
    limite: 100, pagina: 0,
    totais: { respostas: 2, sem_interacao: 2, novos: 1 },
    respostas: [
      { conversa_id: "c-antiga", aluno_id: "al-1", nome: "Helena Dantas", previa: "posso pagar na sexta?", mensagem_em: "2026-11-09T08:00:00Z",
        espera_min: 240, atendente_ulbra: "Olga Oliveira", responsavel_reativa: "cobranca10@aelbra.com.br",
        ultimo_acionamento: "2026-11-09", acionamento_posterior: true, lida: true },
      { conversa_id: "c-nova", aluno_id: null, nome: "Marina Ferraz", previa: "o valor veio diferente", mensagem_em: "2026-11-09T11:50:00Z",
        espera_min: 10, atendente_ulbra: null, responsavel_reativa: "cobranca10@aelbra.com.br",
        ultimo_acionamento: null, acionamento_posterior: false, lida: false },
    ],
    sem_interacao: [
      { aluno_id: "al-1", nome: "Helena Dantas", dias_sem_acionamento: 12, faixa: "PERDENDO", ultimo_acionamento: "2026-10-28",
        atendente_ulbra: "Olga Oliveira", responsavel_reativa: "cobranca10@aelbra.com.br", origem: "conversa" },
      { aluno_id: "al-3", nome: "Bruno Leal", dias_sem_acionamento: 9, faixa: "CRITICO", ultimo_acionamento: "2026-10-31",
        atendente_ulbra: null, responsavel_reativa: "cobranca10@aelbra.com.br", origem: "atendimento" },
    ],
    novos: [
      { atendimento_id: "x-1", aluno_id: "al-4", nome: "Rodrigo Pessoa", entrou_em: "2026-11-09T11:30:00Z", espera_min: 30,
        destino_motivo: "RODIZIO", destino_email: "cobranca10@aelbra.com.br" },
    ],
    ...extra,
  };
}

function Onde() {
  const l = useLocation();
  return <div data-testid="onde">{l.pathname}{l.search}</div>;
}

function montar(usuario = OPERADOR, entrada = "/central-ulbra") {
  return render(
    <MemoryRouter initialEntries={[entrada]}>
      <Routes>
        <Route path="/central-ulbra" element={<><CentralUlbra usuario={usuario} /><Onde /></>} />
        <Route path="/aluno" element={<Onde />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CentralUlbra", () => {
  it("lê só a RPC do banco, com limite e página, e nunca a Mensageria", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    await screen.findByTestId("central-ulbra");
    expect(rpc).toHaveBeenCalledWith("ulbra_central_operador", { p_operador: null, p_limite: 100, p_pagina: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mostra as três filas na ordem, com a mais antiga primeiro como o banco mandou", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    await screen.findByTestId("central-ulbra");
    const filas = ["fila-respostas", "fila-sem-interacao", "fila-novos"].map((t) => screen.getByTestId(t));
    expect(filas[0].compareDocumentPosition(filas[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filas[1].compareDocumentPosition(filas[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const linhas = filas[0].querySelectorAll('[data-linha="resposta"]');
    expect(linhas[0].textContent).toMatch(/Helena Dantas/);
    expect(linhas[1].textContent).toMatch(/Marina Ferraz/);
  });

  it("cada linha traz motivo, tempo e os dois responsáveis em campos separados", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const fila = await screen.findByTestId("fila-respostas");
    const linha = fila.querySelector('[data-linha="resposta"]');
    expect(linha.textContent).toMatch(/resposta do aluno sem retorno na Mensageria/);
    expect(linha.textContent).toMatch(/aguardando há 4 h 00 min/);
    expect(linha.querySelector('[data-campo="responsavel-reativa"]').textContent).toBe("responsável no ReATIVA: cobranca10");
    expect(linha.querySelector('[data-campo="atendente-mensageria"]').textContent).toBe("atendente na Mensageria: Olga Oliveira");

    const sem = screen.getByTestId("fila-sem-interacao").querySelector('[data-linha="sem-interacao"]');
    expect(sem.textContent).toMatch(/perdendo o caso/);
    expect(sem.textContent).toMatch(/12 dias sem acionamento/);

    const novo = screen.getByTestId("fila-novos").querySelector('[data-linha="novo"]');
    expect(novo.textContent).toMatch(/novo — rodízio do receptivo/);
    expect(novo.textContent).toMatch(/em espera há 30 min/);
    // sem dado, o campo diz que não há — não copia de um sistema para o outro
    expect(novo.querySelector('[data-campo="responsavel-reativa"]').textContent).toBe("responsável no ReATIVA: ninguém");
    expect(novo.querySelector('[data-campo="atendente-mensageria"]').textContent).toBe("atendente na Mensageria: não informado");
  });

  it("resposta lida e com acionamento posterior CONTINUA na fila, dita como informação", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const fila = await screen.findByTestId("fila-respostas");
    const linha = fila.querySelector('[data-linha="resposta"]');
    expect(linha.textContent).toMatch(/acionamento no ReATIVA em 09\/11\/2026 — não comprova resposta à mensagem/);
    expect(linha.textContent).toMatch(/você marcou como lida — segue aguardando resposta/);
    // já lida: não oferece marcar de novo; a outra oferece
    expect(within(linha).queryByText("marcar como lida")).toBeNull();
    expect(within(fila.querySelectorAll('[data-linha="resposta"]')[1]).getByText("marcar como lida")).toBeTruthy();
  });

  it("marcar como lida chama a RPC de leitura e avisa que a linha continua na fila", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const fila = await screen.findByTestId("fila-respostas");
    fireEvent.click(within(fila).getByText("marcar como lida"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("ulbra_conversa_marcar_lida", { p_id: "c-nova" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringMatching(/continua na fila/));
  });

  it("Abrir ficha só existe com vínculo confirmado", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const fila = await screen.findByTestId("fila-respostas");
    const [comVinculo, semVinculo] = fila.querySelectorAll('[data-linha="resposta"]');
    expect(within(comVinculo).getByText("Abrir ficha").getAttribute("href")).toBe("/aluno?alunoId=al-1&origem=ulbra");
    expect(within(semVinculo).queryByText("Abrir ficha")).toBeNull();
    expect(semVinculo.textContent).toMatch(/sem vínculo confirmado por CPF/);
  });

  it("abrir a ficha guarda filtros e posição; voltar com os mesmos filtros os recupera", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const rolar = vi.fn();
    vi.stubGlobal("scrollTo", rolar);
    Object.defineProperty(window, "scrollY", { value: 420, configurable: true });
    const { unmount } = montar(OPERADOR, "/central-ulbra?faixa=CRITICO");
    const fila = await screen.findByTestId("fila-sem-interacao");
    fireEvent.click(within(fila).getByText("Abrir ficha"));
    expect(screen.getByTestId("onde").textContent).toBe("/aluno?alunoId=al-3&origem=ulbra");
    expect(JSON.parse(sessionStorage.getItem("rv_central_ulbra_posicao"))).toEqual({ busca: "?faixa=CRITICO", rolagem: 420, paginas: 1 });
    unmount();

    window.history.replaceState(null, "", "/central-ulbra?faixa=CRITICO");
    montar(OPERADOR, "/central-ulbra?faixa=CRITICO");
    await screen.findByTestId("central-ulbra");
    expect(screen.getByLabelText("Faixa de prazo").value).toBe("CRITICO");
    await waitFor(() => expect(rolar).toHaveBeenCalledWith(0, 420));
    window.history.replaceState(null, "", "/");
  });

  it("filtro de faixa vai para a URL e recorta só a fila de sem interação", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    await screen.findByTestId("central-ulbra");
    fireEvent.change(screen.getByLabelText("Faixa de prazo"), { target: { value: "CRITICO" } });
    await waitFor(() => expect(screen.getByTestId("onde").textContent).toBe("/central-ulbra?faixa=CRITICO"));
    const linhas = screen.getByTestId("fila-sem-interacao").querySelectorAll('[data-linha="sem-interacao"]');
    expect(linhas).toHaveLength(1);
    expect(linhas[0].textContent).toMatch(/Bruno Leal/);
    expect(screen.getByTestId("fila-respostas").querySelectorAll('[data-linha="resposta"]')).toHaveLength(2);
  });

  it("operador não tem seletor de operador e vê o próprio recorte", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    await screen.findByTestId("central-ulbra");
    expect(screen.queryByLabelText("Operador")).toBeNull();
    expect(screen.getByTestId("recorte").textContent).toBe("sua fila · cobranca10");
  });

  it("gestão filtra por operador e o pedido vai ao banco", async () => {
    const gestao = resposta({ eh_gestao: true, operador: null, operadores: ["cobranca05@aelbra.com.br", "cobranca10@aelbra.com.br"] });
    rpc.mockResolvedValue({ data: gestao, error: null });
    montar(GESTAO);
    await screen.findByTestId("central-ulbra");
    expect(screen.getByTestId("recorte").textContent).toBe("todas as carteiras");
    fireEvent.change(screen.getByLabelText("Operador"), { target: { value: "cobranca05@aelbra.com.br" } });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("ulbra_central_operador", { p_operador: "cobranca05@aelbra.com.br", p_limite: 100, p_pagina: 0 }),
    );
    expect(screen.getByTestId("onde").textContent).toBe("/central-ulbra?operador=cobranca05%40aelbra.com.br");
  });

  it("atualização manual mostra a data da última coleta, sem tom de alerta", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const faixa = await screen.findByTestId("faixa-coleta");
    expect(faixa.getAttribute("data-estado")).toBe("MANUAL");
    expect(faixa.textContent).toMatch(/Atualização manual · Última coleta em \d{2}\/\d{2}/);
    expect(faixa.className).toMatch(/ulbra-aviso--cinza/);
    expect(screen.queryByTestId("coleta-detalhe")).toBeNull();
  });

  it("falha e coleta incompleta ficam visíveis e são diferentes de manual", async () => {
    rpc.mockResolvedValue({ data: resposta({ coleta: { estado: "FALHA", ultima_execucao: "2026-11-09T11:00:00Z", ultimo_ciclo: "FALHOU", ultimo_erro: "HTTP_500", atraso_min: 60 } }), error: null });
    montar();
    const faixa = await screen.findByTestId("faixa-coleta");
    expect(faixa.textContent).toMatch(/Falha na última coleta · HTTP_500/);
    expect(faixa.className).toMatch(/ulbra-aviso--vermelho/);
    cleanup();

    rpc.mockResolvedValue({ data: resposta({ coleta: { estado: "MANUAL", ultima_execucao: "2026-11-08T21:23:00Z", ultimo_ciclo: "INCOMPLETO", ultimo_erro: "BACKLOG_OU_ORCAMENTO", atraso_min: 660 } }), error: null });
    montar();
    expect((await screen.findByTestId("coleta-detalhe")).textContent).toMatch(/ficou incompleta \(BACKLOG_OU_ORCAMENTO\)/);
    expect(screen.getByTestId("faixa-coleta").className).toMatch(/ulbra-aviso--ambar/);
  });

  it("oferta, aceite e assumir aparecem como indisponíveis, sem botão ativo", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const bloco = await screen.findByTestId("oferta-indisponivel");
    expect(bloco.textContent).toMatch(/indisponível nesta etapa/);
    expect(bloco.textContent).toMatch(/Aceitar e abrir ficha/);
    expect(bloco.querySelector("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /aceitar|assumir|recusar/i })).toBeNull();
    expect(screen.getByTestId("fila-novos").textContent).toMatch(/assumir — indisponível nesta etapa/);
  });

  it("carrega a página seguinte quando o banco tem mais linhas, sem repetir", async () => {
    const p0 = resposta({ totais: { respostas: 3, sem_interacao: 2, novos: 1 } });
    const p1 = resposta({ pagina: 1, totais: { respostas: 3, sem_interacao: 2, novos: 1 },
      respostas: [{ conversa_id: "c-nova" }, { conversa_id: "c-3", aluno_id: "al-9", nome: "Sofia Prado", previa: "oi", mensagem_em: "2026-11-09T11:55:00Z", espera_min: 5, lida: false }],
      sem_interacao: [], novos: [] });
    rpc.mockImplementation((nome, args) => Promise.resolve({ data: args?.p_pagina === 1 ? p1 : p0, error: null }));
    montar();
    await screen.findByTestId("central-ulbra");
    expect(screen.getByTestId("fila-respostas").querySelectorAll('[data-linha="resposta"]')).toHaveLength(2);
    fireEvent.click(screen.getByText("Carregar mais"));
    await waitFor(() => expect(screen.getByTestId("fila-respostas").querySelectorAll('[data-linha="resposta"]')).toHaveLength(3));
    expect(rpc).toHaveBeenCalledWith("ulbra_central_operador", { p_operador: null, p_limite: 100, p_pagina: 1 });
    expect(screen.queryByText("Carregar mais")).toBeNull();
  });

  it("função ausente no banco: diz que não está disponível, não mostra fila vazia", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.ulbra_central_operador" } });
    montar();
    const aviso = await screen.findByTestId("central-indisponivel");
    expect(aviso.textContent).toMatch(/ainda não está disponível/);
    expect(aviso.textContent).toMatch(/não significa fila vazia/);
    expect(screen.queryByTestId("fila-respostas")).toBeNull();
  });

  it("acesso negado pelo banco não mostra número nenhum", async () => {
    rpc.mockResolvedValue({ data: { ok: false, motivo: "ACESSO_NEGADO" }, error: null });
    montar();
    expect(await screen.findByText("Você não tem acesso à Central ULBRA.")).toBeTruthy();
    expect(screen.queryByTestId("cartoes")).toBeNull();
  });

  it("erro de leitura oferece tentar de novo", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "timeout" } });
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    fireEvent.click(await screen.findByText("Tentar de novo"));
    expect(await screen.findByTestId("central-ulbra")).toBeTruthy();
  });
});

describe("CentralUlbra: divergência de casos", () => {
  it("atendimento a definir aparece sinalizado e sem aviso, nunca como de um operador", async () => {
    const d = resposta({
      respostas: [
        { conversa_id: "c-def", aluno_id: "al-9", nome: "Aluno com dois casos", previa: "oi", mensagem_em: "2026-11-09T10:00:00Z",
          espera_min: 120, atendente_ulbra: null, responsavel_reativa: null, ultimo_acionamento: "2026-11-05",
          acionamento_posterior: false, lida: false, responsabilidade: "A_DEFINIR", notificar: false, minha: false,
          responsavel_e_outro: false, divergencia: true, responsavel_definido: false },
      ],
      sem_interacao: [], novos: [],
      totais: { respostas: 1, sem_interacao: 0, novos: 0, respostas_a_definir: 1, novos_a_definir: 0 },
    });
    rpc.mockResolvedValue({ data: d, error: null });
    montar();
    const linha = (await screen.findByTestId("fila-respostas")).querySelector('[data-linha="resposta"]');
    expect(linha.textContent).toMatch(/Responsabilidade a definir pela gestão/);
    expect(linha.textContent).toMatch(/este aluno tem casos de mais de um operador/);
    expect(linha.textContent).toMatch(/responsável no ReATIVA: a definir/);
    expect(linha.textContent).not.toMatch(/aviso para você/);
    expect(linha.querySelector('[data-campo="responsavel-reativa"]').textContent).not.toMatch(/cobranca/);
  });

  it("responsável comprovado vê o aviso; outro operador vê que há responsável, sem nome", async () => {
    const d = resposta({
      respostas: [
        { conversa_id: "c-mine", aluno_id: "al-1", nome: "Minha", previa: "oi", mensagem_em: "2026-11-09T09:00:00Z",
          espera_min: 60, atendente_ulbra: null, responsavel_reativa: "cobranca10@aelbra.com.br", ultimo_acionamento: null,
          acionamento_posterior: false, lida: false, responsabilidade: "CARTEIRA", notificar: true, minha: true,
          responsavel_e_outro: false, divergencia: false, responsavel_definido: true },
        { conversa_id: "c-outro", aluno_id: "al-2", nome: "Dele", previa: "oi", mensagem_em: "2026-11-09T09:30:00Z",
          espera_min: 30, atendente_ulbra: null, responsavel_reativa: null, ultimo_acionamento: null,
          acionamento_posterior: false, lida: false, responsabilidade: "ASSUMIDO", notificar: false, minha: false,
          responsavel_e_outro: true, divergencia: true, responsavel_definido: true },
      ],
      sem_interacao: [], novos: [],
      totais: { respostas: 2, sem_interacao: 0, novos: 0, respostas_a_definir: 0, novos_a_definir: 0 },
    });
    rpc.mockResolvedValue({ data: d, error: null });
    montar();
    const linhas = (await screen.findByTestId("fila-respostas")).querySelectorAll('[data-linha="resposta"]');
    expect(linhas[0].textContent).toMatch(/aviso para você/);
    expect(linhas[0].textContent).toMatch(/responsabilidade sua/);
    expect(linhas[1].textContent).toMatch(/responsável: outro operador/);
    expect(linhas[1].textContent).toMatch(/você pode ver este atendimento, mas não responde por ele/);
    expect(linhas[1].textContent).not.toMatch(/aviso para você/);
    expect(linhas[1].querySelector('[data-campo="responsavel-reativa"]').textContent).toBe("responsável no ReATIVA: ninguém");
  });

  it("data de acionamento aparece como data pura, sem hora", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar();
    const fila = await screen.findByTestId("fila-sem-interacao");
    expect(fila.textContent).toMatch(/último: 28\/10\/2026/);
    expect(fila.textContent).not.toMatch(/28\/10\/2026, \d{2}:\d{2}/);
  });
});

describe("visão de conversas", () => {
  it("?visao=conversas mostra as duas colunas no lugar das filas, na ordem de prioridade", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar(OPERADOR, "/central-ulbra?visao=conversas");
    const visao = await screen.findByTestId("visao-conversas");
    expect(screen.queryByTestId("fila-respostas")).toBeNull();
    const tipos = Array.from(visao.querySelectorAll(".ulbra-conv-item")).map((b) => b.getAttribute("data-linha"));
    expect(tipos).toEqual(["resposta", "resposta", "sem_interacao", "sem_interacao", "novo"]);
  });

  it("selecionar uma conversa vai para a URL; abrir a ficha e voltar mantém a conversa e a visão", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const rolar = vi.fn();
    vi.stubGlobal("scrollTo", rolar);
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    const { unmount } = montar(OPERADOR, "/central-ulbra?visao=conversas");
    const visao = await screen.findByTestId("visao-conversas");
    fireEvent.click(visao.querySelectorAll(".ulbra-conv-item")[3]);
    await waitFor(() => expect(screen.getByTestId("onde").textContent).toBe("/central-ulbra?visao=conversas&conv=s%3Aal-3"));
    fireEvent.click(screen.getByText("Abrir ficha"));
    expect(screen.getByTestId("onde").textContent).toBe("/aluno?alunoId=al-3&origem=ulbra");
    expect(JSON.parse(sessionStorage.getItem("rv_central_ulbra_posicao")).busca).toBe("?visao=conversas&conv=s%3Aal-3");
    unmount();

    window.history.replaceState(null, "", "/central-ulbra?visao=conversas&conv=s%3Aal-3");
    montar(OPERADOR, "/central-ulbra?visao=conversas&conv=s%3Aal-3");
    const de_volta = await screen.findByTestId("visao-conversas");
    const ativo = de_volta.querySelector('[aria-current="true"]');
    expect(ativo.textContent).toMatch(/Bruno Leal/);
    await waitFor(() => expect(rolar).toHaveBeenCalledWith(0, 300));
    window.history.replaceState(null, "", "/");
  });

  it("a visão de cartões continua a padrão quando não há parâmetro", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar(OPERADOR, "/central-ulbra");
    await screen.findByTestId("fila-respostas");
    expect(screen.queryByTestId("visao-conversas")).toBeNull();
  });
});

describe("fila da carteira na visão de conversas (servidor)", () => {
  it("consulta a tabela casos com o próprio operador e corte de 8 dias, no servidor", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    montar(OPERADOR, "/central-ulbra?visao=conversas");
    await screen.findByTestId("visao-conversas");
    await waitFor(() => expect(fromMock).toHaveBeenCalledWith("casos"));
  });

  it("caso interno sem vínculo ULBRA aparece na fila da carteira", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    fromMock.mockImplementation(() => carteiraCom([{ aluno_id: "sem-vinculo", nome: "Sem Vínculo Mensageria", data_ultimo_acionamento: ha(20), operador_email: "cobranca10@aelbra.com.br" }]));
    montar(OPERADOR, "/central-ulbra?visao=conversas");
    const visao = await screen.findByTestId("visao-conversas");
    await waitFor(() => expect(visao.textContent).toMatch(/Sem Vínculo Mensageria/));
  });

  it("erro da carteira aparece como erro, não como fila vazia", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    fromMock.mockImplementation(() => {
      const b = carteiraCom([]);
      b.range = () => Promise.resolve({ data: null, error: { message: "permission denied" } });
      return b;
    });
    montar(OPERADOR, "/central-ulbra?visao=conversas");
    expect(await screen.findByText(/Não foi possível ler a carteira: permission denied/)).toBeTruthy();
  });

  it("gestão sem operador escolhido recebe a fila de TODAS as carteiras, com o operador em cada linha", async () => {
    rpc.mockResolvedValue({ data: resposta({ eh_gestao: true, operador: null, operadores: ["cobranca10@aelbra.com.br"] }), error: null });
    const nots = [];
    fromMock.mockImplementation(() => {
      const b = carteiraCom([
        ...CARTEIRA_OPERADOR,
        { aluno_id: "al-9", nome: "Caio Prado", data_ultimo_acionamento: ha(30), operador_email: "cobranca05@aelbra.com.br" },
      ]);
      b.not = (...a) => { nots.push(a); return b; };
      return b;
    });
    montar(GESTAO, "/central-ulbra?visao=conversas");
    const visao = await screen.findByTestId("visao-conversas");
    expect(await screen.findByTestId("aviso-todas-carteiras")).toBeTruthy();
    await waitFor(() => expect(visao.textContent).toMatch(/Caio Prado/));
    expect(visao.textContent).toMatch(/Helena Dantas/);
    expect(nots).toContainEqual(["operador_email", "is", null]);
    expect(screen.queryByText(/Escolha um operador no filtro para ver a fila da carteira\./)).toBeNull();
  });
});

describe("recorte da carteira não muda pelo filtro nem pela URL", () => {
  it("operador com ?operador=outro na URL continua consultando só a PRÓPRIA carteira", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const eqs = [];
    fromMock.mockImplementation(() => {
      const b = {};
      for (const m of ["select", "not", "lte", "order"]) b[m] = () => b;
      b.eq = (...a) => (eqs.push(a), b);
      b.range = () => Promise.resolve({ data: CARTEIRA_OPERADOR, error: null });
      return b;
    });
    montar(OPERADOR, "/central-ulbra?visao=conversas&operador=cobranca05%40aelbra.com.br");
    await screen.findByTestId("visao-conversas");
    await waitFor(() => expect(eqs.length).toBeGreaterThan(0));
    expect(eqs.every(([campo, valor]) => campo === "operador_email" && valor === "cobranca10@aelbra.com.br")).toBe(true);
    expect(eqs.some(([, valor]) => valor === "cobranca05@aelbra.com.br")).toBe(false);
  });
});
