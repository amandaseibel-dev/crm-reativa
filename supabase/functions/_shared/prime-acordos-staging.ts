// Integração ACORDOS Mannesoft Prime → ReATIVA One — lógica pura de staging.
//
// POR QUE ISTO É UM MÓDULO SEPARADO: igual a `pdf.ts` — a Edge Function roda
// em Deno e não tem suíte própria no projeto; aqui a lógica fica pura, sem
// rede, sem Supabase e sem RPC, e o vitest da raiz exercita exatamente o
// mesmo código que a função importaria. Nada aqui grava em `acordos`,
// `acordos_titulos`, `parcelas` ou `baixas_pagamento` — e nada aqui chama
// RPC nenhuma. Quem decide se e como promover é a Edge Function, usando
// SEMPRE as rotinas oficiais já existentes (ver seção final).
//
// DECISÕES JÁ FECHADAS (ver docs/integracoes/prime-acordos-staging.md —
// não reabrir, não re-investigar):
//   1. Chave do acordo = número do acordo no Mannesoft + identificador do
//      aluno. Carteira/portador NUNCA entra na chave — é atributo
//      versionado, porque não foi comprovado que fica fixo durante o ciclo
//      de vida do acordo.
//   2. `numero_ulbra` NÃO é chave única (20,1% nula, 17 duplicados com
//      status conflitantes) — nunca usada aqui como identidade.
//   3. `duplicado_de`/`duplicado_marcado_em` são território de
//      `tg_acordo_bloquear_duplicado` e `acordos_sinalizar_boleto_repetido`
//      — esta integração nunca escreve neles.
//   4. Composição = GRUPO (títulos negociados + títulos gerados), nunca
//      correspondência individual que o Mannesoft não dê explicitamente.
//   5. Quitação observada aqui NUNCA aciona baixa — só gera alerta.
//   6. Indeterminado = EXCEÇÃO (fail-closed), nunca AUTOMÁTICO por omissão —
//      mesmo princípio do Guardião (`INDETERMINADO = NEGA`).
//   7. RECONHECIMENTO (identidade + composição + histórico no staging) é
//      uma decisão separada de PROMOÇÃO FINANCEIRA. Reacordo, renegociação
//      parcial, composição mista, acordo parcialmente pago renegociado e
//      parcela única são reconhecidos automaticamente no staging quando a
//      captura é inequívoca — só exigem conferência quando há identidade
//      ambígua, composição divergente ou informação insuficiente
//      (`avaliarReconhecimento`). Cancelamento, quitação, baixa e alteração
//      de título continuam SEMPRE bloqueados nesta etapa
//      (`bloqueioFinanceiroAtivo` nunca libera), independente do
//      reconhecimento — pendente de validar o contrato real das rotinas
//      oficiais e de autorização específica de gestão.
//   8. VÍNCULO COM O CONVÊNIO SANTANDER REATIVA (272047, portador 166) só é
//      comprovado pelos TÍTULOS GERADOS do próprio acordo — nunca pela
//      filiação geral do aluno ao portador 166 (um aluno pode ter outros
//      acordos ou mensalidades em qualquer portador; isso não diz nada sobre
//      ESTE acordo). Sem lista rígida de portadores de ORIGEM: o título
//      negociado pode vir de qualquer portador (mensalidade, parcela de
//      acordo anterior) e é sempre preservado como veio, nunca filtrado nem
//      excluído por isso (ver `avaliarVinculoConvenioReativa`). Quando os
//      títulos gerados não informam portador/convênio, ou informam um que
//      diverge de 166/272047, a captura vai para conferência — nunca é
//      presumida ReATIVA por omissão. A comprovação do convênio é sempre
//      pelo dado bancário de origem (ex.: o campo de convênio da própria
//      linha do arquivo de pagamento), NUNCA pelo formato numérico do
//      boleto isoladamente — o padrão do boleto decodifica identidade
//      (número do acordo/parcela), não convênio.
//   9. IDENTIDADE do acordo e VÍNCULO com o convênio ReATIVA são decisões
//      diferentes de COMPOSIÇÃO FINANCEIRA COMPLETA (quais títulos foram
//      negociados). Uma captura com identidade e vínculo comprovados mas sem
//      nenhum título negociado informado (típico de captura originada só de
//      pagamento observado, nunca da tela do Acordo-Detalhe) não é
//      AUTOMATICO (composição não é conhecida) nem EXCECAO (não há
//      ambiguidade, divergência nem conferência a fazer) — é PARCIAL:
//      registrada no staging, pendente de complementação, sem promoção
//      financeira. Filiação ao portador 166 sozinha, sem número de acordo,
//      não gera nenhuma captura — não é identidade de acordo, é só sinal de
//      nível aluno.

