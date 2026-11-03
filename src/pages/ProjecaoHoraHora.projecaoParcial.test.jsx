// @vitest-environment jsdom
//
// CRM — SELO "PROJEÇÃO PARCIAL" na Projeção Hora a Hora
//
// A regra da gestão (03/11/2026) faz a projeção existir desde o 1º dia útil,
// com o dia corrente dentro da base do ritmo. Enquanto esse dia não fecha, o
// número é parcial e precisa estar escrito na tela — o mesmo selo aparece na
// visão da gestão, na da diretoria e no rodapé do operador.
//
// O selo NÃO decide nada: ele só obedece `projecao_parcial`, que vem pronto do
// snapshot (projecao_calcular_filial / projecao_calcular_operador). Nenhuma
// conta de projeção foi trazida para o navegador.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// A página importa o cliente do Supabase no topo; o teste só quer o selo.
vi.mock("../services/supabase", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));

const { SeloProjecaoParcial } = await import("./ProjecaoHoraHora.jsx");

afterEach(cleanup);

describe("SeloProjecaoParcial", () => {
  it("aparece quando o snapshot diz que a projeção é parcial", () => {
    render(<SeloProjecaoParcial parcial={true} />);
    expect(screen.getByText("PROJEÇÃO PARCIAL")).toBeTruthy();
  });

  it("explica no title por que o número ainda vai mexer", () => {
    render(<SeloProjecaoParcial parcial={true} />);
    expect(screen.getByText("PROJEÇÃO PARCIAL").getAttribute("title"))
      .toMatch(/dia ainda está em andamento/);
  });

  it("não aparece com o dia fechado — feriado, fim de semana ou mês encerrado", () => {
    render(<SeloProjecaoParcial parcial={false} />);
    expect(screen.queryByText("PROJEÇÃO PARCIAL")).toBeNull();
  });

  it("snapshot antigo, sem o campo, não ganha selo", () => {
    render(<SeloProjecaoParcial parcial={undefined} />);
    expect(screen.queryByText("PROJEÇÃO PARCIAL")).toBeNull();
  });

  it("não deriva nada de data nem de dias úteis: só do campo recebido", () => {
    // Se um dia alguém trocar a prop por um cálculo local, este caso cai.
    expect(SeloProjecaoParcial.length).toBe(1);
    expect(String(SeloProjecaoParcial)).not.toMatch(/Date|dias_uteis|getMonth/);
  });
});
