// Triagem da fila de pagamentos — a logica da faixa.
//
// A base destes testes e a MESMA particao medida em producao em 22/10/2026 e
// declarada em supabase/tests/fixtures/fila_pagamento_triagem_referencia.sql:
// 448 pendencias, R$ 377.515,27. Aqui ela entra reduzida em quantidade de
// linhas, mas com as contagens e os valores de cada categoria intactos -- e o
// fechamento e conferido contra os mesmos totais do teste de banco.
import { describe, it, expect } from "vitest";
import {
  CATEGORIAS,
  resumoPorCategoria,
  totalDaTriagem,
  indexarTriagem,
  pendenciasSoNaTriagem,
  filtrarPorCategoria,
  rotuloSubcategoria,
} from "./filaPagamentoTriagem";

// A particao de producao, subcategoria por subcategoria.
const PARTICAO = [
  ["ACIONAVEL_ADMINISTRATIVO", "ja_paga_conferir_e_encerrar", 45, 40261.1, null],
  ["ACIONAVEL_ADMINISTRATIVO", "escolher_aluno_sugerido", 42, 23469.07, null],
  ["AGUARDANDO_INFORMACAO_ACORDO", "acordo_ausente_no_crm", 22, 27564.25, null],
  ["BLOQUEADO_ETAPA_DESATIVADA", "consulta_portador", 265, 186318.47, "consulta_portador"],
  ["CONFERENCIA_HUMANA", "decidida_mas_ainda_pendente", 33, 83203.3, null],
  ["CONFERENCIA_HUMANA", "acordo_sem_parcela_livre", 23, 3894.14, null],
  ["CONFERENCIA_HUMANA", "parcela_paga_antes_da_extracao", 7, 3107.08, null],
  ["CONFERENCIA_HUMANA", "acordo_cancelado_fluxo_proprio", 7, 4511.23, null],
  ["CONFERENCIA_HUMANA", "boleto_reemitido_vencimento_anterior", 3, 2196.08, null],
  ["CONFERENCIA_HUMANA", "valor_fora_da_faixa", 1, 2990.55, null],
];

// Gera as linhas com valores que somam EXATAMENTE o total de cada subcategoria,
// pelo mesmo metodo da base de referencia: divisao inteira em centavos e o resto
// na primeira linha.
function baseDeReferencia() {
  const linhas = [];
  let n = 0;
  for (const [categoria, subcategoria, qtd, total, etapa] of PARTICAO) {
    const cent = Math.round(total * 100);
    const base = Math.floor(cent / qtd);
    const resto = cent - base * qtd;
    for (let i = 0; i < qtd; i += 1) {
      n += 1;
      linhas.push({
        pagamento_id: `pag-${n}`,
        categoria,
        subcategoria,
        etapa_desligada: etapa,
        valor_pago: (base + (i === 0 ? resto : 0)) / 100,
        decisao: subcategoria === "decidida_mas_ainda_pendente" ? "RESOLVIDO_AUTOMATICO" : null,
        acao_sugerida:
          subcategoria === "escolher_aluno_sugerido"
            ? "ESCOLHER_ALUNO"
            : subcategoria === "ja_paga_conferir_e_encerrar"
              ? "CONFERIR_E_ENCERRAR"
              : null,
      });
    }
  }
  return linhas;
}

const cent = (v) => Math.round(v * 100);

describe("fechamento da triagem", () => {
  it("a base de referencia soma 448 pendencias e R$ 377.515,27", () => {
    const t = totalDaTriagem(baseDeReferencia());
    expect(t.quantidade).toBe(448);
    expect(cent(t.valor)).toBe(cent(377515.27));
  });

  it("as quatro categorias fecham na contagem e no valor", () => {
    const resumo = resumoPorCategoria(baseDeReferencia());
    expect(resumo.map((r) => r.categoria)).toEqual([
      "ACIONAVEL_ADMINISTRATIVO",
      "AGUARDANDO_INFORMACAO_ACORDO",
      "BLOQUEADO_ETAPA_DESATIVADA",
      "CONFERENCIA_HUMANA",
    ]);
    expect(resumo.map((r) => r.quantidade)).toEqual([87, 22, 265, 74]);
    expect(resumo.map((r) => cent(r.valor))).toEqual([
      cent(63730.17),
      cent(27564.25),
      cent(186318.47),
      cent(99902.38),
    ]);
    // A soma das categorias e o total: a faixa nao pode perder nem inventar.
    expect(resumo.reduce((s, r) => s + r.quantidade, 0)).toBe(448);
    expect(resumo.reduce((s, r) => s + cent(r.valor), 0)).toBe(cent(377515.27));
  });

  it("a ordem e a de trabalho, nao a alfabetica", () => {
    const ordens = resumoPorCategoria(baseDeReferencia()).map(
      (r) => CATEGORIAS[r.categoria].ordem,
    );
    expect(ordens).toEqual([1, 2, 3, 4]);
  });

  it("devolve as quatro categorias mesmo quando uma esta vazia", () => {
    const soBloqueadas = baseDeReferencia().filter(
      (l) => l.categoria === "BLOQUEADO_ETAPA_DESATIVADA",
    );
    const resumo = resumoPorCategoria(soBloqueadas);
    expect(resumo.length).toBe(4);
    expect(resumo.find((r) => r.categoria === "ACIONAVEL_ADMINISTRATIVO").quantidade).toBe(0);
  });

  it("nomeia a etapa desligada quando a categoria inteira aponta para a mesma", () => {
    const resumo = resumoPorCategoria(baseDeReferencia());
    expect(resumo.find((r) => r.categoria === "BLOQUEADO_ETAPA_DESATIVADA").etapa).toBe(
      "consulta_portador",
    );
    expect(resumo.find((r) => r.categoria === "CONFERENCIA_HUMANA").etapa).toBeNull();
  });

  it("os submotivos vem do maior volume de dinheiro para o menor", () => {
    const conf = resumoPorCategoria(baseDeReferencia()).find(
      (r) => r.categoria === "CONFERENCIA_HUMANA",
    );
    expect(conf.submotivos.map((s) => s.subcategoria)).toEqual([
      "decidida_mas_ainda_pendente",
      "acordo_cancelado_fluxo_proprio",
      "acordo_sem_parcela_livre",
      "parcela_paga_antes_da_extracao",
      "valor_fora_da_faixa",
      "boleto_reemitido_vencimento_anterior",
    ]);
    expect(conf.submotivos.reduce((s, x) => s + x.quantidade, 0)).toBe(74);
  });

  it("triagem vazia ou nula nao quebra a faixa", () => {
    for (const entrada of [null, undefined, []]) {
      expect(resumoPorCategoria(entrada).length).toBe(4);
      expect(totalDaTriagem(entrada).quantidade).toBe(0);
    }
  });
});

