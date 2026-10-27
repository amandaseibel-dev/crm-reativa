// RASTREABILIDADE DA PRÉVIA — o que a tela pode afirmar, e o que não pode.
//
// O CASO REAL QUE MOTIVOU (medido em 27/10/2026, acordo 66247): a parcela 2 do
// boleto 50662470003 está PAGO desde 05/08, e `parcelas.observacao` diz "baixa
// automatica pelo documento 50662470002 (extrato de 05/08/2026)" — o boleto da
// parcela 1. O pagamento de R$ 126,18 de 05/10 é o dinheiro próprio da parcela 2
// e nunca foi ligado a ela: `origem_baixa_ref` é nulo.
//
// A tela precisa dizer isso sem inventar nada, e sem contradizer o motivo
// histórico que o motor gravou ("nao ha registro de quem baixou").
globalThis.process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import {
  AVISO_ORIGEM_BAIXA_REF,
  DIVERGENTE,
  DOCUMENTO_CITADO,
  DOCUMENTO_DIFERE,
  DOCUMENTO_NAO_IDENTIFICADO,
  NAO_DISPONIVEL,
  NAO_INFORMADO,
  ROTULO_EVIDENCIA_ATUAL,
  ROTULO_MOTIVO_HISTORICO,
  historicoDaBaixa,
  identificacaoDaPrevia,
  cpfDaPrevia,
  rotuloDocumentoDaBaixa,
  rotuloOuPendencia,
} from "./encaminhamentoConciliacao";

// A prévia do caso real, como o banco a devolve hoje mais os dois campos que a
// fachada passa a acrescentar.
const PREVIA = {
  ok: true,
  acao: "CONFERIR_E_ENCERRAR",
  motivo_da_pendencia:
    "a parcela 2 do boleto 50662470003 ja estava PAGO antes deste pagamento entrar: nao ha registro de quem baixou",
  // A fachada mascara NA ORIGEM (§7). O CPF cru não chega aqui -- e o teste
  // abaixo reprova qualquer payload que volte a trazê-lo.
  aluno: { id: "a1", nome: "Julia Gabriela Cerqueira Amorim", cpf: "***.***.***-00" },
  acordo: { id: "ac1", numero_ulbra: "66247", status: "ATIVO", qtd_parcelas: 6 },
  parcela: {
    id: "p1", numero: 2, boleto: "50662470003", valor: 122.36,
    pago_em: "2026-08-05T00:00:00+00:00", confirmado_por_email: "ADEMIR.SANTOS",
    origem_baixa: null, origem_baixa_ref: null,
  },
  parcela_observacao: "baixa automatica pelo documento 50662470002 (extrato de 05/08/2026)",
  pagamento: { boleto: "50662470003", valor_pago: 126.18 },
};

describe("ausência vira pendência, nunca dado", () => {
  it("nulo, indefinido e vazio viram “não informado — conferir”", () => {
    expect(rotuloOuPendencia(null)).toBe(NAO_INFORMADO);
    expect(rotuloOuPendencia(undefined)).toBe(NAO_INFORMADO);
    expect(rotuloOuPendencia("")).toBe(NAO_INFORMADO);
    expect(rotuloOuPendencia("   ")).toBe(NAO_INFORMADO);
  });

  it("divergência tem rótulo próprio, diferente de ausência", () => {
    expect(rotuloOuPendencia("qualquer", { divergente: true })).toBe(DIVERGENTE);
    expect(DIVERGENTE).not.toBe(NAO_INFORMADO);
  });

  it("valor presente passa intacto", () => {
    expect(rotuloOuPendencia("66247")).toBe("66247");
    expect(rotuloOuPendencia(0)).toBe("0");
  });

  // Os dois rótulos são frases de conferência, não códigos: quem lê a tela
  // precisa entender que falta olhar, não que o sistema falhou.
  it("os dois rótulos pedem conferência", () => {
    expect(NAO_INFORMADO).toMatch(/conferir/);
    expect(DIVERGENTE).toMatch(/conferir/);
  });
});

