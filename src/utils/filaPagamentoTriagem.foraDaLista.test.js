// O BLOCO "fora da lista acima" — o recorte, a contagem e quem ganha botão.
//
// O DEFEITO QUE ESTES TESTES FECHAM, medido em produção em 27/10/2026:
// `pagamentos_sem_aluno` leva 13,2 s e o `statement_timeout` de `authenticated`
// é de 8 s. A RPC estoura, a lista principal fica vazia, e as 470 pendências
// inteiras caem neste bloco — que até então (a) afirmava no título que todas
// tinham "decisão registrada", quando só 33 tinham, e (b) não oferecia ação
// nenhuma, deixando sem botão os 89 casos que a triagem declara acionáveis.
//
// O que se protege aqui: o título não afirmar decisão que não existe, o bloco
// respeitar a faixa de categoria, e o encaminhamento aparecer exatamente para
// quem a triagem declarou elegível — nem mais, nem menos.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import { recorteForaDaLista } from "./filaPagamentoTriagem";
import { podeEncaminhar } from "./encaminhamentoConciliacao";

// Uma pendência da triagem, como a view a devolve.
const linha = (over = {}) => ({
  pagamento_id: over.id || "p1",
  valor_pago: 100,
  categoria: "CONFERENCIA_HUMANA",
  subcategoria: "decidida_mas_ainda_pendente",
  acao_sugerida: null,
  decisao: null,
  ...over,
});

// O caso acionável: a triagem declara CONFERIR_E_ENCERRAR e não há decisão.
const acionavel = (over = {}) =>
  linha({
    categoria: "ACIONAVEL_ADMINISTRATIVO",
    subcategoria: "ja_paga_conferir_e_encerrar",
    acao_sugerida: "CONFERIR_E_ENCERRAR",
    decisao: null,
    ...over,
  });

describe("o recorte respeita a faixa de categoria", () => {
  const itens = [
    acionavel({ id: "a1", valor_pago: 126.18 }),
    acionavel({ id: "a2", valor_pago: 200 }),
    linha({ id: "c1", valor_pago: 50, decisao: "RESOLVIDO_AUTOMATICO" }),
    linha({ id: "b1", valor_pago: 10, categoria: "BLOQUEADO_ETAPA_DESATIVADA" }),
  ];

  it("TODAS devolve tudo", () => {
    const r = recorteForaDaLista(itens, "TODAS");
    expect(r.quantidade).toBe(4);
    expect(r.valor).toBeCloseTo(386.18, 2);
  });

  it("categoria ausente também não filtra", () => {
    expect(recorteForaDaLista(itens, null).quantidade).toBe(4);
    expect(recorteForaDaLista(itens, undefined).quantidade).toBe(4);
  });

  // ERA O DEFEITO: o bloco só aparecia em TODAS e CONFERENCIA_HUMANA, então
  // quem clicava em "Acionável agora" para achar os casos com ação via nada.
  it("a faixa ACIONÁVEL AGORA traz os acionáveis", () => {
    const r = recorteForaDaLista(itens, "ACIONAVEL_ADMINISTRATIVO");
    expect(r.quantidade).toBe(2);
    expect(r.itens.map((l) => l.pagamento_id)).toEqual(["a1", "a2"]);
    expect(r.valor).toBeCloseTo(326.18, 2);
  });

  it("uma faixa sem itens devolve vazio, e o bloco some", () => {
    const r = recorteForaDaLista(itens, "AGUARDANDO_INFORMACAO_ACORDO");
    expect(r.quantidade).toBe(0);
    expect(r.itens).toEqual([]);
    expect(r.valor).toBe(0);
  });
});

