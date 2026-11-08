// Garantias deste módulo, em ordem de importância:
// 1. equipe de fora NÃO entra, em nenhum caminho;
// 2. identidade só sai de vínculo por CPF — nunca de nome;
// 3. carteira e fidelização vêm antes do rodízio;
// 4. o incremental não repete e não perde;
// 5. a cadência configurada cabe no teto de 500 chamadas/dia.
import { describe, it, expect } from "vitest";
import {
  CADENCIA_PADRAO,
  LIMITE_PAGINA,
  TETO_DIARIO,
  cargaAtendimentos,
  cargaConversas,
  custoDiarioEstimado,
  decidirDestino,
  identificar,
  lerAtendimentos,
  lerCorpoMcp,
  lerPaginaConversas,
  novoCursor,
  operadoresDisponiveis,
  proximoDoRodizio,
  resultadoDoEnvelope,
  type OperadorRodizio,
  type VinculoAtivo,
} from "./sincronizar.ts";

// Recorte real da `listar_conversas`, medido em 08/11/2026 (ids e nomes
// trocados; nenhum dado de aluno real neste arquivo).
const CONVERSAS = {
  conversas: [
    {
      id: "c1".padEnd(24, "0"),
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "k1".padEnd(24, "0"), nome: "Cliente Um" },
      equipe: "Reativa",
      responsavel: "operadora um",
      ultimaMensagemEm: "2026-11-08T05:00:00.000Z",
      ultimaMensagem: { quem: "cliente", em: "2026-11-08T05:00:00.000Z", trecho: "pode ser hoje" },
    },
    {
      id: "c2".padEnd(24, "0"),
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "k2".padEnd(24, "0"), nome: "Cliente Dois" },
      equipe: "Única",
      responsavel: "capta um",
      ultimaMensagemEm: "2026-11-08T04:30:00.000Z",
      ultimaMensagem: { quem: "cliente", em: "2026-11-08T04:30:00.000Z", trecho: "quero ingressar" },
    },
    {
      id: "c3".padEnd(24, "0"),
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "k3".padEnd(24, "0"), nome: "Cliente Três" },
      equipe: "Reativa",
      responsavel: "operadora dois",
      ultimaMensagemEm: "2026-11-08T04:00:00.000Z",
      ultimaMensagem: { quem: "operador", em: "2026-11-08T04:00:00.000Z", trecho: "bom dia" },
    },
  ],
  paginacao: { pagina: 1, limite: 50, total: 420 },
};

describe("corte por equipe", () => {
  it("só devolve conversa da equipe Reativa", () => {
    const { conversas } = lerPaginaConversas(CONVERSAS, null);
    expect(conversas.map((c) => c.ulbra_cliente_id)).toEqual([
      "k1".padEnd(24, "0"),
      "k3".padEnd(24, "0"),
    ]);
  });

  it("não devolve atendimento de outra equipe", () => {
    const lidos = lerAtendimentos({
      atendimentos: [
        { id: "a1", cliente: { id: "k1", nome: "Um" }, equipe: "Reativa", situacao: "waiting", entrouEm: "2026-11-08T05:00:00Z" },
        { id: "a2", cliente: { id: "k2", nome: "Dois" }, equipe: "Única", situacao: "waiting" },
        { id: "a3", cliente: { id: "k3", nome: "Três" }, equipe: "CR Canoas", situacao: "waiting" },
      ],
    });
    expect(lidos).toHaveLength(1);
    expect(lidos[0].ulbra_atendimento_id).toBe("a1");
  });
});

describe("resposta do cliente", () => {
  it("marca resposta só quando quem mandou foi o cliente", () => {
    const { conversas } = lerPaginaConversas(CONVERSAS, null);
    expect(conversas[0].resposta_do_cliente).toBe(true);
    expect(conversas[1].resposta_do_cliente).toBe(false);
  });
});

