// ENCAMINHAMENTO DA PENDÊNCIA CLASSIFICADA — o vocabulário, fora do JSX.
//
// POR QUE EXISTE. `vw_fila_pagamento_triagem` declara `CONFERIR_E_ENCERRAR` para
// 47 pagamentos (R$ 40.663,34, medido em 26/10/2026) e nenhuma tela a oferecia:
// a ação aparecia só em teste e na QuitacaoSugerida. A Etapa 2 abre essa porta.
//
// ESCOPO: UMA AÇÃO. `ESCOLHER_ALUNO` foi retirada desta etapa por decisão da
// gestão em 26/10/2026, e não tem caminho nenhum aqui — nem mapa, nem rótulo,
// nem botão. A razão, para não voltar por esquecimento: a porta dela seria
// `pagamento_vincular_aluno`, que chama `pagamento_conciliar_um(.., true)` e
// PODE DAR BAIXA (154 de 212 vínculos manuais terminaram em BAIXADO), e 32 dos
// 42 casos já têm aluno vinculado — contra a regra de 16/09/2026 que este mesmo
// projeto escreveu em `podeVincularAluno`.
//
// A funcionalidade ANTIGA não mudou: a busca manual de aluno na fila continua
// como estava, com o próprio aviso e o próprio portão. Esta etapa apenas não
// abre uma segunda porta para ela.
//
// Aqui mora só o vocabulário e as regras que a tela e os testes têm de ler
// IGUAIS — nenhuma classificação é decidida neste arquivo: ela é toda do banco,
// como em `filaPagamentoTriagem.js`.
//
// A REGRA QUE ORGANIZA TUDO: a tela nunca inventa o que vai acontecer. Ela
// traduz códigos que a prévia do banco devolveu. Texto montado na tela sobre
// efeito financeiro é exatamente como se promete o que o banco não faz.

import { mascararCpf } from "./mascararCpf";

// A AÇÃO DESTA ETAPA. `passos` espelha o array que a prévia devolve: se o banco
// ganhar um passo e este mapa não, o teste reprova.
export const ACOES_ENCAMINHAMENTO = {
  CONFERIR_E_ENCERRAR: {
    rotulo: "Conferir e encerrar",
    verbo: "Encerrar a pendência",
    explica:
      "A parcela deste boleto já estava paga antes do pagamento entrar, e o dinheiro já está " +
      "refletido. Encerrar registra a conferência e tira a linha da fila.",
    // As duas frases que a gestão precisa ler antes de confirmar: o que muda e
    // o que NÃO muda. A segunda é a que impede a leitura "isto deu baixa".
    aviso:
      "Registra a decisão e move o pagamento para “encerrado sem efeito financeiro”. " +
      "Não dá baixa, não quita, não altera parcela, acordo, título nem saldo.",
    passos: ["REGISTRAR_DECISAO_RESOLVIDO_AUTOMATICO", "MOVER_PARA_ENCERRADO_SEM_EFEITO_FINANCEIRO"],
    resultado: "PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO",
  },
};

// O RESULTADO ESPERADO, em português. O banco devolve código; quem escreve a
// frase é a tela, e a frase diz o LIMITE junto com o efeito — como o rótulo
// `BAIXA_REGISTRADA_CRM` carrega o dele.
export const RESULTADOS = {
  PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO:
    "a pendência sai da fila e do contador, com o motivo preservado no histórico do arquivo. " +
    "Nenhum dinheiro é movido.",
};

