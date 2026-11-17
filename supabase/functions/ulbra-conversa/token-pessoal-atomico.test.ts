// Testes da regra de NÃO SUBSTITUIR conexão existente, com um armazenamento falso que serializa
// as gravações (modela a trava de linha de ulbra_gravar_conexao). A atomicidade REAL, com duas
// conexões no Postgres, está em supabase/tests/ulbra_conexao_token/run.cjs (CI, postgres 17).
import { describe, expect, it } from "vitest";
import { cadastrarTokenPessoal, type DepsTokenPessoal } from "./token-pessoal.ts";

type Linha = { access: string; refresh: string | null } | null;

class ArmazenFalso {
  linha: Linha = null;
  falharLeitura = false;
  private fila: Promise<unknown> = Promise.resolve();

  /** Equivale a ulbra_gravar_conexao: serializada, e não grava se já há credencial. */
  gravar(t: { access: string; refresh: string | null }): Promise<"GRAVADA" | "EXISTENTE"> {
    const op = this.fila.then(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      if (this.falharLeitura) throw new Error("VERIFICACAO_INDISPONIVEL");
      if (this.linha) return "EXISTENTE" as const;
      this.linha = { access: t.access, refresh: t.refresh };
      return "GRAVADA" as const;
    });
    this.fila = op.catch(() => undefined);
    return op;
  }
}

const AGORA = Date.parse("2026-11-17T12:00:00Z");
const EMAIL = "amanda.seibel@aelbra.com.br";

function depsToken(store: ArmazenFalso): DepsTokenPessoal {
  return {
    email: EMAIL,
    agoraMs: AGORA,
    identidadeDoToken: async () => ({ pessoa_email: EMAIL, pessoa_nome: "Amanda", escopos: null, so_leitura: false }),
    guardar: (dados) => store.gravar({ access: dados.access_token, refresh: null }),
  };
}

const TOKEN = "tok_piloto_0123456789abcdef_gestora";

describe("erro de leitura ou gravação: nada é gravado", () => {
  it("falha do banco antes de gravar: cadastro falha e a linha existente não muda", async () => {
    const store = new ArmazenFalso();
    store.linha = { access: "existente", refresh: "r" };
    store.falharLeitura = true;
    await expect(cadastrarTokenPessoal(depsToken(store), TOKEN, 30)).rejects.toThrow("VERIFICACAO_INDISPONIVEL");
    expect(store.linha).toEqual({ access: "existente", refresh: "r" });
  });

  it("falha do banco sem linha prévia: nada é gravado", async () => {
    const store = new ArmazenFalso();
    store.falharLeitura = true;
    await expect(cadastrarTokenPessoal(depsToken(store), TOKEN, 30)).rejects.toThrow();
    expect(store.linha).toBeNull();
  });
});

describe("OAuth ativo: preservado, com ou sem refresh_token", () => {
  it("OAuth com refresh ativo: token pessoal recusado (CONEXAO_EXISTENTE) e a conexão fica igual", async () => {
    const store = new ArmazenFalso();
    store.linha = { access: "oauth_access", refresh: "oauth_refresh" };
    const r = await cadastrarTokenPessoal(depsToken(store), TOKEN, 30);
    expect(r).toEqual({ ok: false, motivo: "CONEXAO_EXISTENTE" });
    expect(store.linha).toEqual({ access: "oauth_access", refresh: "oauth_refresh" });
  });

  it("OAuth sem refresh_token (só access): também recusado e preservado", async () => {
    const store = new ArmazenFalso();
    store.linha = { access: "oauth_access", refresh: null };
    const r = await cadastrarTokenPessoal(depsToken(store), TOKEN, 30);
    expect(r).toEqual({ ok: false, motivo: "CONEXAO_EXISTENTE" });
    expect(store.linha).toEqual({ access: "oauth_access", refresh: null });
  });

  it("credencial revogada na Mensageria mas com refresh guardado (A4): recusado, preservado", async () => {
    const store = new ArmazenFalso();
    store.linha = { access: "a", refresh: "r_ainda_valido" };
    expect((await cadastrarTokenPessoal(depsToken(store), TOKEN, 30)).ok).toBe(false);
    expect(store.linha).toEqual({ access: "a", refresh: "r_ainda_valido" });
  });

  it("sem linha: token pessoal grava", async () => {
    const store = new ArmazenFalso();
    expect((await cadastrarTokenPessoal(depsToken(store), TOKEN, 30)).ok).toBe(true);
    expect(store.linha).toEqual({ access: TOKEN, refresh: null });
  });
});

describe("concorrência: uma gravação vence, a outra é recusada", () => {
  it("duas tentativas de cadastro de token ao mesmo tempo: exatamente uma grava", async () => {
    const store = new ArmazenFalso();
    const [a, b] = await Promise.all([
      cadastrarTokenPessoal(depsToken(store), "tok_A_0123456789abcdef_ok", 30),
      cadastrarTokenPessoal(depsToken(store), "tok_B_0123456789abcdef_ok", 30),
    ]);
    const oks = [a, b].filter((r) => r.ok).length;
    const recusas = [a, b].filter((r) => !r.ok && r.motivo === "CONEXAO_EXISTENTE").length;
    expect(oks).toBe(1);
    expect(recusas).toBe(1);
    expect(store.linha?.access).toMatch(/^tok_[AB]_/);
  });

  it("cadastro de token concorrente com conclusão OAuth: só uma credencial sobrevive", async () => {
    const store = new ArmazenFalso();
    const oauth = store.gravar({ access: "oauth_access", refresh: "oauth_refresh" });
    const token = cadastrarTokenPessoal(depsToken(store), TOKEN, 30);
    const [gravOauth, resToken] = await Promise.all([oauth, token]);
    const venceuOauth = gravOauth === "GRAVADA";
    expect(venceuOauth !== resToken.ok).toBe(true);
    expect(store.linha).not.toBeNull();
    if (venceuOauth) expect(store.linha?.access).toBe("oauth_access");
    else expect(store.linha?.access).toBe(TOKEN);
  });
});
