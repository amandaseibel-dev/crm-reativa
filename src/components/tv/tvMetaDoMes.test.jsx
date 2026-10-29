// @vitest-environment jsdom
//
// TELA DEDICADA "META DO MÊS".
//
// O ponto destes testes NÃO é conferir aritmética — é garantir que a tela só
// REPETE o que o snapshot já calculou. A meta vem de metas_projecao.meta_honorario
// e o realizado da soma dos honorários do mês, ambos montados em
// tv_snapshot_calcular(). Se alguém um dia recalcular algo aqui dentro, os casos
// "usa o número do snapshot, não recalcula" quebram.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const tela = () => CATALOGO_TELAS.find((t) => t.id === "meta_do_mes");
const desenhar = (snap) => {
  const { Comp } = tela();
  return render(<Comp snap={snap} />);
};

// Fatia `mes` como o snapshot entrega (campos de 20260811220000_tv_magic_number).
function mes(extra = {}) {
  return {
    recuperado: 980000,
    honorarios: 70000,
    meta_empresa: 122000,
    meta_pct: 57.4,
    meta_falta: 52000,
    meta_atingida: false,
    dias_uteis_mes: 22,
    dias_uteis_transcorridos: 4,
    dias_uteis_restantes: 18,
    necessidade_diaria: 2889,
    proj_honorarios: 385000,
    proj_honorarios_pct: 315.6,
    ...extra,
  };
}

describe("TV — tela Meta do Mês (catálogo)", () => {
  it("existe, está ligada de fábrica e entra no rodízio", () => {
    const t = tela();
    expect(t).toBeTruthy();
    expect(t.nome).toBe("Meta do Mês");
    expect(t.ativa).toBe(true);
    expect(t.grupo).toBe("operacao");
  });

  it("temConteudo só libera com meta cadastrada no mês", () => {
    const { temConteudo } = tela();
    expect(temConteudo({ mes: { meta_empresa: 122000 } })).toBe(true);
    expect(temConteudo({ mes: { meta_empresa: 0 } })).toBe(false);
    expect(temConteudo({ mes: {} })).toBe(false);
    expect(temConteudo({})).toBe(false);
  });
});

describe("TV — tela Meta do Mês (render)", () => {
  it("mostra o % do snapshot no centro do anel, sem recalcular", () => {
    // 57.4 vem pronto de mes.meta_pct. Se a tela fizesse realizado/meta com
    // estes números daria 57,37% -> arredondado também 57%, então o caso usa um
    // meta_pct deliberadamente DIFERENTE da divisão para provar a origem.
    desenhar({ mes: mes({ meta_pct: 61 }) });
    expect(screen.getByText("61%")).toBeTruthy();
    expect(screen.getByText(/da meta do mês/i)).toBeTruthy();
  });

  it("mostra realizado, falta, dias úteis restantes e necessário por dia útil", () => {
    desenhar({ mes: mes() });
    expect(screen.getByText("Realizado")).toBeTruthy();
    expect(screen.getByText("R$ 70.000")).toBeTruthy();

    expect(screen.getByText("Falta para a meta")).toBeTruthy();
    expect(screen.getByText("R$ 52.000")).toBeTruthy();

    expect(screen.getByText("Dias úteis restantes")).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();
    expect(screen.getByText(/de 22 dias úteis no mês/)).toBeTruthy();

    expect(screen.getByText("Necessário por dia útil")).toBeTruthy();
    expect(screen.getByText("R$ 2.889")).toBeTruthy();
  });

  it("usa dias ÚTEIS restantes do snapshot — nunca dias corridos", () => {
    // 18 dias úteis restantes num mês de 22; dias corridos seriam outro número.
    // A tela não tem acesso a calendário: só repete o campo.
    desenhar({ mes: mes({ dias_uteis_restantes: 7, dias_uteis_mes: 21 }) });
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/de 21 dias úteis no mês/)).toBeTruthy();
  });

  it("rodapé traz a meta piso da competência, direto do snapshot", () => {
    desenhar({ mes: mes({ meta_empresa: 122400 }) });
    expect(screen.getByText("Meta do mês")).toBeTruthy();
    expect(screen.getByText(/R\$ 122\.400/)).toBeTruthy();
  });

  it("a tela é SÓ da meta piso: nada de Magic Number nem de múltiplo da meta", () => {
    // A regra meta x 1,5 saiu em 06/10/2026. Com piso 122.400 ela produziria
    // 183.600; o Magic real de outubro é 142.800 e mora na tela própria.
    desenhar({ mes: mes({ meta_empresa: 122400 }) });
    expect(screen.queryByText(/Meta excelente/i)).toBeNull();
    expect(screen.queryByText(/Magic/i)).toBeNull();
    expect(screen.queryByText(/\+50%/)).toBeNull();
    expect(screen.queryByText(/R\$ 183\.600/)).toBeNull();
  });

  it("mostra a projeção de fechamento quando o snapshot a trouxe", () => {
    desenhar({ mes: mes() });
    expect(screen.getByText("Projeção de fechamento")).toBeTruthy();
    expect(screen.getByText(/R\$ 385\.000/)).toBeTruthy();
    expect(screen.getByText(/316% da meta/)).toBeTruthy();
  });

  it("sem projeção confiável no snapshot, o rodapé simplesmente não a cita", () => {
    desenhar({ mes: mes({ proj_honorarios: null, proj_honorarios_pct: null }) });
    expect(screen.queryByText("Projeção de fechamento")).toBeNull();
    expect(screen.getByText("Meta do mês")).toBeTruthy(); // o resto do rodapé fica
  });

  it("meta batida: fala conquista em vez de pedir ritmo", () => {
    desenhar({ mes: mes({ honorarios: 140000, meta_pct: 114.8, meta_falta: 0, meta_atingida: true, necessidade_diaria: null }) });
    expect(screen.getByText("115%")).toBeTruthy();           // passa de 100% sem travar (114,8 arredonda)
    expect(screen.getAllByText("Meta atingida").length).toBeGreaterThan(0);
  });

  it("mês encerrado (zero dia útil restante) não inventa valor por dia", () => {
    desenhar({ mes: mes({ dias_uteis_restantes: 0, necessidade_diaria: null }) });
    expect(screen.getByText(/Sem dias úteis restantes/)).toBeTruthy();
  });

  it("meta não cadastrada: avisa, não mostra 0%", () => {
    desenhar({ mes: { honorarios: 70000, meta_empresa: 0 } });
    expect(screen.getByText(/não cadastrada/i)).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("snapshot sem a chave `mes` não derruba a tela", () => {
    expect(() => desenhar({})).not.toThrow();
    expect(screen.getByText(/não cadastrada/i)).toBeTruthy();
  });
});
