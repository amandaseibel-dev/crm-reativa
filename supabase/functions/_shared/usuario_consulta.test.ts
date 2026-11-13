// Consulta de identidade por e-mail: o que o banco efetivamente recebe.
// Dublê que aplica igualdade exata (como o Postgres com .eq) e NÃO tem .ilike:
// reintroduzir ilike quebra estes testes. Sem rede.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buscarUsuarioAtivoPorEmail, type ClienteUsuarios } from "./email_exato";

type Linha = Record<string, unknown>;

function banco(linhas: Linha[]) {
  const chamadas: Array<[string, unknown]> = [];
  const cliente: ClienteUsuarios = {
    from(tabela: string) {
      if (tabela !== "usuarios") throw new Error(`tabela inesperada: ${tabela}`);
      const filtros: Array<[string, unknown]> = [];
      let limite = Infinity;
      const q = {
        select(c: string) { chamadas.push(["select", c]); return q; },
        eq(coluna: string, valor: unknown) { chamadas.push(["eq", `${coluna}=${String(valor)}`]); filtros.push([coluna, valor]); return q; },
        limit(n: number) { chamadas.push(["limit", n]); limite = n; return q; },
        async maybeSingle() { throw new Error("não deve usar maybeSingle: duplicidade precisa ser vista"); },
        then(resolve: (v: unknown) => void) {
          const achadas = linhas.filter((l) => filtros.every(([c, v]) => l[c] === v)).slice(0, limite);
          resolve({ data: achadas, error: null });
        },
      };
      return q;
    },
  };
  return { cliente, chamadas };
}

const ATIVO = { email: "cobranca10@aelbra.com.br", perfil: "operador", ativo: true };
const CONSULTA = "email, perfil";

describe("consulta: forma exata enviada ao banco", () => {
  it("usa select pedido, eq em email e ativo, e limit 2; nunca ilike", async () => {
    const { cliente, chamadas } = banco([ATIVO]);
    await buscarUsuarioAtivoPorEmail(cliente, "COBRANCA10@AELBRA.COM.BR ", CONSULTA);
    expect(chamadas).toEqual([
      ["select", CONSULTA],
      ["eq", "email=cobranca10@aelbra.com.br"],
      ["eq", "ativo=true"],
      ["limit", 2],
    ]);
  });
  it("e-mail vazio não consulta o banco", async () => {
    const { cliente, chamadas } = banco([ATIVO]);
    expect(await buscarUsuarioAtivoPorEmail(cliente, "   ", CONSULTA)).toBeNull();
    expect(await buscarUsuarioAtivoPorEmail(cliente, null, CONSULTA)).toBeNull();
    expect(chamadas).toHaveLength(0);
  });
});

describe("identidade: operadores de padrão não casam outra conta", () => {
  const casos: Array<[string, string, string]> = [
    ["underscore", "cobranca_10@aelbra.com.br", "cobranca10@aelbra.com.br"],
    ["percent", "cobranca%@aelbra.com.br", "cobranca10@aelbra.com.br"],
    ["asterisco", "cobranca*@aelbra.com.br", "cobranca10@aelbra.com.br"],
    ["barra invertida", "cobranca\\10@aelbra.com.br", "cobranca10@aelbra.com.br"],
    ["prefixo", "cobranca@aelbra.com.br", "cobranca10@aelbra.com.br"],
    ["sufixo", "10@aelbra.com.br", "cobranca10@aelbra.com.br"],
    ["domínio parcial", "cobranca10@aelbra", "cobranca10@aelbra.com.br"],
  ];
  for (const [nome, pedido, cadastrado] of casos) {
    it(`${nome}: ${pedido} não encontra ${cadastrado}`, async () => {
      const { cliente } = banco([{ ...ATIVO, email: cadastrado }]);
      expect(await buscarUsuarioAtivoPorEmail(cliente, pedido, CONSULTA)).toBeNull();
    });
  }
  it("com os dois cadastrados, cada pedido acha só o seu", async () => {
    const { cliente } = banco([{ ...ATIVO, email: "cobranca_10@aelbra.com.br" }, ATIVO]);
    expect((await buscarUsuarioAtivoPorEmail<{ email: string }>(cliente, "cobranca_10@aelbra.com.br", CONSULTA))?.email).toBe("cobranca_10@aelbra.com.br");
    expect((await buscarUsuarioAtivoPorEmail<{ email: string }>(cliente, "cobranca10@aelbra.com.br", CONSULTA))?.email).toBe("cobranca10@aelbra.com.br");
  });
});

