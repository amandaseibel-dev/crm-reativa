// A fila deixou de ser "sem aluno" e virou "nao baixou". O que este teste
// protege e a consequencia disso na tela: linha com aluno JA identificado
// entra na fila, mas NAO pode oferecer "Vincular" -- vincular ali so daria a
// chance de sobrescrever um vinculo correto por boleto exato.
//
// O fixture sao as seis classes reais do arquivo Santander de 14/09/2026.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATUS_CONCILIACAO,
  SEM_ESTADO,
  estadoDaLinha,
  podeVincularAluno,
  contarPorStatus,
  acaoDaLinha,
  ACOES_DA_FILA,
  TRAVAS_AGUARDANDO_ACORDO,
  ENCERRAR_PENDENCIA_AVISO,
  podeEncerrarPendencia,
} from "./conciliacaoPagamento";

// Uma linha por classe apurada, com o que a RPC devolve para a tela.
const FILA = [
  { pagamento_id: "a", status_conciliacao: "AGUARDANDO_ACORDO", tem_aluno: false, valor_pago: 566.67 },
  { pagamento_id: "b", status_conciliacao: "AGUARDANDO_AMARRACAO", tem_aluno: true, valor_pago: 534.23 },
  { pagamento_id: "c", status_conciliacao: "PARCELA_JA_PAGA", tem_aluno: true, valor_pago: 228.87 },
  { pagamento_id: "d", status_conciliacao: "REVISAO", tem_aluno: true, valor_pago: 419.74 },
  { pagamento_id: "e", status_conciliacao: "SEM_VINCULO", tem_aluno: false, valor_pago: 80.36 },
  // linha anterior a 14/09: entrou sem a coluna e a tela nao pode inventar estado
  { pagamento_id: "f", status_conciliacao: null, tem_aluno: false, valor_pago: 12.5 },
];

describe("estado da linha", () => {
  it("cada um dos cinco estados pendentes tem rotulo proprio", () => {
    for (const chave of [
      "AGUARDANDO_ACORDO",
      "AGUARDANDO_AMARRACAO",
      "PARCELA_JA_PAGA",
      "REVISAO",
      "SEM_VINCULO",
    ]) {
      expect(STATUS_CONCILIACAO[chave].rotulo).toBeTruthy();
      expect(STATUS_CONCILIACAO[chave].explica).toBeTruthy();
    }
  });

  it("BAIXADO existe no vocabulario, mas nao e pendencia", () => {
    expect(STATUS_CONCILIACAO.BAIXADO.rotulo).toBe("Baixado");
  });

  it("linha anterior a regra nao ganha estado inventado", () => {
    expect(estadoDaLinha(FILA[5])).toBe(SEM_ESTADO);
    expect(estadoDaLinha({ status_conciliacao: "QUALQUER_COISA" })).toBe(SEM_ESTADO);
    expect(estadoDaLinha(undefined)).toBe(SEM_ESTADO);
  });

  it("traduz o estado gravado", () => {
    expect(estadoDaLinha(FILA[1]).rotulo).toBe("Aguardando amarração");
  });
});

describe("quem pode receber Vincular", () => {
  it("so as linhas sem aluno", () => {
    expect(FILA.filter(podeVincularAluno).map((l) => l.pagamento_id)).toEqual(["a", "e", "f"]);
  });

  it("as tres com aluno identificado nao oferecem vinculo", () => {
    for (const id of ["b", "c", "d"]) {
      const linha = FILA.find((l) => l.pagamento_id === id);
      expect(podeVincularAluno(linha)).toBe(false);
    }
  });

  it("a ausencia do campo nao libera vinculo por acidente", () => {
    expect(podeVincularAluno({ tem_aluno: undefined })).toBe(true);
    expect(podeVincularAluno({ tem_aluno: true })).toBe(false);
  });
});

describe("contagem por estado", () => {
  it("conta cada estado uma vez e agrupa o historico em SEM_ESTADO", () => {
    expect(contarPorStatus(FILA)).toEqual({
      AGUARDANDO_ACORDO: 1,
      AGUARDANDO_AMARRACAO: 1,
      PARCELA_JA_PAGA: 1,
      REVISAO: 1,
      SEM_VINCULO: 1,
      SEM_ESTADO: 1,
    });
  });

  it("lista vazia nao quebra", () => {
    expect(contarPorStatus([])).toEqual({});
    expect(contarPorStatus(null)).toEqual({});
  });
});

