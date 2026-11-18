// Testes dos HANDLERS REAIS de texto (whatsapp-send) com transporte simulado: Deno, Supabase e gateway
// são simulados; o index.ts é carregado de verdade. Prova que a recusa jurídica vem ANTES de qualquer
// preparo, de qualquer registro e de qualquer chamada ao gateway.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

type Chamada = { nome: string; args: any };
const estado = {
  chamadas: [] as Chamada[],
  checar: null as null | { code: string; message: string },
  preparoLanca: false,
  conversaAluno: "aluno-1" as string | null,
  acesso: true,
  ativo: true,
  desligado: false,
  handler: null as null | ((req: Request) => Promise<Response>),
  gatewayChamadas: 0,
  gatewayResposta: { ok: true, wamid: "W-1" } as any,
};

vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({
  createClient: (_url: string, _chave: string) => ({
    rpc: (nome: string, args: any) => ({
      then: (ok: any, ko: any) => {
        estado.chamadas.push({ nome, args });
        let r: any = { data: null, error: null };
        if (nome === "app_usuario_ativo") r = { data: estado.ativo, error: null };
        if (nome === "juridico_checar_envio" && estado.checar) r = { data: null, error: estado.checar };
        if (nome === "whatsapp_preparar_envio") {
          if (estado.preparoLanca) throw new Error("preparo falhou");
          r = { data: [{ sessao_chave: "sessao-1", telefone_e164: "5511999000001", operador_email: "op1@x", conversa_id: args.p_conversa_id ?? null, ja_existia: true }], error: null };
        }
        return Promise.resolve(r).then(ok, ko);
      },
    }),
    from: (tabela: string) => ({
      select: (campo: string) => ({
        eq: () => ({
          maybeSingle: async () => {
            estado.chamadas.push({ nome: `from:${tabela}`, args: {} });
            if (campo === "id") return { data: estado.acesso ? { id: "c-1" } : null, error: null };
            return { data: { aluno_id: estado.conversaAluno }, error: null };
          },
        }),
      }),
    }),
    auth: { getUser: async () => ({ data: { user: { email: "op1@x" } }, error: null }) },
  }),
}));

(globalThis as any).Deno = {
  env: {
    get: (k: string) => ({
      SUPABASE_URL: "http://supabase.local",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      WHATSAPP_GATEWAY_URL: "http://gateway.local",
      WHATSAPP_GATEWAY_TOKEN: "tok",
      ENVIO_WHATSAPP_DESLIGADO: estado.desligado ? "true" : undefined,
    } as Record<string, string>)[k],
  },
  serve: (h: any) => { estado.handler = h; },
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

beforeEach(async () => {
  estado.chamadas = [];
  estado.checar = null;
  estado.preparoLanca = false;
  estado.conversaAluno = "aluno-1";
  estado.acesso = true;
  estado.ativo = true;
  estado.desligado = false;
  estado.gatewayChamadas = 0;
  estado.gatewayResposta = { ok: true, wamid: "W-1" };
  (globalThis as any).fetch = vi.fn(async () => {
    estado.gatewayChamadas++;
    return { ok: true, status: 200, json: async () => estado.gatewayResposta };
  });
  if (!estado.handler) await import("./index.ts");
});

const pedido = (corpo: Record<string, unknown>) =>
  new Request("http://fn.local/whatsapp-send", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer jwt-do-operador" },
    body: JSON.stringify(corpo),
  });
const nomes = () => estado.chamadas.map((c) => c.nome);

