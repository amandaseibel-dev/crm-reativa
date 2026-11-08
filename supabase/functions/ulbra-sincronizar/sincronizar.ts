// ===========================================================================
// SINCRONIZAÇÃO CENTRALIZADA DA MENSAGERIA ULBRA — lógica pura, sem Deno.
//
// POR QUE CENTRALIZADA, E NÃO UM POLL POR OPERADOR
//
// O orçamento medido da Mensageria é de 500 chamadas por DIA por pessoa
// (`meu_acesso`, conferido em 07/11/2026). Um poll de 60s na tela de cada
// operador — o que `ulbra-leads-pendentes` faz hoje, e que nunca foi montado
// em tela nenhuma — custa 1.440 chamadas por dia POR OPERADOR. Com um único
// operador aberto o dia já estoura o teto, e o segundo operador não teria
// nada: o limite é da credencial, não da aba.
//
// Então existe UM relógio só, do lado do servidor, e a tela do operador lê
// Postgres (grátis, e com Realtime). É isto que esta função serve.
//
// NÃO ASSUMIMOS QUE O ORÇAMENTO DO OAuth E O DO BACKEND SÃO SEPARADOS: o
// `meu_acesso` diz "por pessoa", e a credencial de backend é uma pessoa como
// qualquer outra. Até a ULBRA confirmar, o cálculo de `custoDiarioEstimado`
// trata os dois como UM teto de 500/dia, e a cadência é escolhida para caber
// nele COM a leitura das fichas e a margem de falha.
//
// O QUE NÃO SE INVENTA AQUI
//   - equipe: só `Reativa`. Atendimento de outra equipe não é lido, não é
//     gravado e nunca é assumido nem transferido por nós;
//   - identidade: aluno só sai de `ulbra_vinculos` ativo, pelo
//     `ulbra_cliente_id`. Nome e telefone NÃO identificam ninguém aqui;
//     cliente sem vínculo vira `nao_confirmado` e vai para conferência;
//   - conteúdo de conversa não é copiado em massa: a sincronização grava o
//     TRECHO que a própria `listar_conversas` devolve, e as mensagens só são
//     lidas quando alguém abre a conversa (`ler_conversa`, sob demanda).
// ===========================================================================

export const MCP_URL = "https://crm.ulbra.ai/api/mcp";

/** Cabeçalho exigido pelo MCP sobre HTTP. Sem ele a resposta é 406. */
export const ACCEPT_MCP = "application/json, text/event-stream";

/** Nome canônico da equipe no cadastro da Mensageria. */
export const EQUIPE_REATIVA = "Reativa";

/** Teto de páginas por ciclo. Vale como freio de custo, não como meta. */
export const MAX_PAGINAS = 3;

/** `listar_conversas` pagina em no máximo 50 (contrato medido). */
export const LIMITE_PAGINA = 50;

// ---------------------------------------------------------------------------
// Leitura do envelope
// ---------------------------------------------------------------------------

export function lerCorpoMcp(contentType: string | null, corpo: string): unknown {
  if (!(contentType ?? "").toLowerCase().includes("text/event-stream")) {
    return JSON.parse(corpo);
  }
  for (const evento of corpo.split(/\r?\n\r?\n/)) {
    const dados = evento
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (dados.trim()) return JSON.parse(dados);
  }
  throw new Error("SSE_SEM_DADOS");
}

export function resultadoDoEnvelope(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") throw new Error("ENVELOPE_INVALIDO");
  const env = envelope as {
    error?: { message?: string };
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  if (env.error) throw new Error(`MCP_ERRO: ${env.error.message ?? "sem mensagem"}`);
  if (env.result?.isError) throw new Error("MCP_ERRO: ferramenta devolveu isError");
  const texto = env.result?.content?.[0]?.text;
  if (typeof texto !== "string") throw new Error("ENVELOPE_SEM_CONTEUDO");
  return JSON.parse(texto);
}

// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

export function cargaConversas(pagina = 1, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "listar_conversas",
      arguments: { canal: "whatsapp", situacao: "active", limite: LIMITE_PAGINA, pagina },
    },
  };
}

export function cargaAtendimentos(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    // `listar_atendimentos` não tem filtro por nome de equipe; o corte por
    // `Reativa` é feito aqui, sobre a resposta.
    params: { name: "listar_atendimentos", arguments: { situacao: "waiting", limite: 500 } },
  };
}

