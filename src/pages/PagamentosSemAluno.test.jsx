// @vitest-environment jsdom
//
// A fila de exceção é o portão operacional do canário: se ela não mostrar o
// MOTIVO FINANCEIRO e não tratar os candidatos como sugestão, a regra nova
// vira pagamento sem dono. O que se prova aqui:
//   1. a tela pede a pendência de todos os meses quando a gestão marca a caixa
//      (os pagamentos sem vínculo de hoje são todos de um mês antigo);
//   2. o motivo financeiro aparece na linha, não escondido;
//   3. candidato por nome é SUGESTÃO -- renderiza, mas nada vincula sem clique;
//   4. o vínculo só sai por pagamento_vincular_aluno, com o motivo no histórico;
//   5. (14/09/2026) linha com aluno JÁ identificado aparece na fila, mostra o
//      estado da conciliação e NÃO oferece "Vincular aluno" -- vincular ali só
//      daria a chance de sobrescrever um vínculo correto por boleto exato;
//   6. (16/09/2026) a ação corresponde ao ponto exato em que o pagamento
//      travou: aluno provado por matrícula + nome com acordo ausente oferece
//      "Registrar acordo à vista", nunca "Vincular aluno".
//   7. (23/10/2026) a tela le o recorte por arquivo na URL (`?importacao=`),
//      entao o harness monta sob <MemoryRouter>. Nenhuma assercao mudou -- so
//      o involucro, porque `useSearchParams` exige contexto de Router.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));
vi.mock("../components/CadastroNovoAluno", () => ({ default: () => null }));
vi.mock("../components/DadosAcademicos", () => ({ default: () => null }));
vi.mock("./Aluno", () => ({ default: () => null }));
vi.mock("../components/RegistrarAcordoAvista", () => ({
  default: ({ item }) => <div>modal registrar {item.pagamento_id}</div>,
}));

import PagamentosSemAluno from "./PagamentosSemAluno";

const LINHA = {
  pagamento_id: "p1",
  data_pagamento: "2026-07-18",
  aluno_nome: "JOSE DA SILVA",
  matricula: "2026002032",
  titulo_numero: "4295892",
  numero_parcela_completo: "50716220001",
  valor_pago: 536.13,
  valor_honorario: 53.61,
  operador_nome: "Operador Teste",
  operador_email: "op@teste.com",
  motivo: "SEM_CADASTRO",
  candidatos: 1,
  motivo_financeiro:
    "boleto 50716220001 nao existe em parcelas e o acordo 071622 nao esta no CRM",
  sugestoes: [
    { aluno_id: "a9", nome: "José da Silva", cpf_mascarado: "***.333", matricula: "1234", tem_acordo_ativo: true },
  ],
  detectado_em: "2026-09-12T13:00:00Z",
  importacao_id: "i1",
  arquivo_nome: "parcial 12.09.xlsx",
  status_conciliacao: "AGUARDANDO_ACORDO",
  tem_aluno: false,
};

// O caso que era invisível até 14/09: o boleto resolveu o aluno pelo número
// Ulbra único, então `aluno_id` não é nulo -- e com o eixo antigo
// (`aluno_id IS NULL`) esta linha não entrava na fila nenhuma.
const LINHA_COM_ALUNO = {
  ...LINHA,
  pagamento_id: "p2",
  numero_parcela_completo: "50716630001",
  status_conciliacao: "AGUARDANDO_AMARRACAO",
  tem_aluno: true,
  motivo_financeiro:
    "o acordo 071663 esta no CRM com 5 parcela(s) sem boleto: falta amarrar o boleto 50716630001 a parcela certa",
};

// Cada RPC responde o que é dela. `pagamentos_trava` diz em que ponto cada
// "aguardando acordo" travou; por padrão, LINHA é aluno não identificado.
const TRAVA_P1 = [{ pagamento_id: "p1", trava: "ALUNO_NAO_IDENTIFICADO" }];

