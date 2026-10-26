// AS REGRAS DO ENCAMINHAMENTO, sem montar componente.
//
// O que estes testes protegem: a tela nunca habilitar confirmação que o banco
// vai recusar, e nunca escrever sobre efeito financeiro algo que a função não
// faz. `impedimentoDoEncaminhamento` é a MESMA regra que o botão usa -- se ela
// divergir do que a função do banco aceita, é aqui que aparece.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import {
  ACOES_ENCAMINHAMENTO,
  ENCAMINHAMENTO_AVISO,
  MOTIVOS_RECUSA,
  RESULTADOS,
  impedimentoDoEncaminhamento,
  podeEncaminhar,
  rotuloRecusa,
  rotuloResultado,
  rotuloValidacao,
  textoDaConfirmacao,
  validacoesDaPrevia,
} from "./encaminhamentoConciliacao";

const moeda = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

// As duas ações que a triagem declara em produção hoje (medido em 26/10/2026).
const PREVIA_JA_PAGA = {
  ok: true,
  gravou: false,
  modo: "PREVIA",
  acao: "CONFERIR_E_ENCERRAR",
  subcategoria: "ja_paga_conferir_e_encerrar",
  motivo_da_pendencia: "a parcela 2 do boleto 50640530004 ja estava PAGO antes deste pagamento",
  aprovado: true,
  bloqueios: [],
  validacoes: [
    { codigo: "PENDENCIA_ABERTA_JA_PAGA", ok: true, detalhe: "estado: PARCELA_JA_PAGA" },
    { codigo: "BOLETO_NO_PADRAO", ok: true, detalhe: "boleto 50640530004" },
  ],
  pagamento: { id: "p1", valor_pago: 327.1 },
  passos: ["REGISTRAR_DECISAO_RESOLVIDO_AUTOMATICO", "MOVER_PARA_ENCERRADO_SEM_EFEITO_FINANCEIRO"],
  resultado_esperado: "PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO",
  efeito_financeiro: false,
};

const PREVIA_ESCOLHER = {
  ok: true,
  gravou: false,
  modo: "PREVIA",
  acao: "ESCOLHER_ALUNO",
  subcategoria: "escolher_aluno_sugerido",
  motivo_da_pendencia: "nome repetido: duas fichas com o mesmo nome",
  aprovado: true,
  bloqueios: [],
  sugestoes: [
    { aluno_id: "a1", aluno_nome: "MARIA DA SILVA", cpf: "00000000191" },
    { aluno_id: "a2", aluno_nome: "MARIA DA SILVA", cpf: "00000000272" },
  ],
  pagamento: { id: "p2", valor_pago: 559.0 },
  passos: ["VINCULAR_ALUNO_ESCOLHIDO"],
  resultado_esperado: "PAGAMENTO_VINCULADO_AO_ALUNO",
  efeito_financeiro: false,
};

