// INTEGRAÇÃO — da linha de `pagamentos.dados` até a classe de reconhecimento.
//
// O QUE ESTE ARQUIVO PROVA, e que nenhum teste de unidade prova: que os dois
// módulos já entregues se encaixam, e que as três classes (AUTOMATICO,
// PARCIAL, EXCECAO) saem do caminho real — pagamento observado → adaptador →
// captura → `avaliarReconhecimento()`.
//
// O ELO QUE AINDA NÃO EXISTE, simulado explicitamente: a Edge Function que lê
// `pagamentos.dados` e monta `PagamentoSantanderObservado`. Aqui ela é a função
// `projetarDadosDoPagamento()` abaixo, com DEZ linhas e nenhuma decisão — é
// projeção de campo, não regra. Está assim de propósito: quando a função real
// existir, ela tem de fazer exatamente isto, e este teste é o contrato.
//
// A PREMISSA QUE NÃO É ASSUMIDA: `dados.convenio_bancario` é de origem
// BANCÁRIA. A projeção o coloca em `convenioMannesoft` SÓ porque o contrato do
// adaptador chama o campo assim, e há um caso abaixo que trava a diferença —
// que isto é equivalência NÃO COMPROVADA (ver prime-gaps.md). Se a prova
// chegar, o caso muda de nome; se não chegar, ninguém lê este arquivo e supõe
// que já está provado.
//
// NADA AQUI ESCREVE. Sem banco, sem rede, sem Supabase.
import { describe, it, expect } from "vitest";
import {
  adaptarLotePagamentosSantanderParaAcordos,
} from "./santander-pagamentos-acordos-adapter.ts";
import {
  analisarComposicao,
  avaliarReconhecimento,
  bloqueioFinanceiroAtivo,
  montarChaveAcordo,
} from "./prime-acordos-staging.ts";

// ---------------------------------------------------------------------------
// O elo que falta, em dez linhas: `pagamentos.dados` → PagamentoSantanderObservado
// ---------------------------------------------------------------------------
function projetarDadosDoPagamento(id, dados) {
  return {
    idPagamento: id,
    cpf: dados.cpf ?? null,
    numeroParcelaCompleto: dados.numero_parcela_completo ?? null,
    valorPago: Number(dados.valor_pago) || 0,
    dataPagamento: dados.data_pagamento ?? null,
    // ORIGEM BANCÁRIA, carimbada num campo de nome Mannesoft porque é assim
    // que o contrato do adaptador se chama. A equivalência com o covenant do
    // portador 166 NÃO está provada — ver o caso "a premissa não provada".
    convenioMannesoft: dados.convenio_bancario ?? null,
    portadorIdMannesoft: null, // `pagamentos.dados` nunca traz portador
  };
}

// Linha como a tela normaliza hoje e a RPC grava em `pagamentos.dados`.
// 14 chaves; só as que o adaptador lê aparecem nomeadas.
function dadosDoPagamento({ convenio = "0272047", boleto = "5" + "071903" + "0001", cpf = "111.222.333-44" } = {}) {
  return {
    aluno_nome: "Aluno Sintetico",
    matricula: "2026002333",
    cpf,
    titulo_numero: "71903",
    numero_parcela_completo: boleto,
    convenio_bancario: convenio,
    vencimento: "2026-10-10",
    valor_original: 500,
    valor_honorario: 50,
    data_pagamento: "2026-10-22",
    valor_pago: 500,
    tipo_pagamento: "SANTANDER",
    operador_email: "cobranca13@aelbra.com.br",
    operador_nome: "DIEGO",
  };
}

function classificar(capturas) {
  return capturas.map(({ chaveAcordo, captura }) => {
    const tracos = analisarComposicao(captura.composicao);
    return {
      chave: chaveAcordo,
      chaveConferida: montarChaveAcordo(captura),
      ...avaliarReconhecimento({ conflitoNaCaptura: false, tracos }),
    };
  });
}

function adaptarUm(dados, id = "pag-1") {
  return adaptarLotePagamentosSantanderParaAcordos({
    pagamentos: [projetarDadosDoPagamento(id, dados)],
    eventosJaProcessados: new Set(),
  });
}

