// Adaptador: PAGAMENTOS Santander (já armazenados) → capturas PARCIAIS do
// staging de ACORDOS (prime-acordos-staging.ts).
//
// POR QUE ISTO É UM MÓDULO SEPARADO: mesmo padrão de prime-acordos-staging.ts
// e pdf.ts — lógica pura, sem rede, sem Supabase, sem RPC. Este adaptador
// NUNCA lê nem escreve em `pagamentos`, `baixas_pagamento`, `parcelas` ou
// `acordos` diretamente — recebe como entrada uma projeção já resolvida pelo
// chamador (a Edge Function real, ainda não construída) e devolve dados no
// formato que prime-acordos-staging.ts já entende. Reaproveita
// montarChaveAcordo/avaliarVinculoConvenioReativa/analisarComposicao de lá —
// nunca duplica essa lógica.
//
// CONTRATO REAL DE ARMAZENAMENTO (verificado nesta rodada, não repetir):
//   - `pagamentos`: colunas confirmadas via information_schema incluem id
//     (uuid), cpf, titulo_numero, numero_parcela_completo, valor_pago,
//     data_pagamento, tipo_pagamento, dados (jsonb). O código de
//     santander-previa/planilha.ts (normalizarLinhaSantander) LÊ a coluna F
//     (convênio) do arquivo bancário, mas a DESCARTA na desestruturação — ela
//     nunca é persistida, nem como coluna, nem dentro de `dados` (confirmado
//     por `jsonb_object_keys(dados)`: 26 chaves observadas, nenhuma
//     "convenio"). `acordos` e `parcelas` também não têm nenhuma coluna de
//     portador/convênio (confirmado via information_schema).
//   - CONSEQUÊNCIA: hoje, a partir de dado já armazenado, NÃO EXISTE prova de
//     convênio por linha de pagamento — nem no pagamento, nem no acordo que
//     ele eventualmente referencia. Os campos `convenioBancarioOriginal`/
//     `portadorBancarioOriginal` abaixo existem para respeitar o contrato de
//     IdentificacaoPortador de prime-acordos-staging.ts e para não quebrar se
//     uma fonte futura (ex.: importador alterado, fora do escopo desta
//     tarefa) algum dia os preencher — mas com os dados reais de hoje, estes
//     campos chegam SEMPRE ausentes. Isto é reportado como impedimento real,
//     não contornado por presunção alguma (ex.: nunca se infere convênio
//     272047 só porque `tipo_pagamento = 'SANTANDER'` — esse rótulo identifica
//     o IMPORTADOR usado, não o convênio da linha; o próprio código do
//     importador aceitaria, sem distinção, um arquivo de qualquer outro
//     convênio Santander se algum dia fosse alimentado com um).
//   - `numero_parcela_completo` é o identificador correto, único por parcela
//     (já documentado no próprio código do importador, com aviso explícito
//     para nunca usar `titulo_numero` como chave de dedup) — é o DOCUMENTO
//     usado aqui para o título gerado, nunca o boleto bruto por si.
//   - O EVENTO de pagamento (requisito 5) nunca é identificado por
//     parcela/boleto — é identificado por `pagamentos.id` (uuid, já
//     estável e gerado na própria origem), porque vários pagamentos
//     (parciais, reimportados) podem compartilhar a mesma parcela sem serem
//     o mesmo evento.

import {
  type CapturaAcordo,
  type Composicao,
  type IdentificacaoPortador,
  type TituloGerado,
  montarChaveAcordo,
  normalizarCpf,
} from "./prime-acordos-staging.ts";

// ----------------------------------------------------------------------------
// 1. ENTRADA — projeção já resolvida pelo chamador a partir de `pagamentos`.
//    Nenhum campo aqui é lido de rede ou banco por este módulo.
// ----------------------------------------------------------------------------

