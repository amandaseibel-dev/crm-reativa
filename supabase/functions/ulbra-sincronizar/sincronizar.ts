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

/** Teto TOTAL de leituras por ciclo, incluindo páginas só puladas. */
export const HARD_LEITURAS = 12;

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
// `listar_conversas` NÃO tem filtro "desde". Tem ordenação GLOBAL por
// `ultimaMensagemEm` decrescente (medido em 08/11: piso da página 1 > teto da
// página 2). Com isso o estado tem três marcos, e a janela de coleta é:
//
//   coleta o item  se  cursor < em  E  (em <= pendente  OU  em > topo)
//
//   cursor    = tudo até aqui já foi processado e NÃO precisa ser relido
//   pendente  = piso do que já foi processado num ciclo INCOMPLETO; itens
//               acima dele e abaixo do topo já foram processados, pulam
//   topo      = mensagem mais nova já processada; itens acima dele são novos
//
// Ciclo completo: cursor := topo, pendente := null.
// Ciclo incompleto (teto de páginas): cursor fica; pendente := menor `em`
// coletado; o empate no piso é devolvido ao próximo ciclo (não se perde nem
// se duplica). Interrupção: nada é gravado, o próximo ciclo refaz a janela.
//
// LIMITE DE ORÇAMENTO: pular páginas custa chamada. Por isso há dois tetos
// separados: MAX_PAGINAS (páginas COM coleta por ciclo) e HARD_LEITURAS (total
// de leituras, incluindo as que só pulam). Backlog novo acima de ~HARD_LEITURAS
// × 50 itens não termina nunca e sai como INCOMPLETO, visível na gestão.

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
  /** Data da última mensagem do CLIENTE que a lista PROVA. Quando a última
   *  mensagem é do cliente, é ela. Quando é do operador/bot, fica null:
   *  a lista não mostra se o cliente respondeu antes. Ver `precisaDetalhe`. */
  ultima_mensagem_cliente_em: string | null;
  /** Verdadeiro quando a última mensagem NÃO é do cliente e é recente: a
   *  resposta do cliente pode ter ficado para trás. Só `ler_conversa` prova. */
  precisa_detalhe: boolean;
}

export interface Janela {
  cursor: string | null;
  pendente: string | null;
  topo: string | null;
}

export interface PaginaConversas {
  conversas: ConversaLida[];
  piso: string | null;
  pode_ter_mais: boolean;
  total: number | null;
}

/**
 * Coleta o item se ele ainda não foi processado:
 *  - cursor (exclusivo): tudo até ele já está processado;
 *  - pendente (inclusivo): tudo com em >= pendente e <= topo já está processado.
 * Um ciclo incompleto só fecha depois de ler TODO o grupo do seu piso, então
 * o pendente nunca deixa um empate pela metade.
 */
function dentroDaJanela(em: string, j: Janela): boolean {
  if (j.cursor !== null && em <= j.cursor) return false;
  const jaProcessado =
    j.pendente !== null && em >= j.pendente && (j.topo === null || em <= j.topo);
  return !jaProcessado;
}

export function lerPaginaConversas(resposta: unknown, janela: Janela): PaginaConversas {
  const corpo = resposta as { conversas?: ConversaMcp[]; paginacao?: { total?: number } } | null;
  const itens = Array.isArray(corpo?.conversas) ? corpo!.conversas! : [];
  const total = typeof corpo?.paginacao?.total === "number" ? corpo!.paginacao!.total! : null;

  let piso: string | null = null;
  const conversas: ConversaLida[] = [];

  for (const c of itens) {
    const em = c?.ultimaMensagemEm ?? c?.ultimaMensagem?.em ?? null;
    if (!em) continue;
    if (piso === null || em < piso) piso = em;
    if (!dentroDaJanela(em, janela)) continue;
    if (typeof c.id !== "string" || typeof c.cliente?.id !== "string") continue;
    if ((c.equipe ?? "") !== EQUIPE_REATIVA) continue;

    const quem = c.ultimaMensagem?.quem ?? "desconhecido";
    const doCliente = quem === "cliente";
    conversas.push({
      ulbra_conversa_id: c.id,
      ulbra_cliente_id: c.cliente.id,
      cliente_nome: c.cliente.nome ?? null,
      canal: c.canal ?? "whatsapp",
      situacao: c.situacao ?? "active",
      equipe: EQUIPE_REATIVA,
      responsavel_ulbra: c.responsavel ?? null,
      ultima_mensagem_em: em,
      ultima_mensagem_quem: quem,
      ultima_mensagem_previa: c.ultimaMensagem?.trecho ?? null,
      ultima_mensagem_cliente_em: doCliente ? em : null,
      precisa_detalhe: !doCliente,
    });
  }

  // Página cheia com itens ainda acima do cursor: pode haver mais.
  const pode_ter_mais =
    itens.length >= LIMITE_PAGINA && (janela.cursor === null || (piso !== null && piso > janela.cursor));

  return { conversas, piso, pode_ter_mais, total };
}

