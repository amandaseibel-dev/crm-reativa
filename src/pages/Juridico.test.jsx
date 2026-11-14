// @vitest-environment jsdom
//
// Garantias desta tela:
// 1. caso com pendência NÃO tem aprovação ativa; sem pendência, aprova pela RPC;
// 2. termo não localizado aparece dito, nunca como resolvido;
// 3. acordo ativo só segue com aprovação específica e motivo;
// 4. a tela não soma nada: mostra o total que o banco devolveu;
// 5. confirmar ao jurídico só existe para caso já enviado ao financeiro;
// 6. recusa do banco (não-gestão) vira mensagem, não tela vazia.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import Juridico from "./Juridico";

// A tela carrega a ficha e o diálogo; em máquina carregada 5s não bastam.
vi.setConfig({ testTimeout: 20000 });

const rpc = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpc(...a) } }));
vi.mock("./Aluno", () => ({ default: () => null }));
const exportar = vi.fn();
vi.mock("../utils/exportarJuridico", () => ({ exportarLoteJuridico: (...a) => exportar(...a) }));

const conf = (extra = {}) => ({
  mensalidades: [{ titulo_id: "t1", documento: "DOC-1", vencimento: "2025-06-10", valor: 1000 }],
  total_mensalidades: 1000, incorporadas_qtd: 0, incorporadas_valor: 0, negociado_sem_vinculo: 0,
  acordos: [], total_acordos: 0, acordos_cancelados: 0, termo: { status: "NAO_APLICAVEL" }, total: 1000, ...extra,
});
const caso = (n, status, extra = {}) => ({
  caso_id: `c${n}`, lote_id: "l1", protocolo: "JUR-20261112-0001", status, aluno_id: `a${n}`,
  aluno: `Aluno ${n}`, matricula: `900${n}`, curso: "Direito", situacao_academica: "Formado",
  semestre_divida: "2025/2", valor_previa: 1000, valor_aprovado: status === "EM_ANALISE" ? null : 1000,
  conferencia: status === "EM_ANALISE" ? conf() : null, pendencias: [], titulos_aprovados: 1, ...extra,
});
const PAINEL = (casos) => ({
  indicadores: { em_analise: 1, aprovados: 0, enviados_financeiro: 0, confirmados_juridico: 0, valor_em_analise: 1000, valor_bloqueado: 0 },
  lotes: [{ lote_id: "l1", protocolo: "JUR-20261112-0001", qtd_solicitada: 40, casos_ativos: casos.length }],
  casos,
});
let casosAtuais;
const responder = (extra = {}) => rpc.mockImplementation((nome, args) => {
  if (nome === "juridico_painel") return Promise.resolve({ data: PAINEL(casosAtuais), error: null });
  if (extra[nome]) return Promise.resolve(extra[nome](args));
  return Promise.resolve({ data: {}, error: null });
});
const abrirAba = async (rotulo) => {
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("juridico_painel"));
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${rotulo}`) }));
};
const chamadas = (nome) => rpc.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => { vi.clearAllMocks(); casosAtuais = []; });
afterEach(cleanup);

describe("aprovação", () => {
  it("caso sem pendência aprova pela RPC, com o id do caso", async () => {
    casosAtuais = [caso(1, "EM_ANALISE")];
    responder();
    render(<Juridico />);
    await abrirAba("Em análise");
    expect(screen.getByText("Pronto para aprovar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aprovar e bloquear cobrança" }));
    await waitFor(() => expect(chamadas("juridico_caso_aprovar")).toHaveLength(1));
    expect(chamadas("juridico_caso_aprovar")[0][1]).toEqual({ p_caso_id: "c1" });
    expect(await screen.findByText(/Cobrança bloqueada — manual, massiva e automática/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith("juridico_varrer_alertas");
  });

  it("termo não localizado: aparece dito, a aprovação fica desligada e as saídas são vincular ou autorização jurídica", async () => {
    casosAtuais = [caso(1, "EM_ANALISE", {
      pendencias: ["TERMO_NAO_LOCALIZADO"],
      conferencia: conf({ termo: { status: "NAO_LOCALIZADO" }, acordos: [{ acordo_id: "x", numero_acordo: 5001, situacao: "QUEBRADO", parcelas_vencidas: 2, saldo: 600 }], total: 1600 }),
    })];
    responder();
    render(<Juridico />);
    await abrirAba("Em análise");
    expect(screen.getByText("Termo NÃO localizado")).toBeTruthy();
    expect(screen.getByText("Termo do acordo não localizado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aprovar e bloquear cobrança" }).disabled).toBe(true);
    // total é o do banco (1.600), não uma soma refeita na tela
    expect(screen.getByText(/1\.600,00/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Autorização jurídica" }));
    const dlg = screen.getByRole("dialog");
    // sem motivo não envia
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    expect(chamadas("juridico_caso_autorizar_documento")).toHaveLength(0);
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Dra. Fulana autorizou" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(chamadas("juridico_caso_autorizar_documento")).toHaveLength(1));
    expect(chamadas("juridico_caso_autorizar_documento")[0][1]).toEqual({ p_caso_id: "c1", p_motivo: "Dra. Fulana autorizou" });
  });

  it("acordo ativo: aprovação desligada até a aprovação específica com motivo", async () => {
    casosAtuais = [caso(1, "EM_ANALISE", { pendencias: ["ACORDO_ATIVO_SEM_APROVACAO"] })];
    responder();
    render(<Juridico />);
    await abrirAba("Em análise");
    expect(screen.getByRole("button", { name: "Aprovar e bloquear cobrança" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Aprovar acordo ativo" }));
    const dlg = screen.getByRole("dialog");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "pedido do jurídico" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(chamadas("juridico_caso_aprovar_acordo_ativo")).toHaveLength(1));
    expect(chamadas("juridico_caso_aprovar")).toHaveLength(0);
  });

  it("pendência impeditiva (pagamento em confirmação) não oferece nenhuma liberação", async () => {
    casosAtuais = [caso(1, "EM_ANALISE", { pendencias: ["!PAGAMENTO_PENDENTE"] })];
    responder();
    render(<Juridico />);
    await abrirAba("Em análise");
    expect(screen.getByText("Pagamento aguardando confirmação")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aprovar e bloquear cobrança" }).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Autorização jurídica" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aprovar acordo ativo" })).toBeNull();
  });
});

describe("acordo quebrado", () => {
  it("revisão envia os acordos e o saldo que vieram do banco, com justificativa; aprovação fica desligada", async () => {
    casosAtuais = [caso(1, "EM_ANALISE", {
      pendencias: ["ACORDO_QUEBRADO_SEM_REVISAO"],
      conferencia: conf({
        acordos: [{ acordo_id: "x1", numero_acordo: 5001, situacao: "QUEBRADO", parcelas_vencidas: 1, saldo: 100.1 },
                  { acordo_id: "x2", numero_acordo: 5002, situacao: "QUEBRADO", parcelas_vencidas: 1, saldo: 200.2 }],
        quebrados: { ids: ["x1", "x2"], saldo: 300.3 }, total: 1300.3,
      }),
    })];
    responder();
    render(<Juridico />);
    await abrirAba("Em análise");
    expect(screen.getByRole("button", { name: "Aprovar e bloquear cobrança" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Revisar acordo quebrado" }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText(/5001, 5002/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    expect(chamadas("juridico_caso_revisar_acordo_quebrado")).toHaveLength(0); // sem justificativa não envia
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "saldo conferido" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(chamadas("juridico_caso_revisar_acordo_quebrado")).toHaveLength(1));
    expect(chamadas("juridico_caso_revisar_acordo_quebrado")[0][1]).toEqual({
      p_caso_id: "c1", p_motivo: "saldo conferido", p_acordos: ["x1", "x2"], p_saldo: 300.3,
    });
  });
});

describe("envio ao financeiro e confirmação ao jurídico", () => {
  it("aprovados: um botão gera o Excel e registra o envio do lote", async () => {
    casosAtuais = [caso(1, "APROVADO")];
    const payload = { protocolo: "JUR-20261112-0001", enviados_agora: 1, casos: [{ caso_id: "c1", titulos: [] }] };
    responder({ juridico_lote_enviar_financeiro: () => ({ data: payload, error: null }) });
    render(<Juridico />);
    await abrirAba("Aprovados");
    expect(screen.queryByRole("button", { name: /Registrar encaminhamento ao jurídico/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Gerar Excel e registrar envio ao financeiro" }));
    await waitFor(() => expect(exportar).toHaveBeenCalledWith(payload));
    expect(chamadas("juridico_lote_enviar_financeiro")[0][1]).toEqual({ p_lote_id: "l1" });
  });

  it("confirmação com caso 'Não encaminhável': a tela mostra quem não foi confirmado e por quê", async () => {
    casosAtuais = [caso(1, "ENVIADO_FINANCEIRO"), caso(2, "ENVIADO_FINANCEIRO")];
    responder({ juridico_casos_confirmar_juridico: () => ({ data: { confirmados: 1, recusados: [{ caso_id: "c2", aluno: "Aluno 2", divergencias: ["TITULO_EM_CONFIRMACAO"] }] }, error: null }) });
    render(<Juridico />);
    await abrirAba("Enviados ao financeiro");
    fireEvent.click(screen.getByRole("checkbox", { name: "Selecionar Aluno 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Selecionar Aluno 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Registrar encaminhamento ao jurídico \(2\)/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText(/NÃO confirmados.*Aluno 2.*confirmação/)).toBeTruthy();
  });

  it("enviados: confirma só os casos marcados, com data, e a tela diz que não é ajuizamento", async () => {
    casosAtuais = [caso(1, "ENVIADO_FINANCEIRO"), caso(2, "ENVIADO_FINANCEIRO")];
    responder({ juridico_casos_confirmar_juridico: () => ({ data: { confirmados: 1 }, error: null }) });
    render(<Juridico />);
    await abrirAba("Enviados ao financeiro");
    const botao = screen.getByRole("button", { name: /Registrar encaminhamento ao jurídico \(0\)/ });
    expect(botao.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Selecionar Aluno 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Registrar encaminhamento ao jurídico \(1\)/ }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText(/Não indica ajuizamento/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(chamadas("juridico_casos_confirmar_juridico")).toHaveLength(1));
    const args = chamadas("juridico_casos_confirmar_juridico")[0][1];
    expect(args.p_caso_ids).toEqual(["c2"]);
    expect(args.p_data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("seleção e acesso", () => {
  it("gera a lista com a quantidade informada e os filtros; quantidade inválida não envia", async () => {
    responder({ juridico_lote_gerar: () => ({ data: { protocolo: "JUR-20261112-0002", solicitados: 25, gerados: 25 }, error: null }) });
    render(<Juridico />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("juridico_painel"));
    const qtd = screen.getByLabelText("Alunos solicitados pelo jurídico");
    fireEvent.change(qtd, { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Gerar lista preliminar" }).disabled).toBe(true);
    fireEvent.change(qtd, { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Ano da dívida (prioriza formados)"), { target: { value: "2025" } });
    fireEvent.click(screen.getByLabelText("Evadidos"));
    fireEvent.click(screen.getByRole("button", { name: "Gerar lista preliminar" }));
    await waitFor(() => expect(chamadas("juridico_lote_gerar")).toHaveLength(1));
    expect(chamadas("juridico_lote_gerar")[0][1]).toEqual({
      p_qtd: 25, p_ano: 2025, p_semestre: null, p_grupos: ["FORMADO", "TRANCADO"], p_observacao: null,
    });
  });

  it("recusa do banco para quem não é gestão vira mensagem", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "A aba Jurídico é restrita à gestão." } });
    render(<Juridico />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("restrita à gestão");
  });
});
