import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hashValido } from "./hashArquivo";

// ============================================================================
// O hash é PRÉ-REQUISITO da importação financeira, não um detalhe da trilha.
//
// Antes: se `crypto.subtle` falhasse, o financeiro gravava e a captura morria no
// `catch` com um aviso. Em 06/10 17:11 uma importação concluiu sem gerar escopo
// (9 de 10 pós-deploy tinham escopo) e o banco não distingue "reaproveitamento
// por hash" de "captura perdida".
//
// Por que teste ESTRUTURAL para a ordem: a trava é um `return` dentro de um
// handler de componente. Sem DOM não há como exercitar o clique, e o que precisa
// ser garantido é POSIÇÃO -- a trava antes da primeira gravação. Então o teste lê
// o arquivo e compara índices.
//
// Armadilha conhecida do projeto (testes estruturais): comentário conta como
// ocorrência. Por isso TODO comentário é removido antes de procurar qualquer
// âncora -- senão a menção a `importar_acordos` no cabeçalho do arquivo passaria
// por chamada e o teste mediria a linha errada.
// ============================================================================

function semComentarios(caminho) {
  return readFileSync(new URL(caminho, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // bloco
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // linha (preserva "https://")
}

const ACORDOS = semComentarios("../pages/ImportacaoAcordos.jsx");
const BORDERO = semComentarios("../pages/Borderos.jsx");

describe("hashValido", () => {
  it("aceita exatamente 64 hex minusculos", () => {
    expect(hashValido("a".repeat(64))).toBe(true);
    expect(hashValido("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("recusa ausente, vazio e nao-string", () => {
    for (const v of [undefined, null, "", 0, 123, {}, [], NaN, true]) {
      expect(hashValido(v)).toBe(false);
    }
  });

  it("recusa tamanho errado por 1 caractere, nos dois lados", () => {
    expect(hashValido("a".repeat(63))).toBe(false);
    expect(hashValido("a".repeat(65))).toBe(false);
  });

  it("recusa maiuscula: o hash gravado e sempre minusculo", () => {
    expect(hashValido("A".repeat(64))).toBe(false);
    expect(hashValido("aA".repeat(32))).toBe(false);
  });

  it("recusa caractere fora do hex e espaco", () => {
    expect(hashValido("g".repeat(64))).toBe(false);
    expect(hashValido(" " + "a".repeat(63))).toBe(false);
    expect(hashValido("a".repeat(63) + "\n")).toBe(false);
  });

  it("aceita o que hashArquivo realmente produz", () => {
    // valor de referencia obtido FORA do codigo sob teste:
    //   printf '' | shasum -a 256
    const vazio = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(hashValido(vazio)).toBe(true);
  });
});

describe("a trava vem ANTES da importacao financeira", () => {
  it("ImportacaoAcordos: hashValido antes do primeiro importar_acordos", () => {
    const trava = ACORDOS.indexOf("hashValido(arquivoHash)");
    const financeiro = ACORDOS.indexOf('rpc("importar_acordos"');
    expect(trava).toBeGreaterThan(-1);
    expect(financeiro).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(financeiro);
  });

  it("ImportacaoAcordos: hashValido antes do setImportando(true)", () => {
    const trava = ACORDOS.indexOf("hashValido(arquivoHash)");
    const marca = ACORDOS.indexOf("setImportando(true)");
    expect(marca).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(marca);
  });

  it("Bordero: hashValido antes do INSERT em importacoes", () => {
    // Ancora no insert, nao em `from("importacoes")`: a PRIMEIRA ocorrencia de
    // `from("importacoes")` no arquivo e a consulta da previa (o aviso de
    // bordero ja importado), que roda antes de qualquer gravacao e nao e o que
    // precisa ser medido. Esta foi a primeira versao errada deste teste.
    const trava = BORDERO.indexOf("hashValido(arquivoHash)");
    const insert = BORDERO.indexOf('tipo: "BORDERO"');
    expect(trava).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(insert);
  });

  it("Bordero: hashValido antes do setImportando(true)", () => {
    const trava = BORDERO.indexOf("hashValido(arquivoHash)");
    const marca = BORDERO.indexOf("setImportando(true)");
    expect(marca).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(marca);
  });

  it("a trava interrompe com return, nao apenas avisa", () => {
    for (const src of [ACORDOS, BORDERO]) {
      const i = src.indexOf("hashValido(arquivoHash)");
      // o bloco do if tem de conter um `return` antes de fechar
      const bloco = src.slice(i, i + 600);
      expect(bloco).toMatch(/return;/);
    }
  });

  it("o bordero nao calcula mais o hash dentro da captura", () => {
    // antes era `p_arquivo_hash: await hashArquivo(await arquivo.arrayBuffer())`,
    // depois do financeiro ja concluido
    expect(BORDERO).not.toMatch(/p_arquivo_hash:\s*await hashArquivo/);
    expect(BORDERO).toMatch(/p_arquivo_hash:\s*arquivoHash/);
  });

  it("a trava NAO esta dentro do try/catch da trilha", () => {
    // O catch da trilha so avisa; se a trava caisse ali dentro, o bloqueio seria
    // engolido exatamente como antes. Ancora na CHAMADA da captura, nao no texto
    // do comentario do catch: comentarios sao removidos acima, e ancorar neles
    // dava -1. Foi a segunda versao errada deste teste.
    for (const src of [ACORDOS, BORDERO]) {
      const trava = src.indexOf("hashValido(arquivoHash)");
      const captura = src.indexOf('rpc("registrar_presenca_extracao"');
      expect(trava).toBeGreaterThan(-1);
      expect(captura).toBeGreaterThan(-1);
      expect(trava).toBeLessThan(captura);
    }
  });
});

describe("o reaproveitamento por hash continua intacto no front", () => {
  it("ImportacaoAcordos sai pelo reaproveitado antes de anexar ou fechar", () => {
    const reaproveitado = ACORDOS.indexOf("pres.reaproveitado");
    const anexar = ACORDOS.indexOf('rpc("extracao_lote_anexar"');
    const fechar = ACORDOS.indexOf('rpc("extracao_lote_fechar"');
    expect(reaproveitado).toBeGreaterThan(-1);
    expect(reaproveitado).toBeLessThan(anexar);
    expect(reaproveitado).toBeLessThan(fechar);
  });

  it("a captura em lotes nao foi alterada: lote de 1.200 e os dois RPCs seguem la", () => {
    expect(ACORDOS).toMatch(/LOTE_PRESENCA\s*=\s*1200/);
    expect(ACORDOS).toMatch(/rpc\("extracao_lote_anexar"/);
    expect(ACORDOS).toMatch(/rpc\("extracao_lote_fechar"/);
  });
});
