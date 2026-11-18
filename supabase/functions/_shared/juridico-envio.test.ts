// Testes do helper de bloqueio jurídico nos envios (roda no vitest; sem Deno).
import { describe, it, expect } from "vitest";
import { sha256Hex, checarEnvioJuridico, alunoDaConversa, hashDocumento } from "./juridico-envio";

const base = { alunoId: "a1", conversaId: "c1", operador: "op@x", tipo: "MENSAGEM" as const, hash: "h" };

describe("sha256Hex", () => {
  it("vetor conhecido em hexadecimal (texto e bytes do mesmo conteudo)", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(await sha256Hex("abc"));
  });
});

describe("checarEnvioJuridico (fail-closed)", () => {
  it("passa quando o banco nao recusa e chama a funcao certa com os argumentos certos", async () => {
    const chamadas: Array<[string, any]> = [];
    const r = await checarEnvioJuridico(async (n, a) => { chamadas.push([n, a]); return { error: null }; }, base);
    expect(r).toEqual({ ok: true });
    expect(chamadas[0][0]).toBe("juridico_checar_envio");
    expect(chamadas[0][1]).toEqual({ p_aluno: "a1", p_conversa: "c1", p_operador: "op@x", p_tipo: "MENSAGEM", p_conteudo_hash: "h" });
  });

  it("recusa quando o banco devolve erro (bloqueio, aluno ausente, autorizacao ausente)", async () => {
    const r = await checarEnvioJuridico(async () => ({ error: { message: "Envio bloqueado: aluno com bloqueio jurídico." } }), base);
    expect(r.ok).toBe(false);
  });

  it("recusa juridica (JUR01) e marcada como bloqueio; erro de infraestrutura nao", async () => {
    const juridica = await checarEnvioJuridico(async () => ({ error: { message: "Envio bloqueado", code: "JUR01" } as any }), base);
    expect(juridica.ok).toBe(false);
    if (!juridica.ok) expect(juridica.bloqueio).toBe(true);
    const infra = await checarEnvioJuridico(async () => ({ error: { message: "timeout", code: "57014" } as any }), base);
    expect(infra.ok).toBe(false);
    if (!infra.ok) expect(infra.bloqueio).toBe(false);
    const semGrant = await checarEnvioJuridico(async () => ({ error: { message: "permission denied", code: "42501" } as any }), base);
    expect(semGrant.ok).toBe(false);
    if (!semGrant.ok) expect(semGrant.bloqueio).toBe(false);
  });

  it("recusa quando a chamada lanca excecao (rede, RPC indisponivel)", async () => {
    const r = await checarEnvioJuridico(async () => { throw new Error("rede caiu"); }, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toMatch(/envio não realizado/);
  });
});

describe("alunoDaConversa", () => {
  const admin = (resp: { data?: any; error?: any }) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => resp }) }) }),
  });
  it("devolve o aluno da conversa", async () => {
    expect(await alunoDaConversa(admin({ data: { aluno_id: "a9" }, error: null }), "c1")).toEqual({ ok: true, alunoId: "a9" });
  });
  it("conversa sem aluno devolve null (a checagem recusa depois)", async () => {
    expect(await alunoDaConversa(admin({ data: { aluno_id: null }, error: null }), "c1")).toEqual({ ok: true, alunoId: null });
  });
  it("erro de leitura recusa (nao segue sem identificar o aluno)", async () => {
    const r = await alunoDaConversa(admin({ data: null, error: { message: "x" } }), "c1");
    expect(r.ok).toBe(false);
  });
});

describe("hashDocumento", () => {
  const b = new TextEncoder().encode("PDF-conteudo");
  it("muda se o nome ou o mime mudar (ambos vao para o gateway)", async () => {
    const h = await hashDocumento("a.pdf", "application/pdf", b);
    expect(await hashDocumento("a.pdf", "application/pdf", b)).toBe(h);
    expect(await hashDocumento("b.pdf", "application/pdf", b)).not.toBe(h);
    expect(await hashDocumento("a.pdf", "text/plain", b)).not.toBe(h);
    expect(await hashDocumento("a.pdf", "application/pdf", new TextEncoder().encode("outro"))).not.toBe(h);
  });
});
