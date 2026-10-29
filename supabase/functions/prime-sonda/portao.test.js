// Testes do portao da `prime-sonda`.
//
// O QUE ESTES TESTES PROTEGEM. Esta funcao segura a chave que da acesso a CPF e
// dados financeiros de ~400 mil pessoas. O portao e a ultima coisa entre essa
// chave e quem chama -- a primeira e o gateway, ver abaixo.
//
// O QUE ELES NAO COBREM, DE PROPOSITO: a autenticacao do GATEWAY
// (`verify_jwt = true`, registrado em supabase/config.toml). O gateway exige um
// JWT valido no `Authorization` antes de executar uma linha da funcao, e isso
// vale para as DUAS portas -- inclusive a da rotina. Teste unitario nao
// atravessa gateway; essa camada se verifica na configuracao implantada. Os
// casos abaixo comecam do ponto em que o gateway JA deixou a chamada passar.
//
// O segredo da rotina entra como valor e o verificador de sessao como funcao,
// entao o codigo exercitado aqui e exatamente o que roda em producao, e nao uma
// reimplementacao parecida.

import { describe, it, expect } from "vitest";
import {
  decidirAcesso,
  tokenDaRotinaConfere,
  caminhoPermitido,
  CAMINHOS_PERMITIDOS,
} from "./portao.ts";

const SEGREDO = "segredo-da-rotina-em-ambiente";

const bancoDizQueEhGestao = async () => true;
const bancoDizQueNaoEhGestao = async () => false;

const base = {
  tokenRecebido: "",
  segredoRotina: SEGREDO,
  autorizacao: "",
  validarGestao: bancoDizQueNaoEhGestao,
};

describe("prime-sonda / portao", () => {
  it("1. ROTINA AUTORIZADA: token que bate com o segredo de ambiente entra", async () => {
    const d = await decidirAcesso({ ...base, tokenRecebido: SEGREDO });
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
      expect(d.ok, autorizacao).toBe(false);
      expect(d.status, autorizacao).toBe(401);
      expect(d.corpo.erro).toBe("SEM_TOKEN");
    }
    expect(consultou).toBe(false);
  });

  it("4b. SESSAO INVALIDA: JWT expirado faz a RPC falhar -> false -> 403, nunca passa", async () => {
    const d = await decidirAcesso({
      ...base,
      autorizacao: "Bearer jwt-expirado",
      validarGestao: async () => false,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
  });

  it("5. SEGREDO AUSENTE: nao libera acesso anonimo -- a regressao que este PR fecha", async () => {
    // O portao ANTIGO era `if (esperado && recebido !== esperado) { 401 }`. Com
    // o segredo ausente, `esperado` era "", a condicao inteira dava falso e a
    // funcao seguia SEM token nenhum.
    // "" cobre tanto o secret nao definido quanto o definido vazio: em
    // index.ts, `Deno.env.get(...) ?? Deno.env.get(...) ?? ""` colapsa os dois.
    for (const segredoRotina of [""]) {
      // chamador anonimo, sem token e sem sessao
      const anonimo = await decidirAcesso({ ...base, segredoRotina });
      expect(anonimo.ok).toBe(false);
      expect(anonimo.status).toBe(401);

      // chamador com um token qualquer: sem segredo, nada confere
      const comChute = await decidirAcesso({ ...base, segredoRotina, tokenRecebido: "chute" });
      expect(comChute.ok).toBe(false);
      expect(comChute.status).toBe(401);
      expect(comChute.corpo.erro).toBe("TOKEN_INVALIDO");

      // e nem string vazia como token abre
      expect(tokenDaRotinaConfere("", segredoRotina)).toBe(false);
    }
  });

  it("5b. SEGREDO AUSENTE nao fecha a porta da gestao: ela nao depende do segredo", async () => {
    const d = await decidirAcesso({
      ...base,
      segredoRotina: "",
      autorizacao: "Bearer jwt-da-amanda",
      validarGestao: bancoDizQueEhGestao,
    });
    expect(d).toEqual({ ok: true, via: "gestao" });
  });

  it("token da rotina: so confere no valor exato", () => {
    expect(tokenDaRotinaConfere(SEGREDO, SEGREDO)).toBe(true);
    expect(tokenDaRotinaConfere(SEGREDO + "x", SEGREDO)).toBe(false);
    expect(tokenDaRotinaConfere(SEGREDO.slice(0, -1), SEGREDO)).toBe(false);
    expect(tokenDaRotinaConfere(SEGREDO.toUpperCase(), SEGREDO)).toBe(false);
    expect(tokenDaRotinaConfere(" " + SEGREDO, SEGREDO)).toBe(false);
  });

  it("token invalido nao ganha segunda chance pela porta da gestao", async () => {
    const d = await decidirAcesso({
      ...base,
      tokenRecebido: "token-errado",
      autorizacao: "Bearer jwt-da-amanda",
      validarGestao: bancoDizQueEhGestao, // seria aceito, se fosse consultado
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  it("nenhuma resposta de recusa carrega credencial", async () => {
    const recusas = await Promise.all([
      decidirAcesso({ ...base, tokenRecebido: "token-errado", segredoRotina: SEGREDO }),
      decidirAcesso({ ...base, autorizacao: "Bearer jwt-secreto" }),
      decidirAcesso({ ...base }),
    ]);
    for (const d of recusas) {
      const texto = JSON.stringify(d.corpo);
      expect(texto).not.toContain(SEGREDO);
      expect(texto).not.toContain("token-errado");
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
      "students/123",
      "/admin",
      "/students/123/payments",
      "/students/../../admin",
      "/students//123",
      "/students/123/contracts/../../admin",
      "http://outro.host/students/123",
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