export type PagamentoSantanderObservado = IdentificacaoPortador & {
  // Chave estável do EVENTO de pagamento na origem — sempre `pagamentos.id`.
  // Nunca `parcelas.boleto` nem `numero_parcela_completo` isolados (requisito 5).
  idPagamento: string;
  cpf: string | null; // bruto, como armazenado — pode vir nulo/vazio; nunca presumido
  numeroParcelaCompleto: string | null; // formato esperado: 5 + acordo(6) + parcela(4) = 11 dígitos
  valorPago: number;
  dataPagamento: string; // ISO yyyy-mm-dd, como armazenado
};

// ----------------------------------------------------------------------------
// 2. DECODIFICAÇÃO DO BOLETO — só extrai identidade (acordo/parcela); nunca
//    convênio (decisão 8 já fechada em prime-acordos-staging.ts). Formato
//    validado explicitamente; nenhuma suposição quando não casa.
// ----------------------------------------------------------------------------

const FORMATO_NUMERO_PARCELA_COMPLETO = /^5(\d{6})(\d{4})$/;

export type IdentidadePorBoleto = {
  numeroAcordoMannesoft: string;
  numeroParcela: string;
};

export function decodificarNumeroParcelaCompleto(numeroParcelaCompleto: string | null): IdentidadePorBoleto | null {
  const bruto = (numeroParcelaCompleto ?? "").trim();
  const m = FORMATO_NUMERO_PARCELA_COMPLETO.exec(bruto);
  if (!m) return null;
  return { numeroAcordoMannesoft: m[1], numeroParcela: m[2] };
}

// ----------------------------------------------------------------------------
// 3. IDENTIDADE DO ALUNO — nunca presume CPF nem vínculo inexistente. Ausência
//    ou formato inválido devolve null; o chamador nunca recebe um identificador
//    inventado (requisito 4).
// ----------------------------------------------------------------------------

export function resolverIdentidadeAlunoPorCpf(cpf: string | null): string | null {
  const limpo = normalizarCpf(cpf ?? "");
  if (limpo.length !== 11) return null; // CPF ausente ou incompleto: nunca presumido
  return limpo;
}

// ----------------------------------------------------------------------------
// 4. CHAVE DO EVENTO — sempre `idPagamento`. Função só para deixar explícito
//    no código (e nos testes) que não é o boleto/parcela.
// ----------------------------------------------------------------------------

export function chaveEventoPagamento(p: Pick<PagamentoSantanderObservado, "idPagamento">): string {
  const id = (p.idPagamento ?? "").trim();
  if (!id) throw new Error("CHAVE_EVENTO_PAGAMENTO_AUSENTE: idPagamento é obrigatório");
  return id;
}

// ----------------------------------------------------------------------------
// 5. TÍTULO GERADO a partir de UM pagamento — preserva bruto o que vier de
//    portador/convênio (hoje, sempre ausente — ver nota de contrato no topo).
//    Nunca infere valor, vencimento ou qualquer outro campo não informado.
// ----------------------------------------------------------------------------

export function transformarPagamentoEmTituloGerado(
  p: PagamentoSantanderObservado,
  identidade: IdentidadePorBoleto,
): TituloGerado {
  return {
    documento: p.numeroParcelaCompleto as string, // já validado pelo chamador (decodificarNumeroParcelaCompleto não null)
    valor: p.valorPago,
    portadorIdMannesoft: p.portadorIdMannesoft ?? null,
    convenioMannesoft: p.convenioMannesoft ?? null,
  };
}

// ----------------------------------------------------------------------------
// 6. ACUMULAÇÃO DE TÍTULOS GERADOS — nunca perde um título já conhecido de
//    captura anterior (requisito 7). Mesmo `documento` (mesma parcela) só tem
//    seus campos completados onde faltavam; nunca sobrescreve informação já
//    comprovada por um valor "mais pobre" vindo depois.
// ----------------------------------------------------------------------------