describe("CPF: uma régua só, a do projeto", () => {
  // UMA máscara em todo o CRM. Duas réguas significariam dois formatos na tela
  // e, pior, uma delas sem tolerar o valor que a fachada passa a mandar.
  it("usa a máscara canônica, que mostra só os verificadores", () => {
    expect(cpfDaPrevia("04508881600")).toBe("***.***.***-00");
    expect(cpfDaPrevia("045.088.816-00")).toBe("***.***.***-00");
  });

  // O PONTO QUE REPROVOU A VERSÃO ANTERIOR: quando a fachada mascarar na
  // origem, a tela recebe o valor JÁ mascarado. Isso é dado presente, nunca
  // pendência -- a correção de segurança não pode apagar o campo que protege.
  it("valor já mascarado continua sendo dado, não pendência", () => {
    expect(cpfDaPrevia("***.***.***-00")).toBe("***.***.***-00");
    expect(identificacaoDaPrevia(PREVIA).aluno.cpf).toBe("***.***.***-00");
  });

  it("ausência vira pendência, e nunca o traço solto", () => {
    expect(cpfDaPrevia(null)).toBeNull();
    expect(cpfDaPrevia("")).toBeNull();
    expect(rotuloOuPendencia(cpfDaPrevia(null))).toBe(NAO_INFORMADO);
    expect(identificacaoDaPrevia({ aluno: { id: "a1" } }).aluno.cpf).toBe(NAO_INFORMADO);
  });

  // A TELA NÃO É A BARREIRA. O contrato versionado aqui é o payload da fachada:
  // o bloco do aluno não carrega CPF completo -- nem na fixture. (O teste olha o
  // bloco `aluno`, e não o payload inteiro: boleto também tem 11 dígitos, e
  // confundir os dois faria este teste reprovar dado que não é pessoal.)
  it("nenhum CPF completo trafega no bloco do aluno", () => {
    expect(JSON.stringify(PREVIA.aluno)).not.toMatch(/\d{11}/);
    expect(PREVIA.aluno.cpf).not.toMatch(/\d{3}\D*\d{3}\D*\d{3}\D*\d{2}/);
  });
});

describe("identificação: quem é o aluno e qual o acordo", () => {
  it("com vínculo, traz nome, CPF mascarado e o acordo", () => {
    const r = identificacaoDaPrevia(PREVIA);
    expect(r.aluno.nome).toBe("Julia Gabriela Cerqueira Amorim");
    expect(r.aluno.cpf).toBe("***.***.***-00");
    expect(r.aluno.temVinculo).toBe(true);
    expect(r.acordo.numero).toBe("66247");
    expect(r.acordo.status).toBe("ATIVO");
    expect(r.acordo.parcelas).toBe(6);
  });

  // ENQUANTO A FACHADA NÃO MANDAR O ALUNO, a tela não pode inventá-lo. O acordo
  // já vem hoje e continua aparecendo — é o que separa "não temos" de "não
  // mostramos".
  it("sem o bloco aluno, diz que a fachada não manda, e ainda mostra o acordo", () => {
    const r = identificacaoDaPrevia({ acordo: PREVIA.acordo });
    expect(r.aluno.nome).toBe(NAO_DISPONIVEL);
    expect(r.aluno.cpf).toBe(NAO_DISPONIVEL);
    expect(r.aluno.alimentado).toBe(false);
    expect(r.aluno.temVinculo).toBe(false);
    expect(r.acordo.numero).toBe("66247");
  });

  // Com a chave presente e vazia, a falta é do banco -- e aí sim é conferência.
  it("bloco aluno vazio é pendência de conferência", () => {
    const r = identificacaoDaPrevia({ aluno: null, acordo: PREVIA.acordo });
    expect(r.aluno.alimentado).toBe(true);
    expect(r.aluno.nome).toBe(NAO_INFORMADO);
  });

  it("prévia vazia não derruba nada e vira pendência em tudo", () => {
    const r = identificacaoDaPrevia({});
    expect(r.aluno.nome).toBe(NAO_DISPONIVEL);
    expect(r.acordo.numero).toBe(NAO_INFORMADO);
    expect(r.acordo.status).toBe(NAO_INFORMADO);
    expect(identificacaoDaPrevia(null).aluno.temVinculo).toBe(false);
  });
});