/**
 * Data da mensagem mais nova DO CLIENTE que `ler_conversa` mostra (limite 20).
 * Sem filtro de cursor: a fila de detalhes precisa checar conversas que o cursor
 * já passou. A gravação guarda o máximo (greatest), então repetir não rebaixa.
 * LIMITE: se houver mais de 20 mensagens depois da do cliente, ela não aparece.
 */
export function ultimaDoClienteNoDetalhe(resposta: unknown): string | null {
  const corpo = resposta as { mensagens?: Array<{ quem?: string; em?: string }> } | null;
  const msgs = Array.isArray(corpo?.mensagens) ? corpo!.mensagens! : [];
  let maior: string | null = null;
  for (const m of msgs) {
    if (m?.quem !== "cliente" || typeof m.em !== "string") continue;
    if (maior === null || m.em > maior) maior = m.em;
  }
  return maior;
}

export function cargaDetalhe(conversaId: string, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ler_conversa", arguments: { id: conversaId, limite: 20 } },
  };
}

// ---------------------------------------------------------------------------
// Orçamento: limite CONTROLADO pelo código, por chamada.
// ---------------------------------------------------------------------------
// Consumo estimado (290/dia, 193/12h) é previsão. O que o código garante é:
// nenhuma chamada sai sem um saldo, e o saldo do dia nunca passa de
// TETO_DIARIO_SYNC. A reserva de RESERVA_FICHAS_DIA protege as fichas dos
// operadores mesmo com backlog.

export const RESERVA_FICHAS_DIA = 60;
export const TETO_DIARIO_SYNC = 500 - RESERVA_FICHAS_DIA; // 440

export class Orcamento {
  private restante: number;
  constructor(restante: number) {
    this.restante = Math.max(0, restante);
  }
  pode(): boolean {
    return this.restante > 0;
  }
  gastar(): void {
    if (this.restante > 0) this.restante--;
  }
  get saldo(): number {
    return this.restante;
  }
}

// ---------------------------------------------------------------------------
// Fila de detalhes: conversas cuja última mensagem não é do cliente.
// ---------------------------------------------------------------------------
// Entra na fila quando a conversa muda na janela (já é "alterada desde a última
// sincronização"). Sai com a leitura de detalhe, ou com DETALHE_TENTATIVAS_MAX
// falhas (desistida, contada e visível na gestão). Ordem: mais antiga primeiro.
// Dedupe: uma linha por conversa (chave primária).

export const DETALHE_TENTATIVAS_MAX = 5;

export interface FilaDetalhe {
  ulbra_conversa_id: string;
  ulbra_cliente_id: string;
  na_lista_em: string;
  tentativas: number;
}

export function candidatasDaColheita(conversas: ConversaLida[]): FilaDetalhe[] {
  return conversas
    .filter((c) => c.precisa_detalhe)
    .map((c) => ({
      ulbra_conversa_id: c.ulbra_conversa_id,
      ulbra_cliente_id: c.ulbra_cliente_id,
      na_lista_em: c.ultima_mensagem_em,
      tentativas: 0,
    }));
}

/**
 * Escolhe até `k` para ler agora, mais antigas primeiro. As que já falharam o
 * máximo saem como `desistidas`: não voltam, e são contadas.
 */
export function selecionarDetalhes(
  fila: FilaDetalhe[],
  k: number,
): { escolhidas: FilaDetalhe[]; desistidas: FilaDetalhe[] } {
  const ordenada = [...fila].sort((a, b) =>
    a.na_lista_em !== b.na_lista_em
      ? (a.na_lista_em < b.na_lista_em ? -1 : 1)
      : a.ulbra_conversa_id.localeCompare(b.ulbra_conversa_id),
  );
  const desistidas = ordenada.filter((f) => f.tentativas >= DETALHE_TENTATIVAS_MAX);
  const escolhidas = ordenada
    .filter((f) => f.tentativas < DETALHE_TENTATIVAS_MAX)
    .slice(0, Math.max(0, k));
  return { escolhidas, desistidas };
}

