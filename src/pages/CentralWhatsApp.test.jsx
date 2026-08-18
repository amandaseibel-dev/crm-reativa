// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import CentralWhatsApp from "./CentralWhatsApp";

// Realtime: canal inerte. A tela não pode depender dele para renderizar.
vi.mock("../services/supabase", () => ({
  supabase: {
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
  },
}));

const servico = vi.hoisted(() => ({
  canais: [],
  conversas: [],
  mensagens: [],
  resumo: null,
  ficha: null,
  candidatos: [],
  gestao: false,
  filtrosPedidos: [],
  fichasPedidas: [],
}));

vi.mock("../services/whatsapp", async (original) => {
  const real = await original();
  return {
    ...real,
    listarCanais: vi.fn(async () => servico.canais),
    listarConversas: vi.fn(async (args) => {
      servico.filtrosPedidos.push(args);
      return servico.conversas;
    }),
    listarMensagens: vi.fn(async () => servico.mensagens),
    listarOperadores: vi.fn(async () => [
      { email: "maria@aelbra.com.br", nome: "Maria" },
      { email: "joao@aelbra.com.br", nome: "João" },
    ]),
    marcarLida: vi.fn(async () => {}),
    carregarResumo: vi.fn(async () => servico.resumo),
    carregarSupervisao: vi.fn(async () => []),
    carregarSyncStatus: vi.fn(async () => []),
    souGestao: vi.fn(async () => servico.gestao),
    carregarFichaAluno: vi.fn(async (id) => {
      servico.fichasPedidas.push(id);
      return servico.ficha;
    }),
    carregarCandidatos: vi.fn(async () => servico.candidatos),
  };
});

const CANAL_ONLINE = {
  id: "c1", apelido: "Cobrança", display_phone_number: "+55 51 1111-1111",
  ativo: true, conexao_status: "CONECTADO", online: true,
  sync_inicial_em: new Date().toISOString(), aguardando_qr: false,
};
const CANAL_FORA = {
  id: "c2", apelido: "Comercial", display_phone_number: "+55 51 2222-2222",
  ativo: true, conexao_status: "PAREAMENTO_NECESSARIO", online: false,
  sync_inicial_em: null, aguardando_qr: true,
};

function conversa(extra = {}) {
  return {
    id: "k1",
    canal_id: "c1",
    canal_apelido: "Cobrança",
    canal_numero: "+55 51 1111-1111",
    telefone_e164: "5551999998888",
    nome_perfil: "Fulano",
    status: "NOVO",
    responsavel_email: null,
    responsavel_nome: null,
    nao_lidas: 2,
    aluno_id: null,
    aluno_nome: null,
    aluno_status: "NAO_ENCONTRADO",
    ultima_mensagem_em: new Date().toISOString(),
    ultima_mensagem_previa: "Oi, quero negociar",
    aguardando_resposta: true,
    aguardando_desde: new Date(Date.now() - 3600000).toISOString(),
    origem_sync: false,
    ...extra,
  };
}

beforeEach(() => {
  // jsdom nao implementa scrollIntoView, e a thread rola sozinha ao receber
  // mensagem. Sem este stub o teste quebra por um detalhe de ambiente.
  Element.prototype.scrollIntoView = vi.fn();
  servico.canais = [CANAL_ONLINE, CANAL_FORA];
  servico.conversas = [];
  servico.mensagens = [];
  servico.resumo = null;
  servico.ficha = null;
  servico.candidatos = [];
  servico.gestao = false;
  servico.filtrosPedidos = [];
  servico.fichasPedidas = [];
});

afterEach(cleanup);