// AS RECUSAS, uma frase cada. Recusa sem nome é o que faz a pessoa clicar de
// novo; recusa nomeada é informação.
export const MOTIVOS_RECUSA = {
  SEM_PENDENCIA_NA_TRIAGEM:
    "este pagamento não está mais na triagem de pendências — atualize a fila.",
  SEM_ACAO_SUGERIDA:
    "a triagem não declara ação para este caso. Ele precisa de conferência caso a caso.",
  // A recusa dos 42 `ESCOLHER_ALUNO`: a pendência continua visível e esta
  // interface diz, sem rodeio, que não é ela que resolve o caso.
  ACAO_FORA_DO_ESCOPO_DESTA_ETAPA:
    "a triagem declara uma ação que esta tela não executa. Use o caminho próprio dela na fila.",
  ACAO_NAO_IMPLEMENTADA:
    "a triagem declara uma ação que esta tela ainda não oferece.",
  ACAO_DIVERGE_DA_SUGERIDA:
    "a classificação mudou depois que a tela carregou — atualize a fila e confira de novo.",
  PASSO_1_RECUSADO:
    "a conferência da parcela já paga não passou em todas as validações.",
};

// AS 8 VALIDAÇÕES de `PARCELA_JA_PAGA_CONFERIDA`, com o nome que a prévia usa.
// Código desconhecido NÃO desaparece: devolve o próprio código, para a tela
// mostrar algo verdadeiro em vez de vazio — mesma decisão de
// `rotuloSubcategoria`.
export const VALIDACOES_JA_PAGA = {
  PENDENCIA_ABERTA_JA_PAGA: "Pendência aberta, em “parcela já paga”",
  BOLETO_NO_PADRAO: "Boleto no padrão 5 + acordo + parcela",
  PARCELA_DO_BOLETO_PAGA: "A parcela deste boleto está PAGO",
  UNICO_PAGAMENTO_DO_BOLETO: "É o único pagamento deste boleto",
  VALOR_REFLETIDO_NA_PARCELA: "Valor pago compatível com a parcela",
  ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO: "O acordo fecha pagamento a pagamento",
  REFERENCIA_ANTIGA_DESLOCADA: "A referência da baixa antiga estava deslocada",
  SEM_BAIXA_DEVOLVIDA: "Nenhuma baixa devolvida na parcela",
};

export function rotuloValidacao(codigo) {
  if (!codigo) return "—";
  return VALIDACOES_JA_PAGA[codigo] || codigo;
}

export function rotuloRecusa(codigo) {
  if (!codigo) return "não foi possível concluir — motivo não informado.";
  return MOTIVOS_RECUSA[codigo] || `não foi possível concluir (${codigo}).`;
}

export function rotuloResultado(codigo) {
  if (!codigo) return "";
  return RESULTADOS[codigo] || "";
}

// A LINHA TEM ENCAMINHAMENTO? Só quando a triagem declarou uma ação QUE ESTA
// ETAPA IMPLEMENTA. A segunda metade é o que mantém `ESCOLHER_ALUNO` (e
// qualquer ação futura) sem botão: a triagem pode declarar o que quiser, e a
// linha só ganha porta quando esta etapa souber executá-la.
//
// Linha já decidida não tem encaminhamento: ela é o caso dos 33 que a Etapa 1
// resolve por backfill, com autorização própria — não por esta porta.
export function podeEncaminhar(triagem) {
  if (!triagem) return false;
  if (triagem.decisao) return false;
  const acao = triagem.acao_sugerida;
  return Boolean(acao && ACOES_ENCAMINHAMENTO[acao]);
}

// UMA REGRA SÓ, usada pelo botão e pelo teste — para a tela nunca discordar do
// que o banco vai aceitar. Mesma decisão de `finalizacaoInvalida`.
//
// Devolve a frase do impedimento, ou null quando pode confirmar.
export function impedimentoDoEncaminhamento({ previa } = {}) {
  if (!previa) return "Carregue a prévia antes de confirmar.";
  if (previa.ok === false) return rotuloRecusa(previa.motivo);

  const def = ACOES_ENCAMINHAMENTO[previa.acao];
  if (!def) return rotuloRecusa("ACAO_FORA_DO_ESCOPO_DESTA_ETAPA");

  if (previa.aprovado !== true) {
    const bloqueios = Array.isArray(previa.bloqueios) ? previa.bloqueios : [];
    if (bloqueios.length === 0) return "A prévia não aprovou este caso.";
    // Bloqueio com nome próprio ganha a própria frase; os outros viram a lista
    // das validações que faltaram, com o rótulo de cada uma.
    if (bloqueios.length === 1 && MOTIVOS_RECUSA[bloqueios[0]]) {
      return rotuloRecusa(bloqueios[0]);
    }
    return `A prévia não aprovou: ${bloqueios.map(rotuloValidacao).join("; ")}.`;
  }

  return null;
}

