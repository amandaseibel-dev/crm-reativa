// Testes puros (sem banco, sem rede) do adaptador PAGAMENTOS Santander →
// capturas PARCIAIS do staging de ACORDOS. Dados FICTÍCIOS.
//
// Cobre: pagamentos parciais, boletos repetidos, acordos com várias
// parcelas, reimportações (idempotência por idPagamento) e convênios
// divergentes — conforme pedido na autorização desta rodada. Nunca duplica
// os testes já existentes de prime-acordos-staging.test.js (reconhecimento,
// vínculo com o convênio, PARCIAL) — aqui só se testa a TRANSFORMAÇÃO dos
// dados de pagamento em entrada para aquela lógica já comprovada.
import { describe, it, expect } from "vitest";
import {
  decodificarNumeroParcelaCompleto,
  resolverIdentidadeAlunoPorCpf,
  chaveEventoPagamento,
  transformarPagamentoEmTituloGerado,
  acumularTitulosGerados,
  adaptarLotePagamentosSantanderParaAcordos,
  SITUACAO_PAGAMENTO_OBSERVADO,
} from "./santander-pagamentos-acordos-adapter.ts";
import { avaliarReconhecimento, analisarComposicao } from "./prime-acordos-staging.ts";
import { normalizarLinhaSantander } from "../santander-previa/planilha.ts";

function pagamento(overrides = {}) {
  return {
    idPagamento: "pag-0001",
    cpf: "123.456.789-09",
    numeroParcelaCompleto: "571903" + "0001", // 5 + acordo(6)="719030" ... ajustado abaixo
    valorPago: 150.5,
    dataPagamento: "2026-01-10",
    ...overrides,
  };
}

// numeroParcelaCompleto válido: 5 + acordo(6 dígitos) + parcela(4 dígitos) = 11 dígitos.
const BOLETO_ACORDO_71903_PARCELA_0001 = "5" + "071903" + "0001"; // acordo "071903", parcela "0001"
const BOLETO_ACORDO_71903_PARCELA_0002 = "5" + "071903" + "0002";
const BOLETO_ACORDO_71622_PARCELA_0001 = "5" + "071622" + "0001";

describe("decodificarNumeroParcelaCompleto", () => {
  it("decodifica acordo e parcela de um boleto válido de 11 dígitos iniciado em 5", () => {
    expect(decodificarNumeroParcelaCompleto(BOLETO_ACORDO_71903_PARCELA_0001)).toEqual({
      numeroAcordoMannesoft: "071903",
      numeroParcela: "0001",
    });
  });

  it("rejeita formato com menos de 11 dígitos", () => {
    expect(decodificarNumeroParcelaCompleto("5071903001")).toBeNull();
  });

  it("rejeita formato que não começa com 5", () => {
    expect(decodificarNumeroParcelaCompleto("60719030001")).toBeNull();
  });

  it("rejeita nulo/vazio sem presumir nada", () => {
    expect(decodificarNumeroParcelaCompleto(null)).toBeNull();
    expect(decodificarNumeroParcelaCompleto("")).toBeNull();
  });
});

describe("resolverIdentidadeAlunoPorCpf", () => {
  it("resolve identidade a partir de um CPF com 11 dígitos (formatado ou não)", () => {
    expect(resolverIdentidadeAlunoPorCpf("123.456.789-09")).toBe("12345678909");
    expect(resolverIdentidadeAlunoPorCpf("12345678909")).toBe("12345678909");
  });

  it("nunca presume identidade quando o CPF está ausente ou incompleto", () => {
    expect(resolverIdentidadeAlunoPorCpf(null)).toBeNull();
    expect(resolverIdentidadeAlunoPorCpf("")).toBeNull();
    expect(resolverIdentidadeAlunoPorCpf("123")).toBeNull();
  });
});

describe("chaveEventoPagamento", () => {
  it("usa sempre idPagamento, nunca boleto/parcela", () => {
    expect(chaveEventoPagamento({ idPagamento: "uuid-abc" })).toBe("uuid-abc");
  });

  it("recusa chave vazia em vez de inventar uma", () => {
    expect(() => chaveEventoPagamento({ idPagamento: "" })).toThrow(/CHAVE_EVENTO_PAGAMENTO_AUSENTE/);
  });
});