describe("a contagem de decisão não afirma o que não mediu", () => {
  // O caso que motivou a correção: a lista principal vazia derruba TUDO aqui,
  // e quase nada tem decisão. O título não pode dizer que tem.
  it("470 pendências sem decisão contam ZERO com decisão", () => {
    const muitas = Array.from({ length: 470 }, (_, i) => acionavel({ id: `p${i}` }));
    const r = recorteForaDaLista(muitas, "TODAS");
    expect(r.quantidade).toBe(470);
    expect(r.comDecisao).toBe(0);
  });

  it("conta só quem tem decisão de verdade", () => {
    const r = recorteForaDaLista(
      [
        linha({ id: "d1", decisao: "FEITO" }),
        linha({ id: "d2", decisao: "RESOLVIDO_AUTOMATICO" }),
        acionavel({ id: "s1" }),
        linha({ id: "s2", decisao: "" }),
      ],
      "TODAS",
    );
    expect(r.quantidade).toBe(4);
    expect(r.comDecisao).toBe(2);
  });

  it("os 33 decididos continuam contados, quando são o que há", () => {
    const trinta3 = Array.from({ length: 33 }, (_, i) =>
      linha({ id: `x${i}`, decisao: "RESOLVIDO_AUTOMATICO", valor_pago: 2521.31 }),
    );
    const r = recorteForaDaLista(trinta3, "TODAS");
    expect(r.comDecisao).toBe(33);
    expect(r.quantidade).toBe(33);
  });
});

describe("entrada imprestável não derruba a tela", () => {
  it("nulo, vazio e itens nulos", () => {
    expect(recorteForaDaLista(null, "TODAS").quantidade).toBe(0);
    expect(recorteForaDaLista([], "TODAS").quantidade).toBe(0);
    expect(recorteForaDaLista([null, undefined], "TODAS").quantidade).toBe(0);
  });

  it("valor não numérico não vira NaN na soma", () => {
    const r = recorteForaDaLista(
      [linha({ id: "n1", valor_pago: null }), linha({ id: "n2", valor_pago: 10 })],
      "TODAS",
    );
    expect(Number.isFinite(r.valor)).toBe(true);
    expect(r.valor).toBe(10);
  });
});

describe("quem ganha o botão dentro do bloco", () => {
  // A regra é a MESMA do encaminhamento — o bloco não inventa elegibilidade.
  it("o acionável sem decisão ganha botão", () => {
    expect(podeEncaminhar(acionavel())).toBe(true);
  });

  it("o decidido não ganha botão, mesmo aparecendo no bloco", () => {
    const r = recorteForaDaLista([linha({ decisao: "RESOLVIDO_AUTOMATICO" })], "TODAS");
    expect(r.quantidade).toBe(1);
    expect(podeEncaminhar(r.itens[0])).toBe(false);
  });

  it("sem ação declarada não ganha botão", () => {
    expect(podeEncaminhar(linha({ subcategoria: "consulta_portador" }))).toBe(false);
  });

  // ESCOLHER_ALUNO saiu do escopo da Etapa 2 em 26/10/2026 e não pode voltar
  // por este caminho: aparece no bloco, sem botão.
  it("ESCOLHER_ALUNO aparece no bloco e continua sem botão", () => {
    const l = linha({
      categoria: "ACIONAVEL_ADMINISTRATIVO",
      subcategoria: "escolher_aluno_sugerido",
      acao_sugerida: "ESCOLHER_ALUNO",
    });
    const r = recorteForaDaLista([l], "ACIONAVEL_ADMINISTRATIVO");
    expect(r.quantidade).toBe(1);
    expect(podeEncaminhar(r.itens[0])).toBe(false);
  });

  it("numa faixa mista, só os elegíveis ganham botão", () => {
    const r = recorteForaDaLista(
      [
        acionavel({ id: "ok1" }),
        linha({ id: "nao1", categoria: "ACIONAVEL_ADMINISTRATIVO", acao_sugerida: "ESCOLHER_ALUNO" }),
        linha({ id: "nao2", categoria: "ACIONAVEL_ADMINISTRATIVO", decisao: "FEITO",
                acao_sugerida: "CONFERIR_E_ENCERRAR" }),
      ],
      "ACIONAVEL_ADMINISTRATIVO",
    );
    expect(r.itens.filter(podeEncaminhar).map((l) => l.pagamento_id)).toEqual(["ok1"]);
  });
});
