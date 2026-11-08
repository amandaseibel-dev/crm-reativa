// Resposta do aluno na Mensageria Ulbra — lógica pura, sem rede e sem React.
//
// ATENÇÃO AO QUE ESTE MÓDULO *NÃO* SABE, porque a tela não pode prometer mais
// do que a integração entrega. A Mensageria **não expõe mensagens nem
// conversas** pelo MCP (`docs/integracoes/mensageria-ulbra.md`, seção
// "Ferramentas (8) e escopos": "Não expostos: conversas, mensagens, envio,
// campanhas, templates..."). De um atendimento o token lê apenas:
//
//   id, cliente{id,nome}, situacao, coluna, equipe, atendente,
//   entrouEm, aceitoEm, atualizadoEm
//
// Logo **não existe "mensagem não lida"** para ler: não há remetente, não há
// conteúdo e não há marca de leitura do lado da ULBRA. O que este módulo
// chama de "o aluno respondeu" e de "não lidas" é derivado de ESTADO e de
// CARIMBO DE TEMPO, e a tela diz isso ao operador em vez de sugerir que
// lemos a conversa.
//
//   "o aluno respondeu"  :=  o atendimento está `waiting` — esperando alguém
//                            da Reativa. É o mesmo sinal que a
//                            `ulbra-leads-pendentes` já usa para a fila
//                            receptiva (`situacao: "waiting"`).
//   "não lida"           :=  `atualizado_em` é posterior ao último instante em
//                            que ESTE usuário olhou. O marcador de leitura é
//                            NOSSO, não da ULBRA.
//
// Quem quiser o conteúdo da conversa abre o cadastro na Mensageria pelo botão
// que já existe na ficha.

/** Nome canônico da equipe. Comparação exata, como em `ulbra-leads-pendentes`. */
export const EQUIPE_REATIVA = "Reativa";

/** Situação que significa "esperando a Reativa" na Mensageria. */
export const SITUACAO_ESPERANDO = "waiting";

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

/**
 * Normaliza um atendimento vindo da Mensageria (ou do dublê) para o formato
 * que a tela usa. Devolve `null` para o que não serve — sem id não há o que
 * mostrar, e equipe diferente de "Reativa" não é nosso.
 *
 * Falha fechado de propósito: na dúvida o item some da lista, em vez de
 * aparecer como aviso que ninguém sabe de quem é.
 */
export function normalizarAtendimento(bruto) {
  if (!bruto || typeof bruto !== "object") return null;
  const id = texto(bruto.atendimento_id ?? bruto.id);
  if (!id) return null;
  if (texto(bruto.equipe) !== EQUIPE_REATIVA) return null;
  return {
    atendimento_id: id,
    aluno_id: texto(bruto.aluno_id),
    aluno_nome: texto(bruto.aluno_nome ?? bruto.cliente?.nome),
    responsavel_email: (texto(bruto.responsavel_email) || "").toLowerCase() || null,
    situacao: texto(bruto.situacao),
    entrou_em: texto(bruto.entrou_em ?? bruto.entrouEm),
    atualizado_em: texto(bruto.atualizado_em ?? bruto.atualizadoEm ?? bruto.entrou_em ?? bruto.entrouEm),
  };
}

/**
 * "O aluno respondeu" — isto é, o atendimento está esperando a Reativa.
 * Não é leitura de mensagem; ver o cabeçalho deste arquivo.
 */
export function alunoRespondeu(item) {
  return item?.situacao === SITUACAO_ESPERANDO;
}

/**
 * O recorte de quem recebe o aviso. O responsável vê os alunos da própria
 * carteira; a gestão vê todos.
 *
 * Isto é peso de TELA, não permissão: quem decide o que cada um pode ler é o
 * portão da Edge Function (`receptivo` da própria linha ou `usuario_e_gestao()`,
 * em `ulbra-leads-pendentes/portao.ts`). Filtrar aqui sem o portão lá seria
 * esconder, não proteger.
 */
export function doResponsavel(itens, { email, gestao = false } = {}) {
  const lista = Array.isArray(itens) ? itens : [];
  if (gestao) return lista;
  const meu = String(email ?? "").trim().toLowerCase();
  return lista.filter((i) => {
    // Item SEM responsável conhecido fica visível para quem o portão já
    // deixou passar. É o caso da `ulbra-leads-pendentes` de hoje, que devolve
    // só id, nome e data: esconder por falta de um campo que a fonte ainda
    // não manda seria perder lead receptivo em silêncio. Quem amarra
    // atendimento a responsável é a etapa 2.
    if (!i?.responsavel_email) return true;
    return Boolean(meu) && i.responsavel_email === meu;
  });
}