// TRIAGEM (22/10/2026). Leitura separada, porque `pagamentos_sem_aluno` esconde
// quem tem decisao registrada -- e sao essas que a conferencia precisa ver.
// Por padrao a triagem vem VAZIA: os testes antigos nao sabem dela e a faixa
// nao pode mudar o que eles observam.
function rotear({ lista = [LINHA], travas = TRAVA_P1, triagem = [], outras = {} } = {}) {
  rpcMock.mockImplementation((nome) => {
    if (nome === "pagamentos_sem_aluno") return Promise.resolve({ data: lista, error: null });
    if (nome === "fila_pagamento_triagem_ler") {
      if (triagem === "ERRO")
        return Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } });
      if (triagem === "AUSENTE")
        return Promise.resolve({
          data: null,
          error: { message: 'Could not find the function public.fila_pagamento_triagem_ler' },
        });
      return Promise.resolve({ data: triagem, error: null });
    }
    if (nome === "pagamentos_trava") {
      if (travas && typeof travas.then === "function") return travas;
      return Promise.resolve(travas === "ERRO"
        ? { data: null, error: { message: "falhou" } }
        : { data: travas, error: null });
    }
    if (outras[nome]) return Promise.resolve(outras[nome]);
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  rpcMock.mockReset();
  rotear();
});
afterEach(cleanup);

describe("Fila de pagamentos sem vínculo", () => {
  it("mostra o motivo financeiro e o boleto na própria linha", async () => {
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/por que caiu aqui/i)).toBeTruthy();
    expect(
      screen.getByText(/boleto 50716220001 nao existe em parcelas/i),
    ).toBeTruthy();
    // o identificador financeiro vem antes do nome na leitura da linha
    expect(screen.getByText(/boleto 50716220001 · título 4295892/i)).toBeTruthy();
  });

  // MUDOU EM 14/09/2026. Antes a tela abria no mes corrente e a caixa "toda a
  // pendencia" vinha desmarcada -- com os pagamentos em aberto todos em
  // 2026-07, a tela abria dizendo "tudo baixado" havendo pendencia na base.
  // Tela vazia que parece resolvida e pior do que fila cheia.
  it("abre pedindo toda a pendência, não só o mês corrente", async () => {
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    expect(rpcMock).toHaveBeenCalledWith(
      "pagamentos_sem_aluno",
      expect.objectContaining({ p_todos_os_meses: true }),
    );
  });

  it("desmarcar a caixa restringe ao mês escolhido", async () => {
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/toda a pendência/i));
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "pagamentos_sem_aluno",
      expect.objectContaining({ p_todos_os_meses: false }),
    );
  });

  it("candidato por nome é sugestão: aparece rotulado, e não vincula sozinho", async () => {
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    await act(async () => { fireEvent.click(screen.getByText("Vincular aluno")); });

    expect(screen.getByText(/1 sugestão por nome/i)).toBeTruthy();
    expect(screen.getByText(/nome não é prova/i)).toBeTruthy();
    expect(screen.getByText("José da Silva")).toBeTruthy();

    // abrir a linha NÃO pode ter vinculado nada
    expect(
      rpcMock.mock.calls.some((c) => c[0] === "pagamento_vincular_aluno"),
    ).toBe(false);
  });

  it("o vínculo sai por pagamento_vincular_aluno e leva o motivo para o histórico", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    rotear({
      outras: {
        pagamento_vincular_aluno: { data: { ok: true, aluno_nome: "José da Silva" }, error: null },
      },
    });

    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    await act(async () => { fireEvent.click(screen.getByText("Vincular aluno")); });
    await act(async () => { fireEvent.click(screen.getByText("Vincular")); });

    const chamada = rpcMock.mock.calls.find((c) => c[0] === "pagamento_vincular_aluno");
    expect(chamada).toBeTruthy();
    expect(chamada[1].p_pagamento_id).toBe("p1");
    expect(chamada[1].p_aluno_id).toBe("a9");
    expect(chamada[1].p_observacao).toMatch(/50716220001/);
    expect(chamada[1].p_observacao).toMatch(/nao esta no CRM/);
  });
});