export function acumularTitulosGerados(
  anteriores: TituloGerado[],
  novos: TituloGerado[],
): TituloGerado[] {
  const porDocumento = new Map<string, TituloGerado>();
  for (const t of anteriores) porDocumento.set(t.documento, t);
  for (const novo of novos) {
    const existente = porDocumento.get(novo.documento);
    if (!existente) {
      porDocumento.set(novo.documento, novo);
      continue;
    }
    // Merge campo a campo: só completa o que faltava; nunca descarta o que já
    // era conhecido (ex.: convênio já comprovado antes nunca é apagado por um
    // pagamento posterior que não traz essa informação).
    porDocumento.set(novo.documento, {
      documento: existente.documento,
      valor: existente.valor ?? novo.valor,
      vencimento: existente.vencimento ?? novo.vencimento,
      unidade: existente.unidade ?? novo.unidade ?? null,
      portadorIdMannesoft: existente.portadorIdMannesoft ?? novo.portadorIdMannesoft ?? null,
      convenioMannesoft: existente.convenioMannesoft ?? novo.convenioMannesoft ?? null,
    });
  }
  return Array.from(porDocumento.values());
}

// ----------------------------------------------------------------------------
// 7. SITUAÇÃO/TIPO — fixos, nunca inferidos. Nunca "QUITADO", "PAGO",
//    "LIQUIDADO" (disparariam ehQuitacaoObservada em prime-acordos-staging.ts)
//    nem "CANCELADO" — requisito 9. O valor é só um rótulo de origem.
// ----------------------------------------------------------------------------

export const SITUACAO_PAGAMENTO_OBSERVADO = "EM_ANDAMENTO_OBSERVADO_PAGAMENTO_SANTANDER";

// ----------------------------------------------------------------------------
// 8. LOTE — idempotente (requisito 10): eventos já processados (por
//    `idPagamento`) são sempre ignorados, nunca reprocessados; a saída traz um
//    cursor para o chamador persistir e retomar com segurança após qualquer
//    interrupção. A ORDEM dos pagamentos recebidos deve ser ascendente por
//    origem (ex.: `pagamentos.created_at`/`id`) — este módulo não ordena,
//    só preserva a ordem dada.
// ----------------------------------------------------------------------------

export type RejeicaoEvento = {
  idPagamento: string;
  motivo: "FORMATO_NUMERO_PARCELA_COMPLETO_INVALIDO" | "IDENTIDADE_ALUNO_AUSENTE" | "CHAVE_ACORDO_INCOMPLETA";
};

export type CapturaAdaptadaPorChave = {
  chaveAcordo: string;
  captura: CapturaAcordo;
};

export type ResultadoAdaptacaoLote = {
  capturas: CapturaAdaptadaPorChave[];
  eventosProcessados: string[]; // idPagamento dos eventos efetivamente novos nesta execução
  eventosIgnoradosDuplicados: string[]; // idPagamento já presentes em eventosJaProcessados
  eventosRejeitados: RejeicaoEvento[];
  cursorUltimoIdPagamentoProcessado: string | null; // último idPagamento (novo ou duplicado) visto no lote, na ordem recebida
};

