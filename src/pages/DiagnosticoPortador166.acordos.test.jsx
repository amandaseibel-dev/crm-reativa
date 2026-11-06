// @vitest-environment jsdom
//
// Diagnóstico de acordos: o botão invoca `prime-sync`/`provar_match` pela
// sessão autenticada, e o resumo NÃO carrega dado pessoal.
//
// O caso que mais importa aqui é o de privacidade: `provar_match` devolve CPF,
// matrícula e o objeto cru do acordo, e a tela não pode exibir nada disso. O
// teste joga um payload COM dado pessoal e exige que ele não apareça no
// resumo — se alguém ampliar o resumidor para passar o payload adiante, cai.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { functions: { invoke }, from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));

const { default: DiagnosticoPortador166 } = await import("./DiagnosticoPortador166.jsx");
const { resumirProvarMatch } = await import("../utils/diagnosticoAcordos.js");

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

// Payload com dado pessoal DE PROPÓSITO, para o teste de privacidade ter o que pegar.
const RELATORIO_COM_ACORDO = [
  {
    registration: "2025007862",
    cpf: "111.222.333-44",
    prime: {
      qtd_acordos: 1,
      campos_do_acordo_prime: ["id", "status", "totalValue", "newInstallments"],
      amostra_acordo: {
        id: 71903,
        status: "Confirmado",
        totalValue: 3975.57,
        newInstallments: [
          { documentNumber: "50719030001", paymentDate: "2026-10-16", paidAmount: 429.36 },
          { documentNumber: "50719030002", paymentDate: null, paidAmount: 0 },
          { documentNumber: "50719030003", paymentDate: null, paidAmount: 0 },
        ],
      },
      docs_prime: ["50719030001", "50719030002", "50719030003"],
      docs_prime_total: 3,
    },
    crm: { docs_casados_em_titulos: ["50719030001"], docs_casados_total: 1, acordos_por_cpf: [{ numero_acordo: "71903" }] },
  },
];

const RELATORIO_VAZIO = [
  { registration: "2025007862", cpf: "111.222.333-44", prime: { qtd_acordos: 0, campos_do_acordo_prime: [], docs_prime: [], docs_prime_total: 0 }, crm: { docs_casados_total: 0 } },
  { registration: "2025001442", cpf: "555.666.777-88", prime: { qtd_acordos: 0, campos_do_acordo_prime: [], docs_prime: [], docs_prime_total: 0 }, crm: { docs_casados_total: 0 } },
];

describe("resumirProvarMatch — os quatro fatos pedidos", () => {
  it("conta acordos, campos, documentos e correspondências", () => {
    const r = resumirProvarMatch(RELATORIO_COM_ACORDO);
    expect(r.consultas).toBe(1);
    expect(r.com_acordo).toBe(1);
    expect(r.acordos_encontrados).toBe(1);
    expect(r.campos).toEqual(["id", "newInstallments", "status", "totalValue"]);
    expect(r.docs_prime).toBe(3);
    expect(r.docs_casados).toBe(1);
  });

  it("separa parcela paga de não paga quando a resposta traz o sinal", () => {
    const r = resumirProvarMatch(RELATORIO_COM_ACORDO);
    expect(r.situacao_conhecida).toBe(true);
    expect(r.parcelas_pagas).toBe(1);
    expect(r.parcelas_nao_pagas).toBe(2);
  });

  it("lista vazia: zero em tudo, e nenhum campo", () => {
    const r = resumirProvarMatch(RELATORIO_VAZIO);
    expect(r.consultas).toBe(2);
    expect(r.com_acordo).toBe(0);
    expect(r.acordos_encontrados).toBe(0);
    expect(r.campos).toEqual([]);
    expect(r.situacao_conhecida).toBe(false);
  });

  it("sem campo de situação, NÃO conclui que não há parcela não paga", () => {
    // A distinção entre medir e supor: parcela sem nenhum sinal de pagamento
    // não entra em nenhuma das duas contas, e situacao_conhecida fica false.
    const semSinal = [
      { prime: { qtd_acordos: 1, campos_do_acordo_prime: ["id"], amostra_acordo: { newInstallments: [{ documentNumber: "x" }, { documentNumber: "y" }] }, docs_prime_total: 2 }, crm: { docs_casados_total: 0 } },
    ];
    const r = resumirProvarMatch(semSinal);
    expect(r.situacao_conhecida).toBe(false);
    expect(r.parcelas_pagas).toBe(0);
    expect(r.parcelas_nao_pagas).toBe(0);
  });

  it("aguenta payload ausente, nulo ou fora de forma sem quebrar", () => {
    for (const entrada of [undefined, null, [], {}, "x", [null], [{}]]) {
      expect(() => resumirProvarMatch(entrada)).not.toThrow();
    }
    expect(resumirProvarMatch(undefined).consultas).toBe(0);
  });
});