describe("pagamento com aluno identificado que não baixou", () => {
  it("entra na fila, com o estado da conciliação na linha", async () => {
    rotear({ lista: [LINHA_COM_ALUNO], travas: [] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("Aguardando amarração")).toBeTruthy();
    expect(screen.getByText(/falta amarrar o boleto 50716630001/i)).toBeTruthy();
  });

  it("não oferece Vincular aluno: a pendência não se resolve trocando o aluno", async () => {
    rotear({ lista: [LINHA_COM_ALUNO], travas: [] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
    expect(screen.getByText(/aluno já identificado/i)).toBeTruthy();
  });

  it("a linha com aluno não identificado continua oferecendo Vincular aluno", async () => {
    rotear();
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByRole("button", { name: /vincular aluno/i })).toBeTruthy();
  });

  it("nenhum vínculo sai sem clique, mesmo com as duas linhas na tela", async () => {
    rotear({ lista: [LINHA, LINHA_COM_ALUNO] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    const chamadas = rpcMock.mock.calls.map(([nome]) => nome);
    expect(chamadas).not.toContain("pagamento_vincular_aluno");
    // um Vincular aluno só: o da linha sem aluno
    expect(screen.getAllByRole("button", { name: /vincular aluno/i })).toHaveLength(1);
  });
});

describe("a ação corresponde ao ponto em que o pagamento travou", () => {
  it("aluno provado por matrícula + nome e acordo ausente: diz isso e oferece só Registrar acordo à vista", async () => {
    rotear({ travas: [{ pagamento_id: "p1", trava: "ACORDO_AVISTA_AUSENTE" }] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("Aluno identificado · acordo não encontrado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Registrar acordo à vista" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
    // o selo de nome é da trava de identidade; aqui ele confundiria
    expect(screen.queryByText(/sem cadastro na base/i)).toBeNull();
    expect(rpcMock).toHaveBeenCalledWith("pagamentos_trava", { p_pagamento_ids: ["p1"] });
  });

  it("abrir a ação não grava nada: só abre o registro com o pagamento da linha", async () => {
    rotear({ travas: [{ pagamento_id: "p1", trava: "ACORDO_AVISTA_AUSENTE" }] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Registrar acordo à vista" })); });

    expect(screen.getByText("modal registrar p1")).toBeTruthy();
    const chamadas = rpcMock.mock.calls.map(([nome]) => nome);
    expect(chamadas).not.toContain("pagamento_vincular_aluno");
  });

  it("acordo parcelado ausente não tem ação manual", async () => {
    rotear({ travas: [{ pagamento_id: "p1", trava: "ACORDO_PARCELADO_AUSENTE" }] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("Aluno identificado · acordo parcelado não encontrado")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
  });

  it("ausência não explicada (o 71752) fica fora do fluxo normal: sem ação", async () => {
    rotear({ travas: [{ pagamento_id: "p1", trava: "ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA" }] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("Aluno identificado · ausência do acordo não explicada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
  });

  // 17/09/2026: recusada pela prévia, a trava diz o motivo e a linha fica sem
  // ação. Os seis casos da auditoria das 27 linhas.
  for (const [trava, rotulo] of [
    ["ACORDO_AVISTA_FORA_DA_MARGEM", "Aluno identificado · acordo não encontrado · valor fora da margem segura"],
    ["ACORDO_AVISTA_ALUNO_ENCERRADO", "Aluno identificado · acordo não encontrado · aluno já encerrado"],
    ["ACORDO_AVISTA_OPERADOR_NAO_CADASTRADO", "Aluno identificado · acordo não encontrado · operador do pagamento não cadastrado"],
    ["ACORDO_AVISTA_SEM_MENSALIDADE_ELEGIVEL", "Aluno identificado · acordo não encontrado · nenhuma mensalidade elegível em aberto"],
    ["ACORDO_AVISTA_SEM_COMBINACAO_SEGURA", "Aluno identificado · acordo não encontrado · sem combinação segura de mensalidades"],
    ["ACORDO_AVISTA_OUTRO_BLOQUEIO", "Aluno identificado · acordo não encontrado · registro bloqueado pela simulação"],
  ]) {
    it(`${trava}: diz o motivo e não oferece registro nem vínculo`, async () => {
      rotear({ travas: [{ pagamento_id: "p1", trava }] });
      await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

      expect(screen.getByText(rotulo)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
    });
  }

  it("identidade divergente oferece Vincular aluno", async () => {
    rotear({ travas: [{ pagamento_id: "p1", trava: "IDENTIDADE_DIVERGENTE" }] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("Matrícula e nome divergem · acordo não encontrado")).toBeTruthy();
    expect(screen.getByRole("button", { name: /vincular aluno/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();
  });

  it("enquanto o diagnóstico não chega: Analisando pendência, sem ação e sem \"sem ação manual\"", async () => {
    let responderTrava;
    const pendente = new Promise((r) => { responderTrava = r; });
    rotear({ travas: pendente });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("Analisando pendência…")).toBeTruthy();
    expect(screen.queryByText("Aguardando acordo")).toBeNull();
    expect(screen.queryByText("sem ação manual")).toBeNull();
    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();

    await act(async () => { responderTrava({ data: [{ pagamento_id: "p1", trava: "ACORDO_AVISTA_AUSENTE" }], error: null }); });

    expect(screen.queryByText("Analisando pendência…")).toBeNull();
    expect(screen.getByText("Aluno identificado · acordo não encontrado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Registrar acordo à vista" })).toBeTruthy();
  });

  it("sem diagnóstico da trava, a linha fica sem ação nenhuma", async () => {
    rotear({ travas: "ERRO" });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();
  });
});

// O erro cru do Postgres nao diz a ninguem o que fazer. As duas mensagens que
// esta tela pode receber tem causa e acao diferentes, e a tela precisa separar.
describe("erro da RPC vira mensagem que a pessoa entende", () => {
  it("permission denied é sessão vencida, não falta de permissão", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "permission denied for function pagamentos_sem_aluno" },
    });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/sua sessão expirou/i)).toBeTruthy();
    // o texto do banco nao pode vazar para a tela
    expect(screen.queryByText(/permission denied/i)).toBeNull();
  });

  it("o portão de gestão vira a explicação do portão", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "A fila de pagamentos sem vinculo e da gestao financeira." },
    });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/é da gestão financeira/i)).toBeTruthy();
  });

  it("erro desconhecido continua aparecendo como veio: não engolir falha nova", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "canceling statement due to statement timeout" },
    });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/statement timeout/i)).toBeTruthy();
  });
});