describe("incremental por cursor", () => {
  it("cursor exclusivo: o que tem a mesma hora não volta", () => {
    const { conversas } = lerPaginaConversas(CONVERSAS, "2026-11-08T05:00:00.000Z");
    expect(conversas).toHaveLength(0);
  });

  it("devolve só o que é mais novo que o cursor", () => {
    const { conversas } = lerPaginaConversas(CONVERSAS, "2026-11-08T04:30:00.000Z");
    expect(conversas.map((c) => c.ulbra_conversa_id)).toEqual(["c1".padEnd(24, "0")]);
  });

  it("página incompleta não pede a próxima", () => {
    expect(lerPaginaConversas(CONVERSAS, null).pode_ter_mais).toBe(false);
  });

  it("página cheia e inteira acima do cursor pede a próxima", () => {
    const cheia = {
      conversas: Array.from({ length: LIMITE_PAGINA }, (_, i) => ({
        id: `x${i}`,
        cliente: { id: `k${i}`, nome: null },
        equipe: "Reativa",
        situacao: "active",
        canal: "whatsapp",
        ultimaMensagemEm: `2026-11-08T0${(i % 9) + 1}:00:00.000Z`,
        ultimaMensagem: { quem: "cliente", trecho: "oi" },
      })),
      paginacao: { total: 420 },
    };
    expect(lerPaginaConversas(cheia, "2026-11-07T00:00:00.000Z").pode_ter_mais).toBe(true);
  });

  it("cursor novo é o máximo visto e nunca anda para trás", () => {
    const p = lerPaginaConversas(CONVERSAS, null);
    const colheita = { paginas: [p], truncado: false, conversas: p.conversas };
    expect(novoCursor(null, colheita)).toBe("2026-11-08T05:00:00.000Z");
    expect(novoCursor("2026-11-09T00:00:00.000Z", colheita)).toBe("2026-11-09T00:00:00.000Z");
  });

  it("nada novo mantém o cursor", () => {
    const p = lerPaginaConversas(CONVERSAS, "2026-11-08T05:00:00.000Z");
    const colheita = { paginas: [p], truncado: false, conversas: p.conversas };
    expect(novoCursor("2026-11-08T05:00:00.000Z", colheita)).toBe("2026-11-08T05:00:00.000Z");
  });
});

describe("identidade", () => {
  const vinculos = new Map<string, VinculoAtivo>([
    ["kCPF", { ulbra_cliente_id: "kCPF", aluno_id: "aluno-1", confianca: "alta_cpf" }],
    ["kVELHO", { ulbra_cliente_id: "kVELHO", aluno_id: "aluno-2", confianca: "alta" }],
    ["kAMBIGUO", { ulbra_cliente_id: "kAMBIGUO", aluno_id: "aluno-3", confianca: "ambigua" }],
  ]);

  it("vínculo por CPF identifica", () => {
    expect(identificar("kCPF", vinculos)).toEqual({ aluno_id: "aluno-1", aluno_status: "vinculado" });
  });

  it("selo antigo 'alta' NÃO identifica", () => {
    expect(identificar("kVELHO", vinculos).aluno_status).toBe("nao_confirmado");
    expect(identificar("kVELHO", vinculos).aluno_id).toBeNull();
  });

  it("ambígua não identifica", () => {
    expect(identificar("kAMBIGUO", vinculos).aluno_status).toBe("nao_confirmado");
  });

  it("sem vínculo vai para conferência", () => {
    expect(identificar("kNADA", vinculos)).toEqual({ aluno_id: null, aluno_status: "nao_confirmado" });
  });
});