// Origem de um item de `titulos_negociados` — só preenchida quando o PRÓPRIO
// Mannesoft distingue o tipo do título (ex.: etiqueta/coluna própria na tela).
// 'INDETERMINADA' é o padrão e fica assim sempre que a captura não traz essa
// distinção explícita — nunca inferida por valor, data ou posição.
export type OrigemTituloNegociado = "MENSALIDADE_ORIGINAL" | "PARCELA_DE_ACORDO_ANTERIOR" | "INDETERMINADA";

// Identificação de portador/convênio — SEMPRE o valor bruto informado pela
// origem (Mannesoft), preservado como veio, nunca normalizado além do que
// `normalizarConvenio` faz para COMPARAR (nunca para substituir o valor
// guardado). Ausência de ambos os campos significa só que a captura não
// trouxe essa informação — nunca inferida por tabela, aluno ou qualquer outra
// fonte.
export type IdentificacaoPortador = {
  portadorIdMannesoft?: number | string | null; // ex.: 166 — bruto, como a Prime/Mannesoft devolve
  convenioMannesoft?: string | null; // ex.: "0272047" — bruto, com ou sem zero à esquerda
};

export type TituloNegociado = IdentificacaoPortador & {
  documento: string;
  origem?: OrigemTituloNegociado; // ausente == INDETERMINADA
  acordoOrigemMannesoft?: string; // só quando o próprio Mannesoft informa de qual acordo vem a parcela herdada
};

// Título gerado (boleto novo do acordo). Antes `unknown[]` — agora tipado,
// com portador/convênio preservados do mesmo jeito que em TituloNegociado,
// porque é exatamente aqui que se comprova (ou não) o vínculo com o convênio
// ReATIVA (ver `avaliarVinculoConvenioReativa`).
export type TituloGerado = IdentificacaoPortador & {
  documento: string;
  vencimento?: string;
  valor?: number;
  unidade?: string | null;
};

export type Composicao = {
  titulos_negociados: TituloNegociado[];
  titulos_gerados: TituloGerado[];
};

export type CapturaAcordo = {
  numeroAcordoMannesoft: string;
  identificadorAluno: string; // CPF, já resolvido pela hierarquia documentada
  carteiraPortador: string | null;
  situacaoMannesoft: string;
  tipoMannesoft: string | null; // texto cru do Mannesoft; nunca inferido
  composicao: Composicao;
  // Referência explícita a um acordo anterior — só preenchida quando o
  // próprio Mannesoft mostra essa referência na tela do Acordo-Detalhe.
  // NUNCA inferida por proximidade de data, valor ou CPF repetido.
  acordoAnteriorMannesoft?: string;
};

// ----------------------------------------------------------------------------
// 1. IDENTIDADE
// ----------------------------------------------------------------------------

export function normalizarCpf(cpf: string): string {
  return (cpf ?? "").replace(/\D/g, "");
}

// Chave do ACORDO — permanente, nunca inclui carteira/portador.
export function montarChaveAcordo(c: Pick<CapturaAcordo, "numeroAcordoMannesoft" | "identificadorAluno">): string {
  const numero = (c.numeroAcordoMannesoft ?? "").trim();
  const cpf = normalizarCpf(c.identificadorAluno);
  if (!numero || !cpf) {
    throw new Error("CHAVE_ACORDO_INCOMPLETA: número do acordo e CPF são obrigatórios");
  }
  return `MANNESOFT:${numero}:CPF:${cpf}`;
}

// ----------------------------------------------------------------------------
// 2. HASH DA COMPOSIÇÃO — determinístico, sem depender de crypto do runtime
//    (Deno e Node/vitest precisam dar o mesmo resultado para o mesmo input).
//    FNV-1a de 32 bits sobre o JSON com chaves ordenadas. Não é
//    criptográfico — é só para detectar "a composição mudou", nunca para
//    identidade de segurança.
// ----------------------------------------------------------------------------