// AS VALIDAÇÕES PARA A TELA, já traduzidas e na ordem que o banco mandou.
export function validacoesDaPrevia(previa) {
  const lista = Array.isArray(previa?.validacoes) ? previa.validacoes : [];
  return lista
    .filter((v) => v && v.codigo)
    .map((v) => ({
      codigo: v.codigo,
      rotulo: rotuloValidacao(v.codigo),
      ok: v.ok === true,
      detalhe: v.detalhe || "",
    }));
}

// O TEXTO DA CONFIRMAÇÃO. Uma frase, com o que vai acontecer e o que não vai.
// `moeda` entra por parâmetro porque a formatação é da tela, não desta regra —
// e porque o teste precisa afirmar o texto sem depender de locale.
export function textoDaConfirmacao({ previa, moeda } = {}) {
  const def = ACOES_ENCAMINHAMENTO[previa?.acao];
  if (!def) return "";
  const valor = typeof moeda === "function" ? moeda(previa?.pagamento?.valor_pago) : "";
  return `${def.verbo}${valor ? ` — pagamento de ${valor}` : ""}? ${def.aviso}`;
}

// O QUE A ETAPA 2 NÃO FAZ, dito na tela em voz alta. A fila inteira já carrega
// `AVISO_PROJECAO`; este aviso é sobre a AÇÃO, não sobre o dinheiro do dia.
export const ENCAMINHAMENTO_AVISO =
  "Encerrar aqui é decisão de conferência: não dá baixa, não quita, não vincula aluno, não " +
  "reatribui caso e não altera valor. Toda confirmação fica registrada na auditoria com quem " +
  "decidiu e quando.";

// ─────────────────────────────────────────────────────────────────────────────
// RASTREABILIDADE DA PRÉVIA (27/10/2026)
//
// POR QUE EXISTE. Na primeira abertura real da prévia em produção, a gestão não
// conseguia conferir três coisas antes de encerrar: QUEM é o aluno, QUAL é o
// acordo, e COMO a parcela virou PAGO. O painel mostrava as 8 validações e o
// resultado, e nada disso.
//
// Pior: o texto "por que caiu aqui" vem de `pagamentos.conciliacao_motivo` e diz
// "nao ha registro de quem baixou". Isso descreve `origem_baixa_ref` estar nulo
// -- mas o banco TEM registro: `parcelas.observacao` guarda "baixa automatica
// pelo documento 50662470002 (extrato de 05/08/2026)". Lido sem contexto, o
// motivo parecia afirmar ausência total de rastro.
//
// A REGRA QUE ORGANIZA ESTE BLOCO: o motivo é HISTÓRICO -- o que o motor
// registrou no dia, e não se reescreve. O que o banco sabe hoje vai AO LADO,
// rotulado como tal. E o que não existe aparece como pendência de conferência,
// nunca preenchido por semelhança.

export const NAO_INFORMADO = "não informado — conferir";
// DOIS SILÊNCIOS DIFERENTES, e a tela não pode misturá-los. "O banco não tem o
// dado" é conferência para a gestão; "a prévia não manda este campo" é versão
// de software, e não adianta ninguém abrir a ficha por causa disso.
export const NAO_DISPONIVEL = "não disponível nesta versão da prévia";

// A chave existir e valer null é o banco dizendo "não tenho". A chave não
// existir é a fachada ainda não mandar o campo.
export function ausenciaOuValor(valor, chavePresente) {
  if (!chavePresente) return NAO_DISPONIVEL;
  return rotuloOuPendencia(valor);
}
export const DIVERGENTE = "divergente — conferir";