describe("rodízio do receptivo", () => {
  const AGORA = Date.parse("2026-11-08T12:00:00.000Z");
  const online = (p: Partial<OperadorRodizio>): OperadorRodizio => ({
    email: "a@x",
    atendimentos_hoje: 0,
    ultimo_atendimento: null,
    em_pausa: false,
    online_em: "2026-11-08T11:59:50.000Z",
    ...p,
  });

  it("tira quem está em pausa e quem está offline", () => {
    const fila = [
      online({ email: "ativo@x" }),
      online({ email: "pausa@x", em_pausa: true }),
      online({ email: "offline@x", online_em: "2026-11-08T11:55:00.000Z" }),
    ];
    expect(operadoresDisponiveis(fila, AGORA).map((o) => o.email)).toEqual(["ativo@x"]);
  });

  it("escolhe quem tem menos atendimentos hoje", () => {
    const fila = [
      online({ email: "muitos@x", atendimentos_hoje: 5 }),
      online({ email: "poucos@x", atendimentos_hoje: 1 }),
    ];
    expect(proximoDoRodizio(fila, AGORA)).toBe("poucos@x");
  });

  it("empate vai para quem atendeu há mais tempo", () => {
    const fila = [
      online({ email: "recente@x", atendimentos_hoje: 2, ultimo_atendimento: "2026-11-08T11:50:00Z" }),
      online({ email: "antigo@x", atendimentos_hoje: 2, ultimo_atendimento: "2026-11-08T09:00:00Z" }),
    ];
    expect(proximoDoRodizio(fila, AGORA)).toBe("antigo@x");
  });

  it("fila vazia não inventa operador", () => {
    expect(proximoDoRodizio([], AGORA)).toBeNull();
  });
});

describe("destino", () => {
  const AGORA = Date.parse("2026-11-08T12:00:00.000Z");
  const fila: OperadorRodizio[] = [
    {
      email: "rodizio@x",
      atendimentos_hoje: 0,
      ultimo_atendimento: null,
      em_pausa: false,
      online_em: "2026-11-08T11:59:50.000Z",
    },
  ];

  it("identidade não confirmada vai para conferência, sem destino", () => {
    const d = decidirDestino(
      { identidade: { aluno_id: null, aluno_status: "nao_confirmado" }, caso: null, fila },
      AGORA,
    );
    expect(d).toEqual({ destino_email: null, destino_motivo: "CONFERENCIA" });
  });

  it("aluno com dono na carteira vai para o dono, não para o rodízio", () => {
    const d = decidirDestino(
      {
        identidade: { aluno_id: "aluno-1", aluno_status: "vinculado" },
        caso: { operador_email: "dono@x" },
        fila,
      },
      AGORA,
    );
    expect(d).toEqual({ destino_email: "dono@x", destino_motivo: "CARTEIRA" });
  });

  it("aluno sem dono vai ao rodízio", () => {
    const d = decidirDestino(
      {
        identidade: { aluno_id: "aluno-1", aluno_status: "vinculado" },
        caso: { operador_email: null },
        fila,
      },
      AGORA,
    );
    expect(d).toEqual({ destino_email: "rodizio@x", destino_motivo: "RODIZIO" });
  });

  it("ninguém online não vira destino nulo silencioso: fica SEM_OPERADOR", () => {
    const d = decidirDestino(
      { identidade: { aluno_id: "aluno-1", aluno_status: "vinculado" }, caso: null, fila: [] },
      AGORA,
    );
    expect(d).toEqual({ destino_email: null, destino_motivo: "SEM_OPERADOR" });
  });
});