export function adaptarLotePagamentosSantanderParaAcordos(params: {
  pagamentos: PagamentoSantanderObservado[];
  eventosJaProcessados: ReadonlySet<string>;
  // Última CapturaAcordo já conhecida no staging para cada chave_acordo —
  // leitura de apoio fornecida pelo chamador (nunca lida aqui do banco).
  capturasAnterioresPorChave?: ReadonlyMap<string, CapturaAcordo>;
}): ResultadoAdaptacaoLote {
  const capturasAnterioresPorChave = params.capturasAnterioresPorChave ?? new Map<string, CapturaAcordo>();
  // Acumulador de trabalho desta execução: começa das capturas anteriores e
  // vai sendo atualizado conforme os pagamentos do próprio lote são lidos,
  // para que vários pagamentos do mesmo acordo NO MESMO LOTE também acumulem
  // entre si (não só contra o que já estava no staging).
  const capturasEmConstrucao = new Map<string, CapturaAcordo>(capturasAnterioresPorChave);

  const eventosProcessados: string[] = [];
  const eventosIgnoradosDuplicados: string[] = [];
  const eventosRejeitados: RejeicaoEvento[] = [];
  let cursorUltimoIdPagamentoProcessado: string | null = null;

  for (const p of params.pagamentos) {
    const chaveEvento = chaveEventoPagamento(p);
    cursorUltimoIdPagamentoProcessado = chaveEvento;

    if (params.eventosJaProcessados.has(chaveEvento)) {
      eventosIgnoradosDuplicados.push(chaveEvento);
      continue; // idempotência: nunca reprocessa o mesmo evento (requisito 6/10)
    }

    const identidadeBoleto = decodificarNumeroParcelaCompleto(p.numeroParcelaCompleto);
    if (!identidadeBoleto) {
      eventosRejeitados.push({ idPagamento: chaveEvento, motivo: "FORMATO_NUMERO_PARCELA_COMPLETO_INVALIDO" });
      continue;
    }

    const identificadorAluno = resolverIdentidadeAlunoPorCpf(p.cpf);
    if (!identificadorAluno) {
      eventosRejeitados.push({ idPagamento: chaveEvento, motivo: "IDENTIDADE_ALUNO_AUSENTE" });
      continue;
    }

    let chaveAcordo: string;
    try {
      chaveAcordo = montarChaveAcordo({
        numeroAcordoMannesoft: identidadeBoleto.numeroAcordoMannesoft,
        identificadorAluno,
      });
    } catch {
      eventosRejeitados.push({ idPagamento: chaveEvento, motivo: "CHAVE_ACORDO_INCOMPLETA" });
      continue;
    }

    const novoTitulo = transformarPagamentoEmTituloGerado(p, identidadeBoleto);
    const anterior = capturasEmConstrucao.get(chaveAcordo) ?? null;
    const titulosGeradosAcumulados = acumularTitulosGerados(
      anterior?.composicao.titulos_gerados ?? [],
      [novoTitulo],
    );

    const composicao: Composicao = {
      // Nunca conhecido a partir de pagamento observado — mantém PARCIAL
      // (via composicaoCompletaDesconhecida em prime-acordos-staging.ts),
      // nunca inventa títulos negociados (requisito 8/9).
      titulos_negociados: anterior?.composicao.titulos_negociados ?? [],
      titulos_gerados: titulosGeradosAcumulados,
    };

    const captura: CapturaAcordo = {
      numeroAcordoMannesoft: identidadeBoleto.numeroAcordoMannesoft,
      identificadorAluno,
      carteiraPortador: anterior?.carteiraPortador ?? null,
      situacaoMannesoft: SITUACAO_PAGAMENTO_OBSERVADO,
      tipoMannesoft: anterior?.tipoMannesoft ?? null, // nunca inferido
      composicao,
      ...(anterior?.acordoAnteriorMannesoft ? { acordoAnteriorMannesoft: anterior.acordoAnteriorMannesoft } : {}),
    };

    capturasEmConstrucao.set(chaveAcordo, captura);
    eventosProcessados.push(chaveEvento);
  }

  const capturas: CapturaAdaptadaPorChave[] = Array.from(capturasEmConstrucao.entries())
    // só devolve chaves que esta execução efetivamente tocou ou que já vinham
    // de capturasAnterioresPorChave e foram atualizadas; chaves intocadas e
    // que não existiam antes não aparecem (não há o que reportar).
    .filter(([chave]) => {
      const veioDoLote = params.pagamentos.some((p) => {
        const identidade = decodificarNumeroParcelaCompleto(p.numeroParcelaCompleto);
        const identificadorAluno = resolverIdentidadeAlunoPorCpf(p.cpf);
        if (!identidade || !identificadorAluno) return false;
        try {
          return montarChaveAcordo({ numeroAcordoMannesoft: identidade.numeroAcordoMannesoft, identificadorAluno }) === chave;
        } catch {
          return false;
        }
      });
      return veioDoLote;
    })
    .map(([chaveAcordo, captura]) => ({ chaveAcordo, captura }));

  return {
    capturas,
    eventosProcessados,
    eventosIgnoradosDuplicados,
    eventosRejeitados,
    cursorUltimoIdPagamentoProcessado,
  };
}