describe("whatsapp-send (handler real): texto com bloqueio jurídico", () => {
  it("envio autorizado: checa antes do preparo e chama o gateway uma vez", async () => {
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Olá" }));
    expect(r.status).toBe(200);
    expect(nomes().indexOf("juridico_checar_envio")).toBeLessThan(nomes().indexOf("whatsapp_preparar_envio"));
    expect(estado.gatewayChamadas).toBe(1);
    const chec = estado.chamadas.find((c) => c.nome === "juridico_checar_envio")!;
    expect(chec.args.p_conteudo_hash).toBe(sha("Olá"));
    expect(chec.args.p_aluno).toBe("aluno-1");
  });

  it("recusa jurídica (JUR01): 403, sem preparo, sem gateway, sem FALHOU, com trilha da recusa", async () => {
    estado.checar = { code: "JUR01", message: "Envio bloqueado: aluno com bloqueio jurídico." };
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Cobrança" }));
    expect(r.status).toBe(403);
    expect(nomes()).not.toContain("whatsapp_preparar_envio");
    expect(nomes()).not.toContain("whatsapp_registrar_mensagem");
    expect(estado.gatewayChamadas).toBe(0);
    expect(nomes()).toContain("juridico_registrar_recusa_envio");
  });

  it("contato novo (sem conversa_id): recusado antes de qualquer RPC de preparo ou gateway", async () => {
    const r = await estado.handler!(pedido({ canal_id: "k-1", telefone: "11999000001", aluno_id: "aluno-1", texto: "Oi" }));
    expect(r.status).toBe(403);
    expect(nomes()).not.toContain("whatsapp_preparar_envio_novo");
    expect(estado.gatewayChamadas).toBe(0);
  });

  it("conversa sem aluno: a checagem recusa e o gateway nao e chamado", async () => {
    estado.conversaAluno = null;
    estado.checar = { code: "JUR01", message: "Contato sem identificação confiável do aluno." };
    const r = await estado.handler!(pedido({ conversa_id: "c-2", texto: "Oi" }));
    expect(r.status).toBe(403);
    expect(estado.gatewayChamadas).toBe(0);
  });

  it("falha de infraestrutura na checagem: 403, sem gateway, e NAO registra recusa juridica", async () => {
    (estado as any).checar = { code: "57014", message: "timeout" };
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Oi" }));
    expect(r.status).toBe(403);
    expect(estado.gatewayChamadas).toBe(0);
    expect(nomes()).not.toContain("juridico_registrar_recusa_envio");
  });

  it("resultado incerto: falha do gateway depois da checagem devolve 502, com FALHOU, e nao reenvia", async () => {
    (globalThis as any).fetch = vi.fn(async () => { estado.gatewayChamadas++; throw new Error("timeout do gateway"); });
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Oi" }));
    expect(r.status).toBe(502);
    expect(estado.gatewayChamadas).toBe(1);
    expect(nomes().filter((n) => n === "juridico_checar_envio")).toHaveLength(1);
  });

  it("JUR01 sem acesso a conversa (ou usuario inativo): recusa generica, sem revelar bloqueio nem aluno", async () => {
    estado.checar = { code: "JUR01", message: "Envio bloqueado: aluno com bloqueio jurídico." };
    estado.acesso = false;
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Oi" }));
    const corpo = await r.json();
    expect(r.status).toBe(403);
    expect(corpo.erro).toBe("Envio não permitido por este fluxo para esta conversa.");
    expect(JSON.stringify(corpo)).not.toMatch(/jur[ií]dico|bloque/i);
  });

  it("JUR01 com acesso (usuario ativo e conversa visivel): mensagem detalhada", async () => {
    estado.checar = { code: "JUR01", message: "Envio bloqueado: aluno com bloqueio jurídico." };
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Oi" }));
    const corpo = await r.json();
    expect(corpo.erro).toMatch(/jurídico/);
  });

  it("usuario inativo nao recebe o detalhe mesmo com conversa visivel", async () => {
    estado.checar = { code: "JUR01", message: "Envio bloqueado: aluno com bloqueio jurídico." };
    estado.ativo = false;
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Oi" }));
    expect((await r.json()).erro).toBe("Envio não permitido por este fluxo para esta conversa.");
  });

  it("recuperacao: envio desligado recusa tudo (503) antes de qualquer acesso a banco ou gateway", async () => {
    estado.desligado = true;
    const r = await estado.handler!(pedido({ conversa_id: "c-1", texto: "Oi" }));
    expect(r.status).toBe(503);
    expect(estado.chamadas).toHaveLength(0);
    expect(estado.gatewayChamadas).toBe(0);
  });
});