// 16/09/2026: a acao da linha corresponde ao ponto exato em que o pagamento
// travou. Aguardando acordo com aluno provado nao pode oferecer vincular.
describe("acaoDaLinha", () => {
  const aguardando = { pagamento_id: "x", status_conciliacao: "AGUARDANDO_ACORDO", tem_aluno: false };

  it("aluno provado e acordo à vista ausente: registrar, nunca vincular", () => {
    const a = acaoDaLinha(aguardando, { x: { pagamento_id: "x", trava: "ACORDO_AVISTA_AUSENTE" } });
    expect(a.rotulo).toBe("Aluno identificado · acordo não encontrado");
    expect(a.acao).toBe("REGISTRAR_ACORDO_AVISTA");
  });

  it("identidade sem prova dupla: vincular aluno", () => {
    expect(acaoDaLinha(aguardando, { x: { trava: "ALUNO_NAO_IDENTIFICADO" } }).acao).toBe("VINCULAR_ALUNO");
    expect(acaoDaLinha(aguardando, { x: { trava: "IDENTIDADE_DIVERGENTE" } }).acao).toBe("VINCULAR_ALUNO");
  });

  it("parcelado, rodada pendente e aluno sem prova dupla não têm ação manual", () => {
    for (const trava of ["ACORDO_PARCELADO_AUSENTE", "ACORDO_CHEGOU_AGUARDANDO_RODADA", "ALUNO_VINCULADO_SEM_PROVA_DUPLA",
      "ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA"]) {
      expect(acaoDaLinha(aguardando, { x: { trava } }).acao).toBeNull();
    }
  });

  it("sem diagnóstico (carregando ou falhou): nenhuma ação genérica", () => {
    expect(acaoDaLinha(aguardando, null).acao).toBeNull();
    // carregando não é diagnóstico: o rótulo diz que ainda está analisando
    expect(acaoDaLinha(aguardando, null).rotulo).toBe("Analisando pendência…");
    expect(acaoDaLinha(aguardando, null).carregando).toBe(true);
    expect(acaoDaLinha(aguardando, {}).carregando).toBeUndefined();
    expect(acaoDaLinha(aguardando, {}).acao).toBeNull();
    expect(acaoDaLinha(aguardando, { x: { trava: "DESCONHECIDA" } }).acao).toBeNull();
  });

  it("os outros estados seguem a regra anterior: vincular só sem aluno", () => {
    expect(acaoDaLinha({ status_conciliacao: "AGUARDANDO_AMARRACAO", tem_aluno: true }, {}).acao).toBeNull();
    expect(acaoDaLinha({ status_conciliacao: "SEM_VINCULO", tem_aluno: false }, {}).acao).toBe("VINCULAR_ALUNO");
  });

  it("toda trava com ação usa uma ação conhecida", () => {
    for (const def of Object.values(TRAVAS_AGUARDANDO_ACORDO)) {
      if (def.acao) expect(ACOES_DA_FILA[def.acao]).toBeTruthy();
      expect(def.rotulo).toBeTruthy();
      expect(def.explica).toBeTruthy();
    }
  });
});

