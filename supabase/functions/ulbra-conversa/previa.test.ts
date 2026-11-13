// Prévia registrada no servidor + confirmação que a consome. Provedores simulados.
// NÃO chama a Mensageria em nenhum caso.
import { describe, it, expect } from "vitest";
import { criarPrevia, confirmarPrevia, VALIDADE_PREVIA_MS, type PreviaRegistro, type RepositorioPrevia } from "./previa.ts";
import { deps, pedido, type RepoMemoria, type EnvioSimulado } from "./fixtures.ts";

class RepoPreviaMemoria implements RepositorioPrevia {
  m = new Map<string, PreviaRegistro>();
  inseridas = 0;
  async inserir(p: PreviaRegistro) { this.inseridas++; this.m.set(p.id, { ...p }); }
  async buscar(id: string) { return this.m.get(id) ?? null; }
  // Check-and-set síncrono: é a semântica do UPDATE ... WHERE consumida_em IS NULL.
  async consumir(id: string, operador: string, agoraMs: number) {
    const p = this.m.get(id);
    if (!p || p.consumida_em_ms !== null || p.operador_email !== operador || agoraMs >= p.expira_em_ms) return false;
    p.consumida_em_ms = agoraMs;
    return true;
  }
}

const AGORA = Date.parse("2026-11-09T12:00:00Z");
const ids = (() => { let n = 0; return () => `prev-${++n}`; })();

function setup(over: Partial<ReturnType<typeof deps>["d"]> = {}) {
  const base = deps(over as never);
  const repositorioPrevia = new RepoPreviaMemoria();
  const d = { ...base.d, repositorioPrevia, gerarId: ids, agora: () => AGORA };
  return { d, repositorio: base.repositorio as RepoMemoria, provedorEnvio: base.provedorEnvio as EnvioSimulado, repositorioPrevia };
}

async function previaCriada(s: ReturnType<typeof setup>, over = {}) {
  const r = await criarPrevia(pedido(over), { repositorioPrevia: s.repositorioPrevia, gerarId: ids, agora: () => AGORA });
  if (r.situacao !== "CRIADA") throw new Error("prévia não criada: " + r.motivos.join(","));
  return r.previa_id;
}

describe("criar prévia: valida agora e registra, sem chamar a Mensageria", () => {
  it("cria a prévia com validade curta e NÃO chama o provedor de envio", async () => {
    const s = setup();
    const r = await criarPrevia(pedido(), { repositorioPrevia: s.repositorioPrevia, gerarId: ids, agora: () => AGORA });
    expect(r.situacao).toBe("CRIADA");
    if (r.situacao === "CRIADA") expect(r.expira_em_ms).toBe(AGORA + VALIDADE_PREVIA_MS);
    expect(s.provedorEnvio.chamadas).toEqual([]);
  });

  it("não cria prévia fora da janela de 24 h", async () => {
    const s = setup();
    const r = await criarPrevia(pedido({ ultima_mensagem_cliente_em_ms: AGORA - 25 * 3600_000 }), { repositorioPrevia: s.repositorioPrevia, gerarId: ids, agora: () => AGORA });
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("JANELA_FECHADA");
    expect(s.repositorioPrevia.inseridas).toBe(0);
  });

  it("não cria prévia sem destinatário identificado", async () => {
    const s = setup();
    const r = await criarPrevia(pedido({ ulbra_cliente_id: null }), { repositorioPrevia: s.repositorioPrevia, gerarId: ids, agora: () => AGORA });
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("DESTINATARIO_NAO_IDENTIFICADO");
  });

  it("não cria prévia para atendente de outra pessoa", async () => {
    const s = setup();
    const r = await criarPrevia(pedido({ atendente_ulbra: "outra-9" }), { repositorioPrevia: s.repositorioPrevia, gerarId: ids, agora: () => AGORA });
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("ATENDENTE_DIFERENTE_DA_CONTA_CONECTADA");
  });
});

describe("confirmar consome a prévia e envia uma vez", () => {
  it("prévia válida, conteúdo igual, mesmo atendimento e cliente: envia e marca a prévia como consumida", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const r = await confirmarPrevia(pedido(), previaId, s.d);
    expect(r.situacao).toBe("PROCESSADO");
    expect(s.provedorEnvio.chamadas.length).toBe(1);
    expect(s.repositorioPrevia.m.get(previaId)!.consumida_em_ms).toBe(AGORA);
    expect(s.repositorio.m.get(`cobranca10@aelbra.com.br|${pedido().chave}`)!.previa_id).toBe(previaId);
  });

  it("repetir a MESMA chave devolve o envio gravado e não consome nem envia de novo", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    await confirmarPrevia(pedido(), previaId, s.d);
    const again = await confirmarPrevia(pedido(), previaId, s.d);
    expect(again.situacao).toBe("JA_PROCESSADO");
    expect(s.provedorEnvio.chamadas.length).toBe(1);
  });

  it("a MESMA prévia com OUTRA chave não envia: PREVIA_JA_USADA", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    await confirmarPrevia(pedido(), previaId, s.d);
    const outra = await confirmarPrevia(pedido({ chave: "outra-chave-clique-0002" }), previaId, s.d);
    expect(outra.situacao === "BLOQUEADO" && outra.motivos).toEqual(["PREVIA_JA_USADA"]);
    expect(s.provedorEnvio.chamadas.length).toBe(1);
  });
});