describe("o vocabulário fecha com o que o banco devolve", () => {
  it("as duas ações implementadas são exatamente as que a triagem declara", () => {
    expect(Object.keys(ACOES_ENCAMINHAMENTO).sort()).toEqual([
      "CONFERIR_E_ENCERRAR",
      "ESCOLHER_ALUNO",
    ]);
  });

  // Se a função do banco ganhar um passo e este mapa não, a pessoa aprova
  // menos do que vai acontecer. O teste casa os dois lados.
  it("os passos de cada ação batem com os da prévia", () => {
    expect(ACOES_ENCAMINHAMENTO.CONFERIR_E_ENCERRAR.passos).toEqual(PREVIA_JA_PAGA.passos);
    expect(ACOES_ENCAMINHAMENTO.ESCOLHER_ALUNO.passos).toEqual(PREVIA_ESCOLHER.passos);
  });

  it("todo resultado esperado tem frase, e cada frase nega efeito financeiro", () => {
    for (const def of Object.values(ACOES_ENCAMINHAMENTO)) {
      expect(RESULTADOS[def.resultado]).toBeTruthy();
      // O aviso de cada ação precisa dizer, em palavras, o que ela NÃO faz.
      expect(def.aviso).toMatch(/Não dá baixa/);
      expect(def.aviso).toMatch(/não altera parcela, acordo, título nem saldo/);
    }
  });

  it("o aviso do painel nega baixa, quitação, reatribuição e alteração de valor", () => {
    expect(ENCAMINHAMENTO_AVISO).toMatch(/nenhuma destas ações dá baixa/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/quita/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/reatribui caso/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/altera valor/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/auditoria/);
  });

  // Código desconhecido não pode virar vazio na tela: vazio parece "sem
  // problema". Mesma decisão de `rotuloSubcategoria`.
  it("código desconhecido devolve algo verdadeiro, nunca vazio", () => {
    expect(rotuloValidacao("INVENTADO_AGORA")).toBe("INVENTADO_AGORA");
    expect(rotuloRecusa("INVENTADO_AGORA")).toMatch(/INVENTADO_AGORA/);
    expect(rotuloRecusa(null)).toMatch(/motivo não informado/);
    expect(rotuloResultado("INVENTADO_AGORA")).toBe("");
  });

  it("todo motivo de recusa tem frase em português", () => {
    for (const [codigo, frase] of Object.entries(MOTIVOS_RECUSA)) {
      expect(frase, codigo).toBeTruthy();
      expect(frase, codigo).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("quem ganha botão, e quem não ganha", () => {
  it("linha com ação implementada e sem decisão ganha botão", () => {
    expect(podeEncaminhar({ acao_sugerida: "CONFERIR_E_ENCERRAR", decisao: null })).toBe(true);
    expect(podeEncaminhar({ acao_sugerida: "ESCOLHER_ALUNO", decisao: null })).toBe(true);
  });

  it("linha sem ação declarada não ganha botão", () => {
    expect(podeEncaminhar({ acao_sugerida: null, subcategoria: "consulta_portador" })).toBe(false);
    expect(podeEncaminhar({})).toBe(false);
    expect(podeEncaminhar(null)).toBe(false);
  });

  // Os 33 decididos e ainda pendentes são caso do backfill da Etapa 1, com
  // autorização própria -- não desta porta.
  it("linha JÁ DECIDIDA não ganha botão, mesmo com ação declarada", () => {
    expect(
      podeEncaminhar({ acao_sugerida: "CONFERIR_E_ENCERRAR", decisao: "RESOLVIDO_AUTOMATICO" })
    ).toBe(false);
  });

  // A triagem pode ganhar uma ação nova antes da tela. Nesse caso a linha fica
  // sem botão, em vez de ganhar um que não faz nada.
  it("ação que a tela ainda não implementa não ganha botão", () => {
    expect(podeEncaminhar({ acao_sugerida: "CONSULTAR_PORTADOR", decisao: null })).toBe(false);
  });
});

describe("o botão de confirmar só habilita quando o banco vai aceitar", () => {
  it("prévia aprovada de já paga: confirma sem escolher aluno", () => {
    expect(impedimentoDoEncaminhamento({ previa: PREVIA_JA_PAGA })).toBeNull();
  });

  it("sem prévia carregada, não confirma", () => {
    expect(impedimentoDoEncaminhamento({})).toMatch(/Carregue a prévia/);
  });

  it("prévia recusada devolve a frase do motivo nomeado", () => {
    const r = impedimentoDoEncaminhamento({
      previa: { ok: false, motivo: "SEM_PENDENCIA_NA_TRIAGEM" },
    });
    expect(r).toBe(MOTIVOS_RECUSA.SEM_PENDENCIA_NA_TRIAGEM);
  });

  // Prévia não aprovada tem de dizer QUAIS validações faltaram, com rótulo --
  // "não aprovado" sozinho não deixa a pessoa agir.
  it("prévia não aprovada lista as validações que faltaram, traduzidas", () => {
    const r = impedimentoDoEncaminhamento({
      previa: {
        ...PREVIA_JA_PAGA,
        aprovado: false,
        bloqueios: ["UNICO_PAGAMENTO_DO_BOLETO", "SEM_BAIXA_DEVOLVIDA"],
      },
    });
    expect(r).toMatch(/É o único pagamento deste boleto/);
    expect(r).toMatch(/Nenhuma baixa devolvida na parcela/);
  });

  it("escolher aluno sem escolher ninguém não confirma", () => {
    expect(impedimentoDoEncaminhamento({ previa: PREVIA_ESCOLHER })).toBe(
      MOTIVOS_RECUSA.ALUNO_NAO_INFORMADO
    );
  });

  it("escolher aluno com uma das sugestões confirma", () => {
    expect(impedimentoDoEncaminhamento({ previa: PREVIA_ESCOLHER, alunoId: "a2" })).toBeNull();
  });

  // A MESMA regra que a função do banco aplica (`ALUNO_FORA_DAS_SUGESTOES`).
  // Aceitar id de fora transformaria a porta num vínculo livre, que é outra
  // ação, com outra tela.
  it("aluno fora das sugestões não confirma", () => {
    expect(impedimentoDoEncaminhamento({ previa: PREVIA_ESCOLHER, alunoId: "a9" })).toBe(
      MOTIVOS_RECUSA.ALUNO_FORA_DAS_SUGESTOES
    );
  });

  it("prévia sem sugestão nenhuma não confirma", () => {
    const r = impedimentoDoEncaminhamento({
      previa: { ...PREVIA_ESCOLHER, aprovado: false, bloqueios: ["SEM_SUGESTAO_DE_ALUNO"], sugestoes: [] },
    });
    expect(r).toBe(MOTIVOS_RECUSA.SEM_SUGESTAO_DE_ALUNO);
  });
});

describe("o que a pessoa lê antes de confirmar", () => {
  it("o texto de já paga diz o valor, o que faz e o que não faz", () => {
    const t = textoDaConfirmacao({ previa: PREVIA_JA_PAGA, moeda });
    expect(t).toMatch(/Encerrar a pendência/);
    expect(t).toMatch(/R\$ 327\.10/);
    expect(t).toMatch(/Não dá baixa/);
  });

  it("o texto de escolher aluno nomeia o aluno escolhido", () => {
    const t = textoDaConfirmacao({ previa: PREVIA_ESCOLHER, alunoNome: "MARIA DA SILVA", moeda });
    expect(t).toMatch(/Vincular o aluno escolhido ao aluno MARIA DA SILVA/);
    expect(t).toMatch(/Não dá baixa/);
  });

  it("ação desconhecida não produz texto de confirmação", () => {
    expect(textoDaConfirmacao({ previa: { acao: "INVENTADA" }, moeda })).toBe("");
  });

  it("as validações saem traduzidas, na ordem do banco", () => {
    const v = validacoesDaPrevia(PREVIA_JA_PAGA);
    expect(v.map((x) => x.rotulo)).toEqual([
      "Pendência aberta, em “parcela já paga”",
      "Boleto no padrão 5 + acordo + parcela",
    ]);
    expect(v[0].detalhe).toBe("estado: PARCELA_JA_PAGA");
  });

  // ESCOLHER_ALUNO não tem validações: a tela mostra as sugestões no lugar, e
  // não um quadro vazio com título.
  it("prévia sem validações devolve lista vazia", () => {
    expect(validacoesDaPrevia(PREVIA_ESCOLHER)).toEqual([]);
    expect(validacoesDaPrevia(null)).toEqual([]);
  });
});