describe("PRIVACIDADE — o resumo não carrega dado pessoal", () => {
  it("nenhum CPF, matrícula, nome ou valor individual sobrevive ao resumidor", () => {
    const r = resumirProvarMatch(RELATORIO_COM_ACORDO);
    const texto = JSON.stringify(r);
    expect(texto).not.toMatch(/111\.222\.333-44/);
    expect(texto).not.toMatch(/2025007862/);
    expect(texto).not.toMatch(/50719030001/); // boleto
    expect(texto).not.toMatch(/3975\.57/);    // valor negociado
    expect(texto).not.toMatch(/429\.36/);     // valor pago
    expect(texto).not.toMatch(/71903/);       // número do acordo
  });

  it("de campos_do_acordo_prime sai só NOME de campo, nunca valor", () => {
    const r = resumirProvarMatch(RELATORIO_COM_ACORDO);
    expect(r.campos).toContain("totalValue");
    expect(JSON.stringify(r.campos)).not.toMatch(/3975/);
  });

  it("o resumidor não repassa o payload adiante", () => {
    const r = resumirProvarMatch(RELATORIO_COM_ACORDO);
    expect(r.amostra_acordo).toBeUndefined();
    expect(r.relatorio).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual([
      "acordos_encontrados", "campos", "com_acordo", "consultas",
      "docs_casados", "docs_prime", "parcelas_nao_pagas", "parcelas_pagas",
      "situacao_conhecida",
    ]);
  });
});

describe("a tela invoca pela sessão autenticada, sem manipular token", () => {
  it("o botão chama prime-sync com provar_match e amostra 5", async () => {
    invoke.mockResolvedValue({ data: { ok: true, relatorio: RELATORIO_VAZIO }, error: null });
    render(<DiagnosticoPortador166 />);

    screen.getByRole("button", { name: /Diagnosticar acordos/i }).click();

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("prime-sync", {
      body: { acao: "provar_match", amostra: 5 },
    });
  });

  it("mostra o resultado agregado, e não o payload", async () => {
    invoke.mockResolvedValue({ data: { ok: true, relatorio: RELATORIO_COM_ACORDO }, error: null });
    render(<DiagnosticoPortador166 />);
    screen.getByRole("button", { name: /Diagnosticar acordos/i }).click();

    const painel = await screen.findByRole("region", { name: /diagnóstico de acordos/i });
    expect(painel.textContent).toMatch(/A API devolveu acordos/);
    expect(painel.textContent).not.toMatch(/111\.222\.333-44/);
    expect(painel.textContent).not.toMatch(/2025007862/);
  });

  it("erro de portão aparece como erro, e explica que é perfil e não mecanismo", async () => {
    invoke.mockResolvedValue({ data: { erro: "Somente gestao" }, error: null });
    render(<DiagnosticoPortador166 />);
    screen.getByRole("button", { name: /Diagnosticar acordos/i }).click();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(/Somente gestao/);
    expect(alerta.textContent).toMatch(/perfil, não de mecanismo/);
  });

  it("não há token, chave nem localStorage no arquivo da tela", async () => {
    const { readFileSync } = await import("node:fs");
    // Caminho relativo à raiz do repositório: em ambiente jsdom o
    // `import.meta.url` nao e URL de arquivo, e fileURLToPath recusa.
    const fonte = readFileSync("src/pages/DiagnosticoPortador166.jsx", "utf8");
    expect(fonte).not.toMatch(/localStorage/);
    expect(fonte).not.toMatch(/service_role|SERVICE_ROLE/);
    expect(fonte).not.toMatch(/access_token/);
    expect(fonte).not.toMatch(/Bearer/);
  });

  it("a tela não grava nada: nenhum insert, update, delete ou rpc de escrita", async () => {
    const { readFileSync } = await import("node:fs");
    // Caminho relativo à raiz do repositório: em ambiente jsdom o
    // `import.meta.url` nao e URL de arquivo, e fileURLToPath recusa.
    const fonte = readFileSync("src/pages/DiagnosticoPortador166.jsx", "utf8");
    expect(fonte).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    // Mede CHAMADA, nao palavra: o arquivo cita "baixa" e "importacao" nos
    // comentarios, justamente para dizer que NAO as toca. Procurar a palavra
    // derrubaria o teste pelo comentario correto.
    expect(fonte).not.toMatch(/\.rpc\(\s*["'`](importar_acordos|pagamento_conciliar_um|baixa_|quitar_)/);
    expect(fonte).not.toMatch(/functions\.invoke\(\s*["'`](?!prime-sync|prime-sonda)/);
  });
});
