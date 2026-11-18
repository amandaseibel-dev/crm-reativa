// Testes do HANDLER REAL de documento (whatsapp-enviar-documento) com transporte simulado: Deno, Supabase
// (RPC, tabelas, storage) e gateway são simulados; o index.ts é carregado de verdade. Prova que a recusa
// jurídica vem ANTES do preparo, do upload e da chamada ao gateway, e que o hash é o do arquivo + nome + tipo.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

type Chamada = { nome: string; args?: any };
const estado = {
  chamadas: [] as Chamada[],
  checar: null as null | { code: string; message: string },
  conversaAluno: "aluno-1" as string | null,
  acesso: true,
  ativo: true,
  desligado: false,
  handler: null as null | ((req: Request) => Promise<Response>),
  gatewayChamadas: 0,
  uploads: 0,
};

vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({
  createClient: (_url: string, _chave: string) => ({
    rpc: (nome: string, args: any) => ({
      then: (ok: any, ko: any) => {
        estado.chamadas.push({ nome, args });
        let r: any = { data: null, error: null };
        if (nome === "app_usuario_ativo") r = { data: estado.ativo, error: null };
        if (nome === "usuario_e_gestao") r = { data: false, error: null };
        if (nome === "juridico_checar_envio" && estado.checar) r = { data: null, error: estado.checar };
        if (nome === "whatsapp_preparar_envio") {
          r = { data: [{ sessao_chave: "sessao-1", telefone_e164: "5511999000001", operador_email: "op1@x", conversa_id: args.p_conversa_id, ja_existia: true }], error: null };
        }
        return Promise.resolve(r).then(ok, ko);
      },
    }),
    from: (tabela: string) => ({
      select: (campo: string) => ({
        eq: () => ({
          maybeSingle: async () => {
            estado.chamadas.push({ nome: `from:${tabela}` });
            if (campo === "responsavel_email") return { data: { responsavel_email: estado.acesso ? "op1@x" : "outro@x" }, error: null };
            return { data: { aluno_id: estado.conversaAluno }, error: null };
          },
        }),
      }),
    }),
    storage: {
      from: (_bucket: string) => ({
        upload: async () => { estado.uploads++; estado.chamadas.push({ nome: "storage.upload" }); return { error: null }; },
        createSignedUrl: async () => { estado.chamadas.push({ nome: "storage.signed" }); return { data: { signedUrl: "https://storage.local/x?sig=1" }, error: null }; },
      }),
    },
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

const PDF = new TextEncoder().encode("%PDF-1.4\n% conteudo de teste\n%%EOF\n");
const sha = (bytes: Uint8Array, nome: string, mime: string) => {
  const cab = new TextEncoder().encode(`${nome}\u0000${mime}\u0000`);
  return createHash("sha256").update(Buffer.concat([Buffer.from(cab), Buffer.from(bytes)])).digest("hex");
};

beforeEach(async () => {
  estado.chamadas = [];
  estado.checar = null;
  estado.conversaAluno = "aluno-1";
  estado.acesso = true;
  estado.ativo = true;
  estado.desligado = false;
  estado.gatewayChamadas = 0;
  estado.uploads = 0;
  (globalThis as any).fetch = vi.fn(async () => {
    estado.gatewayChamadas++;
    estado.chamadas.push({ nome: "gateway.enviar-documento" });
    return { ok: true, status: 200, json: async () => ({ ok: true, wamid: "W-DOC-1" }) };
  });
  if (!estado.handler) await import("./index.ts");
});

const pedido = (conversa: string | null = "c-1", nome = "contrato.pdf") => {
  const f = new FormData();
  if (conversa !== null) f.set("conversa_id", conversa);
  f.set("arquivo", new File([PDF], nome, { type: "application/pdf" }));
  return new Request("http://fn.local/whatsapp-enviar-documento", {
    method: "POST",
    headers: { authorization: "Bearer jwt-do-operador" },
    body: f,
  });
};
const nomes = () => estado.chamadas.map((c) => c.nome);

describe("whatsapp-enviar-documento (handler real): bloqueio jurídico", () => {
  it("envio autorizado: checagem antes do preparo, do upload e do gateway; hash = arquivo + nome + tipo", async () => {
    const r = await estado.handler!(pedido());
    expect(r.status).toBe(200);
    const i = (n: string) => nomes().indexOf(n);
    expect(i("juridico_checar_envio")).toBeLessThan(i("whatsapp_preparar_envio"));
    expect(i("juridico_checar_envio")).toBeLessThan(i("storage.upload"));
    expect(i("juridico_checar_envio")).toBeLessThan(i("gateway.enviar-documento"));
    const chec = estado.chamadas.find((c) => c.nome === "juridico_checar_envio")!;
    expect(chec.args.p_tipo).toBe("DOCUMENTO");
    expect(chec.args.p_conteudo_hash).toBe(sha(PDF, "contrato.pdf", "application/pdf"));
  });

  it("recusa jurídica: 403 sem preparo, sem upload, sem gateway, e sem FALHOU", async () => {
    estado.checar = { code: "JUR01", message: "Envio bloqueado: aluno com bloqueio jurídico." };
    const r = await estado.handler!(pedido());
    expect(r.status).toBe(403);
    expect(nomes()).not.toContain("whatsapp_preparar_envio");
    expect(estado.uploads).toBe(0);
    expect(estado.gatewayChamadas).toBe(0);
    expect(nomes()).not.toContain("whatsapp_registrar_mensagem");
    expect(nomes()).toContain("juridico_registrar_recusa_envio");
  });

  it("conversa sem aluno: recusa antes de preparar e de subir o arquivo", async () => {
    estado.conversaAluno = null;
    estado.checar = { code: "JUR01", message: "Contato sem identificação confiável." };
    const r = await estado.handler!(pedido());
    expect(r.status).toBe(403);
    expect(estado.uploads).toBe(0);
    expect(estado.gatewayChamadas).toBe(0);
  });

  it("falha de infraestrutura na checagem: 403, sem upload, sem gateway, e NAO registra recusa juridica", async () => {
    estado.checar = { code: "57014", message: "timeout" };
    const r = await estado.handler!(pedido());
    expect(r.status).toBe(403);
    expect(estado.uploads).toBe(0);
    expect(estado.gatewayChamadas).toBe(0);
    expect(nomes()).not.toContain("juridico_registrar_recusa_envio");
  });

  it("sem conversa_id: recusa antes de qualquer efeito", async () => {
    const r = await estado.handler!(pedido(null));
    expect(r.status).toBe(400);
    expect(estado.uploads).toBe(0);
    expect(estado.gatewayChamadas).toBe(0);
  });

  it("documento: JUR01 sem acesso gera recusa generica, sem upload nem gateway", async () => {
    estado.checar = { code: "JUR01", message: "Envio bloqueado: aluno com bloqueio jurídico." };
    estado.acesso = false;
    const r = await estado.handler!(pedido());
    const corpo = await r.json();
    expect(r.status).toBe(403);
    expect(corpo.erro).toBe("Envio não permitido por este fluxo para esta conversa.");
    expect(estado.uploads).toBe(0);
    expect(estado.gatewayChamadas).toBe(0);
  });

  it("documento: recuperacao com envio desligado recusa (503) sem banco", async () => {
    estado.desligado = true;
    const r = await estado.handler!(pedido());
    expect(r.status).toBe(503);
    expect(estado.chamadas).toHaveLength(0);
  });
});