// CONFERENCIA MANUAL NA PROPRIA LINHA (23/09/2026). A gestao decidiu conferir
// os `AGUARDANDO_ACORDO` um a um em vez de reclassificar por rotina -- entao a
// linha tem de mostrar, sem abrir outra tela, o acordo que o boleto aponta, as
// evidencias que existem e o saldo de hoje. O que se prova aqui:
//   1. os tres aparecem na linha, sem clique nenhum;
//   2. "acordo nao esta no CRM" aparece como FATO, em destaque de alerta;
//   3. boleto fora do padrao nao inventa acordo;
//   4. nada disso chama RPC de escrita.
const LINHA_CONFERENCIA = {
  ...LINHA,
  pagamento_id: "p9",
  numero_parcela_completo: "50725290001",
  titulo_numero: "72529",
  valor_pago: 3945.53,
  tem_aluno: true,
  acordo_identificado: "072529",
  saldo_total: 5000,
  saldo_vencido: 2000,
  evidencias: {
    acordo_prefixo: "072529",
    acordo_no_crm: false,
    acordo_status: null,
    parcela_com_este_boleto: false,
    parcela_status: null,
    documento: "72529",
    cpf_no_portador_166: true,
    consulta_estrutura: "NAO_ENCONTRADA",
    evidencia_origem: "PRIME_PORTADOR_MEMBRO",
    tentativas: 4,
    ultima_tentativa_em: "2026-09-22T09:00:00Z",
  },
};