describe("as pendencias que a lista principal nao mostra", () => {
  it("as 33 com decisao registrada voltam para a conferencia", () => {
    const triagem = baseDeReferencia();
    // A lista principal vem de `pagamentos_sem_aluno`, que exclui quem tem
    // decisao: aqui ela e simulada exatamente assim.
    const linhas = triagem
      .filter((t) => t.decisao === null)
      .map((t) => ({ pagamento_id: t.pagamento_id, valor_pago: t.valor_pago }));

    const fora = pendenciasSoNaTriagem(triagem, linhas);
    expect(fora.length).toBe(33);
    expect(cent(fora.reduce((s, l) => s + l.valor_pago, 0))).toBe(cent(83203.3));
    expect(fora.every((l) => l.subcategoria === "decidida_mas_ainda_pendente")).toBe(true);
  });

  it("vem do maior valor para o menor: quem confere comeca pelo que pesa", () => {
    const triagem = baseDeReferencia();
    const fora = pendenciasSoNaTriagem(triagem, []);
    const valores = fora.map((l) => l.valor_pago);
    expect([...valores].sort((a, b) => b - a)).toEqual(valores);
  });

  it("lista completa -> nada sobra fora dela", () => {
    const triagem = baseDeReferencia();
    const linhas = triagem.map((t) => ({ pagamento_id: t.pagamento_id }));
    expect(pendenciasSoNaTriagem(triagem, linhas).length).toBe(0);
  });
});

describe("o filtro da faixa", () => {
  const triagem = baseDeReferencia();
  const mapa = indexarTriagem(triagem);
  const linhas = triagem.map((t) => ({ pagamento_id: t.pagamento_id, valor_pago: t.valor_pago }));

  it("TODAS devolve tudo", () => {
    expect(filtrarPorCategoria(linhas, mapa, "TODAS").length).toBe(448);
    expect(filtrarPorCategoria(linhas, mapa, null).length).toBe(448);
  });

  it("cada categoria devolve a sua contagem", () => {
    expect(filtrarPorCategoria(linhas, mapa, "ACIONAVEL_ADMINISTRATIVO").length).toBe(87);
    expect(filtrarPorCategoria(linhas, mapa, "BLOQUEADO_ETAPA_DESATIVADA").length).toBe(265);
    expect(filtrarPorCategoria(linhas, mapa, "CONFERENCIA_HUMANA").length).toBe(74);
    expect(filtrarPorCategoria(linhas, mapa, "AGUARDANDO_INFORMACAO_ACORDO").length).toBe(22);
  });

  it("pagamento fora da triagem segue visivel em TODAS -- nao se esconde por falta de dado", () => {
    const comOrfao = [...linhas, { pagamento_id: "sem-triagem", valor_pago: 10 }];
    expect(filtrarPorCategoria(comOrfao, mapa, "TODAS").length).toBe(449);
    expect(filtrarPorCategoria(comOrfao, mapa, "CONFERENCIA_HUMANA").length).toBe(74);
  });

  it("triagem indisponivel: o filtro por categoria nao apaga a fila em TODAS", () => {
    const vazio = indexarTriagem([]);
    expect(filtrarPorCategoria(linhas, vazio, "TODAS").length).toBe(448);
    expect(filtrarPorCategoria(linhas, vazio, "ACIONAVEL_ADMINISTRATIVO").length).toBe(0);
  });
});

describe("rotulos", () => {
  it("submotivo conhecido vira texto legivel", () => {
    expect(rotuloSubcategoria("consulta_portador")).toMatch(/desligada/i);
    expect(rotuloSubcategoria("decidida_mas_ainda_pendente")).toMatch(/continua pendente/i);
  });

  it("submotivo desconhecido devolve o proprio codigo, nunca vazio", () => {
    expect(rotuloSubcategoria("algo_novo_do_motor")).toBe("algo_novo_do_motor");
    expect(rotuloSubcategoria(null)).toBe("—");
  });

  it("toda subcategoria da particao tem rotulo proprio", () => {
    for (const [, sub] of PARTICAO.map((p) => [p[0], p[1]])) {
      expect(rotuloSubcategoria(sub)).not.toBe(sub);
    }
  });
});
