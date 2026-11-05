// @vitest-environment jsdom
//
// CRM — "Aguardando fechamento do primeiro dia útil" na Projeção Hora a Hora
//
// A regra da gestão (04/11/2026) projeta só por dias úteis encerrados:
// numerador e divisor cobrem o mesmo período, de 1º do mês até ontem. No 1º dia
// útil não existe dia fechado, então não existe projeção — e a tela diz isso em
// vez de mostrar um número sem lastro.
//
// O componente NÃO decide nada: ele só obedece
// `projecao_aguardando_fechamento`, que vem pronto do snapshot
// (projecao_calcular_filial / projecao_calcular_operador). Nenhuma conta de
// projeção foi trazida para o navegador.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// A página importa o cliente do Supabase no topo; o teste só quer o aviso.
vi.mock("../services/supabase", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));

const { AguardandoFechamento } = await import("./ProjecaoHoraHora.jsx");

afterEach(cleanup);

describe("AguardandoFechamento", () => {
  it("diz exatamente o que a gestão pediu", () => {
    render(<AguardandoFechamento />);
    expect(screen.getByText("Aguardando fechamento do primeiro dia útil")).toBeTruthy();
  });

  it("explica no title por que não há projeção ainda", () => {
    render(<AguardandoFechamento />);
    const alvo = screen.getByText("Aguardando fechamento do primeiro dia útil");
    expect(alvo.getAttribute("title")).toMatch(/apenas dias úteis já encerrados/);
    expect(alvo.getAttribute("title")).toMatch(/entra na projeção quando o dia fechar/);
  });

  it("não deriva nada de data nem de dias úteis: quem decide é o banco", () => {
    // Se um dia alguém trocar isso por um cálculo local, este caso cai.
    expect(String(AguardandoFechamento)).not.toMatch(/Date|dias_uteis|getMonth|projecao_honorario/);
  });

  it("não tem props: o estado vem de quem renderiza, lendo o payload", () => {
    expect(AguardandoFechamento.length).toBe(0);
  });
});
