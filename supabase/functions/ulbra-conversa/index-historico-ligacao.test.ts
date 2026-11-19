// VERIFICAÇÃO ESTRUTURAL (leitura de texto do index.ts). NÃO comprova a execução do handler.
// Confirma que a entrada real do histórico passa para executarAcaoHistorico os controles esperados
// (flag do ambiente, lista do piloto, identidade do JWT, conexão individual, leitura com o token do
// operador) e que não há leitura de credencial central. A execução do handler com Deno não roda no CI.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = readFileSync(join(__dirname, "index.ts"), "utf8");
const inicio = INDEX.indexOf('if (acao === "historico_ler" || acao === "historico_capacidade")');
const fim = INDEX.indexOf("return responder(s.corpo, s.status);", inicio);
const BLOCO = inicio >= 0 && fim > inicio ? INDEX.slice(inicio, fim) : "";

describe("ligação estrutural do histórico em index.ts (não executa o handler)", () => {
  it("o bloco de histórico existe e delega à decisão extraída", () => {
    expect(BLOCO.length).toBeGreaterThan(0);
    expect(BLOCO).toContain("await executarAcaoHistorico(acao, corpo, {");
  });
  it("flag de leitura e lista do piloto vêm do ambiente", () => {
    expect(BLOCO).toContain('habilitadoEnv: Deno.env.get("ULBRA_HISTORICO_HABILITADO") === "true"');
    expect(BLOCO).toContain('listaPilotoEnv: Deno.env.get("ULBRA_HISTORICO_PILOTO_EMAILS")');
  });
  it("identidade vem do JWT (e-mail do usuário autenticado) e do cadastro ativo", () => {
    expect(INDEX).toContain("const email = user.email.toLowerCase();");
    expect(BLOCO).toMatch(/\n\s+email,\n/);
    expect(BLOCO).toContain("usuarioAtivo: usuario?.ativo === true");
  });
  it("conexão individual: garantirConexao sobre o registro do operador, e o token usado é o dele", () => {
    expect(BLOCO).toContain("garantirConexao(r, provedorOAuth, Date.now())");
    expect(BLOCO).toContain("access_token: conn.registro.access_token");
  });
  it("leitura pelo token do operador (chamarComoOperador), sem credencial central", () => {
    expect(BLOCO).toContain('lerConversa: (token, args) => chamarComoOperador(token, "ler_conversa", args)');
    expect(BLOCO).not.toContain("ULBRA_MCP_TOKEN");
    expect(INDEX).not.toMatch(/Deno\.env\.get\("ULBRA_MCP_TOKEN"\)/);
  });
  it("auditoria da leitura é a do próprio histórico", () => {
    expect(BLOCO).toContain('auditar: (detalhes) => auditar("ULBRA_HISTORICO_LEITURA", "ulbra_conversas", detalhes)');
  });
});
