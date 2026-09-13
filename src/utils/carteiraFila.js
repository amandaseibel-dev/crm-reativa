// Recorte da Minha Carteira (filtros + ordenacao) e a regra do acionamento
// guiado, fora do componente para poder ser TESTADO.
//
// Por que isto existe (bug operacional de 12/09/2026)
// ---------------------------------------------------
// O guiado abria casos que NAO estavam na lista que a operadora via. Duas
// causas somadas:
//
//   1. `iniciarGuiado` trocava a ordenacao escolhida por "Fila inteligente" na
//      surdina. Quem tinha escolhido "Maior valor primeiro" recebia os casos em
//      outra ordem, sem aviso.
//   2. O avanco relia a lista VIVA a cada passo. Uma recarga da carteira no
//      meio do guiado (ela roda em segundo plano a cada avanco) podia injetar
//      id que nao existia quando o guiado comecou, e o filtro de ANO, que
//      carrega por RPC em separado, ainda podia estar vazio no clique -- ou
//      seja, o guiado comecava sobre a carteira inteira.
//
// A regra nova, em uma frase: o clique em "Iniciar acionamento" TIRA UMA FOTO
// dos ids visiveis, na ordem visivel, e o guiado percorre SO essa foto, nessa
// ordem. Invariante:
//
//   ids abertos pelo guiado  ⊆  ids visiveis no momento em que o guiado comecou
//
// Filtro e ordenacao sao coisas separadas: o recorte (quais ids) vem dos
// filtros; a sequencia (em que ordem) vem da ordenacao escolhida pela
// operadora. O guiado nao mexe em nenhum dos dois.
import { umaLinhaPorPessoa } from "./filaSemRepetido";

// ---------------------------------------------------------------------------
// Helpers puros (vieram de PainelCarteira.jsx sem alteracao de comportamento)
// ---------------------------------------------------------------------------

