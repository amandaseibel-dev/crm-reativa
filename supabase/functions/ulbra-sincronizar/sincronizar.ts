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

/** Leituras de detalhe (`ler_conversa`) por ciclo. Cada uma custa 1 chamada. */
export const DETALHE_POR_CICLO = 1;

/** Teto de páginas por ciclo. Vale como freio de custo, não como meta. */
export const MAX_PAGINAS = 3;

/** Teto TOTAL de leituras por ciclo, incluindo páginas só puladas. */
export const HARD_LEITURAS = 12;

/** `listar_conversas` pagina em no máximo 50 (contrato medido). */
export const LIMITE_PAGINA = 50;

// ---------------------------------------------------------------------------
// Portão de acesso da função: a chave, e só a chave
// ---------------------------------------------------------------------------
// A função é publicada com `verify_jwt = false`, porque quem a chama é o cron
// e não a tela de ninguém. Consequência direta: **o Supabase não barra
// ninguém** — o portão inteiro é o cabeçalho `x-sync-chave`. Se este portão
// falhar aberto, a função fica exposta na internet.
//
// Mora aqui, fora do `Deno.serve`, para ser provável sem rede, sem Deno.env e
// **sem gastar uma única chamada da Mensageria**: a decisão de recusar é
// tomada antes de existir qualquer cliente HTTP. É o mesmo desenho do portão
// da `ulbra-consultar` (`portao.ts`).

export type DecisaoPortaoSync =
  | { ok: true }
  | { ok: false; status: 403; corpo: { erro: "ACESSO_NEGADO" } };

const NEGADO: DecisaoPortaoSync = { ok: false, status: 403, corpo: { erro: "ACESSO_NEGADO" } };

/**
 * Comparação de tempo fixo: percorre a chave inteira sempre, acumulando as
 * diferenças em XOR. Sair no primeiro byte diferente vazaria, pelo tempo de
 * resposta, quanto do prefixo está certo.
 *
 * O tamanho é comparado antes porque não há como esconder: chaves de tamanhos
 * diferentes não são comparáveis byte a byte. O que isso revela é o
 * comprimento do segredo, não o conteúdo.
 */
export function chaveConfere(recebida: string, esperada: string): boolean {
  if (recebida.length !== esperada.length) return false;
  let diferenca = 0;
  for (let i = 0; i < recebida.length; i++) {
    diferenca |= recebida.charCodeAt(i) ^ esperada.charCodeAt(i);
  }
  return diferenca === 0;
}

/**
 * Decide se a requisição entra. Recusa, com 403 e sem olhar mais nada:
 * - cabeçalho ausente (`null`) ou vazio;
 * - chave diferente da esperada, em conteúdo ou em tamanho.
 *
 * Segredo vazio ou ausente no ambiente **também** recusa — senão uma função
 * publicada sem o segredo configurado aceitaria requisição sem cabeçalho,
 * que é exatamente o pior caso.
 */
export function portaoSync(recebida: string | null | undefined, esperada: string | null | undefined): DecisaoPortaoSync {
  if (!esperada) return NEGADO;
  if (!recebida) return NEGADO;
  return chaveConfere(recebida, esperada) ? { ok: true } : NEGADO;
}

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
//   pendente  = piso de um ciclo INCOMPLETO; itens ESTRITAMENTE acima dele e até
//               o topo já foram processados, pulam. O grupo do horário do piso
//               é relido: nunca se presume visto
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
  /** Limite INFERIOR opcional (ISO): mensagem mais antiga que isto está fora do
   *  escopo da coleta. Usado na coleta por período (ex.: só novembro): a leitura
   *  para quando a página só tem itens abaixo dele, e o ciclo fecha como
   *  completo — o que ficou abaixo não é backlog, é fora do escopo. */
  desde?: string | null;
}

/** Verdadeiro quando `em` é anterior ao início da janela (`desde`). Sem `desde`, nunca. */
export function antesDoInicio(em: string, j: Janela): boolean {
  const d = j.desde;
  if (!d) return false;
  const a = Date.parse(em);
  const b = Date.parse(d);
  if (Number.isNaN(a) || Number.isNaN(b)) return em < d;
  return a < b;
}

