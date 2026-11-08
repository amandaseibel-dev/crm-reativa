// Garantias deste módulo, em ordem de importância:
// 1. equipe de fora NÃO entra, em nenhum caminho;
// 2. identidade só sai de vínculo por CPF — nunca de nome;
// 3. carteira e fidelização vêm antes do rodízio;
// 4. NENHUMA resposta do cliente se perde, nem se duplica, em backlog,
//    interrupção ou mensagem que chega no meio da leitura;
// 5. a cadência configurada cabe no teto de 500 chamadas/dia.
import { describe, it, expect } from "vitest";
import {
  CADENCIA_PADRAO,
  LIMITE_PAGINA,
  TETO_DIARIO,
  cargaAtendimentos,
  cargaConversas,
  colherConversas,
  custoDiarioEstimado,
  decidirDestino,
  identificar,
  lerAtendimentos,
  lerCorpoMcp,
  lerPaginaConversas,
  novaJanela,
  operadoresDisponiveis,
  proximoDoRodizio,
  resultadoDoEnvelope,
  ultimaDoClienteNoDetalhe,
  type Janela,
  type OperadorRodizio,
  type VinculoAtivo,
} from "./sincronizar.ts";

const J0: Janela = { cursor: null, pendente: null, topo: null };
const id = (n: string) => n.padEnd(24, "0");

// ---------------------------------------------------------------------------
// Simulação de Mensageria: lista em memória, ordenada como a API ordena
// (mais nova primeiro), lida por offset. A lista pode MUTAR entre páginas.
// ---------------------------------------------------------------------------
type Item = { id: string; em: string; quem: string; equipe?: string };

function minuto(n: number): string {
  const h = Math.floor(n / 60).toString().padStart(2, "0");
  const m = (n % 60).toString().padStart(2, "0");
  return `2026-11-08T${h}:${m}:00.000Z`;
}