// Valor ausente NUNCA vira texto bonito. Mesma decisão de `evidenciasDaLinha`:
// "item sem resposta não vira linha; ausência de dado não é um fato".
export function rotuloOuPendencia(valor, { divergente = false } = {}) {
  if (divergente) return DIVERGENTE;
  if (valor === null || valor === undefined) return NAO_INFORMADO;
  const texto = String(valor).trim();
  return texto === "" ? NAO_INFORMADO : texto;
}

// CPF: UMA régua só, a do projeto (`src/utils/mascararCpf.js`), que mostra
// apenas os dois verificadores e aceita valor já mascarado. A versão anterior
// desta entrega criava uma segunda máscara, com formato próprio e sem tolerar
// entrada já mascarada -- no dia em que a fachada mascarasse na origem, a tela
// passaria a dizer "CPF não informado" sobre um dado presente. O "—" daquela
// função é ausência, e aqui vira pendência de conferência como qualquer outra.
export const CPF_AUSENTE = "—";
export function cpfDaPrevia(valor) {
  const m = mascararCpf(valor);
  return m === CPF_AUSENTE ? null : m;
}

// QUEM e QUAL ACORDO. O acordo já vinha na prévia e não era exibido; o aluno
// depende do bloco `aluno` que a fachada passa a montar. Enquanto ele não vier,
// a tela diz pendência -- nunca deduz o aluno pelo nome do arquivo.
export function identificacaoDaPrevia(previa) {
  const a = previa?.aluno || null;
  const ac = previa?.acordo || null;
  // A prévia manda o bloco `aluno`? Sem a chave, é a fachada que ainda não o
  // alimenta -- e a tela diz isso, em vez de mandar a gestão conferir uma
  // ausência que não é dela.
  const temChaveAluno = Boolean(previa) && "aluno" in previa;
  return {
    aluno: {
      nome: ausenciaOuValor(a?.nome, temChaveAluno),
      cpf: ausenciaOuValor(cpfDaPrevia(a?.cpf), temChaveAluno),
      alimentado: temChaveAluno,
      id: a?.id || null,
      temVinculo: Boolean(a?.id),
    },
    acordo: {
      numero: rotuloOuPendencia(ac?.numero_ulbra),
      status: rotuloOuPendencia(ac?.status),
      parcelas: ac?.qtd_parcelas ?? null,
      id: ac?.id || null,
    },
  };
}

