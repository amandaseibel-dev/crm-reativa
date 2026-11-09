// @vitest-environment jsdom
//
// Garantias desta tela, em ordem de importância:
// 1. NÃO chama a Mensageria: nenhum `fetch` sai daqui; só uma RPC do banco;
// 2. indicador sem dado aparece como "não disponível", nunca zero/estimativa;
// 3. zero, desatualizado, erro e coleta incompleta são estados DIFERENTES;
// 4. sem cron, diz "atualização manual" e não sugere sincronização automática;
// 5. quem não é gestão não vê número nenhum; função ausente = "não disponível";
// 6. a porta do menu/rota é a MESMA lista de usuario_e_gestao() no banco;
// 7. "Pendências de conferência" não mostra espera: o agregado é de outro universo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import PainelMensageriaUlbra from "./PainelMensageriaUlbra";
import { descreverEstado, fmtMin, ND, podeVerCrmUlbra, EMAILS_GESTAO_CRM_ULBRA } from "../utils/ulbraPainel";

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

describe("PainelMensageriaUlbra (CRM ULBRA)", () => {
  it("lê só a RPC do banco e nunca chama a Mensageria", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    expect(rpc).toHaveBeenCalledWith("ulbra_painel_gestao");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("'Atualizar painel' relê o banco (segunda chamada à RPC), sem fetch", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    fireEvent.click(screen.getByText("Atualizar painel"));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Não consulta a ULBRA/)).toBeTruthy();
  });

  it("faixa do cabeçalho: manual/automática pelo estado real, data e hora da última coleta, rótulo do estado", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const faixa = container.querySelector('[data-testid="faixa-estado"]');
    expect(faixa.getAttribute("data-atualizacao")).toBe("manual");
    expect(faixa.textContent).toMatch(/^Atualização manual • última coleta em \d{2}\/\d{2}, \d{2}:\d{2} • coleta parcial$/);
    expect(container.textContent).not.toMatch(/Atualização automática/);
  });

  it("falha/incompleto: aviso resumido FORA dos detalhes; coleta concluída: sem aviso", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const r1 = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const aviso = r1.container.querySelector('[data-testid="aviso-estado"]');
    expect(aviso).toBeTruthy();
    expect(aviso.textContent).toMatch(/Coleta incompleta há 3 min/);
    expect(aviso.closest("details")).toBeNull();
    cleanup();
    rpc.mockResolvedValue({ data: resposta({ estado: "COLETA_CONCLUIDA", sync: { ...resposta().sync, ultimo_ciclo: "OK", ultimo_erro: null } }), error: null });
    const r2 = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    expect(r2.container.querySelector('[data-testid="aviso-estado"]')).toBeNull();
    expect(r2.container.querySelector('[data-testid="faixa-estado"]').textContent).toMatch(/última coleta concluída/);
  });

  it("PULADO_ORCAMENTO: aviso vermelho e nunca lido como atualizado", async () => {
    rpc.mockResolvedValue({ data: resposta({ estado: "PULADO_ORCAMENTO", sync: { ...resposta().sync, ultimo_ciclo: "PULADO_ORCAMENTO", ultimo_erro: "ORCAMENTO_DO_DIA" } }), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const aviso = container.querySelector('[data-testid="aviso-estado"]');
    expect(aviso.getAttribute("data-estado")).toBe("PULADO_ORCAMENTO");
    expect(aviso.className).toMatch(/ulbra-aviso--vermelho/);
    expect(aviso.textContent).toMatch(/isto NÃO é atualizado/);
    expect(container.querySelector('[data-testid="faixa-estado"]').textContent).toMatch(/sem orçamento/);
  });

  it("quatro cartões, nesta ordem, com unidade explícita; e uma nota de espelho, não total", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const cartoes = container.querySelectorAll('[data-testid="cartoes"] > div');
    expect(cartoes.length).toBe(4);
    expect(cartoes[0].textContent).toMatch(/^7atendimentos coletados/);
    expect(cartoes[1].textContent).toMatch(/^2conversas aguardando resposta/);
    expect(cartoes[2].textContent).toMatch(/^7atendimentos em conferência/);
    expect(cartoes[3].textContent).toMatch(/^7conversas sem atendente na Mensageria/);
    expect(container.querySelector('[data-testid="nota-espelho"]').textContent).toMatch(/espelho coletado.*não o total da Mensageria/);
    expect(container.querySelectorAll('[data-testid="nota-espelho"]').length).toBe(1);
  });

  it("tabela por atendente na Mensageria: valor bruto da ULBRA, sem casar com operador do ReATIVA", async () => {
    rpc.mockResolvedValue({ data: resposta({ conversas: { ...resposta().conversas, por_atendente_ulbra: { "Maria X": 4, "João Y": 2 }, com_atendente_ulbra: 6, sem_atendente_ulbra: 1 } }), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const t = container.querySelector('[data-testid="por-atendente"]').textContent;
    expect(t).toMatch(/Não é correspondência com operador do ReATIVA/);
    expect(t).toMatch(/Maria X4/);
    expect(t).toMatch(/João Y2/);
    expect(t).toMatch(/sem atendente informado1/);
  });

  it("pendências de conferência: contagem e definição; SEM 'mais antigo esperando' (o agregado de espera é de outro universo)", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const c = container.querySelector('[data-testid="conferencia"]').textContent;
    expect(c).toMatch(/7 atendimentos/);
    expect(c).toMatch(/nunca é presumida por nome ou telefone/);
    expect(c).not.toMatch(/mais antigo|esperando há|1700|28 h/);
  });

  it("'sem responsável no ReATIVA' não é cartão nem pendência: fica nos detalhes, com a nota do bloqueio do assumir", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    expect(container.querySelector('[data-testid="cartoes"]').textContent).not.toMatch(/responsável/);
    expect(container.querySelector('[data-testid="conferencia"]').textContent).not.toMatch(/responsável/);
    const det = container.querySelector('[data-testid="detalhes"]');
    expect(det.textContent).toMatch(/sem responsável no ReATIVA7 — assumir está bloqueado no piloto; não é pendência operacional/);
  });

  it("detalhes da sincronização vêm recolhidos e trazem cursor, piso, backlog, saldo com hora, cobertura, espera com definição e indicadores não disponíveis", async () => {
    rpc.mockResolvedValue({ data: resposta(), error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={GESTAO} />);
    await screen.findByRole("heading", { name: "CRM ULBRA" });
    const det = container.querySelector('[data-testid="detalhes"]');
    expect(det.tagName).toBe("DETAILS");
    expect(det.hasAttribute("open")).toBe(false);
    const t = det.textContent;
    expect(t).toMatch(/cursornão avançou/);
    expect(t).toMatch(/piso guardado\d{2}\/\d{2}, \d{2}:\d{2}/);
    expect(t).toMatch(/backlog \(fila de detalhes\)5/);
    expect(t).toMatch(/462 de 500 — fotografia de .*não saldo final/);
    expect(t).toMatch(/atualizaçãomanual — sem sincronização automática ativa/);
    const cob = det.querySelector('[data-testid="cobertura"]').textContent;
    expect(cob).toMatch(/equipeReativa/);
    expect(cob).toMatch(/WhatsApp \(e-mail: não ativo\)/);
    expect(cob).toMatch(/situações coletadasactive/);
    expect(t).toMatch(/universoatendimentos sem responsavel NO REATIVA/);
    expect(t).toMatch(/contado desdeentrou_em \(entrada em espera na Mensageria/);
    expect(t).toMatch(/atendimentos — atendente na Mensagerianão disponível \(o espelho de atendimentos não guarda esse campo\)/);
    expect(t).toMatch(/atendimentos por canalnão disponível/);
    expect(t).toMatch(/alcance do último ciclo \(páginas\)não disponível/);
    expect(t).toMatch(/divergência carteira ReATIVA × atendente ULBRAnão disponível — depende do mapeamento/);
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
    expect(pulado.texto).toMatch(/NÃO é atualizado/);
    const concluida = descreverEstado({ ...base, estado: "COLETA_CONCLUIDA" });
    expect(concluida.titulo).toMatch(/Última coleta concluída em \d{2}\/\d{2}, \d{2}:\d{2}/);
    expect(concluida.titulo).not.toMatch(/em dia/i);
  });

  it("porta do menu e da rota: exatamente a lista de usuario_e_gestao() do banco (3 e-mails), sem perfil", () => {
    expect(EMAILS_GESTAO_CRM_ULBRA).toEqual(["amanda.seibel@aelbra.com.br", "cobranca04@aelbra.com.br", "cobranca07@aelbra.com.br"]);
    expect(podeVerCrmUlbra(" Amanda.Seibel@aelbra.com.br ")).toBe(true);
    expect(podeVerCrmUlbra("cobranca07@aelbra.com.br")).toBe(true);
    expect(podeVerCrmUlbra("cobranca10@aelbra.com.br")).toBe(false);
    expect(podeVerCrmUlbra("")).toBe(false);
    expect(podeVerCrmUlbra(undefined)).toBe(false);
  });

  it("quem não é gestão não vê número nenhum", async () => {
    rpc.mockResolvedValue({ data: { ok: false, motivo: "ACESSO_NEGADO" }, error: null });
    const { container } = render(<PainelMensageriaUlbra usuario={{ perfil: { email: "op1@x" } }} />);
    await screen.findByText(/restrita à gestão/);
    expect(container.textContent).not.toMatch(/atendimentos coletados|\b7\b/);
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
    await waitFor(() => expect(screen.queryByRole("heading", { name: "CRM ULBRA" })).toBeTruthy());
  });

  it("formata minutos sem inventar: nulo é 'não disponível'", () => {
    expect(fmtMin(null)).toBe(ND);
    expect(fmtMin(undefined)).toBe(ND);
    expect(fmtMin(0)).toBe("0 min");
    expect(fmtMin(125)).toBe("2 h 05 min");
  });
});
