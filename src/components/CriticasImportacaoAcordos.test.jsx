// @vitest-environment jsdom
//
// P3 — as criticas na tela de Importacoes.
//
// O que este arquivo protege, acima de tudo: a tela NAO pode dizer "nenhuma
// critica" para uma importacao anterior a 23/10/2026. Nenhuma das 136
// anteriores registrou critica, e nenhuma foi reconstruida -- "-" ali e
// ausencia de REGISTRO, nao ausencia de problema. Trocar isso por "nenhuma"
// seria afirmar fato sem evidencia, e e por isso que existe teste para o
// rotulo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import CriticasImportacaoAcordos from "./CriticasImportacaoAcordos";

const LOTE_NOVO = "aaaaaaaa-1111-4111-8111-111111111111";
const LOTE_LIMPO = "bbbbbbbb-2222-4222-8222-222222222222";
const LOTE_ANTIGO = "cccccccc-3333-4333-8333-333333333333";

const LOTES = [
  { importacao_id: LOTE_NOVO, arquivo_nome: "titulos.xlsx", importado_em: "2026-10-23T14:00:00Z",
    importado_por: "amanda@x", titulos_inseridos: 120, linhas_arquivo: 1500,
    arquivo_path: `acordos/${LOTE_NOVO}/titulos.xlsx`, arquivo_sha256: "a".repeat(64), arquivo_bytes: 2048 },
  { importacao_id: LOTE_LIMPO, arquivo_nome: "limpo.xlsx", importado_em: "2026-10-23T15:00:00Z",
    importado_por: "amanda@x", titulos_inseridos: 10, linhas_arquivo: 12,
    arquivo_path: null, arquivo_sha256: "b".repeat(64), arquivo_bytes: 100 },
  { importacao_id: LOTE_ANTIGO, arquivo_nome: "setembro.xlsx", importado_em: "2026-09-10T09:00:00Z",
    importado_por: "amanda@x", titulos_inseridos: 300, linhas_arquivo: null,
    arquivo_path: null, arquivo_sha256: null, arquivo_bytes: null },
];

const RESUMO = [
  { importacao_id: LOTE_NOVO, classe: "REJEICAO", motivo_codigo: "documento_invalido", total: 2 },
  { importacao_id: LOTE_NOVO, classe: "DUPLICIDADE", motivo_codigo: "titulo_ja_existe", total: 5 },
  { importacao_id: LOTE_NOVO, classe: "IGNORADA_POR_REGRA", motivo_codigo: "cpf_quitado_recente", total: 8 },
];

const DETALHE = [
  { id: 1, classe: "REJEICAO", motivo_codigo: "documento_invalido", origem: "ARQUIVO",
    linha_numero: 42, documento: "TOTAL", acordo_ulbra: null, cpf_mascarado: null,
    nome: null, vencimento: null, valor: null, detectado_em: "2026-10-23T14:00:00Z" },
  { id: 2, classe: "DUPLICIDADE", motivo_codigo: "titulo_ja_existe", origem: "SERVIDOR",
    linha_numero: null, documento: "050999990001", acordo_ulbra: null,
    cpf_mascarado: "037.***.***-14", nome: "Aluno Inventado", vencimento: "2026-08-07",
    valor: 1316.1, detectado_em: "2026-10-23T14:00:00Z" },
];

