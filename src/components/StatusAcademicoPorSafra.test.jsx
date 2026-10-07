// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import StatusAcademicoPorSafra from "./StatusAcademicoPorSafra";

// Números INVENTADOS. Rótulo não é dado de aluno e fica o da base — é ele que o
// card tem de casar entre safras. Contagem, título e saldo reais de produção não
// entram em arquivo versionado.
//
// Os valores exercitam o card de propósito: categoria que só existe numa safra,
// fatia minúscula, cobertura incompleta grande em 2024 e pequena em 2025, e
// totais fáceis de conferir de cabeça (saldo de cada safra soma 1.000,00).
const L = (situacao, alunos, titulos, saldo, pct) => ({ situacao, alunos, titulos, saldo, pct });
const FONTE = { fonte: "Relatório de inadimplência (importação)", atualizado_em: "2026-08-04T15:21:17Z" };
const FOTO = { gerado_em: "2026-10-07T13:00:00Z", duracao_ms: 900 };

const S2024 = {
  recorte: "2024",
  total: { alunos: 100, titulos: 400, saldo: 1000.0 },
  linhas: [
    L("(sem situação importada)", 50, 200, 530.0, 53.0),
    L("Término do Contrato", 30, 120, 300.0, 30.0),
    L("Entrada via Reabertura", 20, 80, 170.0, 17.0),
  ],
  fonte_academica: FONTE, snapshot: FOTO, conferencia: { saldo: 1000.0, alunos: 100, titulos: 400 },
};

const S2025 = {
  recorte: "2025",
  total: { alunos: 200, titulos: 810, saldo: 1000.0 },
  linhas: [
    L("Término do Contrato", 150, 610, 700.0, 70.0),
    L("Matriculado Curso Normal", 30, 120, 250.0, 25.0),
    L("Aguardando Matrícula", 19, 79, 49.98, 5.0),
    L("(sem situação importada)", 1, 1, 0.02, 0.002),
  ],
  fonte_academica: FONTE, snapshot: FOTO, conferencia: { saldo: 1000.0, alunos: 200, titulos: 810 },
};

const S2026 = {
  recorte: "2026/1",
  total: { alunos: 300, titulos: 900, saldo: 1000.0 },
  linhas: [
    L("Aguardando Matrícula", 250, 750, 800.0, 80.0),
    L("Término do Contrato", 50, 150, 200.0, 20.0),
  ],
  fonte_academica: FONTE, snapshot: FOTO, conferencia: null,
};

function responder(safras = [S2024, S2025, S2026]) {
  rpcMock.mockImplementation((nome) => {
    if (nome !== "carteira_academico_saldo_ler") return Promise.resolve({ data: null, error: null });
    return Promise.resolve({ data: { lido_em: "2026-10-07T13:05:00Z", safras }, error: null });
  });
}

async function montar() {
  await act(async () => { render(<StatusAcademicoPorSafra />); });
}

const linhaDe = (nome) => screen.getByText(nome).closest("tr");

beforeEach(() => { rpcMock.mockReset(); responder(); });
afterEach(() => cleanup());

describe("as quatro métricas por status", () => {
  it("UMA chamada só, sem reconstruir o universo", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe("carteira_academico_saldo_ler");
    const chamadas = rpcMock.mock.calls.map((c) => c[0]);
    expect(chamadas).not.toContain("carteira_academico_universo");
    expect(chamadas).not.toContain("carteira_academico_perfil");
  });

  it("mostra alunos, títulos, saldo e % de cada status, por safra", async () => {
    await montar();
    // Término do Contrato existe nas três: 2024, 2025 e 2026/1 em sequência
    const celulas = within(linhaDe("Término do Contrato")).getAllByRole("cell")
      .map((c) => c.textContent);
    expect(celulas).toEqual([
      "Término do Contrato",
      "30", "120", "300,00", "30,00%",
      "150", "610", "700,00", "70,00%",
      "50", "150", "200,00", "20,00%",
    ]);
  });

  it("categoria que não existe na safra aparece '—', nunca somada a outra", async () => {
    await montar();
    const celulas = within(linhaDe("Entrada via Reabertura")).getAllByRole("cell")
      .map((c) => c.textContent);
    // existe só em 2024; as outras oito células são travessão
    expect(celulas.slice(1, 5)).toEqual(["20", "80", "170,00", "17,00%"]);
    expect(celulas.slice(5)).toEqual(Array(8).fill("—"));
  });

  it("Matriculado Curso Normal e Aguardando Matrícula são linhas separadas", async () => {
    await montar();
    expect(linhaDe("Matriculado Curso Normal")).not.toBe(linhaDe("Aguardando Matrícula"));
    expect(within(linhaDe("Matriculado Curso Normal")).getAllByRole("cell")[5].textContent).toBe("30");
    expect(within(linhaDe("Aguardando Matrícula")).getAllByRole("cell")[5].textContent).toBe("19");
  });

  it("fatia diminuta não vira 0,00%", async () => {
    await montar();
    const celulas = within(linhaDe("(sem situação importada)")).getAllByRole("cell")
      .map((c) => c.textContent);
    expect(celulas[8]).toBe("<0,1%"); // 2025: 0,002%
  });
});

