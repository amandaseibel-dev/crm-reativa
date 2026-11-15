// Portão de acesso: token do cabeçalho e busca de usuário por e-mail EXATO.
// Sem rede. O banco é um dublê que aplica igualdade exata, como o Postgres faria
// com .eq, e não tem .ilike: qualquer retorno a ILIKE quebra estes testes.
import { describe, it, expect } from "vitest";
import { buscarUsuarioAtivo, normalizarEmail, tokenDoHeader, type ClienteUsuarios } from "./acesso";

type Linha = Record<string, unknown>;

function bancoDublê(linhas: Linha[]): { cliente: ClienteUsuarios; consultas: Array<[string, string, unknown]> } {
  const consultas: Array<[string, string, unknown]> = [];
  const cliente: ClienteUsuarios = {
    from(tabela: string) {
      if (tabela !== "usuarios") throw new Error(`tabela inesperada: ${tabela}`);
      let filtros: Array<[string, unknown]> = [];
      const q = {
        select() { return q; },
        eq(coluna: string, valor: unknown) { consultas.push(["eq", coluna, valor]); filtros.push([coluna, valor]); return q; },
        limit() { return q; },
        async maybeSingle() {
          const achou = linhas.find((l) => filtros.every(([c, v]) => l[c] === v));
          return { data: achou ?? null, error: null };
        },
      };
      return q;
    },
  };
  return { cliente, consultas };
}

const OPERADOR = { email: "cobranca10@aelbra.com.br", perfil: "operador", ativo: true };
const COM_MARCA = { email: "cobranca_10@aelbra.com.br", perfil: "operador", ativo: true };

describe("tokenDoHeader: sem token, nada passa", () => {
  it("cabeçalho ausente, vazio ou de outro esquema não tem token", () => {
    expect(tokenDoHeader(null)).toBeNull();
    expect(tokenDoHeader("")).toBeNull();
    expect(tokenDoHeader("Basic abc")).toBeNull();
    expect(tokenDoHeader("bearer abc")).toBeNull();
  });
  it("Bearer sem token, ou só com espaços, não tem token", () => {
    expect(tokenDoHeader("Bearer ")).toBeNull();
    expect(tokenDoHeader("Bearer    ")).toBeNull();
  });
  it("Bearer com token devolve só o token", () => {
    expect(tokenDoHeader("Bearer eyJabc.def")).toBe("eyJabc.def");
  });
});

describe("normalizarEmail", () => {
  it("minúsculas e sem espaços nas pontas", () => {
    expect(normalizarEmail("  Cobranca10@AELBRA.com.br ")).toBe("cobranca10@aelbra.com.br");
  });
});

describe("buscarUsuarioAtivo: correspondência exata, nunca por padrão", () => {
  it("encontra o usuário ativo pelo e-mail exato, mesmo que o pedido venha em maiúsculas", async () => {
    const { cliente, consultas } = bancoDublê([OPERADOR]);
    const u = await buscarUsuarioAtivo(cliente, "COBRANCA10@AELBRA.COM.BR");
    expect(u).toEqual({ email: "cobranca10@aelbra.com.br", perfil: "operador" });
    expect(consultas).toContainEqual(["eq", "email", "cobranca10@aelbra.com.br"]);
  });

  it("'_' não é curinga: cobranca_10@ NÃO herda a conta cobranca10@", async () => {
    const { cliente } = bancoDublê([OPERADOR]);
    expect(await buscarUsuarioAtivo(cliente, "cobranca_10@aelbra.com.br")).toBeNull();
  });

  it("usuário com '_' real só encontra a si mesmo, não o vizinho sem '_'", async () => {
    const { cliente } = bancoDublê([OPERADOR, COM_MARCA]);
    expect((await buscarUsuarioAtivo(cliente, "cobranca_10@aelbra.com.br"))?.email).toBe("cobranca_10@aelbra.com.br");
    expect((await buscarUsuarioAtivo(cliente, "cobranca10@aelbra.com.br"))?.email).toBe("cobranca10@aelbra.com.br");
  });

  it("'%' também não casa por padrão", async () => {
    const { cliente } = bancoDublê([OPERADOR]);
    expect(await buscarUsuarioAtivo(cliente, "cobranca%@aelbra.com.br")).toBeNull();
  });

  it("usuário inativo não entra, mesmo com o e-mail exato", async () => {
    const { cliente } = bancoDublê([{ ...OPERADOR, ativo: false }]);
    expect(await buscarUsuarioAtivo(cliente, "cobranca10@aelbra.com.br")).toBeNull();
  });

  it("e-mail vazio não consulta nem devolve ninguém", async () => {
    const { cliente, consultas } = bancoDublê([OPERADOR]);
    expect(await buscarUsuarioAtivo(cliente, "   ")).toBeNull();
    expect(consultas).toHaveLength(0);
  });

  it("e-mail sem cadastro devolve null", async () => {
    const { cliente } = bancoDublê([OPERADOR]);
    expect(await buscarUsuarioAtivo(cliente, "estranho@aelbra.com.br")).toBeNull();
  });
});
