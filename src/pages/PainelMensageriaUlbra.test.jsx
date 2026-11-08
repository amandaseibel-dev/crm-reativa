// @vitest-environment jsdom
//
// Garantias desta tela, em ordem de importância:
// 1. NÃO chama a Mensageria: nenhum `fetch` sai daqui; só uma RPC do banco;
// 2. indicador sem dado aparece como "não disponível", nunca zero/estimativa;
// 3. zero, desatualizado, erro e coleta incompleta são estados DIFERENTES;
// 4. sem cron, diz "atualização manual" e não sugere sincronização automática;
// 5. quem não é gestão não vê número nenhum; função ausente = "não disponível".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import PainelMensageriaUlbra from "./PainelMensageriaUlbra";
import { descreverEstado, fmtMin, ND } from "../utils/ulbraPainel";

const rpc = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpc(...a) } }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(cleanup);

const GESTAO = { perfil: { email: "amanda.seibel@aelbra.com.br" } };

function resposta(extra = {}) {
  return {
    ok: true,
    gerado_em: "2026-11-09T12:00:00Z",
    atualizacao: "manual",
    estado: "INCOMPLETO",
    sync: {
      ultima_execucao: "2026-11-09T11:57:00Z", atraso_min: 3, ultimo_ciclo: "INCOMPLETO",
      ultimo_erro: "BACKLOG_OU_ORCAMENTO", chamadas_dia: 7, detalhe_fila_tamanho: 5,
      detalhes_pendencias_abertas: 0, cursor_mensagem: null, piso_pendente: "2026-11-08T21:51:00Z",
      saldo_api_restam: 462, saldo_api_em: "2026-11-08T21:23:50Z",
    },
    conversas: { total: 7, por_canal: { whatsapp: 7 }, por_situacao: { active: 7 }, identidade_confirmada: 0,
      identidade_nao_confirmada: 7, resposta_aguardando: 2, nao_lidas_para_mim: 2,
      resposta_mais_antiga_em: "2026-11-08T05:00:00Z", espera_resposta_max_min: 1860,
      com_atendente_ulbra: 0, sem_atendente_ulbra: 7, por_atendente_ulbra: {} },
    atendimentos: { coletados: 7, sem_responsavel_reativa: 7, com_responsavel_reativa: 0, por_responsavel_reativa: {},
      atendente_ulbra: null, em_conferencia: 7, sem_operador: 0,
      por_situacao: { waiting: 7 }, por_destino_sugerido: { CONFERENCIA: 7 },
      por_canal: null, divergencia_carteira_ulbra: null },
    espera: { base: "entrou_em (entrada em espera na Mensageria, informada pela ULBRA)",
      universo: "atendimentos sem responsavel NO REATIVA (ninguem assumiu aqui); nao diz nada sobre atendente na ULBRA", n: 7, sem_data: 0,
      max_min: 1700, mediana_min: 900, acima_30_min: 7 },
    cobertura: { equipe: "Reativa", canais_coletados: ["whatsapp"], situacoes_coletadas: ["active"],
      periodo: { conversas_de: "2026-11-07T21:51:00Z", conversas_ate: "2026-11-08T20:24:00Z",
        atendimentos_de: "2026-11-07T16:28:00Z", atendimentos_ate: "2026-11-08T05:05:00Z",
        primeira_coleta: "2026-11-08T21:23:52Z", ultima_coleta: "2026-11-09T11:57:00Z" },
      alcance_paginas: null },
    ...extra,
  };
}