describe("a confirmação recusa quando algo mudou", () => {
  it("prévia inexistente é recusada", async () => {
    const s = setup();
    const r = await confirmarPrevia(pedido(), "nao-existe", s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["PREVIA_NAO_ENCONTRADA"]);
    expect(s.provedorEnvio.chamadas).toEqual([]);
  });

  it("prévia expirada não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const expirada = { ...s.d, agora: () => AGORA + VALIDADE_PREVIA_MS + 1 };
    const r = await confirmarPrevia(pedido({ agora_ms: AGORA + VALIDADE_PREVIA_MS + 1 }), previaId, expirada);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["PREVIA_EXPIRADA"]);
    expect(s.provedorEnvio.chamadas).toEqual([]);
  });

  it("conteúdo alterado depois da prévia não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const r = await confirmarPrevia(pedido({ texto: "outro texto, não o aprovado" }), previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["CONTEUDO_ALTERADO"]);
    expect(s.provedorEnvio.chamadas).toEqual([]);
    expect(s.repositorioPrevia.m.get(previaId)!.consumida_em_ms).toBeNull();
  });

  it("outra conta tentando confirmar não envia e não consome a prévia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const outra = "outra@aelbra.com.br";
    const r = await confirmarPrevia(pedido({ operador: outra, dono_carteira: outra }), previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["PREVIA_DE_OUTRA_CONTA"]);
    expect(s.repositorioPrevia.m.get(previaId)!.consumida_em_ms).toBeNull();
  });

  it("atendimento diferente do da prévia não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const r = await confirmarPrevia(pedido({ atendimento_id: "ffffffffffffffffffffffff" }), previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["ATENDIMENTO_DIVERGENTE"]);
  });

  it("cliente (destinatário) diferente do da prévia não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const r = await confirmarPrevia(pedido({ ulbra_cliente_id: "cli-outro" }), previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["DESTINATARIO_DIVERGENTE"]);
  });

  it("revalida a janela: prévia válida, mas a janela fechou antes da confirmação, não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const fechada = pedido({ ultima_mensagem_cliente_em_ms: AGORA - 25 * 3600_000 });
    const r = await confirmarPrevia(fechada, previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("JANELA_FECHADA");
    expect(s.provedorEnvio.chamadas).toEqual([]);
    expect(s.repositorioPrevia.m.get(previaId)!.consumida_em_ms).toBeNull();
  });

  it("revalida a responsabilidade: quem perdeu a carteira não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const r = await confirmarPrevia(pedido({ dono_carteira: "outro@aelbra.com.br", responsavel_atendimento: null }), previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("SEM_PERMISSAO_NA_CONVERSA");
  });

  it("revalida o atendente: se a conta conectada deixou de ser o atendente, não envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const r = await confirmarPrevia(pedido({ atendente_ulbra: "outra-pessoa-9" }), previaId, s.d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("ATENDENTE_DIFERENTE_DA_CONTA_CONECTADA");
  });
});

describe("concorrência e falhas", () => {
  it("duas confirmações simultâneas com chaves diferentes: só uma envia", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    const [a, b] = await Promise.all([
      confirmarPrevia(pedido(), previaId, s.d),
      confirmarPrevia(pedido({ chave: "outra-chave-clique-0002" }), previaId, s.d),
    ]);
    const enviados = [a, b].filter((r) => r.situacao === "PROCESSADO").length;
    expect(enviados).toBe(1);
    expect(s.provedorEnvio.chamadas.length).toBe(1);
  });

  it("falha de gravação do envio propaga; a prévia já consumida não gera envio fantasma", async () => {
    const s = setup();
    const previaId = await previaCriada(s);
    s.repositorio.falharGravacao = true;
    await expect(confirmarPrevia(pedido(), previaId, s.d)).rejects.toThrow("ENVIO_NAO_GRAVADO");
    expect(s.provedorEnvio.chamadas).toEqual([]);
    // Consumida sem envio: o operador precisa de nova prévia. É o lado seguro (nunca envia sem registro).
    expect(s.repositorioPrevia.m.get(previaId)!.consumida_em_ms).toBe(AGORA);
  });
});