describe("Central WhatsApp", () => {
  it("é UMA central só — nunca uma por número", async () => {
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Central WhatsApp")).toBeDefined();
    expect(screen.queryByText(/Central WhatsApp 0?1/)).toBeNull();
    expect(screen.queryByText(/Central WhatsApp 0?2/)).toBeNull();
  });

  it("abre JÁ no filtro de quem está sem retorno", async () => {
    render(<CentralWhatsApp />);
    await waitFor(() => expect(servico.filtrosPedidos.length).toBeGreaterThan(0));
    expect(servico.filtrosPedidos[0].status).toBe("SEM_RETORNO");
  });

  it("mostra o estado de conexão de cada número", async () => {
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Conectado")).toBeDefined();
    expect(screen.getByText("Precisa ler o QR de novo")).toBeDefined();
  });

  it("avisa quando um número ainda não teve o histórico importado", async () => {
    render(<CentralWhatsApp />);
    expect(await screen.findByText(/histórico ainda não importado/)).toBeDefined();
  });

  it("QR Code é só para a gestão", async () => {
    render(<CentralWhatsApp />);
    await screen.findByText("Conectado");
    expect(screen.queryByText("Ver QR Code")).toBeNull();

    cleanup();
    servico.gestao = true;
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Ver QR Code")).toBeDefined();
  });

  it("lista a conversa com o número que RECEBEU", async () => {
    servico.conversas = [conversa()];
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Oi, quero negociar")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined(); // não lidas
  });

  it("cai no telefone quando nem nome de perfil veio", async () => {
    servico.conversas = [conversa({ nome_perfil: null })];
    render(<CentralWhatsApp />);
    expect(await screen.findByText("+55 (51) 99999-8888")).toBeDefined();
  });

  it("mostra o possível aluno sem carregar ficha nenhuma na lista", async () => {
    servico.conversas = [
      conversa({ aluno_id: "a1", aluno_nome: "João da Silva", aluno_status: "IDENTIFICADO" }),
    ];
    render(<CentralWhatsApp />);
    expect(await screen.findByText(/Possível aluno: João da Silva/)).toBeDefined();
    // A ficha NAO pode ser buscada por linha listada — é o que segura a
    // performance com 11 operadores olhando a central ao mesmo tempo.
    expect(servico.fichasPedidas).toHaveLength(0);
  });

  it("só carrega a ficha quando o operador ABRE a conversa", async () => {
    servico.conversas = [
      conversa({ aluno_id: "a1", aluno_nome: "João da Silva", aluno_status: "IDENTIFICADO" }),
    ];
    servico.ficha = {
      aluno_id: "a1", nome: "João da Silva", matricula: "2024001",
      saldo_vencido: 1200.5, saldo_total: 3400, acordos_ativos: 1,
    };
    render(<CentralWhatsApp />);
    (await screen.findByText("Oi, quero negociar")).click();

    await waitFor(() => expect(servico.fichasPedidas).toEqual(["k1"]));
    expect(await screen.findByText(/matrícula 2024001/)).toBeDefined();
    expect(screen.getByText(/R\$\s?1\.200,50/)).toBeDefined();
  });

  it("telefone ambíguo NUNCA escolhe aluno sozinho — pergunta", async () => {
    servico.conversas = [conversa({ aluno_status: "AMBIGUO" })];
    servico.candidatos = [
      { id: "a1", nome: "Ana Souza", matricula: "111" },
      { id: "a2", nome: "Bruno Souza", matricula: "222" },
    ];
    render(<CentralWhatsApp />);
    expect(await screen.findByText(/Mais de um aluno com este telefone/)).toBeDefined();

    (await screen.findByText("Oi, quero negociar")).click();
    expect(await screen.findByText(/Qual deles é\?/)).toBeDefined();
    expect(screen.getByText(/Ana Souza/)).toBeDefined();
    expect(screen.getByText(/Bruno Souza/)).toBeDefined();
  });

  it("mostra quem é o responsável, e avisa quando não tem", async () => {
    servico.conversas = [
      conversa({ id: "k1", responsavel_email: "maria@aelbra.com.br", responsavel_nome: "Maria" }),
      conversa({ id: "k2", ultima_mensagem_previa: "outra conversa" }),
    ];
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Maria")).toBeDefined();
    expect(screen.getByText("sem responsável")).toBeDefined();
  });

  it("libera o campo de resposta quando o número está no ar", async () => {
    servico.conversas = [conversa()];
    render(<CentralWhatsApp />);
    (await screen.findByText("Oi, quero negociar")).click();
    expect(await screen.findByPlaceholderText("Escreva a resposta…")).toBeDefined();
  });

  it("BLOQUEIA a resposta quando o número está fora do ar — e explica por quê", async () => {
    servico.conversas = [
      conversa({ canal_id: "c2", canal_apelido: "Comercial", canal_numero: "+55 51 2222-2222" }),
    ];
    render(<CentralWhatsApp />);
    (await screen.findByText("Oi, quero negociar")).click();

    expect(await screen.findByText(/continua guardada aqui/)).toBeDefined();
    expect(screen.queryByPlaceholderText("Escreva a resposta…")).toBeNull();
  });

  it("conversa finalizada não aceita resposta até ser reaberta", async () => {
    servico.conversas = [conversa({ status: "ENCERRADO" })];
    render(<CentralWhatsApp />);
    (await screen.findByText("Oi, quero negociar")).click();

    expect(await screen.findByText(/Conversa finalizada/)).toBeDefined();
    expect(screen.getByText("Reabrir")).toBeDefined();
  });

  it("ler NÃO tira a conversa da fila de quem espera", async () => {
    servico.conversas = [conversa({ nao_lidas: 2, aguardando_resposta: true })];
    render(<CentralWhatsApp />);
    (await screen.findByText("Oi, quero negociar")).click();

    // A etiqueta de espera continua na lista depois de abrir: ler não é responder.
    expect(await screen.findByText(/esperando 1h/)).toBeDefined();
  });

  it("marca as conversas resgatadas do histórico do aparelho", async () => {
    servico.conversas = [conversa({ origem_sync: true })];
    render(<CentralWhatsApp />);
    expect(await screen.findByText("resgatada")).toBeDefined();
  });

  it("busca fala em CPF e matrícula, não só telefone", async () => {
    render(<CentralWhatsApp />);
    expect(
      await screen.findByPlaceholderText("Buscar por nome, telefone, CPF ou matrícula"),
    ).toBeDefined();
  });

  it("oferece os filtros que a operação precisa para saber o que atender", async () => {
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Sem retorno")).toBeDefined();
    expect(screen.getByText("Minhas")).toBeDefined();
    expect(screen.getByText("Não lidas")).toBeDefined();
    expect(screen.getByText("Aguardando atendimento")).toBeDefined();
    expect(screen.getByText("Em atendimento")).toBeDefined();
    expect(screen.getByText("Finalizadas")).toBeDefined();
  });

  it("permite filtrar por responsável", async () => {
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Qualquer responsável")).toBeDefined();
  });

  it("supervisão é só da gestão", async () => {
    render(<CentralWhatsApp />);
    await screen.findByText("Central WhatsApp");
    expect(screen.queryByText("Supervisão")).toBeNull();

    cleanup();
    servico.gestao = true;
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Supervisão")).toBeDefined();
  });

  it("o painel conta quem espera, incluindo o resgate do histórico", async () => {
    servico.resumo = {
      sem_retorno: 12, esperando_mais_1h: 8, esperando_mais_24h: 3,
      nao_lidas: 5, sem_responsavel: 7, em_atendimento: 4, minhas: 2,
      pendencias_resgate: 41, espera_mais_antiga: new Date(Date.now() - 2 * 86400000).toISOString(),
    };
    render(<CentralWhatsApp />);
    expect(await screen.findByText("12")).toBeDefined();
    expect(screen.getByText("41")).toBeDefined();
    expect(screen.getByText("pendências resgatadas")).toBeDefined();
    expect(screen.getByText(/espera mais antiga:/)).toBeDefined();
  });
});