describe("transformarPagamentoEmTituloGerado", () => {
  it("preserva portador/convênio brutos quando informados (hoje, caso raro/futuro)", () => {
    const p = pagamento({
      numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001,
      portadorIdMannesoft: 166,
      convenioMannesoft: "0272047",
    });
    const identidade = decodificarNumeroParcelaCompleto(p.numeroParcelaCompleto);
    const titulo = transformarPagamentoEmTituloGerado(p, identidade);
    expect(titulo).toEqual({
      documento: BOLETO_ACORDO_71903_PARCELA_0001,
      valor: 150.5,
      portadorIdMannesoft: 166,
      convenioMannesoft: "0272047",
    });
  });

  it("nunca inventa portador/convênio quando a origem não informa (contrato real hoje)", () => {
    const p = pagamento({ numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 });
    const identidade = decodificarNumeroParcelaCompleto(p.numeroParcelaCompleto);
    const titulo = transformarPagamentoEmTituloGerado(p, identidade);
    expect(titulo.portadorIdMannesoft).toBeNull();
    expect(titulo.convenioMannesoft).toBeNull();
  });
});

describe("acumularTitulosGerados", () => {
  it("acumula parcelas novas sem perder as já conhecidas de capturas anteriores", () => {
    const anteriores = [{ documento: BOLETO_ACORDO_71903_PARCELA_0001, valor: 150.5, portadorIdMannesoft: null, convenioMannesoft: null }];
    const novos = [{ documento: BOLETO_ACORDO_71903_PARCELA_0002, valor: 150.5, portadorIdMannesoft: null, convenioMannesoft: null }];
    const resultado = acumularTitulosGerados(anteriores, novos);
    expect(resultado.map((t) => t.documento).sort()).toEqual([
      BOLETO_ACORDO_71903_PARCELA_0001,
      BOLETO_ACORDO_71903_PARCELA_0002,
    ]);
  });

  it("completa campos ausentes de um título já conhecido sem apagar o que já era comprovado", () => {
    const anteriores = [
      { documento: BOLETO_ACORDO_71903_PARCELA_0001, valor: 150.5, portadorIdMannesoft: 166, convenioMannesoft: "0272047" },
    ];
    // um pagamento posterior da mesma parcela, sem informar convênio (caso real de hoje)
    const novos = [{ documento: BOLETO_ACORDO_71903_PARCELA_0001, valor: 150.5, portadorIdMannesoft: null, convenioMannesoft: null }];
    const resultado = acumularTitulosGerados(anteriores, novos);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].convenioMannesoft).toBe("0272047"); // preservado, nunca apagado
    expect(resultado[0].portadorIdMannesoft).toBe(166);
  });

  it("não duplica a mesma parcela quando ela se repete entre lotes", () => {
    const anteriores = [{ documento: BOLETO_ACORDO_71903_PARCELA_0001, valor: 150.5, portadorIdMannesoft: null, convenioMannesoft: null }];
    const novos = [{ documento: BOLETO_ACORDO_71903_PARCELA_0001, valor: 150.5, portadorIdMannesoft: null, convenioMannesoft: null }];
    expect(acumularTitulosGerados(anteriores, novos)).toHaveLength(1);
  });
});