describe("conferência manual na própria linha", () => {
  it("mostra acordo identificado, evidências e saldo sem sair da fila", async () => {
    rotear({ lista: [LINHA_CONFERENCIA], travas: [{ pagamento_id: "p9", trava: "ACORDO_PARCELADO_AUSENTE" }] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText("acordo 072529")).toBeTruthy();
    expect(screen.getByText(/saldo atual/)).toBeTruthy();
    expect(screen.getAllByText((t) => t.replace(/ /g, " ") === "R$ 5.000,00").length).toBeGreaterThan(0);

    expect(screen.getByText("Acordo no CRM")).toBeTruthy();
    expect(screen.getByText("não — o acordo deste boleto não existe aqui")).toBeTruthy();
    expect(screen.getByText("CPF no portador 166")).toBeTruthy();
    expect(screen.getByText("sim — negociação confirmada")).toBeTruthy();
    expect(screen.getByText(/não encontrada — a API do Prime/)).toBeTruthy();
    // SEM O RELOGIO NA ASSERCAO. `toLocaleString` usa o fuso de quem roda: aqui
    // e America/Sao_Paulo e no CI e UTC, entao fixar "06:00" passava na maquina
    // e quebrava no CI. O que importa e a contagem e a data.
    expect(screen.getByText(/^4 · última em 22\/09\/2026/)).toBeTruthy();
    expect(screen.getByText("espelho do portador 166")).toBeTruthy();
  });

  it("boleto fora do padrão não inventa acordo", async () => {
    rotear({
      lista: [{ ...LINHA_CONFERENCIA, acordo_identificado: null, saldo_total: null,
                evidencias: { acordo_prefixo: null, parcela_com_este_boleto: false, tentativas: 1 } }],
      travas: [],
    });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    expect(screen.getByText(/boleto fora do padrão: sem acordo identificável/)).toBeTruthy();
    expect(screen.queryByText("Acordo no CRM")).toBeNull();
  });

  it("conferir não chama nenhuma RPC de escrita", async () => {
    rotear({ lista: [LINHA_CONFERENCIA], travas: [] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    const escrita = ["conciliacao_feito", "conciliacao_rejeitar", "conciliacao_encerrar",
                     "pagamento_vincular_aluno", "acordo_avista_registrar"];
    const chamadas = rpcMock.mock.calls.map((c) => c[0]);
    expect(chamadas.some((n) => escrita.includes(n))).toBe(false);
  });
});

// ===========================================================================
// FAIXA DE TRIAGEM (22/10/2026). O que se prova aqui:
//   1. a faixa conta e soma por categoria, e recorta a lista ao clicar;
//   2. as pendencias que a lista principal NAO mostra (decisao registrada +
//      status ainda pendente) aparecem num bloco de conferencia, sem acao;
//   3. falha na triagem nao apaga a fila, e o texto cru do banco nao vaza.
// ===========================================================================
// O caso que a Etapa 2 resolve: a triagem declara CONFERIR_E_ENCERRAR e nao ha
// decisao. Em producao sao 47 (R$ 40.663,34), e ate 27/10/2026 nenhum deles
// tinha botao, porque a lista principal vinha vazia pelo timeout da RPC.
const T_CONFERIR = {
  pagamento_id: "p9",
  categoria: "ACIONAVEL_ADMINISTRATIVO",
  subcategoria: "ja_paga_conferir_e_encerrar",
  etapa_desligada: null,
  acao_sugerida: "CONFERIR_E_ENCERRAR",
  valor_pago: 126.18,
  data_pagamento: "2026-10-05",
  aluno_id: "a9",
  boleto: "50662470003",
  decisao: null,
  motivo: "a parcela 2 do boleto 50662470003 ja estava PAGO antes deste pagamento",
};

const T_ACIONAVEL = {
  pagamento_id: "p1",
  categoria: "ACIONAVEL_ADMINISTRATIVO",
  subcategoria: "escolher_aluno_sugerido",
  etapa_desligada: null,
  acao_sugerida: "ESCOLHER_ALUNO",
  valor_pago: 536.13,
  data_pagamento: "2026-07-18",
  aluno_id: "a9",
  boleto: "50716220001",
  decisao: null,
  motivo: "boleto 50716220001 nao existe em parcelas",
};
const T_BLOQUEADA = {
  pagamento_id: "p9",
  categoria: "BLOQUEADO_ETAPA_DESATIVADA",
  subcategoria: "consulta_portador",
  etapa_desligada: "consulta_portador",
  acao_sugerida: null,
  valor_pago: 1000,
  data_pagamento: "2026-10-01",
  aluno_id: "a1",
  boleto: "50700000001",
  decisao: null,
  motivo: "a API oficial ainda nao foi consultada para este caso",
};
// Esta NAO esta na lista principal: tem decisao registrada. E o caso dos 33.
const T_DECIDIDA = {
  pagamento_id: "p33",
  categoria: "CONFERENCIA_HUMANA",
  subcategoria: "decidida_mas_ainda_pendente",
  etapa_desligada: null,
  acao_sugerida: null,
  valor_pago: 2521.31,
  data_pagamento: "2026-09-20",
  aluno_id: "a33",
  boleto: "50733330001",
  decisao: "RESOLVIDO_AUTOMATICO",
  motivo: "boleto 50733330001 nao existe em parcelas",
};

describe("faixa de triagem", () => {
  it("mostra as quatro categorias com contagem e valor", async () => {
    rotear({ triagem: [T_ACIONAVEL, T_BLOQUEADA, T_DECIDIDA] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/^Triagem$/)).toBeTruthy();
    expect(screen.getByText(/3 pendências/)).toBeTruthy();
    expect(screen.getByText(/Acionável agora/i)).toBeTruthy();
    expect(screen.getByText(/Parado por etapa desligada/i)).toBeTruthy();
    expect(screen.getByText(/Divergência a conferir/i)).toBeTruthy();
    // A categoria vazia continua na faixa: esconde-la faria parecer inexistente.
    expect(screen.getByText(/Aguardando o acordo/i)).toBeTruthy();
    // A etapa que explica a parada e NOMEADA, nao so "bloqueado".
    expect(screen.getByText(/etapa: consulta_portador/i)).toBeTruthy();
  });

  it("clicar na categoria recorta a lista; o total nao muda de lugar", async () => {
    rotear({ lista: [LINHA, LINHA_COM_ALUNO], triagem: [T_ACIONAVEL, T_BLOQUEADA] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });
    expect(screen.getByText(/boleto 50716220001 nao existe em parcelas/i)).toBeTruthy();

    // p2 (LINHA_COM_ALUNO) nao esta na triagem: filtrar por categoria o remove.
    await act(async () => {
      fireEvent.click(screen.getByTitle(/caminho pronto/i));
    });
    expect(screen.getByText(/boleto 50716220001 nao existe em parcelas/i)).toBeTruthy();
    expect(screen.queryByText(/falta amarrar o boleto 50716630001/i)).toBeNull();

    // E volta ao clicar de novo na mesma categoria.
    await act(async () => {
      fireEvent.click(screen.getByTitle(/caminho pronto/i));
    });
    expect(screen.getByText(/falta amarrar o boleto 50716630001/i)).toBeTruthy();
  });

  it("recorte sem resultado NAO diz 'tudo baixado'", async () => {
    rotear({ lista: [LINHA], triagem: [T_BLOQUEADA] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    await act(async () => {
      fireEvent.click(screen.getByTitle(/etapa que a gestão desligou/i));
    });
    expect(screen.getByText(/nenhum pagamento neste recorte/i)).toBeTruthy();
    expect(screen.queryByText(/tudo baixado/i)).toBeNull();
  });
});

describe("as pendências que a lista principal não mostra", () => {
  it("decisão registrada e ainda pendente aparece na conferência, com o valor", async () => {
    rotear({ lista: [LINHA], triagem: [T_ACIONAVEL, T_DECIDIDA] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    const titulo = screen.getByText(/1 fora da lista acima · 1 com decisão registrada/i);
    expect(titulo).toBeTruthy();
    // Consulta ESCOPADA no bloco. O mesmo valor aparece tambem no cartao da
    // faixa, porque com uma pendencia so o total da categoria coincide com ela
    // -- contar ocorrencias na tela inteira mediria a coincidencia, nao o bloco.
    const bloco = within(titulo.parentElement.parentElement);
    expect(bloco.getAllByText(/R\$\s*2\.521,31/).length).toBeGreaterThanOrEqual(1);
    expect(bloco.getByText("50733330001")).toBeTruthy();
    expect(screen.getByText("RESOLVIDO_AUTOMATICO")).toBeTruthy();
    expect(screen.getByText(/a rodada horária não as reprocessa/i)).toBeTruthy();
  });

  it("o bloco é só leitura: nenhuma ação além de abrir a ficha", async () => {
    rotear({ lista: [], triagem: [T_DECIDIDA] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByRole("button", { name: /abrir ficha/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /vincular aluno/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /registrar acordo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^feito$/i })).toBeNull();
  });

  // A CORRECAO DE 27/10/2026, no nivel da tela. Com a lista principal vazia --
  // que e o que o timeout de 8 s da RPC produz em producao -- o caso acionavel
  // cai neste bloco, e aqui ele PRECISA ter o botao. Antes nao tinha: o
  // componente so era montado dentro do card da lista principal.
  it("com a lista principal vazia, o caso acionável ganha o botão de encerrar", async () => {
    rotear({ lista: [], triagem: [T_CONFERIR] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByRole("button", { name: /conferir e encerrar/i })).toBeTruthy();
    // E a previa e um passo separado: o botao de confirmar so existe depois.
    expect(screen.queryByRole("button", { name: /encerrar a pendência/i })).toBeNull();
  });

  // ESCOLHER_ALUNO saiu do escopo em 26/10/2026 e nao volta por este caminho.
  it("ESCOLHER_ALUNO aparece no bloco e continua sem botão de encaminhamento", async () => {
    rotear({ lista: [], triagem: [T_ACIONAVEL] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/1 fora da lista acima/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /conferir e encerrar/i })).toBeNull();
  });

  it("quem já está na lista principal não é repetido no bloco", async () => {
    // p1 está na lista E na triagem: aparece uma vez, na lista.
    rotear({ lista: [LINHA], triagem: [T_ACIONAVEL] });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.queryByText(/fora da lista acima/i)).toBeNull();
  });
});

describe("a triagem falha sem derrubar a fila", () => {
  it("função ainda não publicada: avisa e mantém a lista", async () => {
    rotear({ lista: [LINHA], triagem: "AUSENTE" });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/ainda não publicada no banco/i)).toBeTruthy();
    expect(screen.getByText(/boleto 50716220001 nao existe em parcelas/i)).toBeTruthy();
  });

  it("erro na triagem não vaza o texto do banco nem some com a fila", async () => {
    rotear({ lista: [LINHA], triagem: "ERRO" });
    await act(async () => { render(
      <MemoryRouter>
        <PagamentosSemAluno />
      </MemoryRouter>,
    ); });

    expect(screen.getByText(/triagem indisponível nesta carga/i)).toBeTruthy();
    expect(screen.queryByText(/statement timeout/i)).toBeNull();
    expect(screen.getByText(/boleto 50716220001 nao existe em parcelas/i)).toBeTruthy();
  });
});