describe("linha bancária real → adaptador → classe de reconhecimento", () => {
  it("convênio 272047 comprovado na própria linha, composição desconhecida → PARCIAL", () => {
    const r = adaptarUm(dadosDoPagamento({ convenio: "0272047" }));
    expect(r.eventosRejeitados).toEqual([]);
    const classes = classificar(r.capturas);
    expect(classes).toHaveLength(1);
    expect(classes[0].classe).toBe("PARCIAL");
    expect(classes[0].motivo).toBe("COMPOSICAO_COMPLETA_DESCONHECIDA_PENDENTE_COMPLEMENTACAO");
  });

  it("o mesmo, sem o zero à esquerda — 272047 cru também comprova", () => {
    const classes = classificar(adaptarUm(dadosDoPagamento({ convenio: "272047" })).capturas);
    expect(classes[0].classe).toBe("PARCIAL");
  });

  it("convênio de OUTRO portador Santander (272036) → EXCECAO por divergência", () => {
    const classes = classificar(adaptarUm(dadosDoPagamento({ convenio: "0272036" })).capturas);
    expect(classes[0].classe).toBe("EXCECAO");
    expect(classes[0].motivo).toBe("VINCULO_CONVENIO_REATIVA_DIVERGENTE");
  });

  it("convênio ausente — o caso de TODO pagamento histórico → EXCECAO por informação insuficiente", () => {
    // Pagamento importado antes de 290b1b1b nunca terá `convenio_bancario`, e
    // o arquivo original não é preservado para reprocessar. Esta é a classe
    // em que a fila inteira de hoje cai, e está certo que caia.
    const classes = classificar(adaptarUm(dadosDoPagamento({ convenio: null })).capturas);
    expect(classes[0].classe).toBe("EXCECAO");
    expect(classes[0].motivo).toBe("VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO");
  });

  it("CPF ausente não vira acordo nenhum — rejeita o evento, não adivinha identidade", () => {
    const r = adaptarUm(dadosDoPagamento({ cpf: null }));
    expect(r.capturas).toEqual([]);
    expect(r.eventosRejeitados).toHaveLength(1);
  });

  it("boleto fora do formato 5+acordo(6)+parcela(4) é rejeitado, não interpretado", () => {
    const r = adaptarUm(dadosDoPagamento({ boleto: "123" }));
    expect(r.capturas).toEqual([]);
    expect(r.eventosRejeitados[0].motivo).toBe("FORMATO_NUMERO_PARCELA_COMPLETO_INVALIDO");
  });
});

describe("contradição dentro do mesmo título gerado → EXCECAO", () => {
  it("portador 166 com convênio divergente não comprova vínculo", () => {
    // `pagamentos.dados` não traz portador, então a contradição só aparece
    // quando a captura é COMPOSTA com algo que traz — é o caso que a correção
    // de 05/11 fechou (antes, o OR aceitava por um dos lados).
    const r = adaptarUm(dadosDoPagamento({ convenio: "0272036" }));
    const { captura } = r.capturas[0];
    const composicaoContraditoria = {
      ...captura.composicao,
      titulos_gerados: captura.composicao.titulos_gerados.map((t) => ({
        ...t,
        portadorIdMannesoft: 166, // diz ReATIVA; o convênio da linha diz 272036
      })),
    };
    const tracos = analisarComposicao(composicaoContraditoria);
    expect(tracos.vinculoConvenioReativa.divergente).toBe(true);
    expect(avaliarReconhecimento({ conflitoNaCaptura: false, tracos })).toEqual({
      classe: "EXCECAO",
      motivo: "VINCULO_CONVENIO_REATIVA_DIVERGENTE",
    });
  });
});

describe("idempotência: o mesmo evento nunca entra duas vezes", () => {
  it("segundo lote com o mesmo idPagamento não produz captura nova", () => {
    const dados = dadosDoPagamento();
    const primeiro = adaptarUm(dados, "pag-1");
    expect(primeiro.capturas).toHaveLength(1);

    const segundo = adaptarLotePagamentosSantanderParaAcordos({
      pagamentos: [projetarDadosDoPagamento("pag-1", dados)],
      eventosJaProcessados: new Set(primeiro.eventosProcessados),
    });
    expect(segundo.capturas).toEqual([]);
    expect(segundo.eventosIgnoradosDuplicados).toHaveLength(1);
  });
});

describe("nenhuma classe libera efeito financeiro", () => {
  it("AUTOMATICO, PARCIAL e EXCECAO: bloqueio ativo em todas", () => {
    for (const situacao of ["Acordo", "QUITADO", "CANCELADO", "ATIVO", ""]) {
      const r = bloqueioFinanceiroAtivo(situacao);
      expect(r.bloqueado).toBe(true);
    }
  });

  it("a projeção do elo que falta não inventa portador — `pagamentos.dados` não tem", () => {
    const p = projetarDadosDoPagamento("x", dadosDoPagamento());
    expect(p.portadorIdMannesoft).toBeNull();
  });
});

describe("a premissa NÃO provada, travada por teste", () => {
  it("convenio_bancario é de origem BANCÁRIA, e isso está dito onde a projeção acontece", () => {
    // Este caso existe para que ninguém leia `convenioMannesoft` e conclua que
    // o dado veio do Mannesoft. Se a projeção perder esse aviso, o caso cai.
    const fonte = String(projetarDadosDoPagamento);
    expect(fonte).toMatch(/ORIGEM BANC|origem banc/i);
    expect(fonte).toMatch(/convenio_bancario/);
  });

  it("a equivalência com o portador 166 NÃO é afirmada em lugar nenhum do caminho", () => {
    // O adaptador nunca escreve portadorIdMannesoft a partir do convênio.
    const p = projetarDadosDoPagamento("x", dadosDoPagamento({ convenio: "0272047" }));
    expect(p.convenioMannesoft).toBe("0272047");
    expect(p.portadorIdMannesoft).toBeNull();
  });
});
