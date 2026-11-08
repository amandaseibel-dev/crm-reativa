// Resposta do aluno na Mensageria Ulbra — lógica pura, sem rede e sem React.
//
// PREMISSA CORRIGIDA EM 08/11/2026. Uma versão anterior deste arquivo dizia
// que a Mensageria não expunha mensagens e derivava "o aluno respondeu" de
// `situacao === "waiting"` e "não lida" de `atualizadoEm`. **Estava errado.**
// O diagnóstico de produção (#854/#855) confirmou no token de backend 18
// escopos e 60 ferramentas, entre elas `conversas:read`, `listar_conversas` e
// `ler_conversa`. Os contratos foram medidos em 08/11/2026 e estão abaixo.
// `waiting` é estado de ATENDIMENTO e `atualizadoEm` muda por qualquer
// motivo — nenhum dos dois é evidência de mensagem recebida, e não são mais
// usados aqui.
//
// CONTRATO MEDIDO — `listar_conversas` devolve, por conversa:
//   { id, canal, situacao, cliente{id,nome}, equipe, responsavel,
//     ultimaMensagemEm, ultimaMensagem{ quem, em, trecho } }
//
// CONTRATO MEDIDO — `ler_conversa` devolve, por mensagem:
//   { id, quem, autor, em, tipo, texto, transcricao, assunto, anexos[] }
//   `paginacao { maisAntigas, antesDe }` para as anteriores.
//
// Daí saem as quatro coisas que o aviso precisa, todas de primeira mão:
//   mensagem recebida -> `quem === "cliente"`
//   direção           -> `quem` ∈ cliente | operador | bot | sistema
//   id                -> `id` da mensagem (24 hex)
//   horário           -> `em` (ISO)

/** Quem mandou. Medido em `ler_conversa` em 08/11/2026. */
export const DIRECOES = ["cliente", "operador", "bot", "sistema"];

/** Só esta direção é mensagem RECEBIDA do aluno. */
export const DIRECAO_CLIENTE = "cliente";

/** Limite medido da Mensageria, por pessoa (docs/integracoes/mensageria-ulbra.md). */
export const LIMITE_DIARIO_MENSAGERIA = 500;

function instante(valor) {
  if (!valor) return null;
  const t = new Date(valor).getTime();
  return Number.isFinite(t) ? t : null;
}

function texto(valor) {
  const s = String(valor ?? "").trim();
  return s || null;
}

function direcao(valor) {
  const d = texto(valor);
  return DIRECOES.includes(d) ? d : null;
}

/**
 * Normaliza UMA MENSAGEM de `ler_conversa`.
 * Guarda id, direção e horário — nunca o texto: conteúdo de conversa fica na
 * Mensageria, lido sob demanda por quem tem alcance lá.
 */
export function normalizarMensagem(bruto, extra = {}) {
  if (!bruto || typeof bruto !== "object") return null;
  const mensagem_id = texto(bruto.mensagem_id ?? bruto.id);
  const quem = direcao(bruto.quem);
  const em = texto(bruto.em ?? bruto.recebida_em);
  // Falha fechado: sem id, sem direção reconhecida ou sem horário não dá para
  // dizer que alguém respondeu, nem quando.
  if (!mensagem_id || !quem || instante(em) === null) return null;
  return {
    mensagem_id,
    conversa_id: texto(extra.conversa_id ?? bruto.conversa_id),
    canal: texto(extra.canal ?? bruto.canal),
    quem,
    recebida_em: em,
    tipo: texto(bruto.tipo),
    aluno_id: texto(extra.aluno_id ?? bruto.aluno_id),
    aluno_nome: texto(extra.aluno_nome ?? bruto.aluno_nome),
    ulbra_cliente_id: texto(extra.ulbra_cliente_id ?? bruto.ulbra_cliente_id),
    responsavel_email: (texto(extra.responsavel_email ?? bruto.responsavel_email) || "").toLowerCase() || null,
  };
}

/**
 * Normaliza UMA CONVERSA de `listar_conversas`. O barato aqui é que a lista
 * já traz `ultimaMensagem{quem, em}` — dá para saber quem falou por último
 * sem abrir a conversa, logo sem gastar uma chamada por aluno.
 *
 * Note que NÃO filtramos por `equipe`: a conversa medida veio com
 * `equipe: "Única"`, e a ferramenta nem aceita filtro de equipe. Quem diz que
 * a conversa é nossa é o VÍNCULO POR CPF (`cliente.id` ↔ `ulbra_vinculos`),
 * resolvido fora daqui.
 */
export function normalizarConversa(bruto, extra = {}) {
  if (!bruto || typeof bruto !== "object") return null;
  const conversa_id = texto(bruto.conversa_id ?? bruto.id);
  if (!conversa_id) return null;
  const ultima = bruto.ultimaMensagem ?? bruto.ultima_mensagem ?? null;
  const quem = direcao(ultima?.quem ?? bruto.ultima_de);
  const em = texto(ultima?.em ?? bruto.ultimaMensagemEm ?? bruto.ultima_mensagem_em);
  return {
    conversa_id,
    canal: texto(bruto.canal),
    situacao: texto(bruto.situacao),
    ulbra_cliente_id: texto(bruto.cliente?.id ?? bruto.ulbra_cliente_id),
    cliente_nome: texto(bruto.cliente?.nome ?? bruto.cliente_nome),
    equipe: texto(bruto.equipe),
    // Quem falou por último e quando. `null` quando a conversa não traz —
    // conversa sem última mensagem conhecida não vira aviso.
    ultima_de: quem,
    ultima_em: instante(em) === null ? null : em,
    aluno_id: texto(extra.aluno_id ?? bruto.aluno_id),
    aluno_nome: texto(extra.aluno_nome ?? bruto.aluno_nome),
    responsavel_email: (texto(extra.responsavel_email ?? bruto.responsavel_email) || "").toLowerCase() || null,
  };
}