describe("histórico da baixa anterior", () => {
  it("extrai data, responsável e o documento citado na observação", () => {
    const r = historicoDaBaixa(PREVIA);
    expect(r.pagoEm).toBe("2026-08-05");
    expect(r.responsavel).toBe("ADEMIR.SANTOS");
    expect(r.documento).toBe("50662470002");
    expect(r.observacao).toMatch(/baixa automatica pelo documento 50662470002/);
    expect(r.temObservacao).toBe(true);
  });

  // ITEM 1 DA REPROVAÇÃO DO GUARDIÃO (27/10/2026): a diferença entre dois
  // números de boleto NÃO classifica nada. Os 4 dígitos finais são sequência de
  // emissão da ULBRA, não o número da parcela -- nenhuma convenção fixa explica
  // mais de 56,3% das 14.488 parcelas medidas em 23/10/2026. Documento diferente
  // é compatível com a MESMA parcela reemitida.
  it("não existe mais classificação de origem do documento", () => {
    const r = historicoDaBaixa(PREVIA);
    expect("documentoDeOutraParcela" in r).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/OUTRA parcela/i);
  });

  // O que sobra é o FATO: os dois números diferem. Sem veredito.
  it("a diferença entre os números é fato, não conclusão", () => {
    expect(historicoDaBaixa(PREVIA).documentoDifereDoBoleto).toBe(true);
    const igual = historicoDaBaixa({
      ...PREVIA,
      parcela_observacao: "baixa automatica pelo documento 50662470003 (extrato)",
    });
    expect(igual.documento).toBe("50662470003");
    expect(igual.documentoDifereDoBoleto).toBe(false);
  });

  // Medido pelo Guardião em 27/10/2026: a observação é texto livre do motor, e
  // "nº"/"no" apareciam como ausência de documento -- afirmação falsa, com o
  // número visível na observação integral logo abaixo.
  it("reconhece o documento com nº, com no e sem nada", () => {
    for (const forma of ["documento 50662470002", "documento nº 50662470002",
                         "documento no 50662470002", "Documento Nº 50662470002"]) {
      expect(historicoDaBaixa({ ...PREVIA, parcela_observacao: forma }).documento)
        .toBe("50662470002");
    }
  });

  // Observação presente e número irreconhecível NÃO é "não informado".
  it("texto sem número reconhecível diz que não identificou", () => {
    const r = historicoDaBaixa({ ...PREVIA, parcela_observacao: "baixa manual pelo operador" });
    expect(r.documento).toBe(DOCUMENTO_NAO_IDENTIFICADO);
    expect(r.documento).not.toBe(NAO_INFORMADO);
  });

  // Zero à esquerda é grafia, não divergência.
  it("compara só os dígitos, sem zeros à esquerda", () => {
    const r = historicoDaBaixa({
      parcela: { ...PREVIA.parcela, boleto: "050662470003" },
      parcela_observacao: "baixa automatica pelo documento 50662470003",
    });
    expect(r.documentoDifereDoBoleto).toBe(false);
  });

  // "Boleto apresentado" é sempre o da parcela. Dois referentes sob um rótulo
  // só fariam a tela comparar uma coisa e dizer outra.
  it("não compara contra o boleto do pagamento", () => {
    const r = historicoDaBaixa({
      parcela: { numero: 2 },
      pagamento: { boleto: "50662470003" },
      parcela_observacao: "baixa automatica pelo documento 50662470002",
    });
    expect(r.documentoDifereDoBoleto).toBeNull();
  });

  // Sem os dois lados, a tela não compara o que não tem.
  it("sem documento ou sem boleto, não compara", () => {
    expect(historicoDaBaixa({ parcela: { boleto: "50662470003" } }).documentoDifereDoBoleto).toBeNull();
    expect(historicoDaBaixa({ parcela_observacao: "documento 123" }).documentoDifereDoBoleto).toBeNull();
  });

  // ITEM 2: o rótulo é descritivo e fechado. Pede conferência, não conclui.
  it("o rótulo do documento descreve e pede conferência, sem concluir", () => {
    expect(rotuloDocumentoDaBaixa(historicoDaBaixa(PREVIA))).toBe(DOCUMENTO_DIFERE);
    expect(DOCUMENTO_DIFERE).toMatch(/difere do boleto apresentado; conferir/);
    expect(DOCUMENTO_DIFERE).not.toMatch(/parcela/i);
    expect(rotuloDocumentoDaBaixa({ documentoDifereDoBoleto: false })).toBe(DOCUMENTO_CITADO);
    expect(rotuloDocumentoDaBaixa({ documentoDifereDoBoleto: null })).toBe(DOCUMENTO_CITADO);
    expect(rotuloDocumentoDaBaixa(null)).toBe(DOCUMENTO_CITADO);
  });

  // ITEM 5: a chave NÃO existir é a fachada ainda não mandar o campo; a chave
  // existir e valer null é o banco dizendo que não tem. São frases diferentes:
  // uma é pendência de software, a outra é conferência de quem lê.
  it("campo que a fachada não manda não vira pendência de conferência", () => {
    const r = historicoDaBaixa({ parcela: PREVIA.parcela });
    expect(r.documento).toBe(NAO_DISPONIVEL);
    expect(r.observacao).toBe(NAO_DISPONIVEL);
    expect(r.temObservacao).toBe(false);
    // o que já vem hoje continua vindo
    expect(r.pagoEm).toBe("2026-08-05");
    expect(r.responsavel).toBe("ADEMIR.SANTOS");
  });

  it("chave presente e vazia é o banco não tendo, e pede conferência", () => {
    const r = historicoDaBaixa({ parcela: PREVIA.parcela, parcela_observacao: null });
    expect(r.documento).toBe(NAO_INFORMADO);
    expect(r.observacao).toBe(NAO_INFORMADO);
    expect(NAO_DISPONIVEL).not.toBe(NAO_INFORMADO);
    expect(NAO_DISPONIVEL).not.toMatch(/conferir/);
  });

  // `origem_baixa_ref` nulo é o fato central: é o elo que o encerramento NÃO
  // cria. Precisa aparecer como pendência, não como vazio.
  it("origem_baixa_ref nula vira pendência explícita", () => {
    expect(historicoDaBaixa(PREVIA).origemBaixaRef).toBe(NAO_INFORMADO);
  });

  it("origem_baixa_ref preenchida aparece como está", () => {
    const r = historicoDaBaixa({ parcela: { ...PREVIA.parcela, origem_baixa_ref: "abc-123" } });
    expect(r.origemBaixaRef).toBe("abc-123");
  });
});

