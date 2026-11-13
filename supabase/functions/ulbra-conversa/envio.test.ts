// Envio: validação, autoria, idempotência, recusa, timeout e falha incerta.
// PROVA SIMULADA: provedores fake. Não é envio real à Mensageria.
import { describe, it, expect } from "vitest";
import {
  RecusadoPelaUlbra,
  TEXTO_MAX,
  enviarResposta,
  validarPedido,
  type Envio,
  type PedidoEnvio,
  type ProvedorEnvio,
  type RepositorioEnvio,
} from "./envio.ts";
import type { ProvedorOAuth, RegistroConexao } from "./conexao.ts";

const AGORA = Date.parse("2026-11-09T12:00:00Z");
const OP = "cobranca10@aelbra.com.br";
const CHAVE = "chave-clique-0001-abcdef";

const pedido = (over: Partial<PedidoEnvio> = {}): PedidoEnvio => ({
  operador: OP,
  atendimento_id: "0123456789abcdef01234567",
  texto: "Olá, em que posso ajudar?",
  chave: CHAVE,
  agora_ms: AGORA,
  ultima_mensagem_cliente_em_ms: AGORA - 60_000,
  dono_carteira: OP,
  responsavel_atendimento: null,
  identidade_confirmada: true,
  ...over,
});

const conexao = (over: Partial<RegistroConexao> = {}): RegistroConexao => ({
  operador_email: OP,
  access_token: "tok-do-operador",
  refresh_token: "ref-do-operador",
  expira_em_ms: AGORA + 3600_000,
  revogada_em_ms: null,
  pessoa_id: "pessoa-do-operador-1",
  ...over,
});

class RepoMemoria implements RepositorioEnvio {
  m = new Map<string, Envio>();
  chaveDe(o: string, c: string) { return `${o}|${c}`; }
  async buscar(o: string, c: string) { return this.m.get(this.chaveDe(o, c)) ?? null; }
  async inserirSeNovo(e: Envio) {
    const k = this.chaveDe(e.operador_email, e.chave);
    if (this.m.has(k)) return false;
    this.m.set(k, { ...e });
    return true;
  }
  async atualizar(o: string, c: string, campos: Partial<Envio>) {
    const k = this.chaveDe(o, c);
    this.m.set(k, { ...this.m.get(k)!, ...campos });
  }
}

class OAuthSimulado implements ProvedorOAuth {
  async renovar() { return { access_token: "novo", refresh_token: "novo-ref", expira_em_ms: AGORA + 3600_000 }; }
  async revogar() {}
}

class EnvioSimulado implements ProvedorEnvio {
  chamadas: Array<{ access_token: string; texto: string }> = [];
  modo: "ok" | "recusa" | "lento" | "queda" = "ok";
  async enviar(p: { access_token: string; atendimento_id: string; texto: string; chave: string }) {
    this.chamadas.push({ access_token: p.access_token, texto: p.texto });
    if (this.modo === "recusa") throw new RecusadoPelaUlbra("CONVERSA_ENCERRADA");
    if (this.modo === "queda") throw new Error("ECONNRESET");
    if (this.modo === "lento") await new Promise((r) => setTimeout(r, 200));
    return { ulbra_mensagem_id: "msg-99" };
  }
}

function deps(over: Partial<Parameters<typeof enviarResposta>[1]> = {}) {
  const repositorio = new RepoMemoria();
  const provedorEnvio = new EnvioSimulado();
  return {
    repositorio,
    provedorEnvio,
    d: {
      repositorio,
      provedorOAuth: new OAuthSimulado(),
      provedorEnvio,
      conexao: conexao(),
      envioRealConfirmado: true,
      agora: () => AGORA,
      timeoutMs: 50,
      ...over,
    },
  };
}

describe("validação do pedido", () => {
  it("texto vazio e texto longo são recusados (limite 4096, como na ferramenta)", () => {
    expect(validarPedido(pedido({ texto: "   " }))).toContain("TEXTO_VAZIO");
    expect(validarPedido(pedido({ texto: "x".repeat(TEXTO_MAX + 1) }))).toContain("TEXTO_LONGO");
    expect(validarPedido(pedido({ texto: "x".repeat(TEXTO_MAX) }))).toEqual([]);
  });

  it("fora da janela de 24 h só template: bloqueia o envio livre", () => {
    expect(validarPedido(pedido({ ultima_mensagem_cliente_em_ms: AGORA - 25 * 3600_000 }))).toContain("JANELA_FECHADA_USAR_TEMPLATE");
    expect(validarPedido(pedido({ ultima_mensagem_cliente_em_ms: null }))).toContain("JANELA_FECHADA_USAR_TEMPLATE");
  });

  it("atendimento com formato inválido e chave fora de 8 a 80 caracteres são recusados", () => {
    expect(validarPedido(pedido({ atendimento_id: "conv-1" }))).toContain("ATENDIMENTO_INVALIDO");
    expect(validarPedido(pedido({ chave: "curta" }))).toContain("CHAVE_INVALIDA");
    expect(validarPedido(pedido({ chave: "x".repeat(81) }))).toContain("CHAVE_INVALIDA");
  });

  it("identidade não confirmada bloqueia, mesmo para o dono", () => {
    expect(validarPedido(pedido({ identidade_confirmada: false }))).toContain("IDENTIDADE_NAO_CONFIRMADA");
  });

  it("operador que não é dono nem responsável não envia", () => {
    const m = validarPedido(pedido({ dono_carteira: "outro@aelbra.com.br", responsavel_atendimento: null }));
    expect(m).toContain("SEM_PERMISSAO_NA_CONVERSA");
  });

  it("responsável do atendimento envia mesmo sem carteira", () => {
    expect(validarPedido(pedido({ dono_carteira: null, responsavel_atendimento: OP }))).toEqual([]);
  });

  it("comparação de e-mail ignora maiúsculas", () => {
    expect(validarPedido(pedido({ dono_carteira: OP.toUpperCase() }))).toEqual([]);
  });
});

