// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as renderNu, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import CentralWhatsApp from "./CentralWhatsApp";

// A Central navega POR DENTRO do CRM ("Abrir ficha completa"), então usa
// useNavigate — que fora de um roteador lança. Todo render passa por aqui;
// os testes de rota mais abaixo montam o roteador deles, com rotas de verdade.
const render = (ui, opcoes) => renderNu(<MemoryRouter>{ui}</MemoryRouter>, opcoes);

// Realtime: canal inerte. A tela não pode depender dele para renderizar.
vi.mock("../services/supabase", () => ({
  supabase: {
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
  },
}));

const servico = vi.hoisted(() => ({
  canais: [],
  cadencia: [],
  cadenciaSalva: [],
  conversas: [],
  mensagens: [],
  resumo: null,
  ficha: null,
  candidatos: [],
  gestao: false,
  filtrosPedidos: [],
  fichasPedidas: [],
  conversaExistente: null,
  enviosNovos: [],
  erroAoIniciar: null,
  alunosAchados: [],
  comandos: [],
  canaisSalvos: [],
  transferencias: [],
  arquivadas: [],
  desarquivadas: [],
  arquivadasLista: [],
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
      { email: "rafaella@aelbra.com.br", nome: "Rafaella" },
    ]),
    marcarLida: vi.fn(async () => {}),
    // Mexem no dado, como o banco. Mock que so registra a chamada deixaria a
    // tela mostrando o estado anterior e o teste passaria por acidente.
    arquivarConversa: vi.fn(async (id) => {
      servico.arquivadas.push(id);
      const c = servico.conversas.find((x) => x.id === id);
      if (c) c.arquivada_em = "2026-08-20T10:00:00Z";
      servico.conversas = servico.conversas.filter((x) => x.id !== id);
    }),
    desarquivarConversa: vi.fn(async (id) => {
      servico.desarquivadas.push(id);
      const c = servico.arquivadasLista.find((x) => x.id === id);
      if (c) { c.arquivada_em = null; c.arquivada_por = null; }
    }),
    carregarResumo: vi.fn(async () => servico.resumo),
    carregarSupervisao: vi.fn(async () => servico.supervisao),
    carregarCadencia: vi.fn(async () => servico.cadencia),
    salvarCadenciaCanal: vi.fn(async (args) => {
      servico.cadenciaSalva.push(args);
    }),
    carregarSyncStatus: vi.fn(async () => []),
    souGestao: vi.fn(async () => servico.gestao),
    carregarFichaAluno: vi.fn(async (id) => {
      servico.fichasPedidas.push(id);
      return servico.ficha;
    }),
    carregarCandidatos: vi.fn(async () => servico.candidatos),
    comandarSessao: vi.fn(async (canalId, comando) => {
      servico.comandos.push({ canalId, comando });
    }),
    salvarCanal: vi.fn(async (args) => {
      servico.canaisSalvos.push(args);
    }),
    // Estes mocks PRECISAM alterar os dados, como o banco faz. Um mock que só
    // registra a chamada deixa a tela mostrando o estado anterior depois da
    // ação, e aí o teste cobra da tela um comportamento que ela nunca poderia
    // ter — ou passa por acidente.
    transferirConversa: vi.fn(async (id, email) => {
      servico.transferencias.push({ id, email });
      const c = servico.conversas.find((x) => x.id === id);
      if (c) {
        c.responsavel_email = email;
        c.responsavel_nome = { "maria@aelbra.com.br": "Maria",
                               "joao@aelbra.com.br": "João",
                               "rafaella@aelbra.com.br": "Rafaella" }[email] || email;
        c.status = "EM_ATENDIMENTO";
      }
    }),
    assumirConversa: vi.fn(async (id) => {
      const c = servico.conversas.find((x) => x.id === id);
      if (c) {
        c.responsavel_email = "eu@aelbra.com.br";
        c.responsavel_nome = "Eu Mesmo";
        c.status = "EM_ATENDIMENTO";
      }
    }),
    retirarResponsavel: vi.fn(async (id) => {
      const c = servico.conversas.find((x) => x.id === id);
      if (c) { c.responsavel_email = null; c.responsavel_nome = null; }
    }),
    buscarAluno: vi.fn(async () => servico.alunosAchados),
    procurarConversaPorTelefone: vi.fn(async () => servico.conversaExistente),
    iniciarConversa: vi.fn(async (args) => {
      servico.enviosNovos.push(args);
      if (servico.erroAoIniciar) throw new Error(servico.erroAoIniciar);
      return { ok: true, conversa_id: "k-nova", ja_existia: false };
    }),
  };
});

const CANAL_ONLINE = {
  id: "c1", apelido: "Cobrança", display_phone_number: "+55 51 1111-1111",
  sessao_chave: "cobranca",
  ativo: true, conexao_status: "CONECTADO", online: true,
  sync_inicial_em: new Date().toISOString(), aguardando_qr: false,
};
// Cadência do canal online, com folga. Os testes que exercitam limite trocam
// campos desta base.
const CADENCIA_LIVRE = {
  canal_id: "c1", canal_apelido: "Cobrança", modo: "ATIVO_CONTROLADO",
  limite_operador: 10, usadas_operador: 4,
  limite_canal: 100, usadas_canal: 37,
  janela_inicio: "09:00:00", janela_fim: "20:00:00", dentro_da_janela: true,
};

