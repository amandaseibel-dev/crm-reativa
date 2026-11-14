// Fixtures compartilhados dos testes de envio e de prévia. Provedores simulados.
import { enviarResposta, type Envio, type PedidoEnvio, type ProvedorEnvio, type RepositorioEnvio, type StatusEnvio } from "./envio.ts";
import type { ProvedorOAuth, RegistroConexao } from "./conexao.ts";

export const AGORA = Date.parse("2026-11-09T12:00:00Z");
export const OP = "cobranca10@aelbra.com.br";
export const CHAVE = "chave-clique-0001-abcdef";

export const pedido = (over: Partial<PedidoEnvio> = {}): PedidoEnvio => ({
  operador: OP,
  atendimento_id: "0123456789abcdef01234567",
  ulbra_cliente_id: "cli-1",
  texto: "Olá, em que posso ajudar?",
  chave: CHAVE,
  agora_ms: AGORA,
  ultima_mensagem_cliente_em_ms: AGORA - 60_000,
  dono_carteira: OP,
  responsavel_atendimento: null,
  identidade_confirmada: true,
  atendente_ulbra: "pessoa-do-operador-1",
  conta_conectada: { pessoa_id: "pessoa-do-operador-1", pessoa_nome: "Operador Piloto" },
  ...over,
});

export const conexao = (over: Partial<RegistroConexao> = {}): RegistroConexao => ({
  operador_email: OP,
  access_token: "tok-do-operador",
  refresh_token: "ref-do-operador",
  expira_em_ms: AGORA + 3600_000,
  revogada_em_ms: null,
  pessoa_id: "pessoa-do-operador-1",
  ...over,
});

export class RepoMemoria implements RepositorioEnvio {
  m = new Map<string, Envio>();
  /** Quando true, a próxima gravação falha com erro que NÃO é chave repetida. */
  falharGravacao = false;
  chaveDe(o: string, c: string) { return `${o}|${c}`; }
  async buscar(o: string, c: string) { return this.m.get(this.chaveDe(o, c)) ?? null; }
  async inserirSeNovo(e: Envio) {
    if (this.falharGravacao) throw new Error("ENVIO_NAO_GRAVADO");
    const k = this.chaveDe(e.operador_email, e.chave);
    if (this.m.has(k)) return "CHAVE_EXISTENTE" as const;
    const emAberto = [...this.m.values()].some((x) => x.atendimento_id === e.atendimento_id && x.texto === e.texto && (x.repeticao ?? 0) === (e.repeticao ?? 0) && ["PENDENTE", "ENVIANDO", "FALHA_INCERTA", "CONFIRMADO_ENVIADO"].includes(x.status));
    if (emAberto) return "TEXTO_EM_ABERTO" as const;
    this.m.set(k, { ...e });
    return "NOVO" as const;
  }
  async existeBloqueante(atendimento_id: string, texto: string, incluiConfirmados: boolean) {
    const estados: string[] = ["PENDENTE", "ENVIANDO", "FALHA_INCERTA", ...(incluiConfirmados ? ["CONFIRMADO_ENVIADO"] : [])];
    return [...this.m.values()].some((e) => e.atendimento_id === atendimento_id && e.texto === texto && estados.includes(e.status));
  }
  async proximaRepeticao(atendimento_id: string, texto: string) {
    const usados = [...this.m.values()].filter((e) => e.atendimento_id === atendimento_id && e.texto === texto).map((e) => e.repeticao ?? 0);
    return usados.length === 0 ? 0 : Math.max(...usados) + 1;
  }
  async atualizar(o: string, c: string, campos: Partial<Envio>, de?: readonly StatusEnvio[]) {
    const k = this.chaveDe(o, c);
    const atual = this.m.get(k);
    if (!atual) return false;
    if (de && !de.includes(atual.status)) return false;
    this.m.set(k, { ...atual, ...campos });
    return true;
  }
}

class OAuthSimulado implements ProvedorOAuth {
  async renovar() { return { access_token: "novo", refresh_token: "novo-ref", expira_em_ms: AGORA + 3600_000 }; }
  async revogar() {}
}

export class EnvioSimulado implements ProvedorEnvio {
  chamadas: Array<{ access_token: string; texto: string; chave: string }> = [];
  modo: "ok" | "recusa" | "lento" | "queda" = "ok";
  async enviar(p: { access_token: string; atendimento_id: string; texto: string; chave: string }) {
    this.chamadas.push({ access_token: p.access_token, texto: p.texto, chave: p.chave });
    if (this.modo === "queda") throw new Error("ECONNRESET");
    if (this.modo === "lento") await new Promise((r) => setTimeout(r, 200));
    return { ulbra_mensagem_id: "msg-99" };
  }
}

export function deps(over: Partial<Parameters<typeof enviarResposta>[1]> = {}) {
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