// ---------------------------------------------------------------------------
// Conversas: o incremental
// ---------------------------------------------------------------------------
//
// `listar_conversas` NÃO tem filtro "desde" — nenhuma ferramenta do catálogo
// tem. O que ela tem, e que foi medido em 08/11/2026 nas páginas 1 e 2, é
// ordenação GLOBAL por `ultimaMensagemEm` decrescente: o piso da página 1 é
// maior que o teto da página 2. Isso basta para um incremental de verdade —
// lê-se da página 1 para baixo e para-se na primeira conversa que não é mais
// nova que o cursor. Em regime, isso é UMA chamada por ciclo.

export interface ConversaMcp {
  id?: string;
  canal?: string;
  situacao?: string;
  equipe?: string | null;
  responsavel?: string | null;
  cliente?: { id?: string; nome?: string | null } | null;
  ultimaMensagemEm?: string | null;
  ultimaMensagem?: { quem?: string; em?: string; trecho?: string } | null;
}

export interface ConversaLida {
  ulbra_conversa_id: string;
  ulbra_cliente_id: string;
  cliente_nome: string | null;
  canal: string;
  situacao: string;
  equipe: string;
  responsavel_ulbra: string | null;
  ultima_mensagem_em: string;
  ultima_mensagem_quem: string;
  ultima_mensagem_previa: string | null;
  /** Só `quem === "cliente"` é resposta do aluno. Mensagem do bot ou do
   *  operador da ULBRA não notifica ninguém: não é resposta recebida. */
  resposta_do_cliente: boolean;
}

export interface PaginaConversas {
  conversas: ConversaLida[];
  /** Menor `ultimaMensagemEm` visto na página, mesmo de outra equipe. */
  piso: string | null;
  /** Verdadeiro quando a página inteira ficou acima do cursor: pode haver
   *  mais coisa nova na página seguinte. */
  pode_ter_mais: boolean;
  total: number | null;
}

export function lerPaginaConversas(resposta: unknown, cursor: string | null): PaginaConversas {
  const corpo = resposta as { conversas?: ConversaMcp[]; paginacao?: { total?: number } } | null;
  const itens = Array.isArray(corpo?.conversas) ? corpo!.conversas! : [];
  const total = typeof corpo?.paginacao?.total === "number" ? corpo!.paginacao!.total! : null;

  let piso: string | null = null;
  const conversas: ConversaLida[] = [];

  for (const c of itens) {
    const em = c?.ultimaMensagemEm ?? c?.ultimaMensagem?.em ?? null;
    if (!em) continue;
    if (piso === null || em < piso) piso = em;

    // Cursor é exclusivo: igual não é novo, e assim a mesma conversa não
    // notifica duas vezes quando o ciclo repete.
    if (cursor && em <= cursor) continue;
    if (typeof c.id !== "string" || typeof c.cliente?.id !== "string") continue;
    if ((c.equipe ?? "") !== EQUIPE_REATIVA) continue;

    conversas.push({
      ulbra_conversa_id: c.id,
      ulbra_cliente_id: c.cliente.id,
      cliente_nome: c.cliente.nome ?? null,
      canal: c.canal ?? "whatsapp",
      situacao: c.situacao ?? "active",
      equipe: EQUIPE_REATIVA,
      responsavel_ulbra: c.responsavel ?? null,
      ultima_mensagem_em: em,
      ultima_mensagem_quem: c.ultimaMensagem?.quem ?? "desconhecido",
      ultima_mensagem_previa: c.ultimaMensagem?.trecho ?? null,
      resposta_do_cliente: c.ultimaMensagem?.quem === "cliente",
    });
  }

  // Página vazia não autoriza seguir: sem piso, não há o que comparar.
  const pode_ter_mais =
    itens.length >= LIMITE_PAGINA && (cursor === null || (piso !== null && piso > cursor));

  return { conversas, piso, pode_ter_mais, total };
}

/**
 * Novo cursor = a mensagem mais recente já processada, e SÓ se a coleta
 * alcançou o cursor antigo (ou seja, nada entre os dois ficou para trás).
 *
 * Se a coleta parou por teto de páginas ANTES de chegar ao cursor antigo, o
 * cursor NÃO anda. Avançá-lo aqui perderia tudo o que ficou entre o topo lido e
 * o cursor: a ordenação é decrescente, e o próximo ciclo pararia no topo.
 * Manter o cursor é o lado seguro: a janela inteira é relida no próximo ciclo
 * (a gravação é idempotente) e o ciclo sai como INCOMPLETO, visível na gestão.
 */
export function novoCursor(
  cursor: string | null,
  colheita: Colheita,
): string | null {
  if (colheita.truncado) return cursor;
  let maior = cursor;
  for (const p of colheita.paginas) {
    for (const c of p.conversas) {
      if (maior === null || c.ultima_mensagem_em > maior) maior = c.ultima_mensagem_em;
    }
  }
  return maior;
}