// 17/09/2026: o banco so devolve ACORDO_AVISTA_AUSENTE quando a previa do
// registro aprova; recusada, devolve o motivo. A tela so traduz o codigo.
describe("a ação de registro só existe quando o banco diz que é registrável", () => {
  const aguardando = { pagamento_id: "x", status_conciliacao: "AGUARDANDO_ACORDO", tem_aluno: true };
  const RECUSADAS = {
    ACORDO_AVISTA_FORA_DA_MARGEM: "Aluno identificado · acordo não encontrado · valor fora da margem segura",
    ACORDO_AVISTA_ALUNO_ENCERRADO: "Aluno identificado · acordo não encontrado · aluno já encerrado",
    ACORDO_AVISTA_OPERADOR_NAO_CADASTRADO: "Aluno identificado · acordo não encontrado · operador do pagamento não cadastrado",
    ACORDO_AVISTA_SEM_MENSALIDADE_ELEGIVEL: "Aluno identificado · acordo não encontrado · nenhuma mensalidade elegível em aberto",
    ACORDO_AVISTA_SEM_COMBINACAO_SEGURA: "Aluno identificado · acordo não encontrado · sem combinação segura de mensalidades",
    ACORDO_AVISTA_OUTRO_BLOQUEIO: "Aluno identificado · acordo não encontrado · registro bloqueado pela simulação",
  };

  it("cada recusa da prévia tem rótulo próprio e nenhuma ação", () => {
    for (const [trava, rotulo] of Object.entries(RECUSADAS)) {
      const a = acaoDaLinha(aguardando, { x: { pagamento_id: "x", trava } });
      expect(a.rotulo).toBe(rotulo);
      expect(a.acao).toBeNull();
    }
  });

  it("Registrar acordo à vista pertence a uma trava só: a aprovada pela prévia", () => {
    const comRegistro = Object.entries(TRAVAS_AGUARDANDO_ACORDO)
      .filter(([, def]) => def.acao === "REGISTRAR_ACORDO_AVISTA").map(([k]) => k);
    expect(comRegistro).toEqual(["ACORDO_AVISTA_AUSENTE"]);
  });

  it("nenhuma regra financeira no front: a fila não compara valor, margem nem resultado da prévia", () => {
    const AQUI = dirname(fileURLToPath(import.meta.url));
    const semComentario = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const arquivo of ["./conciliacaoPagamento.js", "../pages/PagamentosSemAluno.jsx"]) {
      const codigo = semComentario(readFileSync(resolve(AQUI, arquivo), "utf8"));
      expect(codigo).not.toMatch(/1[.,]15/);
      expect(codigo).not.toMatch(/\baprovado\b|\bbloqueios\b|margem_segura|soma_minima|faixa_valor_pago/);
      expect(codigo).not.toMatch(/valor_pago\s*(\)|\|\|\s*0\))?\s*(<|>|\*|\/)/);
    }
  });
});

// 17/09/2026: a fila ganhou saida. Encerrar e decisao da gestao -- nao entra na
// lista de travas, nao vira acao tecnica e nao promete conserto financeiro.
describe("encerrar pendência é saída da gestão, não ação técnica", () => {
  it("cabe em qualquer pendência, menos em baixado e em linha anterior à regra", () => {
    expect(ACOES_DA_FILA.ENCERRAR_PENDENCIA).toBe("Encerrar pendência");
    for (const estado of ["AGUARDANDO_ACORDO", "AGUARDANDO_AMARRACAO", "PARCELA_JA_PAGA", "REVISAO", "SEM_VINCULO"]) {
      expect(podeEncerrarPendencia({ status_conciliacao: estado }), estado).toBe(true);
    }
    expect(podeEncerrarPendencia({ status_conciliacao: "BAIXADO" })).toBe(false);
    expect(podeEncerrarPendencia({})).toBe(false);
    expect(podeEncerrarPendencia(null)).toBe(false);
  });

  it("não substitui a ação técnica da linha", () => {
    const aguardando = { pagamento_id: "x", status_conciliacao: "AGUARDANDO_ACORDO", tem_aluno: true };
    expect(acaoDaLinha(aguardando, { x: { pagamento_id: "x", trava: "ACORDO_AVISTA_AUSENTE" } }).acao).toBe("REGISTRAR_ACORDO_AVISTA");
    expect(acaoDaLinha({ status_conciliacao: "PARCELA_JA_PAGA", tem_aluno: false }, {}).acao).toBe("VINCULAR_ALUNO");
    expect(Object.values(TRAVAS_AGUARDANDO_ACORDO).some((def) => def.acao === "ENCERRAR_PENDENCIA")).toBe(false);
  });

  it("o aviso diz, na tela, que nada financeiro muda", () => {
    expect(ENCERRAR_PENDENCIA_AVISO).toMatch(/Não baixa parcela/);
    expect(ENCERRAR_PENDENCIA_AVISO).toMatch(/não altera acordo, saldo nem mensalidade/i);
    expect(ENCERRAR_PENDENCIA_AVISO).toMatch(/para o reprocessamento/);
  });
});
