// Testes do portao da `prime-sonda`.
//
// O QUE ESTES TESTES PROTEGEM. Esta funcao segura a chave que da acesso a CPF e
// dados financeiros de ~400 mil pessoas. O portao e a unica coisa entre essa
// chave e quem chama. Os cinco cenarios pedidos pela gestao em 28/09 estao
// aqui, um a um, mais a trava de caminho.
//
// Os dubles devolvem exatamente o que as RPCs reais devolvem (booleano, ou
// false quando a RPC falha) -- o codigo exercitado e o mesmo que roda em
// producao, importado de ./portao.ts, nao uma copia.

import { describe, it, expect } from "vitest";
import { decidirAcesso, caminhoPermitido, CAMINHOS_PERMITIDOS } from "./portao.ts";

// Dubles nomeados, para o teste ler como a regra: quem valida e o BANCO.
const bancoDizQueTokenConfere = async () => true;
const bancoDizQueTokenNaoConfere = async () => false;
const bancoDizQueEhGestao = async () => true;
const bancoDizQueNaoEhGestao = async () => false;

// Secret ausente: `prime_cadastro_token_valido` nao encontra segredo no Vault e
// devolve false. E o cenario que o portao antigo transformava em passe livre.
const bancoSemSecret = async () => false;

const base = {
  tokenRecebido: "",
  autorizacao: "",
  validarToken: bancoDizQueTokenNaoConfere,
  validarGestao: bancoDizQueNaoEhGestao,
};

describe("prime-sonda / portao", () => {
  it("1. ROTINA AUTORIZADA: token que confere no banco entra, sem precisar de sessao", async () => {
    const d = await decidirAcesso({
      ...base,
      tokenRecebido: "token-da-rotina",
      validarToken: bancoDizQueTokenConfere,
    });
    expect(d).toEqual({ ok: true, via: "rotina" });
  });

  it("2. GESTAO AUTORIZADA: sem token, sessao de gestao validada no servidor entra", async () => {
    const d = await decidirAcesso({
      ...base,
      autorizacao: "Bearer jwt-da-amanda",
      validarGestao: bancoDizQueEhGestao,
    });
    expect(d).toEqual({ ok: true, via: "gestao" });
  });

  it("3. USUARIO SEM PERMISSAO: sessao valida, mas nao e gestao -> 403", async () => {
    const d = await decidirAcesso({
      ...base,
      autorizacao: "Bearer jwt-de-operador",
      validarGestao: bancoDizQueNaoEhGestao,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
    expect(d.corpo.erro).toBe("ACESSO_NEGADO");
  });

  it("4. SESSAO INVALIDA: header ausente ou malformado -> 401, sem consultar o banco", async () => {
    let consultou = false;
    const espia = async () => { consultou = true; return true; };

    for (const autorizacao of ["", "jwt-sem-bearer", "Basic abc", "Bearer"]) {
      const d = await decidirAcesso({ ...base, autorizacao, validarGestao: espia });
      expect(d.ok).toBe(false);
      expect(d.status).toBe(401);
      expect(d.corpo.erro).toBe("SEM_TOKEN");
    }
    expect(consultou).toBe(false);
  });

  it("4b. SESSAO INVALIDA: JWT expirado faz a RPC falhar -> false -> 403, nunca passa", async () => {
    // `validarGestao` ja colapsa erro da RPC em false (ver index.ts). Aqui se
    // prova que false FECHA -- falha de verificacao nao vira autorizacao.
    const d = await decidirAcesso({
      ...base,
      autorizacao: "Bearer jwt-expirado",
      validarGestao: async () => false,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
  });

  it("5. SECRET AUSENTE: nao libera acesso anonimo -- a regressao que este PR fecha", async () => {
    // O portao ANTIGO era `if (esperado && recebido !== esperado) { 401 }`.
    // Com o secret ausente, `esperado` era "", a condicao inteira dava falso e
    // a funcao seguia em frente SEM token nenhum. Aqui, chamador anonimo com
    // secret ausente tem de bater em 401.
    const anonimo = await decidirAcesso({
      ...base,
      tokenRecebido: "",
      autorizacao: "",
      validarToken: bancoSemSecret,
    });
    expect(anonimo.ok).toBe(false);
    expect(anonimo.status).toBe(401);

    // E quem apresenta um token qualquer tambem nao entra: sem secret, nada
    // confere, e a porta da rotina fica fechada.
    const comTokenQualquer = await decidirAcesso({
      ...base,
      tokenRecebido: "chute",
      validarToken: bancoSemSecret,
    });
    expect(comTokenQualquer.ok).toBe(false);
    expect(comTokenQualquer.status).toBe(401);
    expect(comTokenQualquer.corpo.erro).toBe("TOKEN_INVALIDO");
  });

  it("token invalido nao ganha segunda chance pela porta da gestao", async () => {
    const d = await decidirAcesso({
      ...base,
      tokenRecebido: "token-errado",
      autorizacao: "Bearer jwt-da-amanda",
      validarToken: bancoDizQueTokenNaoConfere,
      validarGestao: bancoDizQueEhGestao, // seria aceito, se fosse consultado
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  it("nenhuma resposta de recusa carrega credencial", async () => {
    const recusas = await Promise.all([
      decidirAcesso({ ...base, tokenRecebido: "segredo-vazado", validarToken: bancoSemSecret }),
      decidirAcesso({ ...base, autorizacao: "Bearer jwt-secreto" }),
      decidirAcesso({ ...base }),
    ]);
    for (const d of recusas) {
      const texto = JSON.stringify(d.corpo);
      expect(texto).not.toContain("segredo-vazado");
      expect(texto).not.toContain("jwt-secreto");
      expect(texto).not.toMatch(/Bearer/);
    }
  });
});

describe("prime-sonda / caminhos de leitura", () => {
  it("aceita as seis rotas de leitura do catalogo", () => {
    for (const c of [
      "/carriers",
      "/students?search=052.961.800-11&carrierId=195&take=10",
      "/students/2025001213",
      "/students/2025001213/contracts",
      "/students/2025001213/financial-statement?take=500",
      "/students/2025001213/agreements",
    ]) {
      expect(caminhoPermitido(c), c).toBe(true);
    }
  });

  it("recusa o que nao esta catalogado, inclusive tentativa de sair do caminho", () => {
    for (const c of [
      "",
      "students/123",                        // sem barra inicial
      "/admin",
      "/students/123/payments",              // rota nao mapeada
      "/students/../../admin",               // travessia
      "/students//123",                      // barra dupla
      "/students/123/contracts/../../admin",
      "http://outro.host/students/123",      // host trocado
    ]) {
      expect(caminhoPermitido(c), c).toBe(false);
    }
  });

  it("a lista e fechada: nenhum padrao casa caminho arbitrario", () => {
    for (const re of CAMINHOS_PERMITIDOS) {
      expect(re.test("/qualquer/coisa/inventada")).toBe(false);
    }
  });
});
