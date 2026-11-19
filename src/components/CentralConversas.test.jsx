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
    expect(document.querySelector('[data-campo="vinculo-pendente"]').textContent).toMatch(/Vínculo pendente/);
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
    expect(within(painel).getByRole("button", { name: /prévia/i }).disabled).toBe(true);
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

// TRAVA DE ETAPA: enquanto a `ulbra-conversa` nao estiver publicada, a Central
// nao passa `onConectar`, e o caminho de OAuth nao vai para a tela. O segundo
// caso e o GRUPO DE CONTROLE: sem ele, o primeiro passaria tambem se o painel
// simplesmente nao renderizasse -- verde falso.
describe("trava de etapa: OAuth e envio sem backend", () => {
  const SEM_CONEXAO = { estado: "SEM_CONEXAO", pessoa: null, envioReal: false };

  it("sem backend de conversa (onConectar ausente), nao oferece Conectar", () => {
    tela({ selecionadoChave: "r:c1", conexao: SEM_CONEXAO });
    expect(document.querySelector('[data-campo="conectar"]')).toBeNull();
  });

  it("GRUPO DE CONTROLE: com backend (onConectar presente), oferece Conectar", () => {
    tela({ selecionadoChave: "r:c1", conexao: SEM_CONEXAO, onConectar: () => {} });
    expect(document.querySelector('[data-campo="conectar"]')).toBeTruthy();
  });

  it("conexão ATIVA mas envio real desligado no servidor: resposta bloqueada (capacidade do servidor)", () => {
    const ativa = { estado: "ATIVA", pessoa: "Operador", envioReal: false };
    tela({ selecionadoChave: "r:c1", conexao: ativa, onConectar: () => {}, onPrevia: () => {}, onEnviar: () => {} });
    const area = screen.queryByLabelText("Resposta");
    if (area) expect(area.disabled).toBe(true);
    expect(document.querySelector('[data-campo="confirmar"]')).toBeNull();
  });

  it("conexão ATIVA, envio real e capacidade do servidor para esta conversa: resposta liberada", () => {
    const ativa = { estado: "ATIVA", pessoa: "Operador", envioReal: true };
    tela({ selecionadoChave: "r:c1", conexao: ativa, podeResponder: true, historico: { estado: "ok", mensagens: [] }, onConectar: () => {}, onPrevia: () => {}, onEnviar: () => {} });
    const area = screen.queryByLabelText("Resposta");
    expect(area).toBeTruthy();
    expect(area.disabled).toBe(false);
  });

  it("conexão ATIVA sem capacidade do servidor para a conversa: resposta fechada (padrão)", () => {
    const ativa = { estado: "ATIVA", pessoa: "Operador", envioReal: true };
    tela({ selecionadoChave: "r:c1", conexao: ativa, historico: { estado: "ok", mensagens: [] }, onConectar: () => {}, onPrevia: () => {}, onEnviar: () => {} });
    const area = screen.queryByLabelText("Resposta");
    if (area) expect(area.disabled).toBe(true);
    expect(document.querySelector('[data-campo="confirmar"]')).toBeNull();
  });

  it("sem backend, o envio segue bloqueado: nada de previa nem de confirmar", () => {
    tela({ selecionadoChave: "r:c1", conexao: SEM_CONEXAO });
    expect(document.querySelector('[data-campo="confirmar"]')).toBeNull();
    const area = screen.queryByLabelText("Resposta");
    if (area) expect(area.disabled).toBe(true);
  });
});

// Prévia da lista: CPF FICTÍCIO com e sem pontuação é mascarado; o resto do texto fica.
describe("prévia da lista — CPF mascarado (dados fictícios)", () => {
  it("prévia com CPF formatado e só dígitos sai mascarada; telefone de 11 dígitos não é apagado", () => {
    const dados = {
      respostas: [
        { conversa_id: "p1", nome: "Aluno P1", espera_min: 5, previa: "meu cpf 529.982.247-25 pode ver?", aluno_id: "al-p1", responsavel_reativa: null, atendente_ulbra: null },
        { conversa_id: "p2", nome: "Aluno P2", espera_min: 6, previa: "cpf 52998224725 obrigada", aluno_id: "al-p2", responsavel_reativa: null, atendente_ulbra: null },
        { conversa_id: "p3", nome: "Aluno P3", espera_min: 7, previa: "me liga no 11987654321", aluno_id: "al-p3", responsavel_reativa: null, atendente_ulbra: null },
      ],
      sem_interacao: [],
      novos: [],
    };
    const { container } = render(
      <MemoryRouter>
        <CentralConversas itens={listaPrioridade(dados, "")} selecionadoChave="" onSelecionar={() => {}} onVoltar={() => {}} historico={{ estado: "indisponivel", mensagens: [] }} />
      </MemoryRouter>,
    );
    const texto = container.textContent || "";
    expect(texto).toContain("meu cpf ***.***.***-25 pode ver?");
    expect(texto).toContain("cpf ***.***.***-25 obrigada");
    expect(texto).toContain("me liga no 11987654321");
    expect(texto).not.toContain("529.982.247-25");
    expect(texto).not.toContain("52998224725");
  });
});
