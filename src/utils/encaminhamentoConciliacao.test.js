// AS REGRAS DO ENCAMINHAMENTO, sem montar componente.
//
// O que estes testes protegem: a tela nunca habilitar confirmação que o banco
// vai recusar, e nunca escrever sobre efeito financeiro algo que a função não
// faz. `impedimentoDoEncaminhamento` é a MESMA regra que o botão usa -- se ela
// divergir do que a função do banco aceita, é aqui que aparece.
//
// E, desde o corte de escopo de 26/10/2026, protegem uma coisa a mais: que
// `ESCOLHER_ALUNO` não tenha voltado. O bloco "o escopo é uma ação" falha se
// alguém reintroduzir a ação no vocabulário, e é de propósito que ele seja
// chato de contornar.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const moeda = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

// A única ação desta etapa (47 pagamentos, R$ 40.663,34, medido em 26/10/2026).
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

// A recusa que os 42 `escolher_aluno_sugerido` recebem desta interface.
const PREVIA_FORA_DO_ESCOPO = {
  ok: false,
  gravou: false,
  motivo: "ACAO_FORA_DO_ESCOPO_DESTA_ETAPA",
  acao: "ESCOLHER_ALUNO",
  subcategoria: "escolher_aluno_sugerido",
  motivo_da_pendencia: "NOME_REPETIDO: duas fichas com o mesmo nome",
};

describe("o escopo é UMA ação, e ESCOLHER_ALUNO não voltou", () => {
  it("o vocabulário tem exatamente uma ação", () => {
    expect(Object.keys(ACOES_ENCAMINHAMENTO)).toEqual(["CONFERIR_E_ENCERRAR"]);
  });

  // POR QUE ESTA REGRA EXISTE, para quem for mexer: a porta do ESCOLHER_ALUNO
  // seria `pagamento_vincular_aluno`, que chama
  // `pagamento_conciliar_um(.., true)` e PODE DAR BAIXA -- 154 de 212 vínculos
  // manuais terminaram em BAIXADO -- e 32 dos 42 casos já têm aluno vinculado,
  // contra a regra de 16/09/2026 (`podeVincularAluno`).
  it("nenhum artefato desta etapa tem CÓDIGO que vincule aluno", () => {
    // MENCIONAR no comentário é desejável -- é o que explica a decisão a quem
    // for mexer. O que não pode existir é CÓDIGO. Então a régua é sobre o
    // arquivo SEM os comentários: tirar a explicação da conta é o que torna
    // esta asserção uma prova em vez de uma proibição de falar no assunto.
    const semComentarios = (src) =>
      src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");

    const alvos = [
      ["util", semComentarios(ler("src/utils/encaminhamentoConciliacao.js"))],
      ["componente", semComentarios(ler("src/components/EncaminharPendencia.jsx"))],
    ];

    for (const [nome, src] of alvos) {
      expect(src, nome).not.toMatch(/pagamento_vincular_aluno/);
      expect(src, nome).not.toMatch(/p_aluno_id/);
      expect(src, nome).not.toMatch(/sugestoes/);
      expect(src, nome).not.toMatch(/exigeAluno/);
      expect(src, nome).not.toMatch(/alunoId/);
      // E a ação retirada não aparece como chave, string ou valor no código.
      expect(src, nome).not.toMatch(/ESCOLHER_ALUNO/);
    }
  });

  it("a ação retirada não ganha botão, nem que a triagem a declare", () => {
    expect(podeEncaminhar({ acao_sugerida: "ESCOLHER_ALUNO", decisao: null })).toBe(false);
  });

  it("a prévia fora do escopo não habilita confirmação, e tem frase própria", () => {
    expect(impedimentoDoEncaminhamento({ previa: PREVIA_FORA_DO_ESCOPO })).toBe(
      MOTIVOS_RECUSA.ACAO_FORA_DO_ESCOPO_DESTA_ETAPA
    );
    expect(MOTIVOS_RECUSA.ACAO_FORA_DO_ESCOPO_DESTA_ETAPA).toMatch(/esta tela não executa/);
  });

  it("não há texto de confirmação para a ação retirada", () => {
    expect(textoDaConfirmacao({ previa: { acao: "ESCOLHER_ALUNO" }, moeda })).toBe("");
  });
});

describe("o vocabulário fecha com o que o banco devolve", () => {
  // Se a função do banco ganhar um passo e este mapa não, a pessoa aprova
  // menos do que vai acontecer. O teste casa os dois lados.
  it("os passos da ação batem com os da prévia", () => {
    expect(ACOES_ENCAMINHAMENTO.CONFERIR_E_ENCERRAR.passos).toEqual(PREVIA_JA_PAGA.passos);
  });

  it("o resultado esperado tem frase, e o aviso nega efeito financeiro", () => {
    const def = ACOES_ENCAMINHAMENTO.CONFERIR_E_ENCERRAR;
    expect(RESULTADOS[def.resultado]).toBeTruthy();
    expect(def.aviso).toMatch(/Não dá baixa/);
    expect(def.aviso).toMatch(/não altera parcela, acordo, título nem saldo/);
  });

  it("o aviso do painel nega baixa, quitação, vínculo, reatribuição e valor", () => {
    expect(ENCAMINHAMENTO_AVISO).toMatch(/não dá baixa/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/não quita/);
    // O vínculo entra no aviso DEPOIS do corte de escopo: a pessoa precisa
    // saber que esta porta não é a de vincular aluno.
    expect(ENCAMINHAMENTO_AVISO).toMatch(/não vincula aluno/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/não reatribui caso/);
    expect(ENCAMINHAMENTO_AVISO).toMatch(/não altera valor/);
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
  it("linha com a ação desta etapa e sem decisão ganha botão", () => {
    expect(podeEncaminhar({ acao_sugerida: "CONFERIR_E_ENCERRAR", decisao: null })).toBe(true);
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

  it("ação futura que a triagem crie não ganha botão sozinha", () => {
    expect(podeEncaminhar({ acao_sugerida: "CONSULTAR_PORTADOR", decisao: null })).toBe(false);
  });
});

describe("o botão de confirmar só habilita quando o banco vai aceitar", () => {
  it("prévia aprovada confirma", () => {
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

  it("prévia não aprovada sem bloqueio nomeado ainda diz algo", () => {
    const r = impedimentoDoEncaminhamento({
      previa: { ...PREVIA_JA_PAGA, aprovado: false, bloqueios: [] },
    });
    expect(r).toMatch(/não aprovou/);
  });
});

describe("o que a pessoa lê antes de confirmar", () => {
  it("o texto diz o valor, o que faz e o que não faz", () => {
    const t = textoDaConfirmacao({ previa: PREVIA_JA_PAGA, moeda });
    expect(t).toMatch(/Encerrar a pendência/);
    expect(t).toMatch(/R\$ 327\.10/);
    expect(t).toMatch(/Não dá baixa/);
  });

  it("as validações saem traduzidas, na ordem do banco", () => {
    const v = validacoesDaPrevia(PREVIA_JA_PAGA);
    expect(v.map((x) => x.rotulo)).toEqual([
      "Pendência aberta, em “parcela já paga”",
      "Boleto no padrão 5 + acordo + parcela",
    ]);
    expect(v[0].detalhe).toBe("estado: PARCELA_JA_PAGA");
  });

  it("prévia sem validações devolve lista vazia", () => {
    expect(validacoesDaPrevia(null)).toEqual([]);
    expect(validacoesDaPrevia({})).toEqual([]);
  });
});