/** A mensagem foi recebida DO ALUNO. É a evidência, não um proxy. */
export function mensagemRecebida(m) {
  return m?.quem === DIRECAO_CLIENTE;
}

/**
 * "O aluno respondeu": a ÚLTIMA mensagem da conversa é do cliente — ou seja,
 * a bola está com a gente. Se o último a falar foi operador, bot ou sistema,
 * ninguém está esperando resposta nossa.
 */
export function alunoRespondeu(conversa) {
  return conversa?.ultima_de === DIRECAO_CLIENTE && Boolean(conversa?.ultima_em);
}

/**
 * Recorte de quem recebe o aviso. Operador vê a própria carteira; gestão vê
 * tudo. Isto é peso de TELA — quem decide o que cada um pode ler é a RLS de
 * `ulbra_mensagens_recebidas` e o portão da Edge Function.
 */
export function doResponsavel(itens, { email, gestao = false } = {}) {
  const lista = Array.isArray(itens) ? itens : [];
  if (gestao) return lista;
  const meu = String(email ?? "").trim().toLowerCase();
  return lista.filter((i) => {
    // Sem responsável conhecido = cliente ainda não vinculado por CPF. Esse
    // caso é só da gestão: não dá para dizer de quem é a conversa.
    if (!i?.responsavel_email) return false;
    return Boolean(meu) && i.responsavel_email === meu;
  });
}

/**
 * Não lidas: respostas do aluno com horário posterior ao marcador de leitura
 * DESTE usuário. O marcador é nosso — a Mensageria não expõe leitura.
 */
export function naoLidas(itens, { lidoAte = null } = {}) {
  const lista = (Array.isArray(itens) ? itens : []).filter(alunoRespondeu);
  const corte = instante(lidoAte);
  if (corte === null) return lista;
  return lista.filter((i) => {
    const t = instante(i.ultima_em);
    return t !== null && t > corte;
  });
}

export function contarNaoLidas(itens, opcoes = {}) {
  return naoLidas(doResponsavel(itens, opcoes), opcoes).length;
}

/**
 * Dimensionamento dentro das 500 chamadas/dia.
 *
 * CORREÇÃO DE ARQUITETURA, medida em 08/11/2026. A versão anterior assumia
 * que um tick custava 1 chamada. Não custa: **hoje não existe nada
 * compartilhado entre operadores**.
 *   - `ulbra-leads-pendentes` não tem cache nenhum;
 *   - o cache da `ulbra-atendimento` é um `Map` em memória de isolate
 *     (`index.ts:14`), que não atravessa isolates nem sobrevive à reciclagem.
 * Logo, com polling no navegador, o custo multiplica por operador logado.
 *
 * `operadores` é justamente esse multiplicador:
 *   - sincronização CENTRALIZADA (um job no servidor) -> `operadores: 1`,
 *     porque os navegadores passam a ler o Postgres, que não gasta orçamento;
 *   - polling no navegador -> `operadores: N`, e é aí que estoura.
 */
export function orcamentoSincronizacao({
  intervaloMin = 10,
  horasPorDia = 12,
  operadores = 1,
  aberturasFicha = 0,
  limiteDiario = LIMITE_DIARIO_MENSAGERIA,
} = {}) {
  const porHora = intervaloMin > 0 ? 60 / intervaloMin : 0;
  const sincronizacao = Math.ceil(porHora * horasPorDia) * Math.max(1, operadores);
  const fichas = Math.max(0, aberturasFicha) * 2;
  const total = sincronizacao + fichas;
  return {
    sincronizacao,
    fichas,
    total,
    limiteDiario,
    folga: limiteDiario - total,
    cabe: total <= limiteDiario,
  };
}

/**
 * Dados SIMULADOS. Mantidos SEPARADOS do real de propósito: quem chama isto
 * sabe que está pedindo amostra, e a tela carimba o selo SIMULADO.
 * Datas relativas a `agora` — fixture com data absoluta vence e derruba o CI.
 */
export function amostraSimulada(agora = Date.now(), email = "cobranca05@aelbra.com.br") {
  const min = (n) => new Date(agora - n * 60_000).toISOString();
  return [
    // Último a falar foi o aluno: é resposta esperando.
    {
      id: "sim-conversa-1",
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "sim-cliente-1", nome: "Maria Oliveira dos Santos" },
      equipe: "Única",
      ultimaMensagemEm: min(4),
      ultimaMensagem: { quem: "cliente", em: min(4), trecho: "Quanto ficaria?" },
    },
    {
      id: "sim-conversa-2",
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "sim-cliente-2", nome: "Carlos Eduardo Lima" },
      equipe: "Única",
      ultimaMensagemEm: min(41),
      ultimaMensagem: { quem: "cliente", em: min(41), trecho: "Consigo parcelar?" },
    },
    // Último a falar fomos nós: NÃO é resposta esperando.
    {
      id: "sim-conversa-3",
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "sim-cliente-3", nome: "Juliana Prado" },
      equipe: "Única",
      ultimaMensagemEm: min(120),
      ultimaMensagem: { quem: "operador", em: min(120), trecho: "Enviei o link" },
    },
  ].map((c, i) =>
    normalizarConversa(c, {
      aluno_id: `sim-aluno-${i + 1}`,
      aluno_nome: c.cliente.nome,
      responsavel_email: email,
    }),
  );
}