function jsonEstavel(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(",")}]`;
  const chaves = Object.keys(valor as Record<string, unknown>).sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonEstavel((valor as Record<string, unknown>)[k])}`).join(",")}}`;
}

function fnv1a(texto: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function hashComposicao(composicao: Composicao): string {
  return fnv1a(jsonEstavel(composicao));
}

// ----------------------------------------------------------------------------
// 2b. VÍNCULO COM O CONVÊNIO SANTANDER REATIVA (272047 / portador 166) —
//     comprovado SÓ pelos títulos GERADOS do próprio acordo (os boletos
//     novos emitidos por ele), nunca pela filiação geral do aluno ao
//     portador 166 em outro lugar do CRM/Prime. Sem lista rígida de
//     portadores de ORIGEM: um título negociado pode vir de qualquer
//     portador (mensalidade em 195, parcela herdada de outro acordo em
//     qualquer convênio) e isso nunca é restringido nem usado para excluir a
//     negociação — só é preservado, bruto, em `IdentificacaoPortador`.
// ----------------------------------------------------------------------------

// Valor oficial, medido em produção (prime-mapa-identificadores.md): carrier
// 166 = "SANTANDER REATIVA", covenant "0272047" (zero à esquerda variável).
const PORTADOR_REATIVA_ACORDO_ID = 166;
const CONVENIO_REATIVA_ACORDO_DIGITOS = "272047";

function normalizarConvenio(convenio: unknown): string {
  return String(convenio ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

// true só quando o PRÓPRIO item informa explicitamente portador 166 e/ou
// convênio 272047 — nunca por omissão.
export function ehPortadorReativa(p: IdentificacaoPortador): boolean {
  const convenioOk = p.convenioMannesoft != null && normalizarConvenio(p.convenioMannesoft) === CONVENIO_REATIVA_ACORDO_DIGITOS;
  const portadorOk = p.portadorIdMannesoft != null && String(p.portadorIdMannesoft).trim() === String(PORTADOR_REATIVA_ACORDO_ID);
  return convenioOk || portadorOk;
}

// Contradição DENTRO do mesmo item: os dois sinais estão informados e
// discordam entre si — portador 166 com convênio que não é 272047, ou
// convênio 272047 com portador que não é 166. Desenho fail-closed: evidência
// contraditória nunca comprova vínculo, mesmo que um dos dois lados case.
//
// Omissão NÃO é contradição. Item com apenas um dos dois sinais informado
// segue julgado por `ehPortadorReativa` (critério inalterado), e item sem
// nenhum dos dois segue caindo em `semInformacao`.
export function ehVinculoContraditorio(p: IdentificacaoPortador): boolean {
  if (p.convenioMannesoft == null || p.portadorIdMannesoft == null) return false;
  const convenioOk = normalizarConvenio(p.convenioMannesoft) === CONVENIO_REATIVA_ACORDO_DIGITOS;
  const portadorOk = String(p.portadorIdMannesoft).trim() === String(PORTADOR_REATIVA_ACORDO_ID);
  return convenioOk !== portadorOk;
}

export type VinculoConvenioReativa = {
  suficiente: boolean; // true só quando TODOS os títulos gerados informam portador/convênio e todos casam com 166/272047
  divergente: boolean; // algum título gerado informa portador/convênio que NÃO é 166/272047, OU informa os dois em contradição entre si
  semInformacao: boolean; // nenhum título gerado, ou algum sem portador/convênio informado
};

// Avalia só os títulos GERADOS — nunca a filiação do aluno, nunca os títulos
// negociados (que podem legitimamente vir de qualquer portador).
export function avaliarVinculoConvenioReativa(titulosGerados: TituloGerado[]): VinculoConvenioReativa {
  if (!titulosGerados || titulosGerados.length === 0) {
    return { suficiente: false, divergente: false, semInformacao: true };
  }
  let divergente = false;
  let semInformacao = false;
  for (const t of titulosGerados) {
    const informado = t.portadorIdMannesoft != null || t.convenioMannesoft != null;
    if (!informado) {
      semInformacao = true;
      continue;
    }
    // Contradição primeiro: um item que informa 166 e um convênio que não é
    // 272047 (ou o inverso) é evidência contra o vínculo, não a favor — mesmo
    // que `ehPortadorReativa` aceite por um dos lados.
    if (ehVinculoContraditorio(t) || !ehPortadorReativa(t)) divergente = true;
  }
  return { suficiente: !divergente && !semInformacao, divergente, semInformacao };
}

// ----------------------------------------------------------------------------
// 3. COMPARAÇÃO ENTRE VERSÕES — nunca decide o que fazer, só descreve o que mudou.
// ----------------------------------------------------------------------------

export type ComparacaoVersoes = {
  primeiraCaptura: boolean;
  situacaoMudou: boolean;
  carteiraMudou: boolean;
  composicaoMudou: boolean;
  vinculoConvenioMudou: boolean; // o vínculo com 166/272047 (suficiente/insuficiente) mudou entre as duas capturas
  camposAlterados: string[];
};

export function compararVersoes(
  anterior: CapturaAcordo | null,
  atual: CapturaAcordo,
): ComparacaoVersoes {
  if (!anterior) {
    return {
      primeiraCaptura: true,
      situacaoMudou: false,
      carteiraMudou: false,
      composicaoMudou: false,
      vinculoConvenioMudou: false,
      camposAlterados: [],
    };
  }
  const campos: string[] = [];
  const situacaoMudou = anterior.situacaoMannesoft !== atual.situacaoMannesoft;
  const carteiraMudou = (anterior.carteiraPortador ?? null) !== (atual.carteiraPortador ?? null);
  const composicaoMudou = hashComposicao(anterior.composicao) !== hashComposicao(atual.composicao);
  const vinculoConvenioMudou =
    avaliarVinculoConvenioReativa(anterior.composicao.titulos_gerados).suficiente !==
    avaliarVinculoConvenioReativa(atual.composicao.titulos_gerados).suficiente;
  if (situacaoMudou) campos.push("situacao_mannesoft");
  if (carteiraMudou) campos.push("carteira_portador");
  if (composicaoMudou) campos.push("composicao");
  if (vinculoConvenioMudou) campos.push("vinculo_convenio_reativa");
  return { primeiraCaptura: false, situacaoMudou, carteiraMudou, composicaoMudou, vinculoConvenioMudou, camposAlterados: campos };
}

// ----------------------------------------------------------------------------
// 4. CLASSIFICAÇÃO DO CASO — só descreve; nunca decide escrita.
//    "Reacordo" só é reconhecido quando o próprio Mannesoft rotula o campo
//    como tal (`tipoMannesoft` contém o texto) — nunca inferido por boleto,
//    valor ou qualquer heurística já invalidada em rodadas anteriores.
// ----------------------------------------------------------------------------

export type Caso =
  | "ACORDO_NOVO"
  | "REACORDO_ROTULADO"
  | "REACORDO_APOS_CANCELAMENTO"
  | "MUDANCA_SITUACAO"
  | "SEM_MUDANCA";

// `acordoAnterior`: quando a captura atual referencia explicitamente (campo
// `acordoAnteriorMannesoft`) um acordo que JÁ ESTÁ no staging com situação
// CANCELADO, é uma renegociação encadeada — nunca presumida por proximidade,
// só pela referência que o próprio Mannesoft deu e pela situação já
// capturada anteriormente (o chamador resolve essa busca; esta função só
// decide a partir do que já foi confirmado).
export function classificarCaso(
  anterior: CapturaAcordo | null,
  atual: CapturaAcordo,
  acordoAnterior?: { situacaoMannesoft: string } | null,
): Caso {
  if (!anterior) {
    if (atual.acordoAnteriorMannesoft && acordoAnterior?.situacaoMannesoft?.toUpperCase() === "CANCELADO") {
      return "REACORDO_APOS_CANCELAMENTO";
    }
    return /reacordo/i.test(atual.tipoMannesoft ?? "") ? "REACORDO_ROTULADO" : "ACORDO_NOVO";
  }
  const cmp = compararVersoes(anterior, atual);
  if (cmp.situacaoMudou) return "MUDANCA_SITUACAO";
  return "SEM_MUDANCA";
}

// ----------------------------------------------------------------------------
// 4b. RENEGOCIAÇÕES SUCESSIVAS — a cadeia é a sequência de referências
//     explícitas `acordoAnteriorMannesoft`, nunca reconstruída por data ou
//     valor. Devolve a cadeia tal como o chamador a resolveu (um lookup por
//     elo); se algum elo não tiver referência explícita, a cadeia TERMINA
//     ali — não presume continuidade.
// ----------------------------------------------------------------------------

export function montarCadeiaReacordo(
  chaveAtual: string,
  buscarAnteriorPorChave: (chave: string) => { chave: string; acordoAnteriorChave?: string } | null,
): string[] {
  const cadeia: string[] = [chaveAtual];
  const vistos = new Set([chaveAtual]);
  let atual: string | undefined = chaveAtual;
  for (let i = 0; i < 100 && atual; i++) {
    const elo = buscarAnteriorPorChave(atual);
    const proximo = elo?.acordoAnteriorChave;
    if (!proximo || vistos.has(proximo)) break; // sem referência explícita, ou ciclo: a cadeia termina aqui
    cadeia.push(proximo);
    vistos.add(proximo);
    atual = proximo;
  }
  return cadeia;
}

// ----------------------------------------------------------------------------
// 4c. TRAÇOS DA COMPOSIÇÃO — tudo lido só do que a PRÓPRIA captura distingue
//     explicitamente. 'INDETERMINADA'/ausente nunca conta como mista, pura,
//     divergente ou suficiente — fica de fora, porque a captura não deu base
//     para afirmar nada.
// ----------------------------------------------------------------------------

export type TracosComposicao = {
  composicaoMista: boolean; // mensalidade original + parcela de acordo anterior no mesmo grupo (item 4)
  temParcelaDeAcordoAnterior: boolean; // uma ou várias parcelas de acordo anterior na negociação (item 3)
  acordoOrigemReferenciasDivergentes: boolean; // mais de um acordo de origem distinto referenciado — AMBÍGUO
  algumaParcelaDeAcordoAnteriorSemReferencia: boolean; // origem dada sem dizer de qual acordo — INSUFICIENTE
  parcelaUnica: boolean; // um único título gerado (item 6) — nunca, por si, presume quitação
  vinculoConvenioReativa: VinculoConvenioReativa; // comprovação do destino 166/272047 pelos títulos gerados
  // Identidade do acordo é uma coisa; a COMPOSIÇÃO FINANCEIRA COMPLETA (quais
  // títulos negociados entraram) é outra. Verdadeiro quando NENHUM título
  // negociado foi informado — nunca por qualquer outro motivo (não é "poucos",
  // é "nenhum"). É o caso típico de uma captura originada só de um pagamento
  // observado (boleto identificado + convênio comprovado pela própria linha
  // do arquivo bancário), que nunca traz os títulos originais negociados —
  // ver `avaliarReconhecimento` e `PARCIAL`.
  composicaoCompletaDesconhecida: boolean;
};

export function analisarComposicao(composicao: Composicao): TracosComposicao {
  const origensDistintas = new Set(
    composicao.titulos_negociados
      .map((t) => t.origem)
      .filter((o): o is OrigemTituloNegociado => !!o && o !== "INDETERMINADA"),
  );
  const parcelasHerdadas = composicao.titulos_negociados.filter((t) => t.origem === "PARCELA_DE_ACORDO_ANTERIOR");
  const referenciasDefinidas = parcelasHerdadas.map((t) => t.acordoOrigemMannesoft).filter((r): r is string => !!r);
  return {
    composicaoMista: origensDistintas.size > 1,
    temParcelaDeAcordoAnterior: parcelasHerdadas.length > 0,
    acordoOrigemReferenciasDivergentes: new Set(referenciasDefinidas).size > 1,
    algumaParcelaDeAcordoAnteriorSemReferencia: parcelasHerdadas.some((t) => !t.acordoOrigemMannesoft),
    parcelaUnica: composicao.titulos_gerados.length === 1,
    vinculoConvenioReativa: avaliarVinculoConvenioReativa(composicao.titulos_gerados),
    composicaoCompletaDesconhecida: composicao.titulos_negociados.length === 0,
  };
}

// Mantida por compatibilidade com o uso já testado na etapa anterior.
export function temComposicaoMista(composicao: Composicao): boolean {
  return analisarComposicao(composicao).composicaoMista;
}

// ----------------------------------------------------------------------------
// 5. QUITAÇÃO OBSERVADA — NUNCA aciona baixa. Só classifica para alerta.
//    `quitar_acordo_cartao()` grava uma baixa como se o pagamento tivesse
//    ocorrido agora, neste sistema — usá-la para refletir algo só OBSERVADO
//    no Mannesoft forjaria um evento financeiro que não ocorreu aqui.
//    Nunca depende da quantidade de parcelas: um acordo de parcela única
//    (item 6) só é quitação se `situacaoMannesoft` disser isso — a mesma
//    regra, sem exceção, de um acordo de várias parcelas.
// ----------------------------------------------------------------------------

const SITUACOES_QUITACAO = ["QUITADO", "PAGO", "LIQUIDADO"];

export function ehQuitacaoObservada(situacaoMannesoft: string): boolean {
  return SITUACOES_QUITACAO.includes((situacaoMannesoft ?? "").toUpperCase());
}

// ----------------------------------------------------------------------------
// 6. RECONHECIMENTO AUTOMÁTICO NO STAGING — decide só se identidade,
//    composição e histórico podem ser REGISTRADOS no staging sem
//    conferência humana. Isto NUNCA autoriza nenhuma alteração financeira
//    — ver `bloqueioFinanceiroAtivo()`, que é sempre consultada em separado
//    e está sempre bloqueada nesta etapa.
//
//    Fail-closed continua valendo, mas o critério mudou: só exige
//    conferência quando houver (a) identidade ambígua, (b) composição
//    divergente ou (c) informação insuficiente — nunca só porque o caso é
//    um reacordo, uma renegociação parcial, uma composição mista, um acordo
//    parcialmente pago renegociado ou uma parcela única bem formados: esses
//    são reconhecidos automaticamente no staging quando a captura é
//    inequívoca.
//
//    (b)/(c) agora também cobrem o VÍNCULO COM O CONVÊNIO REATIVA: um título
//    gerado que informa portador/convênio diferente de 166/272047 é
//    divergência (b); títulos gerados sem nenhuma informação de
//    portador/convênio são informação insuficiente (c) — nunca presumidos
//    ReATIVA por omissão, e nunca pela filiação do aluno a 166 em outro
//    lugar.
//
//    TERCEIRA CLASSE: PARCIAL. Identidade do acordo (número + CPF) e vínculo
//    com o convênio ReATIVA são coisas DIFERENTES de composição financeira
//    completa (quais títulos foram negociados). Uma captura originada só de
//    um pagamento observado — boleto identificável, convênio 272047
//    comprovado pela própria linha do arquivo bancário de origem, SEM
//    nenhum título negociado informado — tem identidade e vínculo
//    comprovados, mas NUNCA sabe a composição completa. Isso não é
//    ambiguidade (a), divergência (b) nem informação insuficiente sobre o
//    que FOI informado (c): é a ausência, reconhecida como tal, da
//    composição inteira. Por isso NÃO classifica como EXCECAO (não precisa
//    de conferência humana a cada captura) nem como AUTOMATICO (não é um
//    reconhecimento completo) — fica PARCIAL: registrada no staging, pendente
//    de complementação, sem promoção financeira (que já está sempre
//    bloqueada por `bloqueioFinanceiroAtivo`, independente de tudo isto).
//    Nunca presume, a partir disso, quitação, cancelamento, quantidade total
//    de parcelas ou vínculo com mensalidades originais — PARCIAL só descreve
//    o que falta, nunca completa por inferência.
// ----------------------------------------------------------------------------

export type ClasseSeguranca = "AUTOMATICO" | "PARCIAL" | "EXCECAO";

export type AvaliacaoSeguranca = {
  classe: ClasseSeguranca;
  motivo: string;
};

export type ContextoReconhecimento = {
  conflitoNaCaptura: boolean; // (a) identidade ambígua — colisão de chave dentro do lote
  // (a) identidade ambígua — a captura referencia um acordo anterior
  // explicitamente, mas o lookup no staging não encontrou esse acordo (não
  // dá para confirmar nada sobre ele). Sempre exige conferência.
  referenciaAcordoAnteriorNaoResolvida?: boolean;
  tracos: TracosComposicao; // (b)/(c) vêm de analisarComposicao()
};

export function avaliarReconhecimento(ctx: ContextoReconhecimento): AvaliacaoSeguranca {
  if (ctx.conflitoNaCaptura) {
    return { classe: "EXCECAO", motivo: "COLISAO_CHAVE_NO_LOTE" };
  }
  if (ctx.referenciaAcordoAnteriorNaoResolvida === true) {
    return { classe: "EXCECAO", motivo: "IDENTIDADE_AMBIGUA_REFERENCIA_NAO_RESOLVIDA" };
  }
  if (ctx.tracos.acordoOrigemReferenciasDivergentes) {
    return { classe: "EXCECAO", motivo: "COMPOSICAO_DIVERGENTE_MULTIPLOS_ACORDOS_DE_ORIGEM" };
  }
  if (ctx.tracos.vinculoConvenioReativa.divergente) {
    return { classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_DIVERGENTE" };
  }
  if (ctx.tracos.algumaParcelaDeAcordoAnteriorSemReferencia) {
    return { classe: "EXCECAO", motivo: "INFORMACAO_INSUFICIENTE_ORIGEM_DO_TITULO_SEM_REFERENCIA" };
  }
  if (ctx.tracos.vinculoConvenioReativa.semInformacao) {
    return { classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO" };
  }
  // A partir daqui: identidade sem ambiguidade E vínculo com o convênio
  // ReATIVA comprovado. Falta só saber se a composição completa é conhecida.
  if (ctx.tracos.composicaoCompletaDesconhecida) {
    return { classe: "PARCIAL", motivo: "COMPOSICAO_COMPLETA_DESCONHECIDA_PENDENTE_COMPLEMENTACAO" };
  }
  // Nenhuma ambiguidade, divergência ou lacuna encontrada: identidade,
  // composição e histórico (reacordo simples ou encadeado, renegociação
  // parcial, composição mista, parcela única, acordo parcialmente pago
  // renegociado) são reconhecidos automaticamente no staging.
  return { classe: "AUTOMATICO", motivo: "RECONHECIMENTO_AUTOMATICO_IDENTIDADE_COMPOSICAO_HISTORICO" };
}

// Resultado completo de uma captura: o caso identificado, os traços de
// composição (incluindo o sinal de pagamento parcial na cadeia, quando o
// chamador o informa a partir de leitura própria do CRM) e se o
// RECONHECIMENTO no staging é automático ou exige conferência. Nunca inclui
// nem implica nenhuma decisão financeira.
export type ResultadoReconhecimento = {
  caso: Caso;
  tracos: TracosComposicao & {
    // Item 5: a cadeia (acordo anterior referenciado) já recebeu algum
    // pagamento (parcela PAGO ou baixa viva) — só true quando o chamador
    // informa isso explicitamente, a partir de leitura própria do CRM
    // (nunca inferido aqui). Relevante porque titulo_reavaliar() trata
    // diferente uma cadeia que já recebeu dinheiro.
    renegociacaoDeAcordoParcialmentePago: boolean;
  };
  reconhecimento: AvaliacaoSeguranca;
};

export function reconhecerCaptura(params: {
  anterior: CapturaAcordo | null;
  atual: CapturaAcordo;
  conflitoNaCaptura: boolean;
  acordoAnterior?: { situacaoMannesoft: string; teveParcelaPagaOuBaixaViva?: boolean } | null;
  referenciaAcordoAnteriorNaoResolvida?: boolean;
}): ResultadoReconhecimento {
  const caso = classificarCaso(params.anterior, params.atual, params.acordoAnterior ?? null);
  const tracosComposicao = analisarComposicao(params.atual.composicao);
  const tracos = {
    ...tracosComposicao,
    renegociacaoDeAcordoParcialmentePago: params.acordoAnterior?.teveParcelaPagaOuBaixaViva === true,
  };
  const reconhecimento = avaliarReconhecimento({
    conflitoNaCaptura: params.conflitoNaCaptura,
    referenciaAcordoAnteriorNaoResolvida: params.referenciaAcordoAnteriorNaoResolvida,
    tracos: tracosComposicao,
  });
  return { caso, tracos, reconhecimento };
}

// ----------------------------------------------------------------------------
// 6b. BLOQUEIO FINANCEIRO — SEMPRE ativo nesta etapa, independente do
//     reconhecimento acima. Cancelamento, quitação, baixa e alteração de
//     título só seriam acionados por rotina oficial (cancelar_acordo_ficha,
//     quitar_acordo_cartao, importar_acordos, etc.) depois de (1) validar o
//     contrato real dessas rotinas contra este staging e (2) autorização
//     específica de gestão — nenhuma das duas existe ainda. Esta função
//     nunca devolve liberado: existe para que nenhum chamador precise
//     "lembrar" disso por conta própria.
// ----------------------------------------------------------------------------

export type BloqueioFinanceiro = { bloqueado: true; motivo: string };

export function bloqueioFinanceiroAtivo(situacaoMannesoft: string): BloqueioFinanceiro {
  if (ehQuitacaoObservada(situacaoMannesoft)) {
    return { bloqueado: true, motivo: "QUITACAO_OBSERVADA_EXTERNA_NUNCA_GERA_BAIXA_AUTOMATICA" };
  }
  if ((situacaoMannesoft ?? "").toUpperCase() === "CANCELADO") {
    return { bloqueado: true, motivo: "CANCELAMENTO_SO_POR_ROTINA_OFICIAL_APOS_VALIDACAO_E_AUTORIZACAO" };
  }
  return { bloqueado: true, motivo: "PROMOCAO_FINANCEIRA_BLOQUEADA_PENDENTE_VALIDACAO_DAS_ROTINAS_OFICIAIS" };
}

// ----------------------------------------------------------------------------
// 7. TRANSFORMAÇÃO PARA O FORMATO DE `importar_acordos()` — PROPOSTA, não
//    contrato comprovado. `importar_acordos()` foi desenhada para a linha
//    do relatório "Títulos em Aberto" (cpf, documento/boleto, vencimento,
//    valor, unidade, situação), não para a estrutura completa do
//    Acordo-Detalhe. Esta função NÃO deve ser tratada como pronta para
//    produção: toda vez que é chamada, devolve também as pendências de
//    validação que ainda faltam confirmar contra o código real da rotina.
// ----------------------------------------------------------------------------

export type LinhaImportarAcordosProposta = {
  cpf: string;
  documento: string;
  vencimento: string;
  valor: number;
  unidade: string | null;
  situacao: string;
};

export type TransformacaoResultado = {
  linhas: LinhaImportarAcordosProposta[];
  pendenciasValidacao: string[];
};

export function transformarParaImportarAcordos(
  captura: CapturaAcordo,
  tituloGerado: { documento: string; vencimento: string; valor: number; unidade?: string | null },
): TransformacaoResultado {
  const linha: LinhaImportarAcordosProposta = {
    cpf: normalizarCpf(captura.identificadorAluno),
    documento: tituloGerado.documento,
    vencimento: tituloGerado.vencimento,
    valor: tituloGerado.valor,
    unidade: tituloGerado.unidade ?? null,
    situacao: captura.situacaoMannesoft,
  };
  return {
    linhas: [linha],
    pendenciasValidacao: [
      "Confirmar que o `documento` sintetizado aqui resulta no mesmo `acordo_base = substr(documento,4,5)` que importar_acordos() usa para checar existência — não testado contra dado real do Mannesoft.",
      "Confirmar que `importar_acordos()` não rejeita a linha pela regra de CPF quitado há <=7 dias quando o CPF já tem acordo recém-encerrado nesta própria integração.",
      "Esta função só cobre o caso ACORDO_NOVO. Cancelamento e confirmação de situação NUNCA passam por importar_acordos() — usam cancelar_acordo_ficha() e o modelo de fila_acordos_confirmar_automatico(), respectivamente (fora deste módulo).",
      "O vínculo título negociado × título gerado NÃO é transformado aqui — fica preservado só na composição do staging, e só é promovido via acordo_vinculo_sugestao_confirmar() quando o nível calculado for FORTE.",
      "Reconhecimento automático no staging (avaliarReconhecimento/reconhecerCaptura) NUNCA autoriza chamar esta função contra produção — bloqueioFinanceiroAtivo() está sempre bloqueada nesta etapa, para TODO caso, independente do reconhecimento. Esta função só serve para preparar a proposta de linha, a ser revisada por gestão.",
      "Saldo residual herdado de acordo anterior (origem = PARCELA_DE_ACORDO_ANTERIOR) não tem, nesta proposta, uma regra de cálculo de valor — o valor a importar para esse título precisa ser confirmado contra a lógica real de titulo_reavaliar() antes de qualquer promoção automática.",
    ],
  };
}
