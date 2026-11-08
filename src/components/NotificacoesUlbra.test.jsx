// @vitest-environment jsdom
//
// Garantias deste componente, em ordem de importância:
// 1. NÃO chama a Mensageria: nenhum `fetch` sai daqui — o custo por operador
//    aberto é zero, e é esta a razão de o componente existir desta forma;
// 2. operador não vê o que é da carteira de outro nem o que está em
//    conferência;
// 3. "Assumir" respeita a recusa do banco e não finge sucesso;
// 4. som nunca toca na primeira carga.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import NotificacoesUlbra from "./NotificacoesUlbra";

const estado = {
  conversas: [],
  atendimentos: [],
  gestao: false,
  casos: [],
  assumir: { ok: true, responsavel: "op1@x" },
};
const rpcChamadas = [];
const avisosRealtime = [];

function tabelaFalsa(nome) {
  const encadeado = {
    select: () => encadeado,
    gt: () => encadeado,
    is: () => encadeado,
    eq: () => encadeado,
    order: () => encadeado,
    limit: () =>
      Promise.resolve({
        data:
          nome === "ulbra_conversas"
            ? estado.conversas
            : nome === "ulbra_atendimentos"
              ? estado.atendimentos
              : estado.casos,
        error: null,
      }),
  };
  return encadeado;
}

vi.mock("../services/supabase", () => ({
  supabase: {
    from: (nome) => tabelaFalsa(nome),
    rpc: (nome, args) => {
      rpcChamadas.push([nome, args]);
      if (nome === "usuario_e_gestao") return Promise.resolve({ data: estado.gestao, error: null });
      if (nome === "ulbra_atendimento_assumir") {
        return Promise.resolve({ data: estado.assumir, error: null });
      }
      return Promise.resolve({ data: { ok: true }, error: null });
    },
    channel: () => ({
      on: function (_evento, _filtro, cb) {
        avisosRealtime.push(cb);
        return this;
      },
      subscribe: function () {
        return this;
      },
    }),
    removeChannel: () => {},
  },
}));

const USUARIO = { perfil: { email: "op1@x" } };

const CONVERSA = {
  ulbra_conversa_id: "c1",
  cliente_nome: "Aluno Um",
  nao_lidas: 2,
  aluno_id: "aluno-1",
  aluno_status: "vinculado",
  responsavel_ulbra: "op1@x",
  ultima_mensagem_em: "2026-11-08T05:00:00Z",
  ultima_mensagem_quem: "cliente",
  ultima_mensagem_previa: "pode ser hoje",
};

const LEAD_MEU = {
  ulbra_atendimento_id: "a1",
  cliente_nome: "Aluno Dois",
  aluno_id: "aluno-2",
  aluno_status: "vinculado",
  destino_email: "op1@x",
  destino_motivo: "CARTEIRA",
  responsavel_email: null,
  dispensado_em: null,
  entrou_em: "2026-11-08T05:10:00Z",
};

const LEAD_DE_OUTRO = { ...LEAD_MEU, ulbra_atendimento_id: "a2", destino_email: "op2@x" };
const LEAD_EM_CONFERENCIA = {
  ...LEAD_MEU,
  ulbra_atendimento_id: "a3",
  aluno_id: null,
  aluno_status: "nao_confirmado",
  destino_email: null,
  destino_motivo: "CONFERENCIA",
};

const fetchMock = vi.fn();

beforeEach(() => {
  estado.conversas = [];
  estado.atendimentos = [];
  estado.gestao = false;
  estado.casos = [{ aluno_id: "aluno-1" }, { aluno_id: "aluno-2" }];
  estado.assumir = { ok: true, responsavel: "op1@x" };
  rpcChamadas.length = 0;
  avisosRealtime.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
afterEach(cleanup);

describe("NotificacoesUlbra", () => {
  it("não dispara nenhuma chamada de rede própria — lê o banco", async () => {
    estado.conversas = [CONVERSA];
    render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(screen.getByText("Mensageria ULBRA")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("some da tela quando não há novidade", async () => {
    const { container } = render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("conta mensagens não lidas e leads no mesmo badge", async () => {
    estado.conversas = [CONVERSA];
    estado.atendimentos = [LEAD_MEU];
    render(<NotificacoesUlbra usuario={USUARIO} />);
    // 2 não lidas + 1 lead
    await waitFor(() => expect(screen.getByText("3")).toBeTruthy());
  });

  it("não mostra lead destinado a outro operador", async () => {
    estado.atendimentos = [LEAD_DE_OUTRO];
    const { container } = render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("não mostra ao operador o que está em conferência", async () => {
    estado.atendimentos = [LEAD_EM_CONFERENCIA];
    const { container } = render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("gestão vê o que está em conferência", async () => {
    estado.gestao = true;
    estado.atendimentos = [LEAD_EM_CONFERENCIA];
    render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
  });

  it("assumir chama a RPC do banco e mostra a recusa como ela veio", async () => {
    estado.atendimentos = [LEAD_MEU];
    estado.assumir = { ok: false, motivo: "JA_ASSUMIDO", responsavel: "op2@x" };
    render(<NotificacoesUlbra usuario={USUARIO} />);
    fireEvent.click(await screen.findByText("Mensageria ULBRA"));
    fireEvent.click(await screen.findByText("Assumir"));
    await waitFor(() =>
      expect(screen.getByText("outro operador assumiu primeiro")).toBeTruthy(),
    );
    expect(rpcChamadas.some(([n, a]) => n === "ulbra_atendimento_assumir" && a.p_id === "a1")).toBe(
      true,
    );
  });

  function dublarSom() {
    const osc = { frequency: {}, connect: () => {}, start: () => {}, stop: () => {} };
    const criarOsc = vi.fn(() => osc);
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        createOscillator = criarOsc;
        createGain = () => ({
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: () => {},
        });
        destination = {};
      },
    );
    localStorage.setItem("rv_ulbra_prefs_op1_x", JSON.stringify({ som: true, visual: true }));
    return criarOsc;
  }

  it("primeira carga não toca som", async () => {
    const criarOsc = dublarSom();
    estado.conversas = [CONVERSA];
    render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
    expect(criarOsc).not.toHaveBeenCalled();
  });

  it("toca quando a contagem sobe depois de carregada", async () => {
    const criarOsc = dublarSom();
    estado.conversas = [CONVERSA];
    render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

    estado.conversas = [CONVERSA, { ...CONVERSA, ulbra_conversa_id: "c2", nao_lidas: 1 }];
    avisosRealtime.forEach((cb) => cb({}));
    await waitFor(() => expect(screen.getByText("3")).toBeTruthy());
    expect(criarOsc).toHaveBeenCalled();
  });

  it("com som desligado, a contagem sobe e nada toca", async () => {
    const criarOsc = dublarSom();
    localStorage.setItem("rv_ulbra_prefs_op1_x", JSON.stringify({ som: false, visual: true }));
    estado.conversas = [CONVERSA];
    render(<NotificacoesUlbra usuario={USUARIO} />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

    estado.conversas = [CONVERSA, { ...CONVERSA, ulbra_conversa_id: "c2", nao_lidas: 1 }];
    avisosRealtime.forEach((cb) => cb({}));
    await waitFor(() => expect(screen.getByText("3")).toBeTruthy());
    expect(criarOsc).not.toHaveBeenCalled();
  });
});