describe("adaptarLotePagamentosSantanderParaAcordos — cenários do lote", () => {
  it("adapta um pagamento válido isolado em uma captura PARCIAL (sem títulos negociados, sem convênio comprovado)", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamento({ idPagamento: "pag-1", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 })],
      eventosJaProcessados: new Set(),
    });

    expect(resultado.eventosProcessados).toEqual(["pag-1"]);
    expect(resultado.eventosRejeitados).toEqual([]);
    expect(resultado.capturas).toHaveLength(1);

    const { captura } = resultado.capturas[0];
    expect(captura.numeroAcordoMannesoft).toBe("071903");
    expect(captura.situacaoMannesoft).toBe(SITUACAO_PAGAMENTO_OBSERVADO);
    expect(captura.composicao.titulos_negociados).toEqual([]); // nunca inventado (requisito 8/9)
    expect(captura.composicao.titulos_gerados).toHaveLength(1);

    // Integração com a lógica já existente (nunca duplicada aqui): sem
    // convênio comprovado pelos dados reais de hoje, a classificação correta
    // e já comprovada é EXCECAO por falta de informação — não PARCIAL nem
    // AUTOMATICO — porque não há, hoje, prova de vínculo com 166/272047.
    const tracos = analisarComposicao(captura.composicao);
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos });
    expect(avaliacao.motivo).toBe("VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO");
    expect(avaliacao.classe).toBe("EXCECAO");
  });

  it("quando o convênio bancário original É informado e comprovadamente 272047, a composição integra-se corretamente e fica PARCIAL (nunca AUTOMATICO, pois títulos negociados continuam desconhecidos)", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({
          idPagamento: "pag-2",
          numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001,
          portadorIdMannesoft: 166,
          convenioMannesoft: "0272047",
        }),
      ],
      eventosJaProcessados: new Set(),
    });

    const { captura } = resultado.capturas[0];
    const tracos = analisarComposicao(captura.composicao);
    expect(tracos.vinculoConvenioReativa.suficiente).toBe(true);
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos });
    expect(avaliacao.classe).toBe("PARCIAL");
    expect(avaliacao.motivo).toBe("COMPOSICAO_COMPLETA_DESCONHECIDA_PENDENTE_COMPLEMENTACAO");
  });

  it("convênio divergente do bancário original nunca é descartado — é preservado e a função já existente classifica como EXCECAO divergente", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({
          idPagamento: "pag-3",
          numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001,
          portadorIdMannesoft: 95,
          convenioMannesoft: "272036",
        }),
      ],
      eventosJaProcessados: new Set(),
    });

    const { captura } = resultado.capturas[0];
    expect(captura.composicao.titulos_gerados[0].convenioMannesoft).toBe("272036"); // preservado, nunca filtrado
    const tracos = analisarComposicao(captura.composicao);
    expect(tracos.vinculoConvenioReativa.divergente).toBe(true);
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos });
    expect(avaliacao.classe).toBe("EXCECAO");
    expect(avaliacao.motivo).toBe("VINCULO_CONVENIO_REATIVA_DIVERGENTE");
  });

  it("rejeita pagamento com boleto em formato inválido, sem gerar captura", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamento({ idPagamento: "pag-4", numeroParcelaCompleto: "123" })],
      eventosJaProcessados: new Set(),
    });
    expect(resultado.capturas).toEqual([]);
    expect(resultado.eventosProcessados).toEqual([]);
    expect(resultado.eventosRejeitados).toEqual([
      { idPagamento: "pag-4", motivo: "FORMATO_NUMERO_PARCELA_COMPLETO_INVALIDO" },
    ]);
  });

  it("rejeita pagamento sem CPF resolúvel, sem presumir identidade", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamento({ idPagamento: "pag-5", cpf: null, numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 })],
      eventosJaProcessados: new Set(),
    });
    expect(resultado.capturas).toEqual([]);
    expect(resultado.eventosRejeitados).toEqual([{ idPagamento: "pag-5", motivo: "IDENTIDADE_ALUNO_AUSENTE" }]);
  });

  it("acumula várias parcelas do MESMO acordo no mesmo lote, sem perder nenhuma (requisito 7)", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({ idPagamento: "pag-6a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 }),
        pagamento({ idPagamento: "pag-6b", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0002 }),
      ],
      eventosJaProcessados: new Set(),
    });

    expect(resultado.capturas).toHaveLength(1); // mesma chave_acordo (mesmo CPF + mesmo número de acordo)
    const { captura } = resultado.capturas[0];
    expect(captura.composicao.titulos_gerados.map((t) => t.documento).sort()).toEqual([
      BOLETO_ACORDO_71903_PARCELA_0001,
      BOLETO_ACORDO_71903_PARCELA_0002,
    ]);
  });

  it("preserva múltiplos pagamentos (parciais) da MESMA parcela como eventos distintos, sem duplicar o título gerado", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({ idPagamento: "pag-7a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001, valorPago: 80 }),
        pagamento({ idPagamento: "pag-7b", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001, valorPago: 70.5 }),
      ],
      eventosJaProcessados: new Set(),
    });

    expect(resultado.eventosProcessados).toEqual(["pag-7a", "pag-7b"]); // dois eventos distintos (requisito 6)
    const { captura } = resultado.capturas[0];
    expect(captura.composicao.titulos_gerados).toHaveLength(1); // mesma parcela, um único título gerado
  });

  it("distingue acordos diferentes (números de acordo diferentes) em capturas separadas", () => {
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({ idPagamento: "pag-8a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 }),
        pagamento({ idPagamento: "pag-8b", numeroParcelaCompleto: BOLETO_ACORDO_71622_PARCELA_0001 }),
      ],
      eventosJaProcessados: new Set(),
    });
    expect(resultado.capturas).toHaveLength(2);
    expect(resultado.capturas.map((c) => c.captura.numeroAcordoMannesoft).sort()).toEqual(["071622", "071903"]);
  });

  it("reimportação: ignora eventos já processados e só avança os novos, preservando idempotência (requisito 10)", () => {
    const eventosJaProcessados = new Set(["pag-9a"]);
    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({ idPagamento: "pag-9a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 }), // já processado antes
        pagamento({ idPagamento: "pag-9b", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0002 }), // novo
      ],
      eventosJaProcessados,
    });

    expect(resultado.eventosIgnoradosDuplicados).toEqual(["pag-9a"]);
    expect(resultado.eventosProcessados).toEqual(["pag-9b"]);
    expect(resultado.cursorUltimoIdPagamentoProcessado).toBe("pag-9b");
  });

  it("recuperação após interrupção: reprocessar o lote inteiro de novo (ex.: após falha a meio) não duplica nada, pois os eventos já processados ficam no segundo set", () => {
    const primeiraExecucao = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({ idPagamento: "pag-10a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 }),
        pagamento({ idPagamento: "pag-10b", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0002 }),
      ],
      eventosJaProcessados: new Set(),
    });
    expect(primeiraExecucao.eventosProcessados).toEqual(["pag-10a", "pag-10b"]);

    // simula reprocessar o MESMO lote, já com os eventos persistidos como processados
    const eventosJaProcessados = new Set(primeiraExecucao.eventosProcessados);
    const segundaExecucao = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [
        pagamento({ idPagamento: "pag-10a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 }),
        pagamento({ idPagamento: "pag-10b", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0002 }),
      ],
      eventosJaProcessados,
    });
    expect(segundaExecucao.eventosProcessados).toEqual([]);
    expect(segundaExecucao.eventosIgnoradosDuplicados).toEqual(["pag-10a", "pag-10b"]);
    expect(segundaExecucao.capturas).toEqual([]); // nada novo para reportar
  });

  it("mantém, ao acumular entre lotes sucessivos, uma parcela conhecida antes mesmo quando o lote novo só traz outra parcela do mesmo acordo", () => {
    const loteAnterior = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamento({ idPagamento: "pag-11a", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0001 })],
      eventosJaProcessados: new Set(),
    });
    const capturasAnterioresPorChave = new Map(
      loteAnterior.capturas.map((c) => [c.chaveAcordo, c.captura]),
    );

    const loteNovo = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamento({ idPagamento: "pag-11b", numeroParcelaCompleto: BOLETO_ACORDO_71903_PARCELA_0002 })],
      eventosJaProcessados: new Set(loteAnterior.eventosProcessados),
      capturasAnterioresPorChave,
    });

    expect(loteNovo.capturas).toHaveLength(1);
    expect(loteNovo.capturas[0].captura.composicao.titulos_gerados.map((t) => t.documento).sort()).toEqual([
      BOLETO_ACORDO_71903_PARCELA_0001,
      BOLETO_ACORDO_71903_PARCELA_0002,
    ]);
  });
});

