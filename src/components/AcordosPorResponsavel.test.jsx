// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import AcordosPorResponsavel from "./AcordosPorResponsavel";

// Números reais de produção em 27/09/2026 para amanda.seibel@aelbra.com.br:
// 11 casos na tela contra 753 acordos sob a responsabilidade dela, 726 deles em
// casos de outras pessoas. O teste falha se a tela voltar a confundir as duas
// titularidades.
const PAINEL = {
  responsavel: "amanda.seibel@aelbra.com.br",
  total_acordos: 753, total_valor: 2683032.45, alunos: 699, em_caso_de_outro: 726,
  por_status: [
    { status: "ATIVO", acordos: 653, valor: 2361760.32 },
    { status: "QUITADO", acordos: 82, valor: 114000 },
    { status: "CANCELADO", acordos: 18, valor: 88000 },
  ],
  por_dono_do_caso: [
    { classe: "EU", acordos: 27, valor: 89951.76, ativos: 11 },
    { classe: "OUTRO", acordos: 563, valor: 1808715.87, ativos: 519 },
    { classe: "FILA_LIVRE", acordos: 34, valor: 53774.63, ativos: 4 },
    { classe: "SEM_CASO", acordos: 2, valor: 1429.29, ativos: 0 },
  ],
};

const LISTA = [
  {
    acordo_id: "ac-1", aluno_id: "al-1", nome: "ALUNA NO CASO DA OLGA",
    numero_acordo: "9001", status: "ATIVO", valor: 4500,
    caso_dono_email: "cobranca03@aelbra.com.br", caso_dono_nome: "Olga", caso_dono_classe: "OUTRO",
  },
  {
    acordo_id: "ac-2", aluno_id: "al-2", nome: "ALUNO NO MEU CASO",
    numero_acordo: "9002", status: "ATIVO", valor: 1200,
    caso_dono_email: "amanda.seibel@aelbra.com.br", caso_dono_nome: "Amanda", caso_dono_classe: "EU",
  },
];