// COMO A PARCELA VIROU PAGO. Tudo medido, nada concluído.
//
// O QUE ESTE BLOCO NÃO FAZ MAIS, e por quê (reprovação do Guardião, 27/10/2026).
// A versão anterior comparava o documento citado na observação com o boleto
// desta parcela e, quando diferiam, afirmava na tela "de OUTRA parcela deste
// acordo". Isso era inferência, e usava justamente a convenção que o projeto já
// derrubou: os 4 dígitos finais do boleto são SEQUÊNCIA DE EMISSÃO da ULBRA, não
// o número da parcela -- medido em 23/10/2026, nenhuma convenção fixa explica
// mais de 56,3% das 14.488 parcelas. Documento diferente é compatível com a
// MESMA parcela reemitida (`docs/TRIAGEM-FILA-PAGAMENTO-2026-10-22.md`, seção
// dos três casos de divergência de vencimento).
//
// Além disso, julgar a origem da baixa aqui violava a Premissa 12 -- "a regra
// mora no banco, não na tela" (`docs/PREMISSAS.md` §12). Quem pode comparar o
// segmento do acordo e o histórico de emissão é a prévia, no banco.
//
// O que sobrou é leitura: a observação sai integral, o documento aparece como
// citado, e a diferença entre dois números é apresentada como FATO que pede
// conferência -- nunca como conclusão sobre qual parcela pagou o quê.
export function historicoDaBaixa(previa) {
  const p = previa?.parcela || null;
  const temChaveObs = Boolean(previa) && "parcela_observacao" in previa;
  const obs = previa?.parcela_observacao ?? null;
  // "documento 123", "documento nº 123", "documento no 123" -- a observação é
  // texto livre do motor e não tem forma garantida.
  // QUANDO O BANCO MANDAR, O BANCO MANDA. `documento_citado` e
  // `documento_difere_do_boleto` são a saída desta dívida (Premissa 12): no dia
  // em que a fachada os trouxer, o parse abaixo deixa de ser consultado e sai.
  const doDoBanco = previa && "documento_citado" in previa;
  const doc = doDoBanco ? previa.documento_citado || null : typeof obs === "string"
    ? (obs.match(/documento\s+(?:n[º°o]\.?\s*)?(\d+)/i) || [])[1] || null
    : null;
  // O "boleto apresentado" é SEMPRE o da parcela. Cair no boleto do pagamento
  // poria dois referentes diferentes sob o mesmo rótulo na tela.
  const boleto = p?.boleto || null;
  return {
    pagoEm: rotuloOuPendencia(p?.pago_em ? String(p.pago_em).slice(0, 10) : null),
    responsavel: rotuloOuPendencia(p?.confirmado_por_email),
    // O número como ele aparece no texto. Nenhuma afirmação sobre o que ele é.
    documento: !doDoBanco && temChaveObs && obs && !doc
      ? DOCUMENTO_NAO_IDENTIFICADO
      : ausenciaOuValor(doc, temChaveObs || doDoBanco),
    // FATO, não veredito: os dois números diferem. `null` quando falta um dos
    // lados -- a tela não compara o que não tem.
    // Só dígitos, sem zeros à esquerda: "050662470003" e "50662470003" são o
    // mesmo boleto escrito de dois jeitos, e isso não é divergência.
    documentoDifereDoBoleto: doDoBanco
      ? previa.documento_difere_do_boleto ?? null
      : doc && boleto
        ? digitos(doc) !== digitos(boleto)
        : null,
    observacao: ausenciaOuValor(obs, temChaveObs),
    temObservacao: Boolean(obs),
    origemBaixaRef: rotuloOuPendencia(p?.origem_baixa_ref),
    parcelaNumero: p?.numero ?? null,
    parcelaValor: p?.valor ?? null,
  };
}

// O TEXTO DO CAMPO DO DOCUMENTO. Descritivo, fechado, e sem conclusão: diz o
// que se viu (um número citado, que difere do boleto) e pede conferência.
export const DOCUMENTO_DIFERE =
  "Documento citado na observação — difere do boleto apresentado; conferir";
export const DOCUMENTO_CITADO = "Documento citado na observação";

// A observação existe e nenhum número reconhecível saiu dela. É diferente de
// "não informado": o texto está logo abaixo, integral, para quem lê decidir.
export const DOCUMENTO_NAO_IDENTIFICADO = "não identificado no texto";

const digitos = (v) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");

export function rotuloDocumentoDaBaixa(historico) {
  if (!historico || historico.documentoDifereDoBoleto !== true) return DOCUMENTO_CITADO;
  return DOCUMENTO_DIFERE;
}

// O LIMITE DO ENCERRAMENTO, dito na tela. Encerrar fecha a pendência e não liga
// este pagamento à parcela que ele pagou: `origem_baixa_ref` fica como está.
// Gravar esse elo é escrita em `parcelas` -- efeito financeiro, fora desta etapa.
export const AVISO_ORIGEM_BAIXA_REF =
  "Encerrar não preenche origem_baixa_ref: o vínculo entre este pagamento e a parcela " +
  "continua como está. Fechar a pendência não registra quem pagou a parcela.";

// O motivo é histórico e tem dono: foi o motor que o escreveu, no dia. O rótulo
// existe para ninguém ler aquele texto como veredito sobre o que há no banco hoje.
export const ROTULO_MOTIVO_HISTORICO = "o que o motor registrou na importação";
export const ROTULO_EVIDENCIA_ATUAL = "o que o banco guarda hoje sobre esta parcela";