describe("envelope", () => {
  it("lê o corpo SSE", () => {
    const corpo = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"{\\"conversas\\":[]}"}]}}\n\n`;
    const envelope = lerCorpoMcp("text/event-stream", corpo);
    expect(resultadoDoEnvelope(envelope)).toEqual({ conversas: [] });
  });

  it("erro do MCP levanta em vez de virar lista vazia", () => {
    expect(() => resultadoDoEnvelope({ error: { message: "limite" } })).toThrow(/MCP_ERRO/);
  });
});

describe("chamadas", () => {
  it("conversas pede whatsapp ativo, 50 por página", () => {
    expect(cargaConversas(2).params.arguments).toEqual({
      canal: "whatsapp",
      situacao: "active",
      limite: 50,
      pagina: 2,
    });
  });

  it("atendimentos pede os em espera", () => {
    expect(cargaAtendimentos().params.arguments).toEqual({ situacao: "waiting", limite: 500 });
  });
});

describe("orçamento", () => {
  it("a cadência padrão cabe no teto de 500/dia", () => {
    const c = custoDiarioEstimado(CADENCIA_PADRAO);
    expect(c.cabe).toBe(true);
    expect(c.total).toBeLessThanOrEqual(TETO_DIARIO);
    // O número da decisão, cravado: se alguém mexer na cadência, este teste
    // muda junto e a conta volta para a mesa.
    expect(c).toMatchObject({ conversas: 144, atendimentos: 48, fichas: 60, total: 290 });
  });

  it("apertar para 1 minuto estoura o teto", () => {
    const c = custoDiarioEstimado({ ...CADENCIA_PADRAO, cadencia_conversas_min: 1 });
    expect(c.cabe).toBe(false);
  });

  it("5 minutos ainda cabe, mas sem folga para o dobro de fichas", () => {
    expect(custoDiarioEstimado({ ...CADENCIA_PADRAO, cadencia_conversas_min: 5 }).cabe).toBe(true);
    expect(
      custoDiarioEstimado({ ...CADENCIA_PADRAO, cadencia_conversas_min: 5, fichas_por_dia: 120 }).cabe,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paginação: o que o cursor promete, provado contra uma Mensageria simulada.
//
// A simulação é uma lista em memória, ordenada como a API ordena (mais nova
// primeiro). `buscarPagina` lê um recorte por offset, igual à API. Cada teste
// pode MUTAR a lista entre uma página e outra — é o que acontece de verdade
// quando uma mensagem chega no meio da leitura.
// ---------------------------------------------------------------------------
import { colherConversas, novoCursor } from "./sincronizar.ts";

type ItemSimulado = { id: string; em: string; quem: string; equipe: string };

function minuto(n: number): string {
  // n = minutos desde 2026-11-08T00:00Z; zero-padded, ordenável como texto
  const h = Math.floor(n / 60).toString().padStart(2, "0");
  const m = (n % 60).toString().padStart(2, "0");
  return `2026-11-08T${h}:${m}:00.000Z`;
}

function fabricar(id: string, em: string, quem = "cliente", equipe = "Reativa") {
  return { id, em, quem, equipe };
}

/** API simulada: pagina por offset sobre `lista`, ordenada decrescente. */
function apiSimulada(lista: ItemSimulado[], aoLer?: (pagina: number) => void) {
  return async (pagina: number) => {
    aoLer?.(pagina);
    const ordenada = [...lista].sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0));
    const inicio = (pagina - 1) * LIMITE_PAGINA;
    const fatia = ordenada.slice(inicio, inicio + LIMITE_PAGINA);
    return {
      conversas: fatia.map((i) => ({
        id: i.id,
        canal: "whatsapp",
        situacao: "active",
        equipe: i.equipe,
        cliente: { id: `k${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em,
        ultimaMensagem: { quem: i.quem, em: i.em, trecho: "x" },
      })),
      paginacao: { total: lista.length },
    };
  };
}

/** Conjunto de ids entregues pela colheita, para comparar com o que deveria vir. */
function idsColhidos(colheita: { conversas: { ulbra_conversa_id: string }[] }) {
  return new Set(colheita.conversas.map((c) => c.ulbra_conversa_id));
}

