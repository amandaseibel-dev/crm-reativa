import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { classificarFalhaExportacao, montarLinhasContatos, gerarArquivoExportacao } from "./exportacaoMassiva.js";

const normalizarTelefone = (t) => (t ? `+${String(t).replace(/\D/g, "")}` : "");

describe("classificarFalhaExportacao", () => {
  it("RPC recusou por validacao (SQLSTATE 22023/42501/P0002) -> etapa validacao", () => {
    expect(classificarFalhaExportacao("rpc", { code: "22023" }).etapa).toBe("validacao");
    expect(classificarFalhaExportacao("rpc", { code: "42501" }).etapa).toBe("validacao");
    expect(classificarFalhaExportacao("rpc", { code: "P0002" }).etapa).toBe("validacao");
  });

  it("RPC sem codigo de validacao (rede, timeout, 500) -> etapa rpc, sem afirmar registro", () => {
    const r = classificarFalhaExportacao("rpc", new Error("fetch failed"));
    expect(r.etapa).toBe("rpc");
    expect(r.mensagem).toMatch(/Não é possível afirmar/);
  });

  it("falha de arquivo -> etapa arquivo, avisa que o lote ja foi registrado", () => {
    const r = classificarFalhaExportacao("arquivo", new Error("boom"));
    expect(r.etapa).toBe("arquivo");
    expect(r.mensagem).toMatch(/já foi registrado/);
  });

  it("mensagem nunca carrega o texto bruto do erro (nomes, contatos, tokens)", () => {
    const vazamento = new Error("Aluno Maria Silva telefone +5551999999999 token abc123");
    const r = classificarFalhaExportacao("rpc", vazamento);
    expect(JSON.stringify(r)).not.toMatch(/Maria|5551999|abc123/);
  });
});

describe("montarLinhasContatos", () => {
  it("WhatsApp: nome e telefone formatado, sem e-mail", () => {
    const linhas = montarLinhasContatos([{ nome: "Ana", telefone: "51999990000", email: "a@x.com" }], "WHATSAPP", normalizarTelefone);
    expect(linhas).toEqual([{ "Nome do aluno": "Ana", Telefone: "+51999990000" }]);
  });

  it("E-mail: nome, e-mail sem espaco e telefone", () => {
    const linhas = montarLinhasContatos([{ nome: "Ana", telefone: null, email: "  a@x.com " }], "EMAIL", normalizarTelefone);
    expect(linhas).toEqual([{ "Nome do aluno": "Ana", "E-mail": "a@x.com", Telefone: "" }]);
  });

  it("lista vazia ou ausente devolve lista vazia", () => {
    expect(montarLinhasContatos(undefined, "EMAIL", normalizarTelefone)).toEqual([]);
  });
});

describe("gerarArquivoExportacao", () => {
  const rel = {
    nomeArquivo: "acao-massiva-whatsapp-2026-11-15.xlsx",
    linhas: [
      { "Nome do aluno": "Ana", Telefone: "+51999990000" },
      { "Nome do aluno": "Beto", Telefone: "+51988880000" },
    ],
  };

  it("gera o livro com a aba e o conteudo esperados (lido de volta)", () => {
    let capturado = null;
    const r = gerarArquivoExportacao(XLSX, rel, (livro, nome) => {
      capturado = { livro, nome };
    });
    expect(r).toEqual({ ok: true, linhas: 2 });
    expect(capturado.nome).toBe(rel.nomeArquivo);
    expect(capturado.livro.SheetNames).toEqual(["Ação Massiva"]);
    // ida e volta pelo formato real do .xlsx
    const bytes = XLSX.write(capturado.livro, { type: "array", bookType: "xlsx" });
    const lido = XLSX.read(bytes, { type: "array" });
    const linhas = XLSX.utils.sheet_to_json(lido.Sheets["Ação Massiva"]);
    expect(linhas).toEqual(rel.linhas);
  });

  it("sem linhas: nao gera e lanca erro de arquivo", () => {
    expect(() => gerarArquivoExportacao(XLSX, { nomeArquivo: "x.xlsx", linhas: [] }, () => {})).toThrow("arquivo");
  });

  it("falha no download: lanca erro de arquivo, sem vazar o conteudo", () => {
    let erro = null;
    try {
      gerarArquivoExportacao(XLSX, rel, () => {
        throw new Error("Ana +51999990000 bloqueado pelo navegador");
      });
    } catch (e) {
      erro = e;
    }
    expect(erro?.etapaFalha).toBe("arquivo");
    expect(erro.message).toBe("arquivo");
    expect(erro.message).not.toMatch(/Ana|51999/);
    expect(erro.original).toBe("Error");
  });
});