export interface PaginaConversas {
  conversas: ConversaLida[];
  piso: string | null;
  pode_ter_mais: boolean;
  total: number | null;
  /** Horário de cada item BRUTO da página, na ordem da API (null se faltar). */
  ems: (string | null)[];
}

/**
 * Coleta o item se ele ainda não foi processado:
 *  - cursor (exclusivo): tudo até ele já está processado;
 *  - pendente (exclusivo): tudo com em > pendente e <= topo já está processado;
 *    o grupo com em == pendente é relido.
 * Um ciclo incompleto só fecha depois de ler TODO o grupo do seu piso, então
 * o pendente nunca deixa um empate pela metade.
 */
function dentroDaJanela(em: string, j: Janela): boolean {
  if (antesDoInicio(em, j)) return false;
  if (j.cursor !== null && em <= j.cursor) return false;
  // Estrito no piso: o grupo com o horário do piso NÃO está garantido como
  // processado (pode ter atravessado a página em que o ciclo parou). Relê-lo
  // custa leitura; tratá-lo como visto perde mensagem em silêncio.
  const jaProcessado =
    j.pendente !== null && em > j.pendente && (j.topo === null || em <= j.topo);
  return !jaProcessado;
}

/**
 * Modo do ciclo, a partir da janela guardada:
 *  - BACKLOG: ainda há histórico a recuperar (cold start, ou ciclo incompleto
 *    com pendente). Consome as leituras que sobrarem da chegada nova.
 *  - INCREMENTAL: janela fechada; só as mensagens novas acima do topo.
 * Separar o modo não muda a coleta: muda o que a gestão deve esperar e o
 * que alerta quando o backlog não drena.
 */
export function modoDoCiclo(j: Janela): "BACKLOG" | "INCREMENTAL" {
  return j.cursor === null || j.pendente !== null ? "BACKLOG" : "INCREMENTAL";
}

export function lerPaginaConversas(resposta: unknown, janela: Janela): PaginaConversas {
  const corpo = resposta as { conversas?: ConversaMcp[]; paginacao?: { total?: number } } | null;
  const itens = Array.isArray(corpo?.conversas) ? corpo!.conversas! : [];
  const total = typeof corpo?.paginacao?.total === "number" ? corpo!.paginacao!.total! : null;

  let piso: string | null = null;
  const conversas: ConversaLida[] = [];
  const ems = itens.map((c) => c?.ultimaMensagemEm ?? c?.ultimaMensagem?.em ?? null);

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
  // Com `desde`, uma página cujo piso já está abaixo do início não tem mais nada
  // a coletar: tudo abaixo é fora do escopo, não backlog.
  const pode_ter_mais =
    itens.length >= LIMITE_PAGINA &&
    (janela.cursor === null || (piso !== null && piso > janela.cursor)) &&
    !(piso !== null && antesDoInicio(piso, janela));

  return { conversas, piso, pode_ter_mais, total, ems };
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

export function cargaDetalhe(conversaId: string, antesDe?: string | null, id = 1) {
  const args: Record<string, unknown> = { id: conversaId, limite: 20 };
  if (antesDe) args.antesDe = antesDe;
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ler_conversa", arguments: args } };
}

/** Páginas de `ler_conversa` por conversa antes de parar e registrar a pendência. 3 x 20 = 60. */
export const MAX_PAGINAS_DETALHE = 3;

export type PassoDetalhe =
  | { acao: "CONCLUIR"; ultima_cliente: string | null }
  | { acao: "CONTINUAR"; antes_de: string }
  | { acao: "ALCANCE_ESGOTADO"; antes_de: string };

/**
 * Próximo passo de uma conversa, a partir de UMA página de `ler_conversa`.
 *
 * - há mensagem do cliente na página: CONCLUIR com a mais nova dele (a primeira
 *   página com cliente contém a mais recente);
 * - não há, o histórico tem mais: CONTINUAR com `antesDe`, até MAX_PAGINAS_DETALHE;
 * - não há, o limite de páginas acabou e ainda há histórico: ALCANCE_ESGOTADO.
 *   NUNCA se conclui "sem resposta" por truncamento: a pendência fica visível e
 *   guarda `antesDe` para retomada;
 * - não há, e o histórico acabou (maisAntigas falso): CONCLUIR null. Aí sim o
 *   histórico inteiro foi lido e não existe resposta do cliente.
 */
export function decidirDetalhe(resposta: unknown, paginasJaLidas: number): PassoDetalhe {
  const corpo = resposta as {
    paginacao?: { maisAntigas?: boolean; antesDe?: string };
  } | null;
  const ultima = ultimaDoClienteNoDetalhe(resposta);
  if (ultima !== null) return { acao: "CONCLUIR", ultima_cliente: ultima };
  const maisAntigas = corpo?.paginacao?.maisAntigas === true;
  const antesDe = corpo?.paginacao?.antesDe;
  if (!maisAntigas) return { acao: "CONCLUIR", ultima_cliente: null };
  if (typeof antesDe !== "string" || antesDe.length === 0) {
    // Há histórico mas a API não deu o ponto de retomada: não se conclui.
    return { acao: "ALCANCE_ESGOTADO", antes_de: "" };
  }
  if (paginasJaLidas + 1 >= MAX_PAGINAS_DETALHE) return { acao: "ALCANCE_ESGOTADO", antes_de: antesDe };
  return { acao: "CONTINUAR", antes_de: antesDe };
}

/** Consulta de saldo: `meu_acesso`. Mesma pessoa do token usado na chamada. */
export function cargaMeuAcesso(id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "meu_acesso", arguments: {} } };
}

