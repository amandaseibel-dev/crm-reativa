import { describe, expect, it } from "vitest";
import { cadastrarTokenPessoal, type DepsTokenPessoal, type IdentidadeToken } from "./token-pessoal.ts";
import { estadoConexao } from "./conexao.ts";

const TOKEN_VALIDO = "tok_teste_piloto_0123456789abcdef";
const AGORA = Date.parse("2026-11-17T12:00:00Z");

function deps(over: Partial<DepsTokenPessoal> & { identidade?: IdentidadeToken; erro?: string } = {}) {
  const gravados: Array<{ dados: { access_token: string; expira_em_ms: number }; extra: Record<string, unknown> }> = [];
  const d: DepsTokenPessoal = {
    email: "amanda.seibel@aelbra.com.br",
    agoraMs: AGORA,
    identidadeDoToken: async () => {
      if (over.erro) throw new Error(over.erro);
      return over.identidade ?? { pessoa_email: "amanda.seibel@aelbra.com.br", pessoa_nome: "Amanda", escopos: ["ver clientes"], so_leitura: false };
    },
    guardar: async (dados, extra) => { gravados.push({ dados, extra }); },
    ...over,
  };
  return { d, gravados };
}

describe("cadastro de token pessoal", () => {
  it("token da própria pessoa logada: grava cifrado com validade e NÃO devolve o token", async () => {
    const { d, gravados } = deps();
    const r = await cadastrarTokenPessoal(d, TOKEN_VALIDO, 30);
    expect(r.ok).toBe(true);
    expect(gravados).toHaveLength(1);
    expect(gravados[0].dados.access_token).toBe(TOKEN_VALIDO);
    expect(gravados[0].dados.expira_em_ms).toBe(AGORA + 30 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(r)).not.toContain(TOKEN_VALIDO);
  });

  it("e-mail do token diferente do usuário logado: recusa e não grava nada (A2)", async () => {
    const { d, gravados } = deps({ identidade: { pessoa_email: "cobranca07@aelbra.com.br", pessoa_nome: "X", escopos: null, so_leitura: null } });
    const r = await cadastrarTokenPessoal(d, TOKEN_VALIDO, 30);
    expect(r).toEqual({ ok: false, motivo: "IDENTIDADE_DIVERGENTE" });
    expect(gravados).toHaveLength(0);
  });

  it("token sem e-mail na resposta de meu_acesso: fail-closed, não grava", async () => {
    const { d, gravados } = deps({ identidade: { pessoa_email: null, pessoa_nome: "X", escopos: null, so_leitura: null } });
    const r = await cadastrarTokenPessoal(d, TOKEN_VALIDO, 30);
    expect(r).toEqual({ ok: false, motivo: "IDENTIDADE_DIVERGENTE" });
    expect(gravados).toHaveLength(0);
  });

  it("comparação de e-mail ignora maiúsculas, mas não aceita outra pessoa", async () => {
    const { d, gravados } = deps({ identidade: { pessoa_email: "Amanda.Seibel@AELBRA.com.br", pessoa_nome: "A", escopos: null, so_leitura: null } });
    expect((await cadastrarTokenPessoal(d, TOKEN_VALIDO, 7)).ok).toBe(true);
    expect(gravados).toHaveLength(1);
  });

  it("Mensageria recusa o token (401/403): motivo próprio, nada gravado", async () => {
    const { d, gravados } = deps({ erro: "ULBRA_AUTENTICACAO" });
    expect(await cadastrarTokenPessoal(d, TOKEN_VALIDO, 30)).toEqual({ ok: false, motivo: "TOKEN_RECUSADO_PELA_MENSAGERIA" });
    expect(gravados).toHaveLength(0);
  });

  it("Mensageria indisponível ou limite: motivo de indisponibilidade, nada gravado", async () => {
    const { d, gravados } = deps({ erro: "ULBRA_LIMITE" });
    expect(await cadastrarTokenPessoal(d, TOKEN_VALIDO, 30)).toEqual({ ok: false, motivo: "MENSAGERIA_INDISPONIVEL" });
    expect(gravados).toHaveLength(0);
  });

  it("formato inválido (vazio, curto, com espaço) e validade fora da lista: nem chama a Mensageria", async () => {
    let chamadas = 0;
    const { d, gravados } = deps({ identidadeDoToken: async () => { chamadas++; throw new Error("nao devia"); } });
    expect((await cadastrarTokenPessoal(d, "", 30)).motivo).toBe("TOKEN_FORMATO_INVALIDO");
    expect((await cadastrarTokenPessoal(d, "curto", 30)).motivo).toBe("TOKEN_FORMATO_INVALIDO");
    expect((await cadastrarTokenPessoal(d, "tem espaco no meio do token 123", 30)).motivo).toBe("TOKEN_FORMATO_INVALIDO");
    expect((await cadastrarTokenPessoal(d, TOKEN_VALIDO, 45)).motivo).toBe("VALIDADE_NAO_PERMITIDA");
    expect(chamadas).toBe(0);
    expect(gravados).toHaveLength(0);
  });
});

describe("expiração sem refresh token", () => {
  it("token pessoal vencido vira EXPIRADA: envio e leitura bloqueados", () => {
    const registro = {
      access_token: TOKEN_VALIDO, refresh_token: null, expira_em_ms: AGORA - 1000, revogada_em_ms: null,
      operador_email: "amanda.seibel@aelbra.com.br", pessoa_email: "amanda.seibel@aelbra.com.br", pessoa_nome: "A",
    } as unknown as Parameters<typeof estadoConexao>[0];
    expect(estadoConexao(registro, AGORA)).toBe("EXPIRADA");
  });

  it("token pessoal dentro da validade: ATIVA", () => {
    const registro = {
      access_token: TOKEN_VALIDO, refresh_token: null, expira_em_ms: AGORA + 10 * 86400000, revogada_em_ms: null,
      operador_email: "amanda.seibel@aelbra.com.br", pessoa_email: "amanda.seibel@aelbra.com.br", pessoa_nome: "A",
    } as unknown as Parameters<typeof estadoConexao>[0];
    expect(estadoConexao(registro, AGORA)).toBe("ATIVA");
  });
});