describe("paginação: nenhuma resposta se perde", () => {
  it("com mais de uma página, traz todas as respostas acima do cursor", async () => {
    // 120 itens acima do cursor: três páginas (50+50+20). Todos da Reativa.
    const lista: ItemSimulado[] = [];
    for (let i = 0; i < 120; i++) lista.push(fabricar(`r${i}`, minuto(600 + i)));
    const colheita = await colherConversas(apiSimulada(lista), minuto(500), 3);
    expect(colheita.truncado).toBe(false);
    expect(idsColhidos(colheita).size).toBe(120);
  });

  it("uma mensagem nova chegando ENTRE páginas não faz perder nenhuma antiga", async () => {
    // Ela entra no topo depois que a página 1 já foi lida. Não aparece neste
    // ciclo — e o cursor NÃO passa dela, então no ciclo seguinte ela aparece.
    // O que o teste prova: nada antigo se perde, e nada novo é engolido.
    const lista: ItemSimulado[] = [];
    for (let i = 0; i < 120; i++) lista.push(fabricar(`r${i}`, minuto(600 + i)));
    let chegou = false;
    const primeiro = await colherConversas(
      apiSimulada(lista, (pagina) => {
        if (pagina === 2 && !chegou) {
          lista.push(fabricar("nova", minuto(999)));
          chegou = true;
        }
      }),
      minuto(500),
      3,
    );
    const idsCiclo1 = idsColhidos(primeiro);
    for (let i = 0; i < 120; i++) expect(idsCiclo1.has(`r${i}`)).toBe(true);

    const cursorDepois = novoCursor(minuto(500), primeiro);
    // o cursor parou no que foi visto (719), não em 999
    expect(cursorDepois).toBe(minuto(719));

    const segundo = await colherConversas(apiSimulada(lista), cursorDepois, 3);
    expect(idsColhidos(segundo).has("nova")).toBe(true);
  });

  it("interrupção no meio NÃO avança o cursor", async () => {
    const lista: ItemSimulado[] = [];
    for (let i = 0; i < 120; i++) lista.push(fabricar(`r${i}`, minuto(600 + i)));
    const cursorAntes = minuto(500);
    const quebra = apiSimulada(lista);
    await expect(
      colherConversas(
        async (pagina) => {
          if (pagina === 2) throw new Error("ULBRA_HTTP_503");
          return quebra(pagina);
        },
        cursorAntes,
        3,
      ),
    ).rejects.toThrow("ULBRA_HTTP_503");
    // a função cai antes de gravar: o cursor guardado segue o mesmo
    // (quem chama só grava quando a colheita termina)
  });
});

describe("cursor: não passa do que ainda não foi processado", () => {
  it("backlog maior que o teto NÃO avança o cursor para o topo", async () => {
    // 200 itens acima do cursor; teto de 2 páginas = 100. Sobram 100 não lidos.
    const lista: ItemSimulado[] = [];
    for (let i = 0; i < 200; i++) lista.push(fabricar(`r${i}`, minuto(600 + i)));
    const cursorAntes = minuto(500);
    const colheita = await colherConversas(apiSimulada(lista), cursorAntes, 2);
    expect(colheita.truncado).toBe(true);
    // o cursor fica onde estava: não pode pular para o topo (minuto 799)
    expect(novoCursor(cursorAntes, colheita)).toBe(cursorAntes);
  });

  it("coleta completa avança o cursor para a mensagem mais nova vista", async () => {
    const lista: ItemSimulado[] = [fabricar("a", minuto(600)), fabricar("b", minuto(601))];
    const colheita = await colherConversas(apiSimulada(lista), minuto(500), 3);
    expect(novoCursor(minuto(500), colheita)).toBe(minuto(601));
  });

  it("o cursor nunca anda para trás", async () => {
    const lista: ItemSimulado[] = [fabricar("a", minuto(600))];
    const colheita = await colherConversas(apiSimulada(lista), minuto(700), 3);
    // item de 600 é mais antigo que o cursor de 700: nada novo, cursor fica
    expect(novoCursor(minuto(700), colheita)).toBe(minuto(700));
  });

  it("repetir o ciclo com o mesmo cursor não duplica a conta de não lidas", () => {
    // a regra de contagem vive no SQL (`ulbra_sync_gravar`), que só incrementa
    // quando a mensagem é mais nova que a gravada. Aqui se prova o lado Node:
    // a mesma mensagem, relida, sai com o mesmo `ultima_mensagem_em` e não
    // gera novo cursor nem nova notificação.
    const p = lerPaginaConversas(
      { conversas: [{ id: "x".padEnd(24, "0"), cliente: { id: "k".padEnd(24, "0") }, equipe: "Reativa", ultimaMensagemEm: minuto(600), ultimaMensagem: { quem: "cliente", em: minuto(600) } }], paginacao: { total: 1 } },
      minuto(590),
    );
    const segunda = lerPaginaConversas(
      { conversas: [{ id: "x".padEnd(24, "0"), cliente: { id: "k".padEnd(24, "0") }, equipe: "Reativa", ultimaMensagemEm: minuto(600), ultimaMensagem: { quem: "cliente", em: minuto(600) } }], paginacao: { total: 1 } },
      minuto(600),
    );
    expect(p.conversas).toHaveLength(1);
    expect(segunda.conversas).toHaveLength(0);
  });
});