function apiSimulada(lista: Item[], aoLer?: (pagina: number) => void) {
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
        equipe: i.equipe ?? "Reativa",
        cliente: { id: `k${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em,
        ultimaMensagem: { quem: i.quem, em: i.em, trecho: "x" },
      })),
      paginacao: { total: lista.length },
    };
  };
}

/** Roda um ciclo com o estado persistido, como a função faz de verdade. */
async function ciclo(
  lista: Item[],
  janela: Janela,
  opcoes: { falhaNaPagina?: number; maxPaginas?: number; hardLeituras?: number; aoLer?: (p: number) => void } = {},
) {
  const api = apiSimulada(lista, opcoes.aoLer);
  const colheita = await colherConversas(
    async (p) => {
      if (opcoes.falhaNaPagina === p) throw new Error("ULBRA_HTTP_503");
      return api(p);
    },
    janela,
    { maxPaginas: opcoes.maxPaginas ?? 3, hardLeituras: opcoes.hardLeituras ?? 12 },
  );
  return { colheita, proxima: novaJanela(janela, colheita) };
}

/** Ids gravados (coletados) somados ao longo dos ciclos, sem perda nem repetição. */
async function rodarAte(
  lista: Item[],
  janela0: Janela,
  opcoes: { maxPaginas?: number; hardLeituras?: number } = {},
  limiteCiclos = 50,
) {
  let janela = janela0;
  const coletados: string[] = [];
  for (let i = 0; i < limiteCiclos; i++) {
    const { colheita, proxima } = await ciclo(lista, janela, opcoes);
    for (const c of colheita.conversas) coletados.push(c.ulbra_conversa_id);
    janela = proxima;
    if (!colheita.truncado) return { coletados, janela, ciclos: i + 1 };
  }
  throw new Error("NAO_CONVERGIU");
}

describe("cliente responde e operador/bot responde depois, antes da sincronização", () => {
  it("a lista mostra o operador por último: resposta do cliente NÃO aparece sem detalhe", () => {
    const resposta = {
      conversas: [
        {
          id: id("c1"),
          equipe: "Reativa",
          cliente: { id: id("k1"), nome: "A" },
          ultimaMensagemEm: "2026-11-08T05:05:00.000Z",
          ultimaMensagem: { quem: "operador", em: "2026-11-08T05:05:00.000Z", trecho: "ok" },
        },
      ],
      paginacao: { total: 1 },
    };
    const p = lerPaginaConversas(resposta, J0);
    // O cliente respondeu às 05:00 — a lista NÃO prova isso.
    expect(p.conversas[0].ultima_mensagem_cliente_em).toBeNull();
    expect(p.conversas[0].precisa_detalhe).toBe(true);
  });

  it("com o detalhe (ler_conversa), a resposta do cliente aparece acima do cursor", () => {
    const detalhe = {
      mensagens: [
        { quem: "cliente", em: "2026-11-08T05:00:00.000Z" },
        { quem: "operador", em: "2026-11-08T05:05:00.000Z" },
        { quem: "bot", em: "2026-11-08T05:06:00.000Z" },
      ],
    };
    expect(ultimaDoClienteNoDetalhe(detalhe)).toBe("2026-11-08T05:00:00.000Z");
    // sem mensagem do cliente no detalhe, não há data a provar
    expect(ultimaDoClienteNoDetalhe({ mensagens: [{ quem: "operador", em: "2026-11-08T05:05:00.000Z" }] })).toBeNull();
  });

  it("sem detalhe, a resposta fica invisível: é a perda conhecida, e o teste a documenta", () => {
    // Este teste prova a LIMITAÇÃO com K=0 (orçamento padrão). Se alguém
    // ligar o detalhe, o teste acima passa a ser a garantia real.
    const p = lerPaginaConversas(
      {
        conversas: [
          {
            id: id("c2"),
            equipe: "Reativa",
            cliente: { id: id("k2") },
            ultimaMensagemEm: "2026-11-08T05:05:00.000Z",
            ultimaMensagem: { quem: "bot", em: "2026-11-08T05:05:00.000Z" },
          },
        ],
        paginacao: { total: 1 },
      },
      J0,
    );
    expect(p.conversas[0].ultima_mensagem_cliente_em).toBeNull();
  });
});

describe("backlog maior que o teto, em ciclos sucessivos", () => {
  it("200 mensagens com teto de 2 páginas por ciclo: todas, uma vez cada, em ciclos sucessivos", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 200; i++) lista.push({ id: `r${i}`, em: minuto(100 + i), quem: "cliente" });
    const r = await rodarAte(lista, J0, { maxPaginas: 2 });
    expect(r.ciclos).toBeGreaterThan(1);
    expect(r.coletados.length).toBe(200);
    expect(new Set(r.coletados).size).toBe(200);
    for (let i = 0; i < 200; i++) expect(r.coletados).toContain(`r${i}`);
  });

  it("empate no piso que cabe numa página não some nem se repete", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 20; i++) lista.push({ id: `e${i}`, em: minuto(300), quem: "cliente" });
    for (let i = 0; i < 40; i++) lista.push({ id: `f${i}`, em: minuto(301 + i), quem: "cliente" });
    const r = await rodarAte(lista, J0, { maxPaginas: 1 });
    expect(new Set(r.coletados).size).toBe(60);
    expect(r.coletados.length).toBe(60);
  });

  it("empate de 60 com teto de 1 página: o grupo termina no mesmo ciclo, sem partir", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 60; i++) lista.push({ id: `e${i}`, em: minuto(300), quem: "cliente" });
    const r = await rodarAte(lista, J0, { maxPaginas: 1, hardLeituras: 3 });
    expect(new Set(r.coletados).size).toBe(60);
    expect(r.coletados.length).toBe(60);
  });

  it("empate MAIOR que o teto de leituras sai INCOMPLETO, sem declarar nada além do lido", async () => {
    // Limite conhecido: grupo do mesmo `em` maior que o total de leituras do
    // ciclo não pode ser concluído. Sai INCOMPLETO, nada é dado como processado.
    const lista: Item[] = [];
    for (let i = 0; i < 200; i++) lista.push({ id: `e${i}`, em: minuto(300), quem: "cliente" });
    const c1 = await ciclo(lista, J0, { maxPaginas: 1, hardLeituras: 3 });
    expect(c1.colheita.truncado).toBe(true);
    expect(c1.proxima.cursor).toBeNull();
  });
});

describe("interrupção e retomada", () => {
  it("falha no meio não move a janela e a retomada coleta exatamente o que faltava", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 120; i++) lista.push({ id: `r${i}`, em: minuto(100 + i), quem: "cliente" });
    // primeiro ciclo cai na página 2
    await expect(ciclo(lista, J0, { falhaNaPagina: 2, maxPaginas: 3 })).rejects.toThrow("ULBRA_HTTP_503");
    // a janela persistida continua J0: nada foi gravado
    const r = await rodarAte(lista, J0, { maxPaginas: 3 });
    expect(new Set(r.coletados).size).toBe(120);
    expect(r.coletados.length).toBe(120);
  });

  it("interrupção depois de um ciclo INCOMPLETO: a janela guardada continua de onde parou", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 200; i++) lista.push({ id: `r${i}`, em: minuto(100 + i), quem: "cliente" });
    const c1 = await ciclo(lista, J0, { maxPaginas: 2 });
    expect(c1.colheita.truncado).toBe(true);
    // falha no ciclo 2 não avança nada
    await expect(ciclo(lista, c1.proxima, { falhaNaPagina: 1, maxPaginas: 2 })).rejects.toThrow();
    // retomada a partir da MESMA janela
    const resto = await rodarAte(lista, c1.proxima, { maxPaginas: 2 });
    const todos = [...c1.colheita.conversas.map((c) => c.ulbra_conversa_id), ...resto.coletados];
    expect(new Set(todos).size).toBe(200);
    expect(todos.length).toBe(200);
  });
});

describe("mensagem que chega no meio do backlog", () => {
  it("entra no próximo ciclo, sem perder nada antigo e sem repetir o que já foi coletado", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 120; i++) lista.push({ id: `r${i}`, em: minuto(100 + i), quem: "cliente" });
    let chegou = false;
    const c1 = await ciclo(lista, J0, {
      maxPaginas: 2,
      aoLer: (p) => {
        if (p === 2 && !chegou) {
          lista.push({ id: "nova", em: minuto(900), quem: "cliente" });
          chegou = true;
        }
      },
    });
    const resto = await rodarAte(lista, c1.proxima, { maxPaginas: 2 });
    const todos = [...c1.colheita.conversas.map((c) => c.ulbra_conversa_id), ...resto.coletados];
    expect(todos).toContain("nova");
    for (let i = 0; i < 120; i++) expect(todos).toContain(`r${i}`);
    expect(new Set(todos).size).toBe(todos.length);
  });
});

describe("cursor e topo", () => {
  it("ciclo completo fecha a janela: cursor = topo, sem pendente", async () => {
    const lista: Item[] = [{ id: "a", em: minuto(600), quem: "cliente" }, { id: "b", em: minuto(601), quem: "cliente" }];
    const r = await rodarAte(lista, J0, { maxPaginas: 3 });
    expect(r.janela).toEqual({ cursor: minuto(601), pendente: null, topo: minuto(601) });
  });

  it("nunca anda para trás", async () => {
    const lista: Item[] = [{ id: "a", em: minuto(600), quem: "cliente" }];
    const r = await rodarAte(lista, { cursor: minuto(700), pendente: null, topo: minuto(700) }, { maxPaginas: 3 });
    expect(r.janela.cursor).toBe(minuto(700));
  });

  it("nenhuma mensagem coletada duas vezes por ciclo repetido com a mesma janela", async () => {
    const lista: Item[] = [{ id: "a", em: minuto(600), quem: "cliente" }];
    const c1 = await ciclo(lista, J0, { maxPaginas: 3 });
    const c2 = await ciclo(lista, c1.proxima, { maxPaginas: 3 });
    expect(c2.colheita.conversas.length).toBe(0);
  });
});

describe("paginação básica", () => {
  it("120 itens em três páginas, todos num ciclo", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 120; i++) lista.push({ id: `r${i}`, em: minuto(600 + i), quem: "cliente" });
    const c = await ciclo(lista, { cursor: minuto(500), pendente: null, topo: null }, { maxPaginas: 3 });
    expect(c.colheita.truncado).toBe(false);
    expect(c.colheita.conversas.length).toBe(120);
  });

  it("uma mensagem nova no meio de uma página não some", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 120; i++) lista.push({ id: `r${i}`, em: minuto(600 + i), quem: "cliente" });
    let chegou = false;
    const c = await ciclo(lista, { cursor: minuto(500), pendente: null, topo: null }, {
      maxPaginas: 3,
      aoLer: (p) => {
        if (p === 2 && !chegou) {
          lista.push({ id: "nova", em: minuto(999), quem: "cliente" });
          chegou = true;
        }
      },
    });
    // Chegou depois da página 1 foi lida: não aparece agora, mas aparece no seguinte
    const resto = await rodarAte(lista, c.proxima, { maxPaginas: 3 });
    expect(resto.coletados).toContain("nova");
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

