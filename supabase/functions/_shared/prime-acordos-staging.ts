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

export type Composicao = {
  titulos_negociados: unknown[];
  titulos_gerados: unknown[];
};

export type CapturaAcordo = {
  numeroAcordoMannesoft: string;
  identificadorAluno: string; // CPF, já resolvido pela hierarquia documentada
  carteiraPortador: string | null;
  situacaoMannesoft: string;
  tipoMannesoft: string | null; // texto cru do Mannesoft; nunca inferido
  composicao: Composicao;
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
// 3. COMPARAÇÃO ENTRE VERSÕES — nunca decide o que fazer, só descreve o que mudou.
// ----------------------------------------------------------------------------

export type ComparacaoVersoes = {
  primeiraCaptura: boolean;
  situacaoMudou: boolean;
  carteiraMudou: boolean;
  composicaoMudou: boolean;
  camposAlterados: string[];
};

export function compararVersoes(
  anterior: CapturaAcordo | null,
  atual: CapturaAcordo,
): ComparacaoVersoes {
  if (!anterior) {
    return { primeiraCaptura: true, situacaoMudou: false, carteiraMudou: false, composicaoMudou: false, camposAlterados: [] };
  }
  const campos: string[] = [];
  const situacaoMudou = anterior.situacaoMannesoft !== atual.situacaoMannesoft;
  const carteiraMudou = (anterior.carteiraPortador ?? null) !== (atual.carteiraPortador ?? null);
  const composicaoMudou = hashComposicao(anterior.composicao) !== hashComposicao(atual.composicao);
  if (situacaoMudou) campos.push("situacao_mannesoft");
  if (carteiraMudou) campos.push("carteira_portador");
  if (composicaoMudou) campos.push("composicao");
  return { primeiraCaptura: false, situacaoMudou, carteiraMudou, composicaoMudou, camposAlterados: campos };
}

// ----------------------------------------------------------------------------
// 4. CLASSIFICAÇÃO DO CASO — só descreve; nunca decide escrita.
//    "Reacordo" só é reconhecido quando o próprio Mannesoft rotula o campo
//    como tal (`tipoMannesoft` contém o texto) — nunca inferido por boleto,
//    valor ou qualquer heurística já invalidada em rodadas anteriores.
// ----------------------------------------------------------------------------

export type Caso = "ACORDO_NOVO" | "REACORDO_ROTULADO" | "MUDANCA_SITUACAO" | "SEM_MUDANCA";

export function classificarCaso(anterior: CapturaAcordo | null, atual: CapturaAcordo): Caso {
  if (!anterior) {
    return /reacordo/i.test(atual.tipoMannesoft ?? "") ? "REACORDO_ROTULADO" : "ACORDO_NOVO";
  }
  const cmp = compararVersoes(anterior, atual);
  if (cmp.situacaoMudou) return "MUDANCA_SITUACAO";
  return "SEM_MUDANCA";
}

// ----------------------------------------------------------------------------
// 5. QUITAÇÃO OBSERVADA — NUNCA aciona baixa. Só classifica para alerta.
//    `quitar_acordo_cartao()` grava uma baixa como se o pagamento tivesse
//    ocorrido agora, neste sistema — usá-la para refletir algo só OBSERVADO
//    no Mannesoft forjaria um evento financeiro que não ocorreu aqui.
// ----------------------------------------------------------------------------

const SITUACOES_QUITACAO = ["QUITADO", "PAGO", "LIQUIDADO"];

export function ehQuitacaoObservada(situacaoMannesoft: string): boolean {
  return SITUACOES_QUITACAO.includes((situacaoMannesoft ?? "").toUpperCase());
}

// ----------------------------------------------------------------------------
// 6. CLASSIFICAÇÃO DE SEGURANÇA — fail-closed: qualquer entrada que o
//    chamador não tenha informado (pré-checagem não feita, nível de vínculo
//    desconhecido) cai em EXCEÇÃO, nunca em AUTOMÁTICO por omissão.
// ----------------------------------------------------------------------------

export type ClasseSeguranca = "AUTOMATICO" | "EXCECAO";

export type AvaliacaoSeguranca = {
  classe: ClasseSeguranca;
  motivo: string;
};

export type ContextoSeguranca = {
  conflitoNaCaptura: boolean;
  caso: Caso;
  situacaoMannesoft: string;
  // Pré-checagens que só a Edge Function pode fazer (consulta ao CRM).
  // Omitidas (undefined) => tratadas como NÃO CONFIRMADAS => exceção.
  semParcelaPagaOuBaixa?: boolean; // obrigatório para permitir cancelamento automático
  nivelVinculo?: "FORTE" | "FRACO" | "SEM_VINCULO"; // de acordo_vinculo_sugestoes_calcular()
};

export function avaliarSeguranca(ctx: ContextoSeguranca): AvaliacaoSeguranca {
  if (ctx.conflitoNaCaptura) {
    return { classe: "EXCECAO", motivo: "COLISAO_CHAVE_NO_LOTE" };
  }
  if (ehQuitacaoObservada(ctx.situacaoMannesoft)) {
    return { classe: "EXCECAO", motivo: "QUITACAO_OBSERVADA_EXTERNA" };
  }
  if ((ctx.situacaoMannesoft ?? "").toUpperCase() === "CANCELADO") {
    if (ctx.semParcelaPagaOuBaixa === true) {
      return { classe: "AUTOMATICO", motivo: "CANCELAMENTO_PRE_CHECADO_SEM_PAGAMENTO" };
    }
    return { classe: "EXCECAO", motivo: "CANCELAMENTO_SEM_PRE_CHECAGEM" };
  }
  if (ctx.caso === "ACORDO_NOVO") {
    return { classe: "AUTOMATICO", motivo: "ACORDO_NOVO_SEM_CONFLITO" };
  }
  if (ctx.caso === "REACORDO_ROTULADO") {
    return { classe: "EXCECAO", motivo: "REACORDO_EXIGE_CONFERENCIA" };
  }
  if (ctx.caso === "SEM_MUDANCA") {
    return { classe: "AUTOMATICO", motivo: "SEM_MUDANCA_NADA_A_PROMOVER" };
  }
  // Qualquer combinação não prevista explicitamente acima — fail-closed.
  return { classe: "EXCECAO", motivo: "CASO_NAO_PREVISTO" };
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
    ],
  };
}