export interface Colheita {
  conversas: ConversaLida[];
  /** Páginas lidas (inclusive as que só pularam). */
  leituras: number;
  truncado: boolean;
  /** Menor `em` coletado neste ciclo; vira o pendente se truncar. */
  piso_coletado: string | null;
  /** Maior `em` visto neste ciclo (coletado). Vira o topo. */
  topo_coletado: string | null;
}

/**
 * Lê as páginas da mais nova para a mais antiga. `buscarPagina(n)` é injetado:
 * em produção chama a Mensageria; no teste, uma lista em memória que pode
 * mudar entre páginas (mensagem chegando no meio da leitura).
 */
export async function colherConversas(
  buscarPagina: (pagina: number) => Promise<unknown>,
  janela: Janela,
  limites: { maxPaginas?: number; hardLeituras?: number; pode?: () => boolean } = {},
): Promise<Colheita> {
  const pode = limites.pode ?? (() => true);
  const maxPaginas = limites.maxPaginas ?? MAX_PAGINAS;
  const hardLeituras = limites.hardLeituras ?? HARD_LEITURAS;
  const conversas: ConversaLida[] = [];
  let leituras = 0;
  let paginasComColeta = 0;
  let truncado = false;
  let piso_coletado: string | null = null;
  let topo_coletado: string | null = null;

  // Paginação por offset: uma mensagem nova no topo empurra os itens para a
  // página seguinte, e um item pode aparecer em duas páginas do mesmo ciclo.
  // Dedupe pelo id dentro do ciclo; entre ciclos, a janela cuida disso.
  const vistos = new Set<string>();
  const recolher = (lista: ConversaLida[]) => {
    for (const c of lista) {
      if (vistos.has(c.ulbra_conversa_id)) continue;
      vistos.add(c.ulbra_conversa_id);
      conversas.push(c);
      if (piso_coletado === null || c.ultima_mensagem_em < piso_coletado) piso_coletado = c.ultima_mensagem_em;
      if (topo_coletado === null || c.ultima_mensagem_em > topo_coletado) topo_coletado = c.ultima_mensagem_em;
    }
  };

  for (let pagina = 1; pagina <= hardLeituras; pagina++) {
    // Sem saldo: para AQUI e marca incompleto. Nunca trata página não lida como vazia.
    if (!pode()) {
      truncado = true;
      break;
    }
    const lida = lerPaginaConversas(await buscarPagina(pagina), janela);
    leituras++;
    if (lida.conversas.length > 0) paginasComColeta++;
    recolher(lida.conversas);

    // Fim da janela: nada mais acima do cursor. Ciclo completo.
    if (!lida.pode_ter_mais) break;

    if (paginasComColeta >= maxPaginas) {
      // Teto atingido. Antes de parar, olha a página seguinte: só o grupo com o
      // MESMO horário do piso entra (não pode ser partido); o resto fica pendente.
      if (pagina + 1 > hardLeituras || !pode()) {
        truncado = true;
        break;
      }
      const prox = lerPaginaConversas(await buscarPagina(pagina + 1), janela);
      leituras++;
      if (piso_coletado !== null) {
        recolher(prox.conversas.filter((c) => c.ultima_mensagem_em === piso_coletado));
      }
      // Ainda há item não processado abaixo do piso, acima do cursor?
      // Conservador: itens com o mesmo horário do piso que sobraram contam como
      // pendentes. Um ciclo a mais, nunca uma perda.
      truncado =
        prox.piso !== null &&
        piso_coletado !== null &&
        prox.piso <= piso_coletado &&
        (janela.cursor === null || prox.piso > janela.cursor);
      break;
    }
  }
  return { conversas, leituras, truncado, piso_coletado, topo_coletado };
}

/** Janela do PRÓXIMO ciclo. Ciclo completo fecha o backlog; incompleto guarda o piso. */
export function novaJanela(janela: Janela, colheita: Colheita): Janela {
  const topoNovo = maiorDeDois(janela.topo, colheita.topo_coletado);
  if (!colheita.truncado) {
    return { cursor: topoNovo, pendente: null, topo: topoNovo };
  }
  // Incompleto: o empate no piso volta ao próximo ciclo (não é marcado como visto).
  const pendenteNovo = colheita.piso_coletado ?? janela.pendente;
  return { cursor: janela.cursor, pendente: pendenteNovo, topo: topoNovo };
}

function maiorDeDois(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
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