describe("cadastros ativos e inativos", () => {
  it("usuário inativo não entra, mesmo com e-mail exato", async () => {
    const { cliente } = banco([{ ...ATIVO, ativo: false }]);
    expect(await buscarUsuarioAtivoPorEmail(cliente, "cobranca10@aelbra.com.br", CONSULTA)).toBeNull();
  });
  it("duplicidade ativa exata é negada (duas linhas)", async () => {
    const { cliente } = banco([ATIVO, { ...ATIVO, perfil: "gerencia" }]);
    expect(await buscarUsuarioAtivoPorEmail(cliente, "cobranca10@aelbra.com.br", CONSULTA)).toBeNull();
  });
  it("uma linha ativa devolve a identidade, com o perfil", async () => {
    const { cliente } = banco([ATIVO]);
    expect(await buscarUsuarioAtivoPorEmail(cliente, "cobranca10@aelbra.com.br", CONSULTA)).toEqual({ email: "cobranca10@aelbra.com.br", perfil: "operador", ativo: true });
  });
  it("gestão: o perfil devolvido é o que a função usa para liberar", async () => {
    const { cliente } = banco([{ email: "gestao@aelbra.com.br", perfil: "gerencia", ativo: true }]);
    expect((await buscarUsuarioAtivoPorEmail<{ perfil: string }>(cliente, "gestao@aelbra.com.br", CONSULTA))?.perfil).toBe("gerencia");
  });
  it("operador sem cadastro ativo não é identificado", async () => {
    const { cliente } = banco([]);
    expect(await buscarUsuarioAtivoPorEmail(cliente, "sem.vinculo@aelbra.com.br", CONSULTA)).toBeNull();
  });
});

describe("limitações conhecidas (documentadas, não escondidas)", () => {
  it("cadastro gravado com maiúscula NÃO casa com o pedido normalizado (negação segura)", async () => {
    const { cliente } = banco([{ ...ATIVO, email: "Cobranca10@aelbra.com.br" }]);
    expect(await buscarUsuarioAtivoPorEmail(cliente, "cobranca10@aelbra.com.br", CONSULTA)).toBeNull();
  });
  it("duplicidade que difere só por caixa NÃO é detectada: a minúscula é aceita", async () => {
    const { cliente } = banco([ATIVO, { ...ATIVO, email: "Cobranca10@aelbra.com.br" }]);
    expect((await buscarUsuarioAtivoPorEmail<{ email: string }>(cliente, "cobranca10@aelbra.com.br", CONSULTA))?.email).toBe("cobranca10@aelbra.com.br");
  });
});

describe("as cinco funções usam o helper e nenhuma usa ilike", () => {
  const FUNCOES = ["ulbra-atendimento", "ulbra-consultar", "ulbra-diagnostico", "ulbra-leads-pendentes", "ulbra-historico"];
  for (const f of FUNCOES) {
    it(`${f}: chama buscarUsuarioAtivoPorEmail e não tem .ilike(`, () => {
      const src = readFileSync(new URL(`../${f}/index.ts`, import.meta.url), "utf8");
      // chamada real (não só import): "await buscarUsuarioAtivoPorEmail<...>(" ou "(...)"
      expect(/await buscarUsuarioAtivoPorEmail[<(]/.test(src)).toBe(true);
      expect(/\.ilike\(/.test(src)).toBe(false);
      // a consulta direta à tabela usuarios por e-mail não pode mais existir na função
      expect(/\.from\("usuarios"\)[\s\S]{0,200}\.eq\("email"/.test(src)).toBe(false);
    });
  }
});