describe("envio real só com confirmação explícita", () => {
  it("sem envioRealConfirmado, bloqueia e não chama o provedor (previa:false não é padrão)", async () => {
    const { d, provedorEnvio } = deps({ envioRealConfirmado: false });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao).toBe("BLOQUEADO");
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["ENVIO_REAL_NAO_CONFIRMADO"]);
    expect(provedorEnvio.chamadas).toEqual([]);
  });
});

describe("autoria: só a conexão do próprio operador", () => {
  it("sem conexão individual, bloqueia e NÃO chama o provedor", async () => {
    const { d, provedorEnvio } = deps({ conexao: null });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });

  it("conexão sem identidade da pessoa (meu_acesso falhou) bloqueia e NÃO chama o provedor", async () => {
    const { d, provedorEnvio } = deps({ conexao: conexao({ pessoa_id: null }) });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao).toBe("BLOQUEADO");
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("CONEXAO_SEM_IDENTIDADE");
    expect(provedorEnvio.chamadas).toEqual([]);
  });

  it("conexão de OUTRO operador não serve: bloqueia", async () => {
    const { d, provedorEnvio } = deps({ conexao: conexao({ operador_email: "outro@aelbra.com.br" }) });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });

  it("conexão revogada bloqueia", async () => {
    const { d, provedorEnvio } = deps({ conexao: conexao({ revogada_em_ms: AGORA - 1 }) });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });

  it("o envio usa o token DO OPERADOR", async () => {
    const { d, provedorEnvio } = deps();
    await enviarResposta(pedido(), d);
    expect(provedorEnvio.chamadas[0].access_token).toBe("tok-do-operador");
  });
});

describe("idempotência: repetir o clique não reenvia", () => {
  it("duas chamadas com a mesma chave enviam UMA vez", async () => {
    const { d, provedorEnvio } = deps();
    const a = await enviarResposta(pedido(), d);
    const b = await enviarResposta(pedido(), d);
    expect(a.situacao).toBe("PROCESSADO");
    expect(b.situacao).toBe("JA_PROCESSADO");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });

  it("chaves diferentes são pedidos diferentes (mensagem intencional repetida)", async () => {
    const { d, provedorEnvio } = deps();
    await enviarResposta(pedido(), d);
    await enviarResposta(pedido({ chave: "outra-chave-clique-0002" }), d);
    expect(provedorEnvio.chamadas.length).toBe(2);
  });

  it("a chave vale por operador: outro operador com a mesma chave não é bloqueado pela chave alheia", async () => {
    const repo = new RepoMemoria();
    await repo.inserirSeNovo({
      chave: CHAVE, operador_email: "outro@aelbra.com.br", atendimento_id: "c", texto: "x",
      status: "ENVIADO", ulbra_mensagem_id: "m", motivo: null, criado_em_ms: AGORA,
    });
    const { d, provedorEnvio } = deps({ repositorio: repo });
    await enviarResposta(pedido(), d);
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
});

describe("resultado do envio", () => {
  it("sucesso grava ENVIADO com o id da Mensageria", async () => {
    const { d, repositorio } = deps();
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("ENVIADO");
    expect(repositorio.m.get(`${OP}|${CHAVE}`)!.ulbra_mensagem_id).toBe("msg-99");
  });

  it("recusa da Mensageria grava RECUSADO e não é reenviada", async () => {
    const { d, provedorEnvio } = deps();
    provedorEnvio.modo = "recusa";
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("RECUSADO");
    expect(r.situacao === "PROCESSADO" && r.envio.motivo).toBe("CONVERSA_ENCERRADA");
  });

  it("timeout vira FALHA_INCERTA e NÃO reenvia automaticamente", async () => {
    const { d, provedorEnvio } = deps({ timeoutMs: 10 });
    provedorEnvio.modo = "lento";
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("FALHA_INCERTA");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });

  it("queda de conexão vira FALHA_INCERTA, sem reenvio às cegas", async () => {
    const { d, provedorEnvio } = deps();
    provedorEnvio.modo = "queda";
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("FALHA_INCERTA");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });

  it("repetir depois de FALHA_INCERTA não envia de novo com a mesma chave", async () => {
    const { d, provedorEnvio } = deps();
    provedorEnvio.modo = "queda";
    await enviarResposta(pedido(), d);
    provedorEnvio.modo = "ok";
    const again = await enviarResposta(pedido(), d);
    expect(again.situacao).toBe("JA_PROCESSADO");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
});
