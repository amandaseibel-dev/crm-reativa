// @vitest-environment jsdom
//
// FILA DE REVISAO CADASTRAL — a tela que fecha o caminho operacional do A7.
//
// Sem ela, o Administrativo e a supervisao nao teriam como VER os contatos
// bloqueados por compartilhamento: a RPC existiria e so o banco responderia.
//
// O que este arquivo prova: a fila aparece, prioriza quem tem 5 ou mais
// pessoas, marca a ficha que fica sem canal alternativo, leva para a ficha do
// aluno pelo link, filtra por canal, nao vaza o contato inteiro na listagem, e
// mostra recado claro quando quem abre nao tem permissao (o 42501 vem do
// portao dentro da propria RPC).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RevisaoCadastral from "./RevisaoCadastral";

let resposta = { data: [], error: null };
let canalPedido;

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (nome, args) => {
      if (nome !== "contato_fila_revisao") throw new Error("RPC inesperada: " + nome);
      canalPedido = args?.p_canal;
      return Promise.resolve(resposta);
    },
  },
}));

const FILA = [
  {
    canal: "TELEFONE",
    contato: "51999991234",
    pessoas: 5,
    fichas: 5,
    revisao_prioritaria: true,
    alunos: [
      { aluno_id: "aaa-1", nome: "Ana Souza", tem_canal_alternativo: true },
      { aluno_id: "aaa-2", nome: "Bruno Lima", tem_canal_alternativo: false },
    ],
  },
  {
    canal: "EMAIL",
    contato: "familia@provedor.com",
    pessoas: 2,
    fichas: 2,
    revisao_prioritaria: false,
    alunos: [{ aluno_id: "bbb-1", nome: "Carla Dias", tem_canal_alternativo: true }],
  },
];

const montar = () => render(<MemoryRouter><RevisaoCadastral /></MemoryRouter>);

beforeEach(() => { resposta = { data: FILA, error: null }; canalPedido = undefined; });
afterEach(cleanup);

describe("Revisão Cadastral", () => {
  it("lista os conflitos e resume o que a gestão precisa decidir", async () => {
    montar();
    const resumo = await screen.findByTestId("resumo");
    expect(resumo.textContent).toMatch(/2\s*contatos em conflito/);
    expect(resumo.textContent).toMatch(/7\s*fichas envolvidas/);   // 5 + 2
    expect(resumo.textContent).toMatch(/1\s*priorit/);
    expect(resumo.textContent).toMatch(/1\s*fichas sem canal alternativo/);

    const linhas = await screen.findAllByTestId("linha-fila");
    expect(linhas.length).toBe(2);
    // o prioritário vem primeiro, na ordem que a RPC devolveu
    expect(screen.getAllByTestId("tag-prioritario").length).toBe(1);
    expect(within(linhas[0]).getByText(/5 pessoas/)).toBeTruthy();
  });

  it("não repete o contato inteiro na listagem", async () => {
    montar();
    await screen.findAllByTestId("linha-fila");
    // o telefone e o e-mail completos NÃO aparecem; o domínio ajuda a reconhecer
    expect(screen.queryByText("51999991234")).toBeNull();
    expect(screen.queryByText("familia@provedor.com")).toBeNull();
    expect(screen.getByText(/@provedor\.com/)).toBeTruthy();
  });

  it("leva para a ficha do aluno e marca quem fica sem canal", async () => {
    montar();
    const linhas = await screen.findAllByTestId("linha-fila");
    const ana = within(linhas[0]).getByText(/Ana Souza/).closest("a");
    expect(ana.getAttribute("href")).toBe("/aluno?id=aaa-1");

    const bruno = within(linhas[0]).getByText(/Bruno Lima/).closest("a");
    expect(within(bruno).getByText(/sem outro canal/i)).toBeTruthy();
    // Ana tem alternativo: não recebe a marca
    expect(within(ana).queryByText(/sem outro canal/i)).toBeNull();
  });

  it("filtra por canal e manda o canal para a RPC", async () => {
    montar();
    await screen.findAllByTestId("linha-fila");
    expect(canalPedido).toBeNull();

    screen.getByTestId("aba-EMAIL").click();
    await waitFor(() => expect(canalPedido).toBe("EMAIL"));
  });

  it("sem permissão, explica de quem é a fila em vez de mostrar erro cru", async () => {
    resposta = { data: null, error: { message: "Acesso negado: fila de revisao cadastral restrita..." } };
    montar();
    const erro = await screen.findByTestId("erro");
    expect(erro.textContent).toMatch(/Administrativo e da supervisão/i);
    expect(erro.textContent).not.toMatch(/42501|restrita\.\.\./);
  });

  it("fila vazia diz que não há nada a revisar", async () => {
    resposta = { data: [], error: null };
    montar();
    expect((await screen.findByTestId("vazio")).textContent).toMatch(/Nada a revisar/i);
  });
});
