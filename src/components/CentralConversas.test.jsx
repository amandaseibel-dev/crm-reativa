// @vitest-environment jsdom
// Garantias da visão de conversas: ordem por prioridade, responsáveis separados,
// "Abrir ficha" só com CPF confirmado, envio bloqueado e cada estado do histórico
// distinto (carregando, sem mensagens, erro, histórico parcial).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CentralConversas from "./CentralConversas";
import { listaPrioridade } from "../utils/ulbraCentral";

afterEach(() => cleanup());

const DADOS = {
  respostas: [
    { conversa_id: "c1", nome: "Aluno Um", espera_min: 42, previa: "Vou ver", aluno_id: "al-1", responsavel_reativa: "cobranca10@aelbra.com.br", atendente_ulbra: "Atendente A" },
    { conversa_id: "c2", nome: "Aluno Dois", espera_min: 17, previa: null, aluno_id: null, responsavel_reativa: null, atendente_ulbra: null },
  ],
  sem_interacao: [{ aluno_id: "al-3", nome: "Aluno Três", dias_sem_acionamento: 9, faixa: "CRITICO", responsavel_reativa: "cobranca05@aelbra.com.br" }],
  novos: [{ atendimento_id: "n1", nome: "Aluno Novo", espera_min: 3, aluno_id: "al-9" }],
};