describe("fechamento dos totais", () => {
  it("o total da safra é o que as linhas somam, e cada coluna fecha em 100%", async () => {
    await montar();
    const rodape = within(screen.getByText("Total da safra").closest("tr"));
    expect(rodape.getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "Total da safra",
      "100", "400", "1.000,00", "100,00%",
      "200", "810", "1.000,00", "100,00%",
      "300", "900", "1.000,00", "100,00%",
    ]);
  });

  it("NÃO existe total das três safras", async () => {
    await montar();
    // A tabela é o que a diretoria lê como número; o rodapé pode EXPLICAR que o
    // total das três não existe, mas célula nenhuma pode trazê-lo.
    const tabela = within(screen.getByRole("table"));
    expect(tabela.queryByText(/total geral/i)).toBeNull();
    expect(tabela.queryByText(/tr[êe]s safras/i)).toBeNull();
    // 100 + 200 + 300 alunos, 400 + 800 + 900 títulos e 3.000,00 de saldo não
    // aparecem em célula alguma
    for (const somado of ["600", "2.110", "3.000,00"]) {
      expect(tabela.queryByText(somado)).toBeNull();
    }
    // o rodapé de total tem exatamente uma coluna por safra, nunca uma extra
    const rodape = within(screen.getByText("Total da safra").closest("tr"));
    expect(rodape.getAllByRole("cell")).toHaveLength(1 + 3 * 4);
    expect(screen.getByText(/não se somam entre si/i)).toBeTruthy();
  });

  it("avisa quando a safra não fecha com a fonte oficial", async () => {
    responder([{ ...S2024, conferencia: { saldo: 999.0, alunos: 100, titulos: 400 } }]);
    await montar();
    expect(screen.getByText(/Confer[êe]ncia com a fonte oficial/i).textContent)
      .toMatch(/1\.000,00 aqui e R\$ 999,00/);
  });

  it("silencia a conferência quando fecha", async () => {
    await montar();
    expect(screen.queryByText(/Confer[êe]ncia com a fonte oficial/i)).toBeNull();
  });
});

describe("cobertura incompleta fica à mostra", () => {
  it("avisa o percentual do saldo sem situação acadêmica na safra em que pesa", async () => {
    await montar();
    const aviso = screen.getByText(/do saldo está sem situação acadêmica importada/i);
    expect(aviso.textContent).toMatch(/2024:/);
    expect(aviso.textContent).toMatch(/53,00%/);
    expect(aviso.textContent).toMatch(/50 de 100 alunos/);
    expect(aviso.textContent).toMatch(/R\$ 530,00/);
  });

  it("não avisa quando a ausência é pequena — a linha da tabela já conta", async () => {
    await montar();
    const avisos = screen.queryAllByText(/do saldo está sem situação acadêmica importada/i);
    expect(avisos).toHaveLength(1); // só 2024; 2025 tem 0,002%
    expect(avisos[0].textContent).not.toMatch(/2025:/);
  });

  it("(sem situação importada) continua linha REAL da tabela, marcada", async () => {
    await montar();
    const tr = linhaDe("(sem situação importada)");
    expect(tr).toBeTruthy();
    expect(within(tr).getByText(/cobertura incompleta/i)).toBeTruthy();
    expect(within(tr).getAllByRole("cell")[1].textContent).toBe("50");
  });

  it("não redistribui nem esconde: a linha entra no total", async () => {
    await montar();
    expect(screen.getByText(/não foi redistribuída nem omitida/i)).toBeTruthy();
  });
});

describe("procedência do dado", () => {
  it("diz a data da importação acadêmica", async () => {
    await montar();
    expect(screen.getByText(/relatório de inadimplência/i).textContent)
      .toMatch(/importado em 04\/08\/2026/);
  });

  it("diz quando o cruzamento com o saldo foi tirado e que 2026 /1 se move", async () => {
    await montar();
    expect(screen.getByText(/Cruzamento com o saldo tirado em/i).textContent)
      .toMatch(/07\/10\/2026/);
    expect(screen.getByText(/carteira viva e se move ao longo do dia/i)).toBeTruthy();
  });
});

describe("densidade e falhas", () => {
  it("o botão reduz para saldo e % e volta", async () => {
    await montar();
    expect(within(linhaDe("Término do Contrato")).getAllByRole("cell")).toHaveLength(13);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /só saldo/i })); });
    const celulas = within(linhaDe("Término do Contrato")).getAllByRole("cell").map((c) => c.textContent);
    expect(celulas).toEqual(["Término do Contrato", "300,00", "30,00%", "700,00", "70,00%",
                             "200,00", "20,00%"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /mostrar alunos e títulos/i }));
    });
    expect(within(linhaDe("Término do Contrato")).getAllByRole("cell")).toHaveLength(13);
  });

  it("falha da RPC aparece, não vira tabela vazia", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "canceling statement due to timeout" } });
    await montar();
    expect(screen.getByText(/Não foi possível cruzar status e saldo/i).textContent)
      .toMatch(/canceling statement/);
  });

  it("sem fotografia alguma, diz isso em vez de ficar em branco", async () => {
    responder([]);
    await montar();
    expect(screen.getByText(/Nenhuma safra tem fotografia do cruzamento ainda/i)).toBeTruthy();
  });
});