const chamadas = vi.hoisted(() => ({ rpc: [] }));

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn, args) => {
      chamadas.rpc.push({ fn, args });
      if (fn === "carteira_geral_acordos_responsaveis")
        return Promise.resolve({
          data: [
            { email: "amanda.seibel@aelbra.com.br", nome: "Amanda", acordos: 753, ativos: 653, ativo: true, existe_em_usuarios: true },
            { email: "cobranca03@aelbra.com.br", nome: "Olga", acordos: 127, ativos: 119, ativo: false, existe_em_usuarios: true },
            { email: "cobranca05@aelbra.com.br", nome: "Luana", acordos: 40, ativos: 33, ativo: true, existe_em_usuarios: true },
          ],
          error: null,
        });
      if (fn === "carteira_geral_acordos_destinos")
        return Promise.resolve({
          data: [
            { email: "carteira.geral@reativa.local", nome: "Carteira Geral", tipo: "CARTEIRA_GERAL" },
            { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "OPERADOR" },
          ],
          error: null,
        });
      if (fn === "carteira_geral_acordos_painel") return Promise.resolve({ data: PAINEL, error: null });
      if (fn === "carteira_geral_acordos_listar") return Promise.resolve({ data: LISTA, error: null });
      if (fn === "carteira_geral_acordos_previa")
        return Promise.resolve({
          data: {
            previa_id: "pv-1", destino_nome: "Luana", destino_email: "cobranca05@aelbra.com.br",
            total_acordos: 1, total_valor: 4500, total_em_caso_de_outro: 1,
            itens: [], conflitos: [{ tipo: "CASO_FICA_COM_OUTRO", acordo_id: "ac-1",
              detalhe: "O acordo 9001 passa para Luana, mas o CASO e a FICHA continuam com cobranca03@aelbra.com.br." }],
          },
          error: null,
        });
      if (fn === "carteira_geral_acordos_mover")
        return Promise.resolve({
          data: { acordos_movidos: 1, destino_nome: "Luana", lote_id: "lote-ac-1", total_recusados: 0 },
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

const EU = "amanda.seibel@aelbra.com.br";
async function montar() {
  render(<AcordosPorResponsavel meuEmail={EU} />);
  await waitFor(() => expect(screen.getByText("ALUNA NO CASO DA OLGA")).toBeTruthy());
}
const ultima = (fn) => [...chamadas.rpc].reverse().find((c) => c.fn === fn)?.args;

describe("Acordos por responsável — a tela", () => {
  beforeEach(() => { chamadas.rpc = []; });
  afterEach(cleanup);

  it("abre em 'Meus acordos' e status ATIVO", async () => {
    await montar();
    const f = ultima("carteira_geral_acordos_listar").p_filtros;
    expect(f.responsavel).toBe(EU);
    expect(f.status).toBe("ATIVO");
  });

  it("mostra contadores de ACORDO separados, incluindo quantos estão em caso de outro", async () => {
    await montar();
    expect(screen.getByText("753")).toBeTruthy();       // acordos
    expect(screen.getByText("726")).toBeTruthy();       // em caso de outra pessoa
    expect(screen.getByText("653")).toBeTruthy();       // ATIVO
    expect(screen.getByText("Em caso de outra pessoa")).toBeTruthy();
  });

  it("diz na tela que dono do caso não é dono do acordo", async () => {
    await montar();
    const sec = screen.getByTestId("acordos-por-responsavel");
    expect(sec.textContent).toMatch(/o dono é o do/);
    expect(sec.textContent).toMatch(/não move o caso nem a ficha/);
  });

  it("'Todos os status' troca o filtro", async () => {
    await montar();
    const sel = screen.getByText("Status do acordo").closest("label").querySelector("select");
    fireEvent.change(sel, { target: { value: "TODOS" } });
    await waitFor(() => expect(ultima("carteira_geral_acordos_listar").p_filtros.status).toBe("TODOS"));
  });

  it("o seletor lista quem TEM acordo, inclusive a operadora inativa", async () => {
    await montar();
    const sel = screen.getByText("Responsável pelo acordo").closest("label").querySelector("select");
    const opcoes = [...sel.querySelectorAll("option")].map((o) => o.textContent);
    expect(opcoes[0]).toBe("Meus acordos");
    expect(opcoes.some((t) => /Olga \(127\) — inativo/.test(t))).toBe(true);
  });

  it("filtrar por outra responsável vai para a RPC com o e-mail exato", async () => {
    await montar();
    const sel = screen.getByText("Responsável pelo acordo").closest("label").querySelector("select");
    fireEvent.change(sel, { target: { value: "cobranca03@aelbra.com.br" } });
    await waitFor(() =>
      expect(ultima("carteira_geral_acordos_painel").p_filtros.responsavel).toBe("cobranca03@aelbra.com.br")
    );
  });

  it("cada linha traz aluno, número, status, valor e dono do caso", async () => {
    await montar();
    const linha = screen.getByText("ALUNA NO CASO DA OLGA").closest("tr");
    expect(within(linha).getByText("9001")).toBeTruthy();
    expect(within(linha).getByText("ATIVO")).toBeTruthy();
    expect(linha.textContent).toMatch(/4\.500,00/);
    expect(linha.textContent).toMatch(/Olga/);
    expect(linha.textContent).toMatch(/O caso é de outro operador/);
  });

  it("o resumo da seleção conta acordo e avisa quantos estão em caso de outro", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar acordo 9001"));
    const r = screen.getByTestId("resumo-acordos");
    expect(r.textContent).toMatch(/1.*acordo\(s\)/);
    expect(r.textContent).toMatch(/1.*em caso de outra pessoa/);
  });

  it("a confirmação avisa que o caso e a ficha não mudam de dono", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await montar();
      fireEvent.click(screen.getByLabelText("Selecionar acordo 9001"));
      const destino = screen.getByText("Novo responsável pelo acordo").closest("label").querySelector("select");
      fireEvent.change(destino, { target: { value: "cobranca05@aelbra.com.br" } });
      fireEvent.change(screen.getByPlaceholderText(/acordos da Olga/), { target: { value: "motivo" } });

      fireEvent.click(screen.getByText(/Conferir movimentação de/));
      await waitFor(() => expect(screen.getByTestId("conflitos-acordos")).toBeTruthy());

      fireEvent.click(screen.getByText("Confirmar movimentação dos acordos"));
      await waitFor(() => expect(confirmar).toHaveBeenCalled());
      expect(confirmar.mock.calls[0][0]).toMatch(/NÃO mudam de dono/);
      expect(confirmar.mock.calls[0][0]).toMatch(/casos de OUTRAS pessoas/);
    } finally {
      confirmar.mockRestore();
    }
  });

  it("a Carteira Geral aparece como destino, marcada como gestão", async () => {
    await montar();
    const sel = screen.getByText("Novo responsável pelo acordo").closest("label").querySelector("select");
    const opcoes = [...sel.querySelectorAll("option")].map((o) => o.textContent);
    expect(opcoes).toContain("Carteira Geral (gestão)");
    expect(opcoes).toContain("Luana");
    // a Olga tem 127 acordos e aparece como ORIGEM, mas nunca como destino
    expect(opcoes.some((t) => /Olga/.test(t))).toBe(false);
  });

  it("o destino NAO sai da lista de quem tem acordo", async () => {
    await montar();
    const origem = screen.getByText("Responsável pelo acordo").closest("label").querySelector("select");
    const destino = screen.getByText("Novo responsável pelo acordo").closest("label").querySelector("select");
    // a origem lista a Olga (inativa, com acordo); o destino nao
    expect([...origem.querySelectorAll("option")].some((o) => /Olga/.test(o.textContent))).toBe(true);
    expect([...destino.querySelectorAll("option")].some((o) => /Olga/.test(o.textContent))).toBe(false);
  });

  it("não deixa gerar prévia sem destino e sem motivo", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar acordo 9001"));
    fireEvent.click(screen.getByText(/Conferir movimentação de/));
    await waitFor(() => expect(screen.getByText(/Escolha o operador de destino/)).toBeTruthy());
    expect(ultima("carteira_geral_acordos_previa")).toBeUndefined();
  });
});
