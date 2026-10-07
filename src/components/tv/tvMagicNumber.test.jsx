// @vitest-environment jsdom
//
// MAGIC NUMBER COM VALOR PRÓPRIO.
//
// Até 06/10/2026 o Magic Number era derivado, e de dois jeitos incompatíveis:
// esta tela fazia meta_empresa x 1,5 e o card 'magic' de snap.metas usava os
// honorários do mês anterior. Nenhum dos dois bate com o combinado da gestão —
// em outubro/2026 o piso é R$ 122.400,00 e o Magic é R$ 142.800,00, uma relação
// que nenhum fator fixo reproduz (x 1,5 daria R$ 183.600,00).
//
// O alvo agora vem de magic_number_mensal, mesclado no snapshot como snap.magic.
// Os casos abaixo existem para que ninguém reintroduza um múltiplo da meta.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const tela = () => CATALOGO_TELAS.find((t) => t.id === "magic_number");
const desenhar = (snap) => {
  const { Comp } = tela();
  return render(<Comp snap={snap} />);
};

// Outubro/2026 como a gestão definiu.
const OUTUBRO = {
  magic: { mes_referencia: "2026-10", valor: 142800 },
  mes: {
    honorarios: 70000,
    meta_empresa: 122400,
    dias_uteis_mes: 22,
    dias_uteis_transcorridos: 4,
    dias_uteis_restantes: 18,
    proj_honorarios: 385000,
  },
};
const snap = (extra = {}) => ({
  ...OUTUBRO,
  ...extra,
  magic: { ...OUTUBRO.magic, ...(extra.magic || {}) },
  mes: { ...OUTUBRO.mes, ...(extra.mes || {}) },
});

describe("TV — Magic Number (catálogo)", () => {
  it("é tela própria, ligada de fábrica, separada da Meta do Mês", () => {
    const t = tela();
    expect(t).toBeTruthy();
    expect(t.nome).toBe("Magic Number");
    expect(t.ativa).toBe(true);
    const ids = CATALOGO_TELAS.map((x) => x.id);
    expect(ids).toContain("meta_do_mes");
    expect(ids).toContain("magic_number");
  });

  it("temConteudo exige o valor cadastrado — a meta sozinha não libera o slide", () => {
    const { temConteudo } = tela();
    expect(temConteudo({ magic: { valor: 142800 } })).toBe(true);
    expect(temConteudo({ magic: { valor: 0 } })).toBe(false);
    expect(temConteudo({ magic: null })).toBe(false);
    // o caso que importa: meta cadastrada e Magic ausente NÃO mostra o slide
    expect(temConteudo({ mes: { meta_empresa: 122400 } })).toBe(false);
    expect(temConteudo({})).toBe(false);
  });
});

describe("TV — Magic Number (render)", () => {
  it("usa o valor cadastrado da competência, não um múltiplo da meta", () => {
    desenhar(snap());
    // "Magic Number" aparece duas vezes: título da tela e rótulo do rodapé.
    expect(screen.getAllByText("Magic Number").length).toBe(2);
    expect(screen.getByText(/R\$ 142\.800/)).toBeTruthy();
    // meta x 1,5 daria 183.600 — não pode aparecer em lugar nenhum
    expect(screen.queryByText(/R\$ 183\.600/)).toBeNull();
    expect(screen.queryByText(/150%/)).toBeNull();
    expect(screen.queryByText(/\+50%/)).toBeNull();
  });

  it("o alvo acompanha o cadastro, sem relação fixa com a meta", () => {
    // Mesma meta piso, Magic diferente: se houvesse fator, isto seria impossível.
    desenhar(snap({ magic: { valor: 200000 } }));
    expect(screen.getByText(/R\$ 200\.000/)).toBeTruthy();
    expect(screen.queryByText(/R\$ 142\.800/)).toBeNull();
  });

  it("o realizado é o MESMO da meta piso: mes.honorarios", () => {
    desenhar(snap());
    expect(screen.getByText("Realizado")).toBeTruthy();
    expect(screen.getByText("R$ 70.000")).toBeTruthy();
  });

  it("% é realizado sobre o Magic, não sobre a meta piso", () => {
    // 70.000 / 142.800 = 49,0%. Sobre o piso (122.400) daria 57% — o número
    // que a tela da meta mostra. Os dois não podem se confundir.
    desenhar(snap());
    expect(screen.getByText("49%")).toBeTruthy();
    expect(screen.queryByText("57%")).toBeNull();
    expect(screen.getByText(/do Magic Number/i)).toBeTruthy();
  });

  it("falta e ritmo saem do Magic e dos dias ÚTEIS restantes", () => {
    // falta = 142.800 - 70.000 = 72.800; por dia útil = 72.800 / 18 = 4.044
    desenhar(snap());
    expect(screen.getByText("Falta para o Magic")).toBeTruthy();
    expect(screen.getByText("R$ 72.800")).toBeTruthy();
    expect(screen.getByText("Dias úteis restantes")).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();
    expect(screen.getByText(/de 22 dias úteis no mês/)).toBeTruthy();
    expect(screen.getByText("R$ 4.044")).toBeTruthy();
  });

  it("rodapé mostra Magic e meta piso lado a lado, sem confundir os dois", () => {
    desenhar(snap());
    expect(screen.getAllByText("Magic Number").length).toBe(2);
    expect(screen.getByText("Meta do mês")).toBeTruthy();
    expect(screen.getByText(/R\$ 122\.400/)).toBeTruthy();
  });

  it("Magic batido: fala conquista em vez de pedir ritmo", () => {
    desenhar(snap({ mes: { honorarios: 150000 } }));
    expect(screen.getAllByText("Magic batido").length).toBe(2); // falta e por-dia
    expect(screen.getByText("105%")).toBeTruthy();              // passa de 100%
  });

  it("mês encerrado (zero dia útil restante) não inventa valor por dia", () => {
    desenhar(snap({ mes: { dias_uteis_restantes: 0 } }));
    expect(screen.getByText(/Sem dias úteis restantes/)).toBeTruthy();
  });

  it("competência sem Magic cadastrado avisa — nunca deriva da meta", () => {
    desenhar({ mes: { honorarios: 70000, meta_empresa: 122400 } });
    expect(screen.getByText(/não cadastrado/i)).toBeTruthy();
    expect(screen.queryByText(/R\$ 183\.600/)).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("snapshot sem a chave `magic` não derruba a tela", () => {
    expect(() => desenhar({})).not.toThrow();
    expect(screen.getByText(/não cadastrado/i)).toBeTruthy();
  });
});