export interface Colheita {
  paginas: PaginaConversas[];
  /** Verdadeiro quando o teto de páginas acabou com itens ainda acima do cursor. */
  truncado: boolean;
  /** Conversas da equipe Reativa, na ordem em que foram lidas. */
  conversas: ConversaLida[];
}

/**
 * Lê as páginas da mais nova para a mais antiga, até o cursor ou o teto.
 *
 * `buscarPagina(n)` é injetado: em produção chama a Mensageria; no teste, uma
 * lista em memória que pode mudar ENTRE uma página e outra — que é o caso real
 * de mensagem chegando durante a leitura.
 */
export async function colherConversas(
  buscarPagina: (pagina: number) => Promise<unknown>,
  cursor: string | null,
  maxPaginas = MAX_PAGINAS,
): Promise<Colheita> {
  const paginas: PaginaConversas[] = [];
  let conversas: ConversaLida[] = [];
  let truncado = false;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const lida = lerPaginaConversas(await buscarPagina(pagina), cursor);
    paginas.push(lida);
    conversas = conversas.concat(lida.conversas);
    if (!lida.pode_ter_mais) {
      truncado = false;
      break;
    }
    // Ainda há itens acima do cursor e o teto acabou: não é concluído.
    if (pagina === maxPaginas) truncado = true;
  }
  return { paginas, truncado, conversas };
}

// ---------------------------------------------------------------------------
// Atendimentos novos
// ---------------------------------------------------------------------------

export interface AtendimentoMcp {
  id?: string;
  cliente?: { id?: string; nome?: string | null } | null;
  situacao?: string;
  coluna?: string | null;
  equipe?: string | null;
  atendente?: string | null;
  entrouEm?: string | null;
  atualizadoEm?: string | null;
}

export interface AtendimentoLido {
  ulbra_atendimento_id: string;
  ulbra_cliente_id: string;
  cliente_nome: string | null;
  equipe: string;
  situacao: string;
  coluna: string | null;
  entrou_em: string | null;
}