// A DÍVIDA DA PREMISSA 12, COM COBRANÇA. Hoje o número do documento é extraído
// por regex no `.js`, e o Guardião aceitou isso ENQUANTO o campo não existir no
// banco. No dia em que a fachada mandar `documento_citado`, este teste falha e
// obriga o parse a sair daqui -- a promessa deixa de ser comentário.
describe("quando o banco classificar, a tela para de parsear", () => {
  it("prévia com documento_citado é lida do banco, não do texto", () => {
    const r = historicoDaBaixa({
      ...PREVIA,
      documento_citado: "50662470002",
      documento_difere_do_boleto: true,
    });
    expect(r.documento).toBe("50662470002");
    expect(r.documentoDifereDoBoleto).toBe(true);
    // O QUE ESTE TESTE COBRA: enquanto a chave não existir na prévia, ele passa
    // pelo parse. Quando existir, o util tem de preferir o campo do banco -- e
    // aí o regex sai de `historicoDaBaixa`.
  });
});

describe("o painel não reescreve o histórico e declara o limite", () => {
  // O motivo do motor e as evidências de hoje têm rótulos DIFERENTES. É o que
  // impede ler "nao ha registro de quem baixou" como ausência de rastro.
  it("motivo histórico e evidência atual são rotulados separadamente", () => {
    expect(ROTULO_MOTIVO_HISTORICO).toMatch(/motor registrou/);
    expect(ROTULO_EVIDENCIA_ATUAL).toMatch(/banco guarda hoje/);
    expect(ROTULO_MOTIVO_HISTORICO).not.toBe(ROTULO_EVIDENCIA_ATUAL);
  });

  it("o aviso diz, em palavras, que origem_baixa_ref não é preenchida", () => {
    expect(AVISO_ORIGEM_BAIXA_REF).toMatch(/não preenche origem_baixa_ref/i);
    expect(AVISO_ORIGEM_BAIXA_REF).toMatch(/continua como está/i);
  });

  // O motivo histórico é dado, não texto da tela: nada aqui pode reescrevê-lo.
  it("o motivo do motor passa intacto para a tela", () => {
    expect(PREVIA.motivo_da_pendencia).toMatch(/nao ha registro de quem baixou/);
  });
});