// Diferenca em dias entre "hoje" e uma data "YYYY-MM-DD" (alvo - hoje).
export function diasParaData(hojeStr, alvoStr) {
  const a = new Date(`${String(hojeStr).slice(0, 10)}T00:00:00`);
  const b = new Date(`${String(alvoStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Remove acentos pra busca funcionar independente de como a pessoa digitou
// (ex: "Joao" precisa achar "João").
export function semAcento(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function nomeAluno(a) {
  return a?.nome || a?.nome_aluno || a?.aluno || "Aluno sem nome";
}

export function hojeLocalBR() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

// Data local (fuso do operador) de um timestamp. Nao da pra fatiar o ISO
// direto: uma tabulacao das 22h vira o dia seguinte em UTC e a linha
// deixaria de contar como trabalhada hoje.
export function dataLocalDe(valor) {
  if (!valor) return null;
  const bruto = String(valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(bruto)) return bruto;
  const d = new Date(bruto);
  if (Number.isNaN(d.getTime())) return bruto.slice(0, 10) || null;
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

// Caso ja acionado hoje. Sai da lista de trabalho, mas segue na base: busca,
// card "Acionados hoje" e contadores continuam vendo.
export function trabalhadoHoje(a, hojeStr) {
  return dataLocalDe(a?.data_ultimo_acionamento) === (hojeStr || hojeLocalBR());
}

export function ehQuitado(a) {
  const texto = [a?.status_acionamento, a?.status_jornada, a?.status_atual]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  return texto.includes("QUITAD") || texto.includes("QUITACAO");
}

export function diasSemContato(a, agoraMs) {
  const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
  if (!base) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  const ms = (Number.isFinite(agoraMs) ? agoraMs : Date.now()) - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export const MAPA_SITUACAO = {
  CONTATAR: "A contatar",
  MENSAGEM_ENVIADA: "Mensagem enviada",
  EM_ATENDIMENTO: "Em atendimento",
  ALUNO_EM_NEGOCIACAO_24H: "Em negociacao",
  RETORNAR_DEPOIS: "Retornar depois",
  SEM_RETORNO: "Sem retorno",
  NAO_LOCALIZADO: "Nao localizado",
  AGUARDANDO_LINK: "Aguardando link",
  SOLICITADO_LINK: "Link solicitado",
  LINK_PRONTO_PARA_ENVIO: "Link pronto p/ envio",
  LINK_ENVIADO_AO_ALUNO: "Link enviado",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Pago",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  ACORDO_FECHADO: "Acordo fechado",
  ALEGA_FIES: "Alega FIES",
  ALEGA_CREDIES: "Alega CREDIES",
  ALEGA_FINANCIAMENTO: "Alega financiamento",
  ANTECIPACAO_SEMESTRE: "Antecipacao de semestre",
  AGUARDAR_RETORNO_UNIDADE: "Aguardar retorno da unidade",
  LEMBRETE_PARCELA: "Lembrete de parcela feito",
  TERMO_ENVIADO_ALUNO: "Termo enviado",
  TERMO_ENVIADO_ADM: "Termo no ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  JURIDICO: "Juridico",
  CANCELAMENTO_COBRANCA: "Cancelado",
  SUSPENSAO_COBRANCA: "Suspenso",
};

export function labelStatus(s) {
  return MAPA_SITUACAO[s] || s;
}

export const SITUACAO_QUITACAO = new Set(["QUITADO", "QUITADO_AGUARDANDO_BAIXA"]);
export const SITUACAO_CANONICA_SEM_VENCIDO = new Set([
  "ACORDO_EM_DIA",
  "AGUARDANDO_CONFIRMACAO",
  "QUITADO",
  "QUITADO_AGUARDANDO_BAIXA",
  "SEM_PENDENCIA",
]);

export function acordoEmDia(a) {
  return String(a?.situacao_operacional || "").toUpperCase() === "ACORDO_EM_DIA";
}

export function semSaldoVencido(a) {
  const sv = Number(a?.saldo_vencido);
  if (Number.isFinite(sv)) return sv <= 0.005; // sinal canonico primario
  // fallback (saldo_vencido ainda nao persistido): confia so nos estados que o
  // backend atribui exclusivamente quando o saldo vencido e zero.
  return SITUACAO_CANONICA_SEM_VENCIDO.has(String(a?.situacao_operacional || "").toUpperCase());
}

export function situacaoLabel(a) {
  const s = a?.status_atual || a?.status_jornada || "";
  // Mesma premissa do seloPrazo: baixa realizada que ainda carrega saldo
  // vencido e pagamento PARCIAL -- a tabulacao nao pode se ler como "Pago".
  if (s === "BAIXA_REALIZADA" && !semSaldoVencido(a)) return "Pago parcial";
  // Baixa de parcela com acordo em dia: ainda ha parcelas A VENCER -- nao e "Pago".
  if (s === "BAIXA_REALIZADA" && acordoEmDia(a)) return "Parcela paga — a vencer";
  if (MAPA_SITUACAO[s]) return MAPA_SITUACAO[s];
  if (!s || s === "Novo caso") return "Sem contato";
  return s;
}

// Tabulacao (desfecho do acionamento) canonica do aluno -- mesma precedencia
// usada no resto da tela: status_atual > status_jornada > status_acionamento.
export function tabulacaoDoAluno(a) {
  return a?.status_atual || a?.status_jornada || a?.status_acionamento || "";
}

// Selo de prazo que a operadora ve na linha -- SO o rotulo. A cor fica na
// tela (statusPrazo em PainelCarteira), porque filtro e ordenacao dependem
// apenas do rotulo e cor nao se testa.
export function seloPrazo(a, agoraMs) {
  const sit = a?.status_atual || "";
  if (sit === "JURIDICO") return "Juridico";
  if (["ACORDO_FECHADO", "AGUARDANDO_BAIXA", "AGUARDANDO_COMPROVANTE", "SOLICITADO_LINK", "LINK_ENVIADO_AO_ALUNO"].includes(sit))
    return "Aguardando pgto";
  // PREMISSA DO SISTEMA: "Pago" so existe com SALDO ZERADO. Caso com baixa
  // realizada que ainda carrega saldo vencido e pagamento PARCIAL -- nao pode
  // se apresentar como pago, senao a operadora para de cobrar o que sobrou.
  if (sit === "BAIXA_REALIZADA") {
    if (!semSaldoVencido(a)) return "Pago parcial";
    // Parcela baixada mas o acordo segue em dia com parcelas futuras: o caso
    // nao esta pago -- esta A VENCER. "Pago" so com saldo TOTAL zerado.
    if (acordoEmDia(a)) return "A vencer";
    return "Pago";
  }
  if (["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"].includes(sit)) return "Cancelado";

  const dias = diasSemContato(a, agoraMs);
  if (dias === null) return "Novo";
  if (dias <= 7) return "Dentro do prazo";
  if (dias === 8) return "Atencao";
  if (dias <= 10) return "Critico";
  return "Perdendo o caso";
}

// Criticidade canonica do backend (alunos.nivel_criticidade). Aqui fica SO o
// rank usado para ordenar; o texto e as cores do selo seguem na tela.
export const CRIT_RANK = { PERDENDO: 0, CRITICO: 1, URGENTE: 2, ATENCAO: 3, NORMAL: 4 };

export function critCanon(a) {
  const n = String(a?.nivel_criticidade || "").toUpperCase();
  return n in CRIT_RANK ? n : "NORMAL";
}

export function critRank(a) {
  return CRIT_RANK[critCanon(a)];
}

export function critAlta(a) {
  const n = critCanon(a);
  return n === "PERDENDO" || n === "CRITICO" || n === "URGENTE";
}

// Prioridade por semestre da divida (regra da gestao, 10/09/2026): o semestre
// mais recente vem primeiro -- 2026/2 na frente de 2026/1, e assim por diante.
// Entra ABAIXO da faixa de prazo de proposito: quem esta a 11+ dias sem
// acionamento continua no topo, seja de que semestre for. Sem rotulo -> por
// ultimo, nunca no meio da fila.
export function rankSemestre(a) {
  const s = String(a?.semestre_divida || "").trim();
  const m = s.match(/^(\d{4})\/([12])$/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  // 2026/2 -> 4053; 2026/1 -> 4052. Maior = mais recente; invertido para que
  // o mais recente fique com o menor rank e suba na fila.
  return -(Number(m[1]) * 2 + Number(m[2]));
}

export const STATUS_NAO_ACIONAVEIS = [
  "JURIDICO",
  "CANCELAMENTO_COBRANCA",
  "SUSPENSAO_COBRANCA",
  "AGUARDANDO_BAIXA",
  "SALDO_ZERO_CONFIRMADO",
  "SEM_SALDO_EM_ABERTO",
];

export const SALDO_MINIMO_FILA = 5; // R$ -- abaixo disso o caso nao entra na fila do operador

export function ehNaoAcionavel(a, idsEmConfirmacao) {
  const s = String(a?.status_atual || "").toUpperCase();
  if (s.startsWith("QUITAD")) return true; // QUITADO / QUITADO_MANUAL / QUITACAO...
  if (STATUS_NAO_ACIONAVEIS.includes(a?.status_atual)) return true;
  // Tem solicitacao de confirmacao de pagamento PENDENTE: ja esta no fluxo de
  // Confirmacao de Pagamento, sai da fila operacional (fonte de verdade =
  // solicitacoes_confirmacao_pagamento, nao o texto de status).
  if (idsEmConfirmacao && idsEmConfirmacao.has(String(a?.id))) return true;
  // "Aguardando confirmacao de pagamento": caso ja foi para a etapa de
  // confirmacao. Se a confirmacao for rejeitada, o status volta ao normal e o
  // caso reaparece. O status vem como texto humano em status_jornada.
  const sj = String(a?.status_jornada || "").toUpperCase();
  if (sj.includes("AGUARDANDO CONFIRMAÇÃO") || sj.includes("AGUARDANDO CONFIRMACAO")) return true;
  // Saldo total abaixo de R$ 5,00 (decisao da gestao, 21/08/2026): residuo
  // nao vale acionamento e so ocupa a fila. Sem saldo gravado, o caso continua
  // na fila (nao esconder por falta de dado).
  const st = Number(a?.saldo_total);
  if (a?.saldo_total != null && Number.isFinite(st) && st < SALDO_MINIMO_FILA) return true;
  return false;
}

// Valor CANONICO para ordenar/filtrar: o MESMO "Em aberto" que aparece grande
// no card (fa.total = mensalidades em aberto + acordos). Fallback pro
// valor_em_aberto do proprio caso quando nao ha detalhe consolidado.
export function valorAbertoDe(a, finAlunos) {
  const fa = (finAlunos || {})[String(a && a.id)];
  if (fa && fa.temDetalhe && Number.isFinite(Number(fa.total))) return Number(fa.total);
  const fb = Number(a && a.valor_em_aberto);
  return Number.isFinite(fb) ? fb : 0;
}

export const ORDENACOES = [
  "inteligente",
  "prioridade",
  "sem_contato_desc",
  "sem_contato_asc",
  "valor_desc",
  "valor_asc",
];

// ---------------------------------------------------------------------------
// O recorte: filtros (quais ids) + ordenacao (em que sequencia)
// ---------------------------------------------------------------------------

// `filtrarCasos` responde SO "quais": nenhuma ordenacao aqui. Separado de
// proposito -- o pedido da gestao foi "separe filtro de ordenacao", porque o
// bug do guiado era exatamente os dois confundidos num passo unico.
export function filtrarCasos(entrada) {
  const {
    casos = [],
    casosEspeciais = null,
    filtroKpi = null,
    busca = "",
    filtroStatus = "TODOS",
    filtroTabulacao = "TODAS",
    somenteFixados = false,
    fixados = new Set(),
    somenteFocoDia = false,
    alunosComBoletoVencendo = new Set(),
    filtroValorMin = "",
    filtroValorMax = "",
    filtroDiasMinSemContato = "",
    alunosDoAnoVencimento = null,
    finAlunos = {},
    hoje = hojeLocalBR(),
    agoraMs = Date.now(),
  } = entrada || {};

  // Com um card selecionado, a lista vem dos registros carregados do
  // indicador; sem card, mostra a carteira normal.
  let l = filtroKpi ? casosEspeciais || [] : casos;
  // Quem ja foi acionado hoje sai da lista de trabalho (ja esta feito).
  if (filtroKpi !== "acionadosHoje" && !busca.trim()) {
    l = l.filter((a) => !trabalhadoHoje(a, hoje));
  }
  if (filtroStatus !== "TODOS") {
    l = l.filter((a) => seloPrazo(a, agoraMs) === filtroStatus);
  }
  if (filtroTabulacao !== "TODAS") {
    l = l.filter((a) => tabulacaoDoAluno(a) === filtroTabulacao);
  }
  if (somenteFixados) {
    l = l.filter((a) => fixados.has(a.id));
  }
  if (somenteFocoDia) {
    l = l.filter((a) => {
      const critico = critAlta(a); // criticidade canonica do backend
      const retornoHoje = a.data_retorno === hoje;
      const retornoAtrasado = a.data_retorno && a.data_retorno < hoje;
      const fixado = fixados.has(a.id);
      const boletoVencendo = alunosComBoletoVencendo.has(a.id);
      return critico || retornoHoje || retornoAtrasado || fixado || boletoVencendo;
    });
  }
  const valorMinNum = String(filtroValorMin).trim()
    ? Number(String(filtroValorMin).replace(/\./g, "").replace(",", "."))
    : null;
  const valorMaxNum = String(filtroValorMax).trim()
    ? Number(String(filtroValorMax).replace(/\./g, "").replace(",", "."))
    : null;
  if (valorMinNum !== null && !Number.isNaN(valorMinNum)) {
    l = l.filter((a) => valorAbertoDe(a, finAlunos) >= valorMinNum);
  }
  if (valorMaxNum !== null && !Number.isNaN(valorMaxNum)) {
    l = l.filter((a) => valorAbertoDe(a, finAlunos) <= valorMaxNum);
  }
  if (String(filtroDiasMinSemContato).trim()) {
    const diasMin = Number(filtroDiasMinSemContato);
    if (!Number.isNaN(diasMin)) {
      l = l.filter((a) => {
        const d = diasSemContato(a, agoraMs);
        return d === null ? true : d >= diasMin;
      });
    }
  }
  if (alunosDoAnoVencimento) {
    l = l.filter((a) => alunosDoAnoVencimento.has(a.id));
  }
  if (busca.trim()) {
    const t = semAcento(busca);
    l = l.filter((a) =>
      [nomeAluno(a), a.cpf, a.telefone, a.responsavel_atual_nome, situacaoLabel(a)]
        .filter(Boolean)
        .some((c) => semAcento(c).includes(t))
    );
  }
  return l;
}

// `ordenarCasos` responde SO "em que ordem". Nao filtra nada e nunca troca a
// ordenacao escolhida pela operadora.
export function ordenarCasos(lista, entrada) {
  const {
    ordenacao = "inteligente",
    somenteFocoDia = false,
    finAlunos = {},
    hoje = hojeLocalBR(),
    agoraMs = Date.now(),
  } = entrada || {};

  // Chave de ordenacao precisa (milissegundos), nao em dias inteiros -- com
  // dias inteiros, varios casos tabulados no mesmo dia empatavam e a ordem
  // entre eles ficava embaralhada.
  const chaveOrdenacao = (a) => {
    const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
    if (!base) return null;
    const t = new Date(base).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const keyDias = (a) => {
    const t = chaveOrdenacao(a);
    return t === null ? Infinity : -t;
  };
  const valor = (a) => valorAbertoDe(a, finAlunos);
  const arr = [...(lista || [])];

  if (ordenacao === "inteligente") {
    // Fila inteligente (regra da gestao, 21/08/2026): a ordem segue EXATAMENTE
    // o selo de prazo que a operadora ve na linha:
    //   0 Perdendo o caso (11+ dias)  -> nunca perder caso
    //   1 Critico (9-10 dias)
    //   2 Atencao (8 dias)
    //   3 Novo (nunca acionado e sem data de entrada)
    //   4 Retorno devido (hoje/atrasado)
    //   5 Dentro do prazo (0-7 dias)
    // Dentro de cada faixa: semestre da divida, CRITICIDADE canonica, depois
    // SEMPRE os mais antigos sem acionamento primeiro; empate por saldo.
    const RANK_PRAZO = { "Perdendo o caso": 0, Critico: 1, Atencao: 2, Novo: 3 };
    const faixa = (a) => {
      const lab = seloPrazo(a, agoraMs);
      if (lab in RANK_PRAZO) return RANK_PRAZO[lab];
      const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
      if (ret && ret <= hoje) return 4;
      return 5;
    };
    const diasParado = (a) => {
      const d = diasSemContato(a, agoraMs);
      return d === null ? 9999 : d;
    };
    arr.sort((a, b) =>
      (faixa(a) - faixa(b)) ||
      (rankSemestre(a) - rankSemestre(b)) ||
      (critRank(a) - critRank(b)) ||
      (diasParado(b) - diasParado(a)) ||
      (keyDias(b) - keyDias(a)) ||
      (valor(b) - valor(a))
    );
  } else if (ordenacao === "prioridade") {
    // O que acionar primeiro: retorno devido (hoje/atrasado) e maior
    // criticidade canonica no topo; empate por mais tempo sem contato e maior
    // saldo.
    const retornoDevido = (a) => {
      const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
      return ret && ret <= hoje ? 0 : 1;
    };
    arr.sort((a, b) =>
      (retornoDevido(a) - retornoDevido(b)) ||
      (critRank(a) - critRank(b)) ||
      (keyDias(b) - keyDias(a)) ||
      (valor(b) - valor(a))
    );
  } else if (ordenacao === "sem_contato_desc") arr.sort((a, b) => keyDias(b) - keyDias(a));
  else if (ordenacao === "sem_contato_asc") arr.sort((a, b) => keyDias(a) - keyDias(b));
  else if (ordenacao === "valor_desc") arr.sort((a, b) => valor(b) - valor(a));
  else if (ordenacao === "valor_asc") arr.sort((a, b) => valor(a) - valor(b));

  // Quando a operadora escolhe explicitamente ordenar por VALOR, essa ordem
  // manda por cima de tudo: nada de re-rank do Foco do Dia reembaralhando.
  const ordenacaoPorValor = ordenacao === "valor_desc" || ordenacao === "valor_asc";

  // No Foco do Dia, a prioridade manda por cima da ordenacao escolhida:
  // retorno do dia/atrasado primeiro, depois boleto vencido/vencendo, depois o
  // resto. Excecao: ordenacao por valor nao re-ranqueia.
  if (somenteFocoDia && !ordenacaoPorValor) {
    const rankFoco = (a) => {
      const ret = a.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
      if (ret && ret <= hoje) return 0; // retorno devido
      const venc = (finAlunos || {})[String(a.id)]?.menorVencimento || null;
      if (venc) {
        const d = diasParaData(hoje, venc);
        if (d !== null && d < 0) return 1; // vencido
        if (d !== null && d <= 3) return 2; // vence em ate 3 dias
      }
      return 3;
    };
    // Empate por MAIOR saldo dentro de cada faixa: sem esse desempate a ordem
    // dentro do grupo dependia do sort anterior e parecia "sem ordem".
    arr.sort((a, b) =>
      (rankFoco(a) - rankFoco(b)) ||
      (critRank(a) - critRank(b)) ||
      (valor(b) - valor(a))
    );
  }
  return arr;
}

// Recorte completo, exatamente o que a tela mostra: filtra, ordena e, por
// ultimo, garante que a mesma pessoa nunca saia duas vezes. A deduplicacao
// fica no fim de proposito -- a linha que sobrevive e a que a ordenacao ja
// tinha colocado mais acima, e o rodape conta a lista deduplicada.
export function montarListaFiltrada(entrada) {
  return umaLinhaPorPessoa(ordenarCasos(filtrarCasos(entrada), entrada));
}

// ---------------------------------------------------------------------------
// Acionamento guiado: a FOTO
// ---------------------------------------------------------------------------

// O recorte esta pronto para virar foto? Enquanto nao estiver, "Iniciar
// acionamento" fica indisponivel -- comecar o guiado com o recorte a meio
// carregar era a porta de entrada do bug.
//
//   - filtro de ANO: `alunosDoAnoVencimento` carrega por RPC em separado
//     (alunos_por_ano_vencimento). Enquanto ele e null com ano escolhido, o
//     filtro NAO esta aplicado e a lista mostra a carteira inteira.
//   - card/KPI: `casosEspeciais` tambem vem por consulta propria. Enquanto
//     carrega, a lista ou esta vazia ou ainda mostra o recorte do card
//     ANTERIOR -- abrir o guiado ali percorreria o card errado.
export function recorteProntoParaGuiado({
  filtroAnoVencimento = "",
  alunosDoAnoVencimento = null,
  filtroKpi = null,
  casosEspeciais = null,
  carregandoEspecial = false,
  carregando = false,
} = {}) {
  if (carregando) return false;
  if (String(filtroAnoVencimento || "").trim() && alunosDoAnoVencimento === null) return false;
  if (filtroKpi && (carregandoEspecial || casosEspeciais === null)) return false;
  return true;
}

// A FOTO: ids visiveis, na ordem visivel, no instante do clique. Nada de
// objeto -- so o id, porque o estado de cada aluno e reconferido no banco
// antes de abrir.
export function snapshotDoGuiado(listaVisivel) {
  const vistos = new Set();
  const ids = [];
  for (const a of listaVisivel || []) {
    if (!a?.id) continue;
    const id = String(a.id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  return ids;
}

// Proximo id da FOTO, na ordem da foto. Nunca consulta a lista viva: id que
// apareceu depois do clique nao entra, e id que saiu da lista continua na
// sequencia (quem decide se ele abre e a reconferencia no banco).
export function proximoIdDoSnapshot({ snapshot = [], feitos = new Set(), acionadosHoje = [], idAtual = null } = {}) {
  const hojeSet = acionadosHoje instanceof Set
    ? new Set([...acionadosHoje].map(String))
    : new Set((acionadosHoje || []).map(String));
  const atual = idAtual == null ? null : String(idAtual);
  for (const id of snapshot) {
    if (id === atual) continue;
    if (feitos.has(id)) continue;
    if (hojeSet.has(id)) continue;
    return id;
  }
  return null;
}

// Quantos ainda faltam na FOTO (selo do modal).
export function faltamNoSnapshot({ snapshot = [], feitos = new Set(), acionadosHoje = [] } = {}) {
  const hojeSet = acionadosHoje instanceof Set
    ? new Set([...acionadosHoje].map(String))
    : new Set((acionadosHoje || []).map(String));
  return snapshot.filter((id) => !feitos.has(id) && !hojeSet.has(id)).length;
}

// Reconferencia no banco antes de abrir: ainda e meu? ainda e acionavel? ja
// foi acionado hoje? Quem falha e PULADO -- segue-se para o proximo id da
// FOTO, sem nunca buscar substituto fora dela.
export function candidatoSegueValido({
  fresco = null,
  meuEmail = null,
  idsEmConfirmacao = null,
  hoje = hojeLocalBR(),
} = {}) {
  if (!fresco) return { ok: false, motivo: "NAO_ENCONTRADO" };
  const aindaMeu =
    !meuEmail ||
    String(fresco.responsavel_atual_email || "").toLowerCase() === String(meuEmail).toLowerCase();
  if (!aindaMeu) return { ok: false, motivo: "NAO_E_MAIS_MEU" };
  if (ehNaoAcionavel(fresco, idsEmConfirmacao)) return { ok: false, motivo: "NAO_ACIONAVEL" };
  if (fresco.data_ultimo_acionamento && String(fresco.data_ultimo_acionamento).slice(0, 10) === hoje) {
    return { ok: false, motivo: "JA_ACIONADO_HOJE" };
  }
  return { ok: true, motivo: null };
}
