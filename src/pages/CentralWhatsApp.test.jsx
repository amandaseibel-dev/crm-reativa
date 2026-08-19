// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
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
  conversaExistente: null,
  enviosNovos: [],
  erroAoIniciar: null,
  alunosAchados: [],
  comandos: [],
  canaisSalvos: [],
  transferencias: [],
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
    comandarSessao: vi.fn(async (canalId, comando) => {
      servico.comandos.push({ canalId, comando });
    }),
    salvarCanal: vi.fn(async (args) => {
      servico.canaisSalvos.push(args);
    }),
    transferirConversa: vi.fn(async (id, email) => {
      servico.transferencias.push({ id, email });
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
  servico.conversaExistente = null;
  servico.enviosNovos = [];
  servico.erroAoIniciar = null;
  servico.alunosAchados = [];
  servico.comandos = [];
  servico.canaisSalvos = [];
  servico.transferencias = [];
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