const CANAL_FORA = {
  id: "c2", apelido: "Comercial", display_phone_number: "+55 51 2222-2222",
  sessao_chave: "comercial",
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
  // O contexto que a Central guarda ao sair para a ficha vive na sessão. Sem
  // limpar, um teste restauraria o filtro deixado pelo anterior.
  sessionStorage.clear();
  localStorage.clear();
  servico.canais = [CANAL_ONLINE, CANAL_FORA];
  servico.cadencia = [CADENCIA_LIVRE];
  servico.cadenciaSalva = [];
  servico.conversas = [];
  servico.mensagens = [];
  servico.resumo = null;
  servico.ficha = null;
  servico.candidatos = [];
  servico.gestao = false;
  servico.filtrosPedidos = [];
  servico.fichasPedidas = [];
  servico.conversaExistente = null;
  servico.enviosNovos = [];
  servico.erroAoIniciar = null;
  servico.alunosAchados = [];
  servico.comandos = [];
  servico.canaisSalvos = [];
  servico.transferencias = [];
  servico.arquivadas = [];
  servico.desarquivadas = [];
  servico.arquivadasLista = [];
  servico.supervisao = [];
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

  // O contador de resgate ja existia; o que faltava era como ABRIR a lista.
  // Tirar o backlog de "Sem retorno" sem isto o deixaria contado e inalcancavel.
  // ------------------------------------------------------------------ cadência
  // O operador precisa ver o consumo ANTES de escrever. Sem isto ele digita a
  // mensagem inteira para descobrir no envio que já bateu no teto.
  // ------------------------------------------- configuração da cadência (gestão)
  // ------------------------------------------------ ordem e filtro de tempo
  // A Central passa a se comportar como o WhatsApp: quem falou por último fica
  // no topo. A ordenação vem do backend — a tela não reordena nada.
  it("respeita a ordem que o backend devolve, sem reordenar", async () => {
    servico.conversas = [
      conversa({ id: "z", nome_perfil: "Comercial 14h03", ultima_mensagem_em: "2026-08-20T14:03:00Z" }),
      conversa({ id: "y", nome_perfil: "Piloto 14h02", ultima_mensagem_em: "2026-08-20T14:02:00Z" }),
    ];
    render(<CentralWhatsApp />);
    await screen.findByText("Comercial 14h03");
    const nomes = [...document.querySelectorAll("button")]
      .map((b) => b.textContent)
      .filter((t) => /14h0/.test(t));
    expect(nomes[0]).toMatch(/Comercial 14h03/);
    expect(nomes[1]).toMatch(/Piloto 14h02/);
  });

  it("o filtro de tempo vai para o backend, nao filtra no navegador", async () => {
    render(<CentralWhatsApp />);
    await screen.findByText("Central WhatsApp");
    fireEvent.change(screen.getByTitle(/Tempo desde a última mensagem/), {
      target: { value: "4_7_DIAS" },
    });
    await waitFor(() => {
      expect(servico.filtrosPedidos.at(-1).tempoSemInteracao).toBe("4_7_DIAS");
    });
  });

  it("oferece as seis faixas e nao inventa um filtro de ordenacao", async () => {
    render(<CentralWhatsApp />);
    const sel = await screen.findByTitle(/Tempo desde a última mensagem/);
    const opcoes = [...sel.options].map((o) => o.value);
    expect(opcoes).toEqual(["", "ATE_1_DIA", "2_3_DIAS", "4_7_DIAS", "8_15_DIAS", "16_30_DIAS", "MAIS_30_DIAS"]);
    // "Mais recentes" NÃO é um filtro: é a ordenação padrão.
    expect(screen.queryByText(/Mais recentes/i)).toBeNull();
  });

  it("combina busca, canal, status e tempo numa chamada so", async () => {
    render(<CentralWhatsApp />);
    await screen.findByText("Central WhatsApp");
    fireEvent.change(screen.getByTitle(/Tempo desde a última mensagem/), { target: { value: "8_15_DIAS" } });
    fireEvent.click(screen.getByText("Resgate"));
    fireEvent.change(screen.getByPlaceholderText(/Buscar por nome, telefone, CPF ou matrícula/), {
      target: { value: "Maria" },
    });
    await waitFor(() => {
      const p = servico.filtrosPedidos.at(-1);
      expect(p.status).toBe("RESGATE");
      expect(p.tempoSemInteracao).toBe("8_15_DIAS");
      expect(p.busca).toBe("Maria");
    }, { timeout: 2000 });
  });


  it("o rótulo do operador diz exatamente quanto sobrou", async () => {
    servico.resumo = {
      sem_retorno: 0, esperando_mais_1h: 0, esperando_mais_24h: 0, nao_lidas: 0,
      sem_responsavel: 0, em_atendimento: 0, minhas: 0, pendencias_resgate: 0,
      arquivadas_nao_lidas: 0,
    };
    render(<CentralWhatsApp />);
    expect(await screen.findByText("4/10")).toBeTruthy();
    expect(screen.getByText(/Novas abordagens hoje · restam 6/)).toBeTruthy();
  });

  it("gestão altera modo e limites pelo painel de números", async () => {
    servico.gestao = true;
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Números"));
    fireEvent.click((await screen.findAllByText("Editar"))[0]);

    const limiteOp = await screen.findByDisplayValue("10");
    fireEvent.change(limiteOp, { target: { value: "15" } });
    fireEvent.change(screen.getByDisplayValue("100"), { target: { value: "150" } });
    fireEvent.click(screen.getByText("Salvar"));

    await waitFor(() => expect(servico.cadenciaSalva.length).toBe(1));
    const salvo = servico.cadenciaSalva[0];
    expect(salvo.limiteOperador).toBe("15");
    expect(salvo.limiteCanal).toBe("150");
    expect(salvo.modo).toBe("ATIVO_CONTROLADO");
  });

  // A RPC grava os cinco campos de uma vez. Se a tela não devolvesse a janela,
  // trocar o limite apagaria o 09:00–20:00 sem ninguém pedir.
  it("salvar limite NÃO apaga a janela", async () => {
    servico.gestao = true;
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Números"));
    fireEvent.click((await screen.findAllByText("Editar"))[0]);
    fireEvent.change(await screen.findByDisplayValue("10"), { target: { value: "12" } });
    fireEvent.click(screen.getByText("Salvar"));

    await waitFor(() => expect(servico.cadenciaSalva.length).toBe(1));
    expect(servico.cadenciaSalva[0].janelaInicio).toBe("09:00:00");
    expect(servico.cadenciaSalva[0].janelaFim).toBe("20:00:00");
  });

  it("mudar para SOMENTE_RESPOSTAS esconde os limites", async () => {
    servico.gestao = true;
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Números"));
    fireEvent.click((await screen.findAllByText("Editar"))[0]);
    await screen.findByDisplayValue("10");

    fireEvent.change(screen.getByDisplayValue(/Ativo controlado/), {
      target: { value: "SOMENTE_RESPOSTAS" },
    });
    await waitFor(() => expect(screen.queryByDisplayValue("10")).toBeNull());
    expect(screen.getByText(/só dá para responder|responder quem procurou a empresa/i)).toBeTruthy();
  });


  it("mostra o consumo diário do operador", async () => {
    servico.resumo = {
      sem_retorno: 0, esperando_mais_1h: 0, esperando_mais_24h: 0, nao_lidas: 0,
      sem_responsavel: 0, em_atendimento: 0, minhas: 0, pendencias_resgate: 0,
      arquivadas_nao_lidas: 0,
    };
    render(<CentralWhatsApp />);
    expect(await screen.findByText("4/10")).toBeTruthy();
    expect(screen.getByText(/restam 6/)).toBeTruthy();
  });

  it("operador no teto não consegue abrir Nova conversa, e o motivo é o dele", async () => {
    servico.cadencia = [{ ...CADENCIA_LIVRE, usadas_operador: 10 }];
    render(<CentralWhatsApp />);
    const botao = await screen.findByText("Nova conversa");
    await waitFor(() => expect(botao.disabled).toBe(true));
    expect(botao.title).toMatch(/você atingiu 10 conversas novas hoje/i);
  });

  it("canal no teto bloqueia todo mundo, com motivo diferente do teto pessoal", async () => {
    servico.cadencia = [{ ...CADENCIA_LIVRE, usadas_operador: 1, usadas_canal: 100 }];
    render(<CentralWhatsApp />);
    const botao = await screen.findByText("Nova conversa");
    await waitFor(() => expect(botao.disabled).toBe(true));
    expect(botao.title).toMatch(/atingiu 100 conversas novas hoje/i);
    expect(botao.title).not.toMatch(/você atingiu/i);
  });

  it("SOMENTE_RESPOSTAS tira o número da Nova conversa", async () => {
    servico.cadencia = [{ ...CADENCIA_LIVRE, modo: "SOMENTE_RESPOSTAS" }];
    render(<CentralWhatsApp />);
    const botao = await screen.findByText("Nova conversa");
    await waitFor(() => expect(botao.disabled).toBe(true));
    expect(botao.title).toMatch(/só responde quem procurou a empresa/i);
  });

  it("fora da janela avisa o horário, não um erro genérico", async () => {
    servico.cadencia = [{ ...CADENCIA_LIVRE, dentro_da_janela: false }];
    render(<CentralWhatsApp />);
    const botao = await screen.findByText("Nova conversa");
    await waitFor(() => expect(botao.disabled).toBe(true));
    expect(botao.title).toMatch(/entre 09:00 e 20:00/);
  });

  it("PAUSADO bloqueia iniciar conversa", async () => {
    servico.cadencia = [{ ...CADENCIA_LIVRE, modo: "PAUSADO" }];
    render(<CentralWhatsApp />);
    const botao = await screen.findByText("Nova conversa");
    await waitFor(() => expect(botao.disabled).toBe(true));
    expect(botao.title).toMatch(/pausado/i);
  });


  it("o resgate tem filtro proprio e o contador abre a lista", async () => {
    servico.resumo = {
      sem_retorno: 3, esperando_mais_1h: 1, esperando_mais_24h: 0, nao_lidas: 2,
      sem_responsavel: 1, em_atendimento: 2, minhas: 1, pendencias_resgate: 7,
      arquivadas_nao_lidas: 0,
    };
    render(<CentralWhatsApp />);
    await screen.findByText(/pendências resgatadas/i);

    fireEvent.click(screen.getByText("7"));
    await waitFor(() => {
      expect(servico.filtrosPedidos.at(-1).status).toBe("RESGATE");
    });
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

// ---------------------------------------------------------------------------
// NOVA CONVERSA — o operador escreve primeiro.
//
// Sem este caminho, iniciar contato empurrava o operador de volta para o
// celular ou o WhatsApp Web. O que sai por fora não tem histórico na Central,
// não tem responsável e não aparece na supervisão.
// ---------------------------------------------------------------------------
async function abrirFormularioNovaConversa() {
  render(<CentralWhatsApp />);
  const botao = await screen.findByRole("button", { name: "Nova conversa" });
  fireEvent.click(botao);
  return await screen.findByText("Primeira mensagem");
}

// O nome do canal também aparece na faixa de status da página; as asserções
// sobre o formulário precisam ficar dentro dele.
const formulario = () => screen.getByRole("heading", { name: "Nova conversa" }).parentElement;

describe("Central WhatsApp — nova conversa", () => {
  it("não deixa iniciar conversa com todos os números fora do ar", async () => {
    servico.canais = [CANAL_FORA];
    render(<CentralWhatsApp />);
    const botao = await screen.findByRole("button", { name: "Nova conversa" });
    expect(botao.disabled).toBe(true);
  });

  it("libera o botão quando existe número conectado", async () => {
    render(<CentralWhatsApp />);
    const botao = await screen.findByRole("button", { name: "Nova conversa" });
    expect(botao.disabled).toBe(false);
  });

  it("só oferece números que estão conectados agora", async () => {
    // CANAL_FORA está PAREAMENTO_NECESSARIO: responder por ele não sairia.
    servico.canais = [CANAL_ONLINE, CANAL_FORA];
    await abrirFormularioNovaConversa();
    const f = formulario();
    expect(within(f).queryByText(/Comercial/)).toBeNull();
    expect(within(f).getByText(/Cobrança/)).toBeDefined();
    // com um único número disponível não há escolha a fazer
    expect(within(f).queryByRole("combobox")).toBeNull();
  });

  it("não envia sem telefone válido", async () => {
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText(/Escreva a mensagem/), {
      target: { value: "Bom dia" },
    });
    const enviar = screen.getByRole("button", { name: /Enviar e abrir conversa/ });
    expect(enviar.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "99999" },
    });
    expect(await screen.findByText(/Número incompleto/)).toBeDefined();
    expect(screen.getByRole("button", { name: /Enviar e abrir conversa/ }).disabled).toBe(true);
  });

  it("não envia sem mensagem — conversa sem texto não existe no WhatsApp", async () => {
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    expect(await screen.findByText(/Vai para/)).toBeDefined();
    expect(screen.getByRole("button", { name: /Enviar e abrir conversa/ }).disabled).toBe(true);
  });

  it("mostra para onde a mensagem vai, já normalizado", async () => {
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51 99999-8888" },
    });
    expect(await screen.findByText("Vai para +55 (51) 99999-8888")).toBeDefined();
  });

  it("avisa ANTES de escrever que já existe conversa, e de quem é", async () => {
    servico.conversaExistente = {
      conversa_id: "k9",
      responsavel_nome: "Maria",
      aluno_nome: "João da Silva",
      status: "EM_ATENDIMENTO",
    };
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    const aviso = await screen.findByText(/Já existe conversa com este número/);
    expect(aviso.textContent).toContain("Maria");
    expect(aviso.textContent).toContain("João da Silva");
  });

  it("conversa de outro operador não promete que a mensagem vai entrar nela", async () => {
    // Dizer "sua mensagem entra nessa mesma conversa" quando ela é de um colega
    // é prometer o que o banco vai recusar — e o operador só descobriria depois
    // de escrever tudo.
    servico.conversaExistente = { conversa_id: "k9", responsavel_nome: "Maria", aluno_nome: null };
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    const aviso = await screen.findByText(/Já existe conversa com este número/);
    expect(aviso.textContent).not.toContain("entra nessa mesma conversa");
    expect(aviso.textContent).toContain("recusado");
    expect(aviso.textContent).toContain("transferência");
  });

  it("conversa sem responsável avisa que a mensagem entra nela mesma", async () => {
    servico.conversaExistente = { conversa_id: "k9", responsavel_nome: null, aluno_nome: null };
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    const aviso = await screen.findByText(/Já existe conversa com este número/);
    expect(aviso.textContent).toContain("Sem responsável");
    expect(aviso.textContent).toContain("entra nessa mesma conversa");
    expect(aviso.textContent).not.toContain("recusado");
  });

  it("envia com o canal, o telefone normalizado e o texto", async () => {
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "(51) 99999-8888" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Escreva a mensagem/), {
      target: { value: "  Bom dia, aqui é da ULBRA  " },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Enviar e abrir conversa/ }));

    await waitFor(() => expect(servico.enviosNovos.length).toBe(1));
    expect(servico.enviosNovos[0]).toEqual({
      canalId: "c1",
      telefone: "5551999998888",
      alunoId: null,
      texto: "Bom dia, aqui é da ULBRA",
    });
  });

  it("depois de criar, troca o filtro para Minhas — senão a conversa nova sumiria", async () => {
    // Conversa que EU iniciei não está "sem retorno" (ninguém espera resposta
    // minha ainda). No filtro padrão ela nasceria invisível.
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Escreva a mensagem/), {
      target: { value: "Bom dia" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Enviar e abrir conversa/ }));

    await waitFor(() => {
      const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
      expect(ultimo.status).toBe("MINHAS");
    });
  });

  it("mostra a recusa do backend em vez de fingir que enviou", async () => {
    servico.erroAoIniciar = "ja existe conversa com este numero, em atendimento por Maria";
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Escreva a mensagem/), {
      target: { value: "Bom dia" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Enviar e abrir conversa/ }));

    expect(await screen.findByText(/em atendimento por Maria/)).toBeDefined();
  });

  it("escolher aluno preenche o telefone e vincula no envio", async () => {
    servico.alunosAchados = [
      { id: "a1", nome: "João da Silva", matricula: "12345", telefone: "51988887777" },
    ];
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("Nome, CPF ou matrícula"), {
      target: { value: "João" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Procurar" }));

    fireEvent.click(await screen.findByRole("button", { name: /João da Silva · 12345/ }));
    expect(await screen.findByText("Vai para +55 (51) 98888-7777")).toBeDefined();

    fireEvent.change(screen.getByPlaceholderText(/Escreva a mensagem/), {
      target: { value: "Bom dia" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enviar e abrir conversa/ }));

    await waitFor(() => expect(servico.enviosNovos.length).toBe(1));
    expect(servico.enviosNovos[0].alunoId).toBe("a1");
    expect(servico.enviosNovos[0].telefone).toBe("5551988887777");
  });

  it("aluno sem telefone na base não trava o fluxo", async () => {
    servico.alunosAchados = [{ id: "a2", nome: "Sem Fone", matricula: "999", telefone: null }];
    await abrirFormularioNovaConversa();
    fireEvent.change(screen.getByPlaceholderText("Nome, CPF ou matrícula"), {
      target: { value: "Sem" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Procurar" }));
    fireEvent.click(await screen.findByRole("button", { name: /Sem Fone · 999 · sem telefone/ }));

    expect(await screen.findByText(/Vinculando a/)).toBeDefined();
    // o operador ainda pode digitar o número na mão
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51977776666" },
    });
    expect(await screen.findByText("Vai para +55 (51) 97777-6666")).toBeDefined();
  });

  it("com dois números conectados o operador escolhe por qual sai", async () => {
    // A regra "responde pelo mesmo número que recebeu" não vale aqui: ninguém
    // recebeu nada ainda, então a escolha é do operador — e precisa ser
    // explícita, nunca um padrão silencioso.
    servico.canais = [
      CANAL_ONLINE,
      { ...CANAL_ONLINE, id: "c3", apelido: "Comercial",
        display_phone_number: "+55 51 3333-3333", online: true, conexao_status: "CONECTADO" },
    ];
    await abrirFormularioNovaConversa();
    const escolha = within(formulario()).getByRole("combobox");
    expect(escolha.options.length).toBe(2);

    fireEvent.change(escolha, { target: { value: "c3" } });
    fireEvent.change(screen.getByPlaceholderText("(51) 99999-8888"), {
      target: { value: "51999998888" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Escreva a mensagem/), {
      target: { value: "Bom dia" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enviar e abrir conversa/ }));

    await waitFor(() => expect(servico.enviosNovos.length).toBe(1));
    expect(servico.enviosNovos[0].canalId).toBe("c3");
  });

  it("fechar no Cancelar não envia nada", async () => {
    await abrirFormularioNovaConversa();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByText("Primeira mensagem")).toBeNull());
    expect(servico.enviosNovos.length).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// GESTÃO — o que só a gestão pode fazer, e o que ela não conseguia fazer sem
// acesso ao banco.
// ---------------------------------------------------------------------------
describe("Central WhatsApp — gestão", () => {
  it("operador não vê as ações de número", async () => {
    servico.gestao = false;
    render(<CentralWhatsApp />);
    await screen.findByText("Central WhatsApp");
    expect(screen.queryByRole("button", { name: "Números" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconectar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desvincular" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Supervisão" })).toBeNull();
  });

  it("gestão desconecta um número que está no ar", async () => {
    servico.gestao = true;
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(servico.comandos).toEqual([{ canalId: "c1", comando: "desconectar" }]));
  });

  it("número já fora do ar não oferece Desconectar", async () => {
    servico.gestao = true;
    servico.canais = [CANAL_FORA];
    render(<CentralWhatsApp />);
    await screen.findByText("Central WhatsApp");
    expect(screen.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconectar" })).toBeDefined();
  });

  it("desvincular nunca sai em um clique só", async () => {
    // Desvincular obriga a reparear, e o histórico do aparelho só é importado
    // no pareamento. Um clique acidental aqui custa caro.
    servico.gestao = true;
    servico.canais = [CANAL_ONLINE];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Desvincular" }));
    expect(servico.comandos.length).toBe(0);
    expect(screen.getByText(/ler o QR Code de novo/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Confirmar desvincular" }));
    await waitFor(() => expect(servico.comandos).toEqual([{ canalId: "c1", comando: "logout" }]));
  });

  it("dá para desistir do desvincular", async () => {
    servico.gestao = true;
    servico.canais = [CANAL_ONLINE];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Desvincular" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByText(/ler o QR Code de novo/)).toBeNull());
    expect(servico.comandos.length).toBe(0);
  });

  it("gestão cadastra número novo sem precisar de SQL", async () => {
    servico.gestao = true;
    servico.canais = [];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Números" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cadastrar número" }));

    fireEvent.change(screen.getByPlaceholderText("Cobrança"), { target: { value: "Comercial" } });
    fireEvent.change(screen.getByPlaceholderText("+55 51 99999-8888"), {
      target: { value: "+55 51 3333-3333" },
    });
    fireEvent.change(screen.getByPlaceholderText("cobranca"), { target: { value: "  COMERCIAL " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(servico.canaisSalvos.length).toBe(1));
    // a chave é normalizada: divergir do serviço por causa de espaço ou
    // maiúscula é justamente a falha que não avisa
    expect(servico.canaisSalvos[0]).toEqual({
      id: null, apelido: "Comercial", numero: "+55 51 3333-3333",
      sessaoChave: "comercial", ativo: true,
    });
  });

  it("não salva número pela metade", async () => {
    servico.gestao = true;
    servico.canais = [];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Números" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cadastrar número" }));
    fireEvent.change(screen.getByPlaceholderText("Cobrança"), { target: { value: "Comercial" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText(/são obrigatórios/)).toBeDefined();
    expect(servico.canaisSalvos.length).toBe(0);
  });

  it("editar não deixa trocar a chave da sessão", async () => {
    // A chave amarra a conversa ao canal. Trocar depois órfãos o histórico.
    servico.gestao = true;
    servico.canais = [{ ...CANAL_ONLINE, sessao_chave: "piloto" }];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Números" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(screen.getByPlaceholderText("cobranca").disabled).toBe(true);
  });
});


describe("Central WhatsApp — de onde veio a conversa", () => {
  it("conversa que o aluno abriu diz 'recebido em'", async () => {
    servico.conversas = [conversa()];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    expect(await screen.findByText(/recebido em/)).toBeDefined();
  });

  it("conversa que nós abrimos diz 'iniciada por' — ninguém recebeu nada", async () => {
    servico.conversas = [conversa({ aguardando_resposta: false, nao_lidas: 0 })];
    servico.mensagens = [
      { id: "m1", direcao: "SAIDA", texto: "Bom dia", status: "ENVIADO",
        timestamp_wa: new Date().toISOString() },
    ];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    expect(await screen.findByText(/iniciada por/)).toBeDefined();
    expect(screen.queryByText(/recebido em/)).toBeNull();
  });
});


describe("Central WhatsApp — transferência", () => {
  it("cabeçalho mostra o novo responsável mesmo se a conversa sair do filtro", async () => {
    // A conversa pode deixar de casar com o filtro por responsável e sumir da
    // lista. Se o cabeçalho continuasse com o dono antigo, o operador
    // transferiria de novo achando que a primeira não pegou.
    servico.conversas = [conversa({ responsavel_email: null, responsavel_nome: null, nao_lidas: 0 })];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    expect(await screen.findByText("Sem responsável")).toBeDefined();

    // a partir daqui a listagem passa a NÃO devolver esta conversa
    servico.conversas = [];
    const seletor = screen.getByRole("option", { name: "Transferir para…" }).closest("select");
    fireEvent.change(seletor, { target: { value: "maria@aelbra.com.br" } });

    await waitFor(() => expect(servico.transferencias).toEqual([
      { id: "k1", email: "maria@aelbra.com.br" },
    ]));
    // o cabeçalho passa a mostrar o novo dono, mesmo sem a conversa na lista
    // (o seletor `strong` evita casar com a <option> de mesmo nome)
    await waitFor(() =>
      expect(screen.getByText("Maria", { selector: "strong" })).toBeDefined());
  });
});

// ---------------------------------------------------------------------------
// SELECIONAR OPERADOR NÃO PODE SAIR DA CENTRAL
//
// Problema relatado: escolher o próprio nome (ou o de um colega) tirava a
// pessoa da Central e abria outra tela. Quem está atendendo perde a fila, o
// rascunho e o contexto — e no meio de um atendimento isso custa o aluno.
//
// Estes testes montam a Central DENTRO de um roteador de verdade e vigiam a
// rota a cada render. Qualquer `navigate`, `<Navigate>` ou `<a href>` que
// escape aparece aqui como mudança de rota.
//
// A ÚNICA saída autorizada é "Abrir ficha completa" — e ela navega POR DENTRO
// do CRM, na mesma aba, para a ficha do aluno certo. Nada de window.open.
// ---------------------------------------------------------------------------
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";

function SondaRota({ registrar }) {
  const l = useLocation();
  registrar(`${l.pathname}${l.search}${l.hash}`);
  return null;
}

// Trocar o filtro de responsável, de verdade.
//
// DOIS JEITOS DE ESTE TESTE MENTIR, os dois já aconteceram aqui:
//
//   1. guardar a referência do <select> e disparar depois — entre o render
//      inicial e o disparo o elemento é recriado, o evento cai num nó solto e o
//      teste passa sem exercitar nada;
//   2. disparar antes de a lista de operadores chegar — `<select>` recusa um
//      valor que ainda não existe como <option>, o value continua vazio e, de
//      novo, o teste passa sem exercitar nada.
//
// Por isso: espera a opção existir, consulta o select na hora, dispara, e só
// devolve depois de o filtro ter chegado ao serviço.
async function filtrarPorResponsavel(email) {
  if (email) await screen.findByRole("option", { name: NOMES[email] });
  const select = screen.getByRole("option", { name: "Qualquer responsável" }).closest("select");
  fireEvent.change(select, { target: { value: email } });
  await waitFor(() => expect(select.value).toBe(email));
  await waitFor(() => {
    const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
    expect(ultimo.responsavel).toBe(email || "");
  });
}

// Os mesmos nomes que `listarOperadores` devolve acima. Se divergirem, o
// <select> recusa o valor em silêncio e o teste passa sem exercitar nada.
const NOMES = {
  "maria@aelbra.com.br": "Maria",
  "joao@aelbra.com.br": "João",
  "rafaella@aelbra.com.br": "Rafaella",
};

// Roteador de verdade, com a ficha do aluno como rota irmã. `renderNu` e não o
// `render` do topo: aqui o roteador é o do próprio teste, e dois <Router>
// aninhados lançam.
function montarNaRota(registrar) {
  return renderNu(
    <MemoryRouter initialEntries={["/central-whatsapp"]}>
      <SondaRota registrar={registrar} />
      <BotaoVoltar />
      <Menu />
      <Routes>
        <Route path="/central-whatsapp" element={<CentralWhatsApp />} />
        {/* Dublê da ficha: prova QUAL aluno a Central mandou abrir. */}
        <Route path="/aluno" element={<FichaDubla />} />
        <Route path="/outra-area" element={<div>OUTRA ÁREA DO CRM</div>} />
        {/* Se algo navegar para fora, cai aqui e o teste vê a rota mudar. */}
        <Route path="*" element={<div>SAIU DA CENTRAL</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function FichaDubla() {
  const l = useLocation();
  return <div>FICHA DO ALUNO {new URLSearchParams(l.search).get("id")}</div>;
}

// O Voltar do navegador, no nível em que o roteador o enxerga. `navigate(-1)` é
// exatamente o que o botão do navegador dispara — e o MemoryRouter tem a mesma
// pilha de histórico do BrowserRouter.
function BotaoVoltar() {
  const navegar = useNavigate();
  return <button onClick={() => navegar(-1)}>VOLTAR DO NAVEGADOR</button>;
}

const voltar = () => fireEvent.click(screen.getByText("VOLTAR DO NAVEGADOR"));

// O menu do CRM: navegação normal (PUSH), não o Voltar (POP). É a diferença
// que decide se o contexto guardado pode ou não ser restaurado.
function Menu() {
  const navegar = useNavigate();
  return (
    <>
      <button onClick={() => navegar("/outra-area")}>MENU: OUTRA ÁREA</button>
      <button onClick={() => navegar("/central-whatsapp")}>MENU: CENTRAL</button>
    </>
  );
}

const peloMenu = (destino) => fireEvent.click(screen.getByText(`MENU: ${destino}`));

// Só existe para ser procurado no que a tela grava. Se aparecer lá, vazou.
const CPF_DIGITADO = "12345678901";

describe("Central WhatsApp — selecionar operador não navega", () => {
  let rotas;
  let abriuJanela;

  beforeEach(() => {
    rotas = [];
    abriuJanela = vi.spyOn(window, "open").mockImplementation(() => null);
  });
  afterEach(() => abriuJanela.mockRestore());

  const soCentral = () => Array.from(new Set(rotas));

  it("filtrar por responsável muda só o filtro, não a rota", async () => {
    servico.conversas = [conversa()];
    montarNaRota((r) => rotas.push(r));
    await screen.findByText("Central WhatsApp");

    // o filtro chegou ao serviço...
    await filtrarPorResponsavel("maria@aelbra.com.br");
    // ...e a rota não se mexeu
    expect(soCentral()).toEqual(["/central-whatsapp"]);
    expect(screen.queryByText("SAIU DA CENTRAL")).toBeNull();
    expect(abriuJanela).not.toHaveBeenCalled();
  });

  it("percorrer TODOS os operadores do filtro mantém a Central aberta", async () => {
    servico.conversas = [conversa()];
    montarNaRota((r) => rotas.push(r));
    await screen.findByText("Central WhatsApp");

    for (const email of ["maria@aelbra.com.br", "joao@aelbra.com.br", ""]) {
      await filtrarPorResponsavel(email);
    }
    expect(soCentral()).toEqual(["/central-whatsapp"]);
    expect(abriuJanela).not.toHaveBeenCalled();
  });

  it("transferir para um operador não tira ninguém da Central", async () => {
    servico.conversas = [conversa({ responsavel_email: null, responsavel_nome: null, nao_lidas: 0 })];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    montarNaRota((r) => rotas.push(r));
    fireEvent.click(await screen.findByText("Fulano"));

    const seletor = screen.getByRole("option", { name: "Transferir para…" }).closest("select");
    fireEvent.change(seletor, { target: { value: "joao@aelbra.com.br" } });

    await waitFor(() => expect(servico.transferencias.length).toBe(1));
    // Esperar o ciclo de render ASSENTAR antes de olhar a rota: conferir logo
    // após a chamada do serviço checaria um instante em que a navegação ainda
    // não teria acontecido, e o teste passaria com o defeito presente.
    await waitFor(() =>
      expect(screen.getByText("João", { selector: "strong" })).toBeDefined());

    expect(soCentral()).toEqual(["/central-whatsapp"]);
    expect(screen.queryByText("SAIU DA CENTRAL")).toBeNull();
    expect(abriuJanela).not.toHaveBeenCalled();
  });

  it("assumir e retirar responsável também ficam na Central", async () => {
    servico.conversas = [conversa({ responsavel_email: null, responsavel_nome: null, nao_lidas: 0 })];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    montarNaRota((r) => rotas.push(r));
    fireEvent.click(await screen.findByText("Fulano"));

    fireEvent.click(screen.getByRole("button", { name: "Assumir" }));
    // idem: espera a conversa passar a ter dono antes de olhar a rota
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retirar responsável" })).toBeDefined());
    expect(soCentral()).toEqual(["/central-whatsapp"]);
    expect(abriuJanela).not.toHaveBeenCalled();
  });

  it("gestão faz o mesmo e continua na Central", async () => {
    // Gestão tem botões a mais (Números, Supervisão). Nenhum deles é rota.
    servico.gestao = true;
    servico.conversas = [conversa()];
    montarNaRota((r) => rotas.push(r));
    await screen.findByText("Central WhatsApp");

    await filtrarPorResponsavel("rafaella@aelbra.com.br");
    fireEvent.click(await screen.findByRole("button", { name: "Supervisão" }));
    fireEvent.click(await screen.findByRole("button", { name: "Números" }));
    await waitFor(() => expect(screen.getByText("Números da Central")).toBeDefined());

    expect(soCentral()).toEqual(["/central-whatsapp"]);
    expect(screen.queryByText("SAIU DA CENTRAL")).toBeNull();
    expect(abriuJanela).not.toHaveBeenCalled();
  });

  it("a Central não tem link nenhum para outra tela", async () => {
    // Um <a href> perdido navega sem passar por navigate() e escaparia dos
    // testes acima. Aqui a busca é no DOM renderizado.
    servico.gestao = true;
    servico.conversas = [conversa()];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    const { container } = montarNaRota((r) => rotas.push(r));
    fireEvent.click(await screen.findByText("Fulano"));
    await waitFor(() => expect(screen.getByText("Assumir")).toBeDefined());

    expect(container.querySelectorAll("a[href]").length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ABRIR FICHA COMPLETA — MESMA ABA
  //
  // Antes isto era window.open("/aluno", "_blank"): cada clique deixava mais
  // uma aba de ficha aberta e ninguém sabia mais qual Central era a viva. A
  // regressão que estes testes barram é o retorno de QUALQUER forma de sair da
  // aba — window.open, target="_blank", <a href> — e a perda do contexto da
  // Central no caminho de volta.
  // -------------------------------------------------------------------------

  // Deixa a Central num estado RECONHECÍVEL (filtro, canal, busca e uma
  // conversa aberta) e sai por "Abrir ficha completa".
  async function contextualizarESairPelaFicha() {
    servico.conversas = [conversa({ aluno_id: "a1", aluno_nome: "Carlos", nao_lidas: 0 })];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    servico.ficha = { aluno_id: "a1", nome: "Carlos", matricula: "1", saldo_total: 0, saldo_vencido: 0 };
    montarNaRota((r) => rotas.push(r));

    fireEvent.click(await screen.findByRole("button", { name: "Minhas" }));
    const canal = screen.getByRole("option", { name: "Todos os números" }).closest("select");
    fireEvent.change(canal, { target: { value: "c2" } });
    await waitFor(() => expect(canal.value).toBe("c2"));
    await filtrarPorResponsavel("joao@aelbra.com.br");
    // A caixa de busca aceita "nome, telefone, CPF ou matrícula": aqui vai um
    // CPF, que é justamente o que NÃO pode acabar gravado na sessão.
    fireEvent.change(screen.getByPlaceholderText(/Buscar por nome/), {
      target: { value: CPF_DIGITADO },
    });
    fireEvent.click(await screen.findByText("Carlos"));

    fireEvent.click(await screen.findByRole("button", { name: "Abrir ficha completa" }));
  }

  const contextoGuardado = () =>
    JSON.parse(sessionStorage.getItem("reativa_central_whatsapp_estado") || "null");

  it("abre a ficha do aluno certo, na mesma aba, por navegação interna", async () => {
    servico.conversas = [conversa({ aluno_id: "a1", aluno_nome: "Carlos", nao_lidas: 0 })];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    servico.ficha = { aluno_id: "a1", nome: "Carlos", matricula: "1", saldo_total: 0, saldo_vencido: 0 };
    const { container } = montarNaRota((r) => rotas.push(r));
    fireEvent.click(await screen.findByText("Carlos"));

    fireEvent.click(await screen.findByRole("button", { name: "Abrir ficha completa" }));

    // a rota do CRM mudou para a ficha DAQUELE aluno — nada de aba nova
    expect(await screen.findByText("FICHA DO ALUNO a1")).toBeDefined();
    expect(rotas[rotas.length - 1]).toBe("/aluno?id=a1");
    expect(screen.queryByText("SAIU DA CENTRAL")).toBeNull();
    expect(abriuJanela).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[target="_blank"]').length).toBe(0);
  });

  it("Voltar do navegador devolve a Central com canal, filtro e conversa", async () => {
    await contextualizarESairPelaFicha();
    expect(await screen.findByText("FICHA DO ALUNO a1")).toBeDefined();

    voltar();

    // de volta na Central...
    await screen.findByText("Central WhatsApp");
    expect(rotas[rotas.length - 1]).toBe("/central-whatsapp");
    // ...com os MESMOS filtros: quem confirma é o pedido que chega ao serviço,
    // não o visual do chip.
    await waitFor(() => {
      const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
      expect(ultimo.status).toBe("MINHAS");
      expect(ultimo.canalId).toBe("c2");
      expect(ultimo.responsavel).toBe("joao@aelbra.com.br");
    });
    // ...e com a conversa que estava aberta reaberta sozinha: só há botão de
    // ficha quando existe conversa selecionada COM aluno.
    expect(await screen.findByRole("button", { name: "Abrir ficha completa" })).toBeDefined();
    expect(abriuJanela).not.toHaveBeenCalled();
  });

  it("o contexto guardado é só id de canal, id de conversa e filtro — sem PII", async () => {
    await contextualizarESairPelaFicha();

    // Chaves fechadas: qualquer campo novo que alguém acrescente aparece aqui e
    // obriga a decidir, de propósito, se aquilo pode ser gravado.
    const ctx = contextoGuardado();
    expect(Object.keys(ctx).sort()).toEqual([
      "conversaId", "filtroCanal", "filtroResponsavel", "filtroStatus", "filtroTempo",
    ]);
    expect(ctx).toEqual({
      filtroStatus: "MINHAS",
      filtroCanal: "c2",
      filtroTempo: "",
      filtroResponsavel: "joao@aelbra.com.br",
      conversaId: "k1",
    });

    // E, olhando o texto cru: nada do que passou pela tela — CPF digitado,
    // telefone da conversa, nome do aluno ou o texto da mensagem.
    const cru = sessionStorage.getItem("reativa_central_whatsapp_estado");
    for (const pii of [CPF_DIGITADO, "5551999998888", "Carlos", "Fulano", "Oi", "98877-6655"]) {
      expect(cru).not.toContain(pii);
    }
  });

  it("a busca digitada não volta com o Voltar — some junto com o contexto", async () => {
    await contextualizarESairPelaFicha();
    voltar();
    await screen.findByText("Central WhatsApp");

    expect(screen.getByPlaceholderText(/Buscar por nome/).value).toBe("");
    await waitFor(() => {
      const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
      expect(ultimo.busca).toBe("");
      // o filtro que NÃO é PII continua restaurado
      expect(ultimo.canalId).toBe("c2");
    });
  });

  it("o contexto é apagado da sessão assim que a Central volta", async () => {
    await contextualizarESairPelaFicha();
    expect(contextoGuardado()).not.toBeNull();

    voltar();
    await screen.findByText("Central WhatsApp");

    await waitFor(() => expect(contextoGuardado()).toBeNull());
  });

  it("abrir a ficha de OUTRA conversa depois de voltar não ressuscita a anterior", async () => {
    // Duas conversas, cada uma com seu aluno. A armadilha real: voltar da
    // segunda ficha e a Central reabrir a PRIMEIRA conversa.
    servico.conversas = [
      conversa({ id: "k1", aluno_id: "a1", aluno_nome: "Carlos", nome_perfil: "Carlos", nao_lidas: 0 }),
      conversa({ id: "k2", aluno_id: "a2", aluno_nome: "Beatriz", nome_perfil: "Beatriz",
                 telefone_e164: "5551988887777", nao_lidas: 0 }),
    ];
    servico.mensagens = [
      { id: "m1", direcao: "ENTRADA", texto: "Oi", timestamp_wa: new Date().toISOString() },
    ];
    servico.ficha = { aluno_id: "a1", nome: "Carlos", matricula: "1", saldo_total: 0, saldo_vencido: 0 };
    montarNaRota((r) => rotas.push(r));

    // 1ª conversa: abre a ficha e volta
    fireEvent.click(await screen.findByText("Carlos"));
    fireEvent.click(await screen.findByRole("button", { name: "Abrir ficha completa" }));
    expect(await screen.findByText("FICHA DO ALUNO a1")).toBeDefined();
    voltar();
    await screen.findByText("Central WhatsApp");
    expect(await screen.findByRole("button", { name: "Abrir ficha completa" })).toBeDefined();

    // 2ª conversa: a ficha aberta agora é a DELA
    servico.ficha = { aluno_id: "a2", nome: "Beatriz", matricula: "2", saldo_total: 0, saldo_vencido: 0 };
    fireEvent.click(await screen.findByText("Beatriz"));
    await waitFor(() =>
      expect(servico.fichasPedidas[servico.fichasPedidas.length - 1]).toBe("k2"));
    fireEvent.click(await screen.findByRole("button", { name: "Abrir ficha completa" }));

    expect(await screen.findByText("FICHA DO ALUNO a2")).toBeDefined();
    // o contexto gravado é o da SEGUNDA conversa, não o resto da primeira
    expect(contextoGuardado().conversaId).toBe("k2");

    // e o Voltar traz a SEGUNDA de volta
    voltar();
    await screen.findByText("Central WhatsApp");
    await waitFor(() =>
      expect(servico.fichasPedidas[servico.fichasPedidas.length - 1]).toBe("k2"));
  });

  it("conversa restaurada que o filtro de agora não traz não abre sozinha depois", async () => {
    // Sem a busca (que é PII e não volta), a conversa pode simplesmente não
    // estar na lista restaurada. O pedido tem de morrer ali: nada de abrir na
    // cara do operador quando o Realtime recarregar a lista mais tarde.
    await contextualizarESairPelaFicha();
    servico.conversas = [];

    voltar();
    await screen.findByText("Central WhatsApp");
    await waitFor(() => expect(screen.getByText(/Escolha uma conversa/)).toBeDefined());

    // a conversa reaparece numa recarga posterior — e continua fechada
    servico.conversas = [conversa({ aluno_id: "a1", aluno_nome: "Carlos", nao_lidas: 0 })];
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    expect(await screen.findByText("Carlos")).toBeDefined();
    await waitFor(() => expect(screen.getByText(/Escolha uma conversa/)).toBeDefined());
    expect(screen.queryByRole("button", { name: "Abrir ficha completa" })).toBeNull();
  });

  it("sair da ficha pelo menu e voltar à Central pelo menu NÃO restaura nada", async () => {
    // O caminho que o Voltar não cobre: da ficha o operador vai para outra
    // tela pelo menu e só depois reabre a Central. Restaurar aqui reabriria,
    // sem ele pedir, uma conversa de minutos atrás em cima do que ele foi
    // fazer agora.
    await contextualizarESairPelaFicha();
    expect(await screen.findByText("FICHA DO ALUNO a1")).toBeDefined();

    peloMenu("OUTRA ÁREA");
    expect(await screen.findByText("OUTRA ÁREA DO CRM")).toBeDefined();
    peloMenu("CENTRAL");
    await screen.findByText("Central WhatsApp");

    // padrão da tela, não o filtro de antes
    await waitFor(() => {
      const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
      expect(ultimo.status).toBe("SEM_RETORNO");
      expect(ultimo.canalId).toBe("");
      expect(ultimo.responsavel).toBe("");
    });
    // e nenhuma conversa reaberta sozinha
    expect(screen.getByText(/Escolha uma conversa/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Abrir ficha completa" })).toBeNull();
  });

  it("o contexto não restaurado é apagado do mesmo jeito", async () => {
    // Se sobrasse na sessão, a visita SEGUINTE — essa sim pelo Voltar —
    // ressuscitaria um contexto velho.
    await contextualizarESairPelaFicha();
    peloMenu("OUTRA ÁREA");
    await screen.findByText("OUTRA ÁREA DO CRM");
    peloMenu("CENTRAL");
    await screen.findByText("Central WhatsApp");

    await waitFor(() => expect(contextoGuardado()).toBeNull());
  });

  it("o contexto guardado é consumido UMA vez: entrar de novo abre no padrão", async () => {
    await contextualizarESairPelaFicha();
    voltar();
    await waitFor(() => {
      const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
      expect(ultimo.status).toBe("MINHAS");
    });

    // Entrar na Central por qualquer outro caminho não pode herdar o filtro de
    // uma visita passada — o padrão da tela é "Sem retorno".
    cleanup();
    servico.filtrosPedidos = [];
    montarNaRota((r) => rotas.push(r));
    await screen.findByText("Central WhatsApp");
    await waitFor(() => {
      const ultimo = servico.filtrosPedidos[servico.filtrosPedidos.length - 1];
      expect(ultimo.status).toBe("SEM_RETORNO");
      expect(ultimo.canalId).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// ANEXO NA CONVERSA
//
// A mídia é a próxima entrega, mas a Central já tem de saber exibi-la — e,
// principalmente, tem de continuar mostrando a mensagem quando o anexo NÃO pôde
// ser recuperado. Comprovante que some sem aviso é pior do que comprovante que
// não abre.
// ---------------------------------------------------------------------------
describe("Central WhatsApp — anexo", () => {
  it("mensagem com anexo não recuperado avisa, e não some", async () => {
    servico.conversas = [conversa({ nao_lidas: 0 })];
    servico.mensagens = [{
      id: "m1", direcao: "ENTRADA", tipo: "image",
      texto: "segue o comprovante",
      midia_path: null, midia_erro: "anexo acima do limite (22 MB)",
      timestamp_wa: new Date().toISOString(),
    }];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));

    // a legenda continua visível
    expect(await screen.findByText("segue o comprovante")).toBeDefined();
    // e o motivo aparece, em vez de a mensagem parecer vazia
    expect(screen.getByText(/Anexo não recuperado/)).toBeDefined();
    expect(screen.getByText(/22 MB/)).toBeDefined();
  });

  it("mensagem sem anexo e sem texto ainda mostra o tipo", async () => {
    servico.conversas = [conversa({ nao_lidas: 0 })];
    servico.mensagens = [{
      id: "m2", direcao: "ENTRADA", tipo: "sticker", texto: null,
      midia_path: null, midia_erro: null,
      timestamp_wa: new Date().toISOString(),
    }];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    expect(await screen.findByText("[sticker]")).toBeDefined();
  });

  it("mensagem de texto comum não vira anexo", async () => {
    servico.conversas = [conversa({ nao_lidas: 0 })];
    servico.mensagens = [{
      id: "m3", direcao: "ENTRADA", tipo: "text", texto: "só texto",
      timestamp_wa: new Date().toISOString(),
    }];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    expect(await screen.findByText("só texto")).toBeDefined();
    expect(screen.queryByText(/Anexo não recuperado/)).toBeNull();
    expect(screen.queryByText(/carregando anexo/)).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Arquivados.
//
// Arquivar tira a conversa das filas operacionais SEM apagar nada — status,
// responsavel, nao_lidas e historico ficam onde estavam. A regra que sustenta
// tudo: se o aluno escrever de novo, o BANCO desarquiva sozinho. Arquivar nao
// pode virar buraco onde mensagem de aluno some.
// ---------------------------------------------------------------------------
describe("Central WhatsApp — arquivados", () => {
  it("o chip Arquivadas existe entre os filtros", async () => {
    render(<CentralWhatsApp />);
    expect(await screen.findByText("Arquivadas")).toBeDefined();
  });

  it("clicar no chip pede o filtro ARQUIVADAS ao banco", async () => {
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Arquivadas"));
    await waitFor(() =>
      expect(servico.filtrosPedidos.some((f) => f.status === "ARQUIVADAS")).toBe(true));
  });

  it("o chip mostra o contador de nao lidas das arquivadas", async () => {
    servico.resumo = { nao_lidas: 0, arquivadas_nao_lidas: 3 };
    render(<CentralWhatsApp />);
    expect(await screen.findByText(/Arquivadas \(3\)/)).toBeDefined();
  });

  it("sem nao lidas arquivadas, o chip nao mostra numero", async () => {
    servico.resumo = { nao_lidas: 0, arquivadas_nao_lidas: 0 };
    render(<CentralWhatsApp />);
    const chip = await screen.findByText("Arquivadas");
    expect(chip.textContent).toBe("Arquivadas");
  });

  it("ARQUIVAR chama a RPC e a conversa sai da lista", async () => {
    servico.conversas = [conversa({ responsavel_email: "amanda@aelbra.com.br" })];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    fireEvent.click(await screen.findByRole("button", { name: "Arquivar" }));

    await waitFor(() => expect(servico.arquivadas).toEqual(["k1"]));
    // Saiu do filtro atual: manter a thread aberta mostraria uma conversa que
    // nao esta mais na lista.
    await waitFor(() =>
      expect(screen.getByText("Escolha uma conversa à esquerda.")).toBeDefined());
  });

  it("na aba Arquivadas o botao vira Desarquivar", async () => {
    servico.conversas = [conversa({ arquivada_em: "2026-08-20T10:00:00Z",
                                    arquivada_por: "amanda@aelbra.com.br" })];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    expect(await screen.findByRole("button", { name: "Desarquivar" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Arquivar" })).toBeNull();
  });

  it("DESARQUIVAR chama a RPC e a conversa volta as filas", async () => {
    const c = conversa({ arquivada_em: "2026-08-20T10:00:00Z" });
    servico.conversas = [c];
    servico.arquivadasLista = [c];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    fireEvent.click(await screen.findByRole("button", { name: "Desarquivar" }));

    await waitFor(() => expect(servico.desarquivadas).toEqual(["k1"]));
    // Voltou: o botao inverte sem precisar recarregar a pagina.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Arquivar" })).toBeDefined());
  });

  it("arquivar NAO altera responsavel, status nem historico da conversa", async () => {
    const c = conversa({ responsavel_email: "amanda@aelbra.com.br",
                         responsavel_nome: "Amanda", status: "EM_ATENDIMENTO", nao_lidas: 5 });
    servico.conversas = [c];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    fireEvent.click(await screen.findByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(servico.arquivadas).toEqual(["k1"]));

    expect(c.status).toBe("EM_ATENDIMENTO");
    expect(c.responsavel_email).toBe("amanda@aelbra.com.br");
    expect(c.nao_lidas).toBe(5);
  });

  it("clique duplo em Arquivar nao dispara duas vezes", async () => {
    servico.conversas = [conversa()];
    render(<CentralWhatsApp />);
    fireEvent.click(await screen.findByText("Fulano"));
    const botao = await screen.findByRole("button", { name: "Arquivar" });
    fireEvent.click(botao);
    fireEvent.click(botao);
    await waitFor(() => expect(servico.arquivadas.length).toBeGreaterThan(0));
    expect(servico.arquivadas).toEqual(["k1"]);
  });

  it("supervisao mostra arquivadas para a gestao", async () => {
    servico.gestao = true;
    servico.supervisao = [{ responsavel_email: "a@a.com", responsavel_nome: "Amanda",
      em_atendimento: 1, aguardando_resposta: 2, nao_lidas: 3, encerradas_hoje: 0,
      espera_mais_antiga: null, arquivadas: 7, arquivadas_nao_lidas: 4 }];
    render(<CentralWhatsApp />);
    // O painel so aparece para gestao E com a supervisao aberta.
    fireEvent.click(await screen.findByRole("button", { name: "Supervisão" }));
    expect(await screen.findByText("Arq. não lidas")).toBeDefined();
    // Os numeros da gestao: arquivar nao pode esconder conversa do supervisor.
    expect(await screen.findByText("7")).toBeDefined();
    expect(await screen.findByText("4")).toBeDefined();
  });
});