/**
 * Atendimentos que mudaram depois do último olhar deste usuário.
 *
 * `vistoEm` ausente (primeira vez na máquina) devolve a lista inteira: é
 * melhor avisar demais uma vez do que engolir a primeira resposta do dia.
 */
export function naoLidas(itens, { vistoEm = null } = {}) {
  const lista = (Array.isArray(itens) ? itens : []).filter(alunoRespondeu);
  const corte = instante(vistoEm);
  if (corte === null) return lista;
  return lista.filter((i) => {
    const t = instante(i?.atualizado_em);
    return t !== null && t > corte;
  });
}

/** Quantas não lidas o responsável tem. É o número do contador. */
export function contarNaoLidas(itens, opcoes = {}) {
  return naoLidas(doResponsavel(itens, opcoes), opcoes).length;
}

/**
 * Dimensionamento da sincronização dentro das 500 chamadas/dia.
 *
 * O que torna a conta viável: `listar_atendimentos` aceita `equipe` e
 * `limite ≤ 500`, então **uma chamada cobre a equipe Reativa inteira**. O
 * custo do sinal NÃO cresce com o número de alunos nem com o número de
 * operadores com a tela aberta — cresce só com a FREQUÊNCIA, desde que a
 * leitura seja compartilhada (uma chamada por tick, não uma por operador).
 *
 * Os outros consumidores do mesmo orçamento, hoje:
 *   - `ulbra-consultar`   — 1 chamada por abertura de ficha;
 *   - `ulbra-atendimento` — 1 por abertura de ficha, com cache de 5 min;
 *   - `ulbra-leads-pendentes` — 1 por tick de quem estiver na fila receptiva.
 *
 * `aberturasFicha` é o número de fichas abertas no dia; cada uma custa 2.
 */
export function orcamentoSincronizacao({
  intervaloMin = 10,
  horasPorDia = 12,
  aberturasFicha = 0,
  limiteDiario = LIMITE_DIARIO_MENSAGERIA,
} = {}) {
  const porHora = intervaloMin > 0 ? 60 / intervaloMin : 0;
  const sincronizacao = Math.ceil(porHora * horasPorDia);
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
 * Dados SIMULADOS da etapa 1. Nenhuma chamada à Mensageria, nenhuma mensagem
 * enviada — a etapa 1 entrega a tela funcionando sem tocar na integração.
 *
 * Datas são relativas a `agora` de propósito: fixture com data absoluta vence
 * e derruba o CI (já aconteceu neste repositório).
 */
export function amostraSimulada(agora = Date.now(), email = "cobranca05@aelbra.com.br") {
  const min = (n) => new Date(agora - n * 60_000).toISOString();
  return [
    {
      atendimento_id: "sim-1",
      aluno_id: "sim-aluno-1",
      aluno_nome: "Maria Oliveira dos Santos",
      responsavel_email: email,
      situacao: SITUACAO_ESPERANDO,
      equipe: EQUIPE_REATIVA,
      entrou_em: min(18),
      atualizado_em: min(4),
    },
    {
      atendimento_id: "sim-2",
      aluno_id: "sim-aluno-2",
      aluno_nome: "Carlos Eduardo Lima",
      responsavel_email: email,
      situacao: SITUACAO_ESPERANDO,
      equipe: EQUIPE_REATIVA,
      entrou_em: min(95),
      atualizado_em: min(41),
    },
    {
      // Já aceito por alguém: NÃO conta como resposta esperando.
      atendimento_id: "sim-3",
      aluno_id: "sim-aluno-3",
      aluno_nome: "Juliana Prado",
      responsavel_email: email,
      situacao: "accepted",
      equipe: EQUIPE_REATIVA,
      entrou_em: min(240),
      atualizado_em: min(120),
    },
    {
      // Outra equipe: não é nossa, some na normalização.
      atendimento_id: "sim-4",
      aluno_nome: "Fora do escopo",
      responsavel_email: email,
      situacao: SITUACAO_ESPERANDO,
      equipe: "Financeiro",
      entrou_em: min(30),
      atualizado_em: min(10),
    },
  ]
    .map(normalizarAtendimento)
    .filter(Boolean);
}