describe("PainelMensageriaUlbra", () => {
  it("lê só a RPC do banco e nunca chama a Mensageria", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Coleta incompleta/);
    expect(rpc).toHaveBeenCalledWith("ulbra_painel_gestao");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confiabilidade vem antes dos números: último ciclo, atraso, resultado, backlog e pendências", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Coleta incompleta há 3 min/);
    const bloco = container.querySelector('[data-testid="bloco-estado"]');
    expect(bloco.getAttribute("data-estado")).toBe("INCOMPLETO");
    expect(bloco.textContent).toMatch(/INCOMPLETO · BACKLOG_OU_ORCAMENTO/);
    expect(bloco.textContent).toMatch(/backlog \(fila de detalhes\)5/);
    expect(bloco.textContent).toMatch(/pendências abertas0/);
    expect(bloco.textContent).toMatch(/não avançou/);
    // o bloco de estado precede os indicadores no DOM
    const tiles = container.querySelector("section.grid");
    expect(bloco.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("saldo é fotografia com hora, não saldo final", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    expect(await screen.findByText(/462 de 500 — fotografia de .*não saldo final/)).toBeTruthy();
  });

  it("'não disponível' para canal de atendimento, alcance e divergência — nunca zero", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Coleta incompleta/);
    const t = container.textContent;
    expect(t).toMatch(/atendimentos por canal.*não disponível/);
    expect(t).toMatch(/alcance do último ciclo \(páginas\).*não disponível/);
    expect(t).toMatch(/divergência carteira ReATIVA × atendente ULBRA: não disponível/);
    expect(t).toMatch(/não se calcula por nome/);
  });

  it("sem cron: 'atualização manual', sem sugerir sincronização automática ativa", async () => {
    rpc.mockResolvedValue({ data: resposta({ atualizacao: "manual" }), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    expect(await screen.findByText(/atualização manual — sem sincronização automática ativa/)).toBeTruthy();
    expect(screen.queryByText(/^sincronização automática ativa$/)).toBeNull();
  });

  it("tempo de espera declara a base: entrou_em, não a hora da coleta", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Coleta incompleta/);
    expect(screen.getByText(/entrou_em \(entrada em espera na Mensageria/)).toBeTruthy();
    expect(screen.getByText(/Não é a hora da coleta/)).toBeTruthy();
  });

  it("cobertura: equipe, canais ativos, situação e período — e-mail marcado como não ativo", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Coleta incompleta/);
    const cob = container.querySelector('[data-testid="cobertura"]').textContent;
    expect(cob).toMatch(/não "o total da Mensageria"/);
    expect(cob).toMatch(/equipeReativa/);
    expect(cob).toMatch(/WhatsApp \(e-mail: não ativo\)/);
    expect(cob).toMatch(/situações coletadasactive/);
    expect(cob).toMatch(/período das conversas/);
  });

  it("responsável NO REATIVA e atendente NA MENSAGERIA são campos distintos; vazio local não prova nada da ULBRA", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Coleta incompleta/);
    const t = container.textContent;
    expect(t).toMatch(/sem responsável NO REATIVA \(ninguém assumiu aqui\)/);
    expect(t).toMatch(/atendimentos sem atendente NA MENSAGERIA/);
    expect(t).toMatch(/atendimentos — atendente ULBRAnão disponível \(o espelho de atendimentos não guarda esse campo\)/);
    expect(t).toMatch(/"Sem responsável no ReATIVA" não prova nada sobre o atendente na ULBRA/);
    expect(t).toMatch(/nenhum atendimento assumido no ReATIVA — zero de verdade/);
    expect(t).toMatch(/destino sugerido \(não é posse\): CONFERENCIA: 7/);
    expect(t).toMatch(/conversas sem atendente ULBRA7/);
  });

  it("estados: sem ciclo, erro, pulado por orçamento, desatualizado, incompleto, em dia e coleta concluída são textos diferentes", () => {
    const base = resposta();
    expect(descreverEstado({ ...base, estado: "SEM_CICLO" }).titulo).toMatch(/Nenhum ciclo/);
    expect(descreverEstado({ ...base, estado: "ERRO", sync: { ...base.sync, ultimo_erro: "ULBRA_HTTP_502" } }).texto).toMatch(/ULBRA_HTTP_502/);
    expect(descreverEstado({ ...base, estado: "DESATUALIZADO", sync: { ...base.sync, atraso_min: 49 } }).titulo).toMatch(/desatualizados: 49 min/);
    expect(descreverEstado({ ...base, estado: "EM_DIA" }).tom).toBe("verde");
    expect(descreverEstado({ ...base, estado: "INCOMPLETO" }).tom).toBe("ambar");
    const pulado = descreverEstado({ ...base, estado: "PULADO_ORCAMENTO", sync: { ...base.sync, ultimo_erro: "ORCAMENTO_DO_DIA" } });
    expect(pulado.tom).toBe("vermelho");
    expect(pulado.titulo).toMatch(/PULADO por orçamento/);
    expect(pulado.texto).toMatch(/NÃO é atualizado/);
    const concluida = descreverEstado({ ...base, estado: "COLETA_CONCLUIDA" });
    expect(concluida.titulo).toMatch(/Última coleta concluída em \d{2}\/\d{2}, \d{2}:\d{2}/); // sempre com data e hora
    expect(concluida.texto).toMatch(/Atualização manual/);
    expect(concluida.titulo).not.toMatch(/em dia/i);
  });

  it("COLETA_CONCLUIDA na tela: data e hora no título, e rótulo de atualização manual", async () => {
    rpc.mockResolvedValue({ data: resposta({ estado: "COLETA_CONCLUIDA", sync: { ...resposta().sync, ultimo_ciclo: "OK", ultimo_erro: null } }), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    expect(await screen.findByText(/Última coleta concluída em \d{2}\/\d{2}, \d{2}:\d{2}/)).toBeTruthy();
    expect(screen.getByText(/atualização manual — sem sincronização automática ativa/)).toBeTruthy();
  });

  it("PULADO_ORCAMENTO na tela: vermelho, e nunca lido como atualizado", async () => {
    rpc.mockResolvedValue({ data: resposta({ estado: "PULADO_ORCAMENTO", sync: { ...resposta().sync, ultimo_ciclo: "PULADO_ORCAMENTO", ultimo_erro: "ORCAMENTO_DO_DIA" } }), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/PULADO por orçamento/);
    const bloco = container.querySelector('[data-testid="bloco-estado"]');
    expect(bloco.getAttribute("data-estado")).toBe("PULADO_ORCAMENTO");
    expect(bloco.className).toMatch(/red/);
    expect(bloco.textContent).toMatch(/isto NÃO é atualizado/);
  });

  it("quem não é gestão não vê número nenhum", async () => {
    rpc.mockResolvedValue({ data: { ok: false, motivo: "ACESSO_NEGADO" }, error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={{ perfil: { email: "op1@x" } }} />);
    await screen.findByText(/restrita à gestão/);
    expect(container.textContent).not.toMatch(/sem responsável NO REATIVA/);
  });

  it("função ausente (migration não aplicada) = painel não disponível, sem número no lugar", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function public.ulbra_painel_gestao() does not exist" } });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Painel não disponível/);
    expect(container.textContent).not.toMatch(/\b0\b/);
  });

  it("erro de leitura mostra erro e botão de tentar de novo, sem número no lugar", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "statement timeout" } })
       .mockResolvedValueOnce({ data: resposta(), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByText(/Erro ao ler o painel/);
    fireEvent.click(screen.getByText(/tentar de novo/));
    await waitFor(() => expect(screen.queryByText(/Coleta incompleta/)).toBeTruthy());
  });

  it("formata minutos sem inventar: nulo é 'não disponível'", () => {
    expect(fmtMin(null)).toBe(ND);
    expect(fmtMin(undefined)).toBe(ND);
    expect(fmtMin(0)).toBe("0 min");
    expect(fmtMin(125)).toBe("2 h 05 min");
  });
});