/**
 * Saldo diário restante, lido do contrato medido de `meu_acesso`:
 * `limites.pessoaPorDia.restam` (medido em 08/11/2026: limite 500, restam 443).
 * Devolve null se o campo não vier: nunca se presume valor.
 */
export function saldoDoMeuAcesso(resposta: unknown): number | null {
  const corpo = resposta as { limites?: { pessoaPorDia?: { restam?: unknown } } } | null;
  const restam = corpo?.limites?.pessoaPorDia?.restam;
  return typeof restam === "number" && Number.isFinite(restam) && restam >= 0 ? Math.floor(restam) : null;
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
  /** Saldo informado pela API prevalece quando é MENOR que o local. */
  ajustarAoSaldoDaApi(saldoApi: number | null): void {
    if (saldoApi !== null && saldoApi < this.restante) this.restante = saldoApi;
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
  /** Onde retomar a leitura de detalhe desta conversa (paginação `antesDe`). */
  antes_de?: string | null;
  /** Páginas já lidas nesta tentativa de detalhe (limite MAX_PAGINAS_DETALHE). */
  paginas_lidas?: number;
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
  /** Páginas lidas (inclusive as que só pularam e as descartadas). */
  leituras: number;
  /** Verdadeiro quando a janela NÃO foi lida até o fim: o próximo ciclo continua. */
  truncado: boolean;
  /** Menor `em` coletado neste ciclo. */
  piso_coletado: string | null;
  /** Maior `em` visto neste ciclo (coletado). Vira o topo. */
  topo_coletado: string | null;
  /**
   * Pendente da PRÓXIMA janela, quando truncado. É EXCLUSIVO: itens com
   * em > pendente e <= topo já estão processados; itens com em <= pendente ainda
   * não estão. Nunca aponta para um item já coletado, então nada se repete entre
   * ciclos e nada abaixo do piso se perde.
   */
  pendente_proximo: string | null;
  /**
   * Posição de leitura para o próximo ciclo: índice, na lista ordenada, da
   * primeira mensagem com em <= pendente. Null quando o ciclo fechou a janela.
   * É só uma dica: quem a usa valida antes de pular (ver `posicao`).
   */
  offset_pendente: number | null;
}

type FimDoCiclo = { terminou: boolean; pendente: string | null };

/** Quantas mensagens antes da posição guardada começar a leitura. Uma página de folga. */
export const FOLGA_POSICAO = LIMITE_PAGINA;

/**
 * Lê as páginas da mais nova para a mais antiga. `buscarPagina(n)` é injetado:
 * em produção chama a Mensageria; no teste, uma lista em memória que pode
 * mudar entre páginas (mensagem chegando no meio da leitura).
 *
 * `posicao` (opcional) é o `offset_pendente` do ciclo anterior. Regras:
 *  - as mensagens NOVAS (acima do topo) são lidas primeiro, em sequência;
 *  - só depois de passar do topo a leitura pula para a página da posição
 *    (com uma página de folga), e só se essa página começar acima do pendente;
 *  - se a página de destino não começar acima do pendente, a posição está
 *    errada: descarta a página e segue em sequência. Nada se perde.
 *
 * Ao atingir o teto de páginas COM coleta, não para no meio de um grupo de
 * mesmo horário: fecha o grupo do piso (lendo as páginas seguintes enquanto o
 * horário continuar igual, até o teto de leituras) e só então para.
 */
export async function colherConversas(
  buscarPagina: (pagina: number) => Promise<unknown>,
  janela: Janela,
  limites: {
    maxPaginas?: number;
    hardLeituras?: number;
    pode?: () => boolean;
    posicao?: { offset: number };
  } = {},
): Promise<Colheita> {
  const pode = limites.pode ?? (() => true);
  const maxPaginas = limites.maxPaginas ?? MAX_PAGINAS;
  const hardLeituras = limites.hardLeituras ?? HARD_LEITURAS;
  const conversas: ConversaLida[] = [];
  // Paginação por offset: uma mensagem nova no topo empurra os itens para a
  // página seguinte, e um item pode aparecer em duas páginas do mesmo ciclo.
  // Dedupe pelo id dentro do ciclo; entre ciclos, a janela cuida disso.
  const vistos = new Set<string>();
  // Estado mutável em objeto: evita o estreitamento de tipo do TypeScript sobre
  // variáveis atribuídas dentro de closures.
  const acc = { piso: null as string | null, topo: null as string | null };
  // Índice e horário de cada item lido, para achar a posição do pendente.
  const lidos: Array<{ indice: number; em: string | null }> = [];
  let leituras = 0;
  let paginasComColeta = 0;

  const recolher = (lista: ConversaLida[]) => {
    for (const c of lista) {
      if (vistos.has(c.ulbra_conversa_id)) continue;
      vistos.add(c.ulbra_conversa_id);
      conversas.push(c);
      if (acc.piso === null || c.ultima_mensagem_em < acc.piso) acc.piso = c.ultima_mensagem_em;
      if (acc.topo === null || c.ultima_mensagem_em > acc.topo) acc.topo = c.ultima_mensagem_em;
    }
  };

  const ler = async (n: number): Promise<PaginaConversas> => {
    const p = lerPaginaConversas(await buscarPagina(n), janela);
    leituras++;
    p.ems.forEach((em, i) => lidos.push({ indice: (n - 1) * LIMITE_PAGINA + i, em }));
    return p;
  };

  /** Fecha o grupo do piso a partir da página `inicio`, sem partir o mesmo horário. */
  const fecharGrupo = async (inicio: number): Promise<FimDoCiclo> => {
    const grupo = acc.piso;
    if (grupo === null) return { terminou: false, pendente: null };
    let n = inicio;
    for (;;) {
      if (leituras >= hardLeituras || !pode()) return { terminou: false, pendente: grupo };
      const p = await ler(n);
      n++;
      // Só entra o que tem o horário do grupo; o restante fica para o próximo ciclo.
      recolher(p.conversas.filter((c) => c.ultima_mensagem_em === grupo));
      if (p.piso === null) return { terminou: true, pendente: null };
      if (p.piso < grupo) {
        if (janela.cursor !== null && p.piso <= janela.cursor) return { terminou: true, pendente: null };
        // Itens abaixo do grupo nesta página ainda não foram coletados. O pendente
        // é o maior deles: os de horário igual a ele voltam no próximo ciclo.
        let maiorAbaixo: string | null = null;
        for (const c of p.conversas) {
          if (c.ultima_mensagem_em < grupo && (maiorAbaixo === null || c.ultima_mensagem_em > maiorAbaixo)) {
            maiorAbaixo = c.ultima_mensagem_em;
          }
        }
        // Nada abaixo do grupo dentro do escopo e o piso já passou do início: completo.
        if (maiorAbaixo === null && antesDoInicio(p.piso, janela)) return { terminou: true, pendente: null };
        return { terminou: false, pendente: maiorAbaixo ?? grupo };
      }
    }
  };

  let fim: FimDoCiclo | null = null;
  let saltou = false;
  let pagina = 1;
  // O teto conta LEITURAS feitas, não números de página: um salto não pode
  // deixar o ciclo com menos leituras do que o teto permite.
  while (leituras < hardLeituras) {
    // Sem saldo: para AQUI e marca incompleto. Nunca trata página não lida como vazia.
    if (!pode()) break;
    const lida = await ler(pagina);
    if (lida.conversas.length > 0) paginasComColeta++;
    recolher(lida.conversas);
    // Fim da janela: nada mais acima do cursor. Ciclo completo.
    if (!lida.pode_ter_mais) {
      fim = { terminou: true, pendente: null };
      break;
    }
    if (paginasComColeta >= maxPaginas) {
      fim = await fecharGrupo(pagina + 1);
      break;
    }
    let proxima = pagina + 1;
    // Passou do topo (esta página já tem mensagem que não é nova): tudo acima foi lido.
    // Só então a posição guardada pode pular o trecho já processado.
    if (
      !saltou &&
      limites.posicao !== undefined &&
      janela.pendente !== null &&
      janela.topo !== null &&
      lida.piso !== null &&
      lida.piso <= janela.topo
    ) {
      saltou = true;
      const alvo = Math.floor(Math.max(0, limites.posicao.offset - FOLGA_POSICAO) / LIMITE_PAGINA) + 1;
      if (alvo > pagina + 1 && leituras < hardLeituras && pode()) {
        const cand = await ler(alvo);
        const primeiro = cand.ems[0] ?? null;
        if (primeiro !== null && primeiro > janela.pendente) {
          if (cand.conversas.length > 0) paginasComColeta++;
          recolher(cand.conversas);
          if (!cand.pode_ter_mais) {
            fim = { terminou: true, pendente: null };
            break;
          }
          if (paginasComColeta >= maxPaginas) {
            fim = await fecharGrupo(alvo + 1);
            break;
          }
          proxima = alvo + 1;
        }
        // Posição errada: a página lida é descartada e a leitura segue em sequência.
      }
    }
    pagina = proxima;
  }

  // Sem fim da janela (teto de leituras, saldo ou página sem coleta até o fim do
  // laço): INCOMPLETO. Antes, um laço que esgotava HARD_LEITURAS saía como
  // completo e o cursor avançava por cima do backlog não lido.
  const terminou = fim?.terminou === true;
  const pendente = terminou ? null : (fim?.pendente ?? acc.piso ?? janela.pendente);
  let offset: number | null = null;
  if (!terminou && pendente !== null) {
    for (const x of lidos) {
      if (x.em !== null && x.em <= pendente && (offset === null || x.indice < offset)) offset = x.indice;
    }
    if (offset === null) offset = limites.posicao?.offset ?? null;
  }
  return {
    conversas,
    leituras,
    truncado: !terminou,
    piso_coletado: acc.piso,
    topo_coletado: acc.topo,
    pendente_proximo: pendente,
    offset_pendente: offset,
  };
}

/** Janela do PRÓXIMO ciclo. Ciclo completo fecha o backlog; incompleto guarda o pendente. */
export function novaJanela(janela: Janela, colheita: Colheita): Janela {
  const topoNovo = maiorDeDois(janela.topo, colheita.topo_coletado);
  if (!colheita.truncado) {
    return { cursor: topoNovo, pendente: null, topo: topoNovo };
  }
  return { cursor: janela.cursor, pendente: colheita.pendente_proximo, topo: topoNovo };
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

/** `meu_acesso` para o saldo real: 1 por hora, com cache de 60 min na função. */
export const CONSULTAS_SALDO_DIA = 24;

/**
 * Custo diário da SINCRONIZAÇÃO (sem as fichas dos operadores), com tudo o que a
 * função chama de fato:
 *  - listar_conversas: 1 por ciclo (com páginas por ciclo, até MAX_PAGINAS);
 *  - ler_conversa: DETALHE_POR_CICLO por ciclo, no pior caso (fila sempre cheia);
 *  - listar_atendimentos: a cada cadencia_atendimentos_min;
 *  - meu_acesso: 1 por hora.
 * Fichas dos operadores usam a reserva (RESERVA_FICHAS_DIA) e não entram aqui.
 * Antes, esta conta deixava de fora as leituras de detalhe e o saldo, e dava
 * "cabe" para cadências que estouram o teto.
 */
export function custoDiarioEstimado(c: Cadencia, detalhePorCiclo: number = DETALHE_POR_CICLO): {
  conversas: number;
  detalhes: number;
  atendimentos: number;
  saldo: number;
  base: number;
  margem: number;
  total: number;
  fichas: number;
  cabe: boolean;
} {
  const minutosDoDia = 24 * 60;
  const ciclos = Math.floor(minutosDoDia / c.cadencia_conversas_min);
  const conversas = ciclos * Math.min(c.paginas_por_ciclo, MAX_PAGINAS);
  const detalhes = ciclos * detalhePorCiclo;
  const atendimentos = Math.floor(minutosDoDia / c.cadencia_atendimentos_min);
  const saldo = CONSULTAS_SALDO_DIA;
  const base = conversas + detalhes + atendimentos + saldo;
  const margem = Math.ceil(base * c.margem_falha);
  const total = base + margem;
  const fichas = c.fichas_por_dia;
  return {
    conversas,
    detalhes,
    atendimentos,
    saldo,
    base,
    margem,
    total,
    fichas,
    cabe: total <= TETO_DIARIO_SYNC && fichas <= RESERVA_FICHAS_DIA,
  };
}

// ---------------------------------------------------------------------------
// Parâmetros da chamada manual (coleta por período)
// ---------------------------------------------------------------------------
/** Teto de chamadas desta execução, lido do corpo JSON. Ausente = sem teto extra. */
export const TETO_EXECUCAO_MAX = 12;
/** Leituras de detalhe por execução quando o corpo pede (coleta por período). */
export const DETALHES_EXECUCAO_MAX = 20;
/** `desde` não pode ser mais antigo que isto: coleta por período é para o mês corrente, não para o histórico. */
export const DESDE_MAX_DIAS = 120;

export interface ParametrosExecucao {
  teto_chamadas: number | null;
  /** Início da janela (ISO), ou null. Ver `Janela.desde`. */
  desde: string | null;
  detalhes: number | null;
}

/**
 * Corpo JSON da chamada manual: `teto_chamadas` (1..12), `desde` (data ISO ou
 * `AAAA-MM-DD`, até 120 dias atrás, nunca no futuro) e `detalhes` (1..20).
 * Corpo ausente = sem parâmetros (cron). Qualquer campo inválido = INVALIDO.
 */
export function lerParametros(texto: string, agoraMs = Date.now()): ParametrosExecucao | "INVALIDO" | null {
  if (!texto) return null;
  let corpo: { teto_chamadas?: unknown; desde?: unknown; detalhes?: unknown };
  try {
    corpo = JSON.parse(texto);
  } catch {
    return "INVALIDO";
  }
  const r: ParametrosExecucao = { teto_chamadas: null, desde: null, detalhes: null };
  if (corpo.teto_chamadas !== undefined) {
    const n = corpo.teto_chamadas;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= TETO_EXECUCAO_MAX)) return "INVALIDO";
    r.teto_chamadas = n;
  }
  if (corpo.detalhes !== undefined) {
    const n = corpo.detalhes;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= DETALHES_EXECUCAO_MAX)) return "INVALIDO";
    r.detalhes = n;
  }
  if (corpo.desde !== undefined) {
    const d = corpo.desde;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(d)) return "INVALIDO";
    // Data pura vale como meia-noite de Brasília, não UTC: "novembro" é o mês daqui.
    const iso = d.length === 10 ? `${d}T00:00:00-03:00` : d;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms) || ms > agoraMs || agoraMs - ms > DESDE_MAX_DIAS * 86400000) return "INVALIDO";
    r.desde = new Date(ms).toISOString();
  }
  return r;
}