function tela(props = {}) {
  return render(
    <MemoryRouter>
      <CentralConversas
        itens={listaPrioridade(DADOS, "")}
        selecionadoChave=""
        onSelecionar={() => {}}
        onVoltar={() => {}}
        historico={{ estado: "indisponivel", mensagens: [] }}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("ordem e lista", () => {
  it("respostas, depois sem interação, depois novos; a ordem do banco se mantém", () => {
    tela();
    const linhas = Array.from(document.querySelectorAll(".ulbra-conv-item")).map((b) => b.getAttribute("data-linha"));
    expect(linhas).toEqual(["resposta", "resposta", "sem_interacao", "novo"]);
  });

  it("mostra responsável no ReATIVA e sem responsável quando não há", () => {
    tela();
    const itens = document.querySelectorAll(".ulbra-conv-item");
    expect(itens[0].textContent).toMatch(/Reativa: cobranca10/);
    expect(itens[1].textContent).toMatch(/Reativa: sem responsável/);
  });

  it("fila vazia diz o que aconteceu, sem parecer erro", () => {
    tela({ itens: [], vazio: "nenhuma resposta aguardando" });
    expect(screen.getByTestId("conv-vazio").textContent).toBe("nenhuma resposta aguardando");
  });

  it("clicar numa conversa chama onSelecionar com a chave", () => {
    const onSelecionar = vi.fn();
    tela({ onSelecionar });
    fireEvent.click(document.querySelectorAll(".ulbra-conv-item")[0]);
    expect(onSelecionar).toHaveBeenCalledWith("r:c1");
  });
});

describe("painel da conversa", () => {
  it("responsável no ReATIVA e atendente na Mensageria são campos separados", () => {
    tela({ selecionadoChave: "r:c1" });
    expect(document.querySelector('[data-campo="responsavel-reativa"]').textContent).toMatch(/cobranca10/);
    expect(document.querySelector('[data-campo="atendente-mensageria"]').textContent).toMatch(/Atendente A/);
  });

  it("Abrir ficha só existe com CPF confirmado (aluno_id)", () => {
    tela({ selecionadoChave: "r:c1" });
    expect(screen.getByText("Abrir ficha").getAttribute("href")).toBe("/aluno?alunoId=al-1&origem=ulbra");
    cleanup();
    tela({ selecionadoChave: "r:c2" });
    expect(screen.queryByText("Abrir ficha")).toBeNull();
    expect(document.querySelector('[data-campo="ficha-bloqueada"]').textContent).toMatch(/CPF não confirmado/);
  });

  it("abrir a ficha chama o gancho que guarda a posição", () => {
    const aoAbrirFicha = vi.fn();
    tela({ selecionadoChave: "r:c1", aoAbrirFicha });
    fireEvent.click(screen.getByText("Abrir ficha"));
    expect(aoAbrirFicha).toHaveBeenCalledTimes(1);
  });

  it("envio fica bloqueado: campo e botão desabilitados", () => {
    tela({ selecionadoChave: "r:c1", historico: { estado: "ok", mensagens: [{ direcao: "ENTRADA", texto: "oi", em: "2026-11-10T10:00:00Z" }] } });
    const painel = document.querySelector(".ulbra-conv-painel");
    expect(within(painel).getByRole("textbox").disabled).toBe(true);
    expect(within(painel).getByRole("button", { name: /enviar/i }).disabled).toBe(true);
    expect(document.querySelector('[data-campo="envio-bloqueado"]').textContent).toMatch(/Envio bloqueado/);
  });

  it("sem conversa selecionada, diz para escolher uma", () => {
    tela();
    expect(screen.getByText("Escolha uma conversa na lista para ver o histórico.")).toBeTruthy();
  });
});

describe("estados do histórico são distintos", () => {
  const casos = [
    [{ estado: "carregando", mensagens: [] }, "carregando", /Carregando a conversa/],
    [{ estado: "indisponivel", mensagens: [] }, "indisponivel", /ainda não ligado/],
    [{ estado: "erro", mensagens: [], erro: "timeout", onTentar: () => {} }, "erro", /Não foi possível carregar o histórico: timeout/],
    [{ estado: "vazio", mensagens: [] }, "vazio", /Nenhuma mensagem nesta conversa/],
  ];
  for (const [historico, estado, texto] of casos) {
    it(`estado ${estado} é só a mensagem dele, sem balões`, () => {
      cleanup();
      tela({ selecionadoChave: "r:c1", historico });
      const el = document.querySelector(`[data-estado="${estado}"]`);
      expect(el).toBeTruthy();
      expect(el.textContent).toMatch(texto);
      expect(document.querySelector(".ulbra-conversa-lista")).toBeNull();
    });
  }

  it("histórico parcial mostra o aviso, os balões e 'Carregar anteriores'", () => {
    const onCarregarAnteriores = vi.fn();
    tela({
      selecionadoChave: "r:c1",
      historico: { estado: "parcial", total: 80, mensagens: [{ direcao: "SAIDA", texto: "Olá", em: "2026-11-10T10:00:00Z" }], onCarregarAnteriores },
    });
    const aviso = document.querySelector('[data-estado="parcial"]');
    expect(aviso.textContent).toMatch(/Histórico parcial/);
    expect(aviso.textContent).toMatch(/últimas 1 de 80/);
    expect(document.querySelector(".ulbra-conversa-lista")).toBeTruthy();
    fireEvent.click(screen.getByText("Carregar anteriores"));
    expect(onCarregarAnteriores).toHaveBeenCalledTimes(1);
  });
});

describe("celular", () => {
  it("o botão Voltar chama onVoltar; o contêiner diz se mostra lista ou conversa", () => {
    const onVoltar = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <CentralConversas itens={listaPrioridade(DADOS, "")} selecionadoChave="" onSelecionar={() => {}} onVoltar={onVoltar} historico={{ estado: "indisponivel", mensagens: [] }} />
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-testid="visao-conversas"]').getAttribute("data-mostra")).toBe("lista");
    rerender(
      <MemoryRouter>
        <CentralConversas itens={listaPrioridade(DADOS, "")} selecionadoChave="r:c1" onSelecionar={() => {}} onVoltar={onVoltar} historico={{ estado: "indisponivel", mensagens: [] }} />
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-testid="visao-conversas"]').getAttribute("data-mostra")).toBe("conversa");
    fireEvent.click(screen.getByLabelText("Voltar para a lista"));
    expect(onVoltar).toHaveBeenCalledTimes(1);
  });
});