// =============================================================================
// TESTE INTEGRADO PONTA A PONTA — arquivo bancário → normalizador real
// (santander-previa/planilha.ts) → adaptador → classificação (PARCIAL só
// quando identidade E convênio 272047 estão comprovados).
//
// Prova a cadeia completa com o normalizador REAL, agora que ele preserva a
// coluna F (convenio_bancario) em vez de descartá-la. Simula o passo que
// ainda falta construir (a Edge Function que lê `pagamentos.dados` e monta
// `PagamentoSantanderObservado`) só como uma projeção explícita de
// `dados.convenio_bancario` para `convenioMannesoft` — sem rede, sem banco.
// =============================================================================
describe("INTEGRAÇÃO — linha bancária real até a classificação PARCIAL/EXCECAO", () => {
  // Mesma ordem de colunas documentada em planilha.ts: A instituição | B
  // matrícula-nome | C título | D operador | E boleto | F convênio |
  // G vencimento | H valor original | I honorário | J data pagamento |
  // K valor pago.
  function linhaBancaria({ convenio = "0272047", boleto = "5" + "071903" + "0001" } = {}) {
    return [
      "ULBRA",
      "2026002333 - Aluno Sintetico",
      "71903",
      "DIEGO",
      boleto,
      convenio,
      new Date("2026-10-22T00:00:00Z"),
      1234.56,
      123.45,
      new Date("2026-10-21T00:00:00Z"),
      1234.56,
    ];
  }

  // Projeta `LinhaNormalizada.dados` (o que acabaria em `pagamentos.dados`)
  // + o CPF já resolvido pelo CRM (fora do escopo do normalizador, que nunca
  // atribui CPF) para dentro de `PagamentoSantanderObservado` -- é
  // exatamente o que a futura Edge Function do adaptador fará ao ler
  // `pagamentos`. Nenhuma lógica de classificação mora aqui.
  function paraPagamentoObservado(linhaNormalizada, { idPagamento, cpf }) {
    return {
      idPagamento,
      cpf,
      numeroParcelaCompleto: linhaNormalizada.numero_parcela_completo,
      valorPago: linhaNormalizada.valor_pago,
      dataPagamento: linhaNormalizada.data_pagamento,
      convenioMannesoft: linhaNormalizada.convenio_bancario,
    };
  }

  it("convênio 272047 comprovado (com zero à esquerda) + identidade resolvida => PARCIAL", () => {
    const linha = normalizarLinhaSantander(linhaBancaria({ convenio: "0272047" }));
    const pagamentoObservado = paraPagamentoObservado(linha, { idPagamento: "pag-int-1", cpf: "12345678909" });

    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamentoObservado],
      eventosJaProcessados: new Set(),
    });

    expect(resultado.eventosRejeitados).toEqual([]);
    const { captura } = resultado.capturas[0];
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(captura.composicao) });
    expect(avaliacao.classe).toBe("PARCIAL");
    expect(avaliacao.motivo).toBe("COMPOSICAO_COMPLETA_DESCONHECIDA_PENDENTE_COMPLEMENTACAO");
  });

  it("convênio 272047 comprovado (sem zero à esquerda) + identidade resolvida => PARCIAL", () => {
    const linha = normalizarLinhaSantander(linhaBancaria({ convenio: "272047" }));
    const pagamentoObservado = paraPagamentoObservado(linha, { idPagamento: "pag-int-2", cpf: "12345678909" });

    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamentoObservado],
      eventosJaProcessados: new Set(),
    });

    const { captura } = resultado.capturas[0];
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(captura.composicao) });
    expect(avaliacao.classe).toBe("PARCIAL");
  });

  it("convênio divergente (outro Santander, 272036) => EXCECAO, nunca PARCIAL -- nunca presume 272047", () => {
    const linha = normalizarLinhaSantander(linhaBancaria({ convenio: "272036" }));
    const pagamentoObservado = paraPagamentoObservado(linha, { idPagamento: "pag-int-3", cpf: "12345678909" });

    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamentoObservado],
      eventosJaProcessados: new Set(),
    });

    const { captura } = resultado.capturas[0];
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(captura.composicao) });
    expect(avaliacao.classe).toBe("EXCECAO");
    expect(avaliacao.motivo).toBe("VINCULO_CONVENIO_REATIVA_DIVERGENTE");
  });

  it("convênio ausente na linha (coluna F vazia) => EXCECAO por falta de informação, nunca PARCIAL -- comportamento de pagamento histórico", () => {
    const linha = normalizarLinhaSantander(linhaBancaria({ convenio: "" }));
    expect(linha.convenio_bancario).toBeNull(); // mesmo comportamento de todo pagamento importado antes desta correção
    const pagamentoObservado = paraPagamentoObservado(linha, { idPagamento: "pag-int-4", cpf: "12345678909" });

    const resultado = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [pagamentoObservado],
      eventosJaProcessados: new Set(),
    });

    const { captura } = resultado.capturas[0];
    const avaliacao = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(captura.composicao) });
    expect(avaliacao.classe).toBe("EXCECAO");
    expect(avaliacao.motivo).toBe("VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO");
  });
});