let falharResumo = false;
const chamadas = [];

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn, args) => {
      chamadas.push({ fn, args });
      if (fn === "listar_importacoes_acordos") return Promise.resolve({ data: LOTES, error: null });
      if (fn === "importacao_acordo_critica_resumo") {
        return falharResumo
          ? Promise.resolve({ data: null, error: { message: "sem permissao" } })
          : Promise.resolve({ data: RESUMO, error: null });
      }
      if (fn === "importacao_acordo_critica_listar") return Promise.resolve({ data: DETALHE, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

const linhaDo = (texto) => screen.getByText(texto).closest("tr");

beforeEach(() => { chamadas.length = 0; falharResumo = false; });
afterEach(() => cleanup());

describe("lista de importacoes de acordos", () => {
  it("mostra as tres naturezas com os rotulos certos, nao 'erro' para tudo", async () => {
    render(<CriticasImportacaoAcordos />);
    const linha = await waitFor(() => linhaDo("titulos.xlsx"));
    const txt = linha.textContent;
    expect(txt).toContain("2 Rejeitada");
    expect(txt).toContain("5 Duplicidade");
    expect(txt).toContain("8 Ignorada por regra");
    expect(txt).not.toContain("erro");
  });

  it("explica que duplicidade e ignorada NAO sao erro", async () => {
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    const bloco = screen.getByTestId("criticas-acordos").textContent;
    expect(bloco).toMatch(/não são erro/i);
    expect(bloco).toMatch(/Rejeitada.*pede alguém olhar o arquivo/is);
  });

  it("importacao ANTERIOR a 23/10 diz 'sem registro', nunca 'nenhuma'", async () => {
    render(<CriticasImportacaoAcordos />);
    const linha = await waitFor(() => linhaDo("setembro.xlsx"));
    expect(linha.textContent).toContain("sem registro");
    expect(linha.textContent).not.toContain("nenhuma");
  });

  it("importacao NOVA sem critica diz 'nenhuma' — ai o registro existe", async () => {
    render(<CriticasImportacaoAcordos />);
    const linha = await waitFor(() => linhaDo("limpo.xlsx"));
    expect(linha.textContent).toContain("nenhuma");
    expect(linha.textContent).not.toContain("sem registro");
  });

  it("arquivo preservado: sim, nao e '-' sao tres estados distintos", async () => {
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    // preservado
    expect(within(linhaDo("titulos.xlsx")).getByTitle(`acordos/${LOTE_NOVO}/titulos.xlsx`).textContent).toBe("sim");
    // tentou e nao ficou, em importacao nova
    expect(linhaDo("limpo.xlsx").textContent).toContain("não");
    // antiga: nao havia preservacao, entao nao e "nao"
    expect(linhaDo("setembro.xlsx").textContent).not.toContain("não");
  });

  it("so oferece 'Ver criticas' para o lote que TEM critica", async () => {
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    expect(within(linhaDo("titulos.xlsx")).getByRole("button", { name: "Ver críticas" })).toBeTruthy();
    expect(within(linhaDo("limpo.xlsx")).queryByRole("button", { name: "Ver críticas" })).toBeNull();
    expect(within(linhaDo("setembro.xlsx")).queryByRole("button", { name: "Ver críticas" })).toBeNull();
  });

  it("erro no resumo nao apaga a lista de importacoes", async () => {
    falharResumo = true;
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    expect(screen.getByText(/Erro ao carregar críticas/)).toBeTruthy();
    expect(screen.getByText("setembro.xlsx")).toBeTruthy();
  });
});

describe("detalhe e exportacao", () => {
  it("abre o detalhe com motivo legivel, linha do arquivo e CPF MASCARADO", async () => {
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    fireEvent.click(within(linhaDo("titulos.xlsx")).getByRole("button", { name: "Ver críticas" }));

    const det = await waitFor(() => screen.getByTestId("detalhe-criticas"));
    expect(det.textContent).toContain("Documento invalido ou ausente na linha");
    expect(det.textContent).toContain("Titulo com este documento ja existe");
    expect(det.textContent).toContain("42");            // a linha da planilha
    expect(det.textContent).toContain("TOTAL");         // o texto CRU da celula
    expect(det.textContent).toContain("037.***.***-14");
    expect(det.textContent).toContain("Aluno Inventado");
    // o CPF cru nunca aparece
    expect(det.textContent).not.toContain("03704201014");
  });

  it("pede o detalhe ao servidor pelo id do lote", async () => {
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    fireEvent.click(within(linhaDo("titulos.xlsx")).getByRole("button", { name: "Ver críticas" }));
    await waitFor(() => screen.getByTestId("detalhe-criticas"));
    const c = chamadas.find((x) => x.fn === "importacao_acordo_critica_listar");
    expect(c.args).toEqual({ p_importacao_id: LOTE_NOVO });
  });

  it("fecha o detalhe no segundo clique", async () => {
    render(<CriticasImportacaoAcordos />);
    await waitFor(() => screen.getByText("titulos.xlsx"));
    const botao = within(linhaDo("titulos.xlsx")).getByRole("button", { name: "Ver críticas" });
    fireEvent.click(botao);
    await waitFor(() => screen.getByTestId("detalhe-criticas"));
    fireEvent.click(within(linhaDo("titulos.xlsx")).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByTestId("detalhe-criticas")).toBeNull());
  });

  it("exporta CSV com cabecalho, as duas linhas e o documento protegido do Excel", async () => {
    // jsdom nao implementa Blob.text() nem navegacao de <a download>. Captura o
    // conteudo pelo construtor do Blob e neutraliza o click do anchor -- sem
    // isso o teste passa cuspindo "Not implemented: navigation" no CI.
    const partes = [];
    const BlobOriginal = globalThis.Blob;
    const nomes = [];
    const clickOriginal = HTMLAnchorElement.prototype.click;
    const criarOriginal = URL.createObjectURL;
    const revogarOriginal = URL.revokeObjectURL;
    globalThis.Blob = class extends BlobOriginal {
      constructor(p, o) { partes.push(p); super(p, o); }
    };
    HTMLAnchorElement.prototype.click = function () { nomes.push(this.download); };
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    try {
      render(<CriticasImportacaoAcordos />);
      await waitFor(() => screen.getByText("titulos.xlsx"));
      fireEvent.click(within(linhaDo("titulos.xlsx")).getByRole("button", { name: "Ver críticas" }));
      await waitFor(() => screen.getByTestId("detalhe-criticas"));
      fireEvent.click(screen.getByRole("button", { name: "Exportar CSV" }));

      expect(nomes).toEqual([`criticas-importacao-acordos-${LOTE_NOVO.slice(0, 8)}.csv`]);
      const texto = partes[0].join("");
      expect(texto.startsWith("\uFEFF")).toBe(true);     // BOM: sem ele o Excel quebra o acento
      expect(texto.split("\r\n")).toHaveLength(3);      // cabecalho + 2 criticas
      expect(texto).toContain("Rejeitada");
      expect(texto).toContain("Duplicidade");
      expect(texto).toContain('"\t050999990001"');       // nao vira notacao cientifica
      expect(texto).toContain("037.***.***-14");
      expect(texto).not.toContain("03704201014");        // CPF cru nunca sai
    } finally {
      globalThis.Blob = BlobOriginal;
      HTMLAnchorElement.prototype.click = clickOriginal;
      URL.createObjectURL = criarOriginal;
      URL.revokeObjectURL = revogarOriginal;
    }
  });
});