export function lerAtendimentos(resposta: unknown): AtendimentoLido[] {
  const itens = (resposta as { atendimentos?: AtendimentoMcp[] } | null)?.atendimentos;
  if (!Array.isArray(itens)) return [];
  return itens
    .filter(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.cliente?.id === "string" &&
        (a.equipe ?? "") === EQUIPE_REATIVA,
    )
    .map((a) => ({
      ulbra_atendimento_id: a.id as string,
      ulbra_cliente_id: a.cliente!.id as string,
      cliente_nome: a.cliente?.nome ?? null,
      equipe: EQUIPE_REATIVA,
      situacao: a.situacao ?? "waiting",
      coluna: a.coluna ?? null,
      entrou_em: a.entrouEm ?? a.atualizadoEm ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Identidade: só vínculo ativo por CPF
// ---------------------------------------------------------------------------

export interface VinculoAtivo {
  ulbra_cliente_id: string;
  aluno_id: string;
  confianca: string;
}

export type AlunoStatus = "vinculado" | "nao_confirmado";

export interface Identidade {
  aluno_id: string | null;
  aluno_status: AlunoStatus;
}

/**
 * `alta_cpf` é a ÚNICA confiança que vale como identidade. `alta` é o selo
 * antigo, gravado antes de 04/11/2026 sem distinguir CPF de telefone, e por
 * isso NÃO identifica: vai para conferência igual a quem não tem vínculo.
 */
export function identificar(
  ulbraClienteId: string,
  vinculos: Map<string, VinculoAtivo>,
): Identidade {
  const v = vinculos.get(ulbraClienteId);
  if (!v || v.confianca !== "alta_cpf") return { aluno_id: null, aluno_status: "nao_confirmado" };
  return { aluno_id: v.aluno_id, aluno_status: "vinculado" };
}

// ---------------------------------------------------------------------------
// Destino: carteira e fidelização antes do rodízio
// ---------------------------------------------------------------------------

export type MotivoDestino = "CARTEIRA" | "RODIZIO" | "CONFERENCIA" | "SEM_OPERADOR";

export interface CasoDoAluno {
  /** Dono atual do caso na carteira, quando há. */
  operador_email: string | null;
}

export interface OperadorRodizio {
  email: string;
  atendimentos_hoje: number;
  ultimo_atendimento: string | null;
  em_pausa: boolean;
  online_em: string;
}

export const ONLINE_MS = 90_000;

/**
 * Quem está de fato na fila agora: online (heartbeat de 20s, folga de 90s) e
 * fora de pausa. Mesma régua que `FilaReceptivo` usa na tela — a fila do
 * receptivo é uma só, e esta função não cria outra.
 */
export function operadoresDisponiveis(fila: OperadorRodizio[], agoraMs: number): OperadorRodizio[] {
  return fila.filter(
    (o) => !o.em_pausa && agoraMs - new Date(o.online_em).getTime() <= ONLINE_MS,
  );
}

/** Menos atendimentos hoje; empate, quem atendeu há mais tempo; depois email. */
export function proximoDoRodizio(fila: OperadorRodizio[], agoraMs: number): string | null {
  const livres = operadoresDisponiveis(fila, agoraMs);
  if (livres.length === 0) return null;
  const ordenado = [...livres].sort((a, b) => {
    if (a.atendimentos_hoje !== b.atendimentos_hoje) {
      return a.atendimentos_hoje - b.atendimentos_hoje;
    }
    const ta = a.ultimo_atendimento ? Date.parse(a.ultimo_atendimento) : 0;
    const tb = b.ultimo_atendimento ? Date.parse(b.ultimo_atendimento) : 0;
    if (ta !== tb) return ta - tb;
    return a.email.localeCompare(b.email);
  });
  return ordenado[0].email;
}

export interface Destino {
  destino_email: string | null;
  destino_motivo: MotivoDestino;
}

/**
 * ORDEM, E ELA NÃO É INTERCAMBIÁVEL:
 *
 * 1. identidade não confirmada  -> CONFERENCIA, sem destino. Não se oferece
 *    aluno que não se sabe quem é, e não se "resolve" isso por nome;
 * 2. aluno com caso e dono      -> CARTEIRA, direto para o dono. É isto que
 *    preserva carteira e fidelização: o lead não vai ao rodízio sortear um
 *    segundo responsável para quem já tem um;
 * 3. o resto                    -> RODIZIO, sugerido ao próximo da fila.
 *
 * `destino_email` é SUGESTÃO, não posse. A posse nasce de `assumir`, que é um
 * UPDATE condicional no banco — é lá que dois operadores deixam de poder
 * assumir o mesmo atendimento.
 */
export function decidirDestino(
  entrada: { identidade: Identidade; caso: CasoDoAluno | null; fila: OperadorRodizio[] },
  agoraMs: number,
): Destino {
  if (entrada.identidade.aluno_status !== "vinculado") {
    return { destino_email: null, destino_motivo: "CONFERENCIA" };
  }
  const dono = entrada.caso?.operador_email ?? null;
  if (dono) return { destino_email: dono, destino_motivo: "CARTEIRA" };

  const proximo = proximoDoRodizio(entrada.fila, agoraMs);
  if (!proximo) return { destino_email: null, destino_motivo: "SEM_OPERADOR" };
  return { destino_email: proximo, destino_motivo: "RODIZIO" };
}

// ---------------------------------------------------------------------------
// Orçamento: o número, não a esperança
// ---------------------------------------------------------------------------

export interface Cadencia {
  /** Minutos entre ciclos de conversas. */
  cadencia_conversas_min: number;
  /** Minutos entre leituras da lista de atendimentos em espera. */
  cadencia_atendimentos_min: number;
  /** Páginas por ciclo em REGIME (1) ou no pico. Teto duro: MAX_PAGINAS. */
  paginas_por_ciclo: number;
  /** Aberturas de conversa na ficha por dia (1 `ler_conversa` cada). */
  fichas_por_dia: number;
  /** Fração para repetição por falha. 0,15 = 15%. */
  margem_falha: number;
}

export const TETO_DIARIO = 500;

/** Cadência escolhida. O teste prova que ela cabe no teto — se alguém
 *  apertar o relógio sem refazer a conta, o CI reprova. */
export const CADENCIA_PADRAO: Cadencia = {
  cadencia_conversas_min: 10,
  cadencia_atendimentos_min: 30,
  paginas_por_ciclo: 1,
  fichas_por_dia: 60,
  margem_falha: 0.15,
};

export function custoDiarioEstimado(c: Cadencia): {
  conversas: number;
  atendimentos: number;
  fichas: number;
  margem: number;
  total: number;
  cabe: boolean;
} {
  const minutosDoDia = 24 * 60;
  const conversas =
    Math.floor(minutosDoDia / c.cadencia_conversas_min) * Math.min(c.paginas_por_ciclo, MAX_PAGINAS);
  const atendimentos = Math.floor(minutosDoDia / c.cadencia_atendimentos_min);
  const fichas = c.fichas_por_dia;
  const base = conversas + atendimentos + fichas;
  const margem = Math.ceil(base * c.margem_falha);
  const total = base + margem;
  return { conversas, atendimentos, fichas, margem, total, cabe: total <= TETO_DIARIO };
}
