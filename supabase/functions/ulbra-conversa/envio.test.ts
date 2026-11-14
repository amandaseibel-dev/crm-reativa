// Envio de TEXTO LIVRE: validação, autoria, idempotência, recusa, timeout, falha incerta
// e falha de gravação. PROVA SIMULADA: provedores fake. Não é envio real à Mensageria.
// Templates não fazem parte desta entrega.
import { describe, it, expect } from "vitest";
import { TEXTO_MAX, enviarResposta, hashConteudo, validarPedido, resolverEnvioAberto, type Envio } from "./envio.ts";
import { AGORA, CHAVE, OP, RepoMemoria, conexao, deps, pedido } from "./fixtures.ts";

describe("validação do pedido", () => {
  it("texto vazio e texto longo são recusados (limite 4096, como no CHECK da migration)", () => {
    expect(validarPedido(pedido({ texto: "   " }))).toContain("TEXTO_VAZIO");
    expect(validarPedido(pedido({ texto: "x".repeat(TEXTO_MAX + 1) }))).toContain("TEXTO_LONGO");
    expect(validarPedido(pedido({ texto: "x".repeat(TEXTO_MAX) }))).toEqual([]);
  });

  it("fora da janela de 24 h o texto livre é bloqueado, e não há template como saída", () => {
    expect(validarPedido(pedido({ ultima_mensagem_cliente_em_ms: AGORA - 25 * 3600_000 }))).toContain("JANELA_FECHADA");
    expect(validarPedido(pedido({ ultima_mensagem_cliente_em_ms: null }))).toContain("JANELA_FECHADA");
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
    expect(validarPedido(pedido({ dono_carteira: "outro@aelbra.com.br", responsavel_atendimento: null }))).toContain("SEM_PERMISSAO_NA_CONVERSA");
  });

  it("responsável do atendimento envia mesmo sem carteira", () => {
    expect(validarPedido(pedido({ dono_carteira: null, responsavel_atendimento: OP }))).toEqual([]);
  });

  it("comparação de e-mail ignora maiúsculas", () => {
    expect(validarPedido(pedido({ dono_carteira: OP.toUpperCase() }))).toEqual([]);
  });
});

describe("identidade do atendente: conferida contra a conta conectada (fail-closed)", () => {
  it("atendente igual ao pessoa_id da conta: passa", () => {
    expect(validarPedido(pedido())).toEqual([]);
  });
  it("atendente igual ao nome da conta (sem diferença de caixa/espaço): passa", () => {
    const p = pedido({ atendente_ulbra: "  OPERADOR  piloto ", conta_conectada: { pessoa_id: null, pessoa_nome: "operador piloto" } });
    expect(validarPedido(p)).toEqual([]);
  });
  it("atendente de OUTRA pessoa: bloqueia", () => {
    expect(validarPedido(pedido({ atendente_ulbra: "outra-pessoa-9" }))).toContain("ATENDENTE_DIFERENTE_DA_CONTA_CONECTADA");
  });
  it("atendente não lido (null): bloqueia", () => {
    expect(validarPedido(pedido({ atendente_ulbra: null }))).toContain("ATENDENTE_ULBRA_NAO_LIDO");
  });
  it("conta sem identificação: bloqueia", () => {
    expect(validarPedido(pedido({ conta_conectada: { pessoa_id: null, pessoa_nome: null } }))).toContain("CONTA_CONECTADA_NAO_IDENTIFICADA");
  });
  it("no envio: atendente divergente bloqueia e NÃO chama o provedor", async () => {
    const { d, provedorEnvio } = deps();
    const r = await enviarResposta(pedido({ atendente_ulbra: "outra-pessoa-9" }), d);
    expect(r.situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
});

describe("envio real só com confirmação explícita", () => {
  it("sem envioRealConfirmado, bloqueia e não chama o provedor", async () => {
    const { d, provedorEnvio } = deps({ envioRealConfirmado: false });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["ENVIO_REAL_NAO_CONFIRMADO"]);
    expect(provedorEnvio.chamadas).toEqual([]);
  });
});

describe("autoria: só a conexão do próprio operador", () => {
  it("sem conexão individual, bloqueia e NÃO chama o provedor", async () => {
    const { d, provedorEnvio } = deps({ conexao: null });
    expect((await enviarResposta(pedido(), d)).situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
  it("conexão sem identidade da pessoa bloqueia e NÃO chama o provedor", async () => {
    const { d, provedorEnvio } = deps({ conexao: conexao({ pessoa_id: null }) });
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("CONEXAO_SEM_IDENTIDADE");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
  it("conexão de OUTRO operador não serve", async () => {
    const { d, provedorEnvio } = deps({ conexao: conexao({ operador_email: "outro@aelbra.com.br" }) });
    expect((await enviarResposta(pedido(), d)).situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
  it("conexão revogada bloqueia", async () => {
    const { d, provedorEnvio } = deps({ conexao: conexao({ revogada_em_ms: AGORA - 1 }) });
    expect((await enviarResposta(pedido(), d)).situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
  it("o envio usa o token DO OPERADOR", async () => {
    const { d, provedorEnvio } = deps();
    await enviarResposta(pedido(), d);
    expect(provedorEnvio.chamadas[0].access_token).toBe("tok-do-operador");
  });
});

describe("idempotência: repetir a chave não reenvia", () => {
  it("duas chamadas com a mesma chave enviam UMA vez", async () => {
    const { d, provedorEnvio } = deps();
    const a = await enviarResposta(pedido(), d);
    const b = await enviarResposta(pedido(), d);
    expect(a.situacao).toBe("PROCESSADO");
    expect(b.situacao).toBe("JA_PROCESSADO");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
  it("chaves diferentes são pedidos diferentes", async () => {
    const { d, provedorEnvio } = deps();
    await enviarResposta(pedido(), d);
    await enviarResposta(pedido({ chave: "outra-chave-clique-0002" }), d);
    expect(provedorEnvio.chamadas.length).toBe(2);
  });
  it("a chave vale por operador", async () => {
    const repo = new RepoMemoria();
    await repo.inserirSeNovo({ chave: CHAVE, operador_email: "outro@aelbra.com.br", atendimento_id: "c", texto: "x", status: "ENVIADO", ulbra_mensagem_id: "m", motivo: null, criado_em_ms: AGORA, previa_id: null });
    const { d, provedorEnvio } = deps({ repositorio: repo });
    await enviarResposta(pedido(), d);
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
});

describe("falha de gravação não vira 'já processado'", () => {
  it("se a gravação falha, a exceção sobe e o provedor NÃO é chamado", async () => {
    const { d, provedorEnvio, repositorio } = deps();
    repositorio.falharGravacao = true;
    await expect(enviarResposta(pedido(), d)).rejects.toThrow("ENVIO_NAO_GRAVADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
});

describe("resultado do envio", () => {
  it("sucesso grava ENVIADO com o id da Mensageria", async () => {
    const { d, repositorio } = deps();
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("ENVIADO");
    expect(repositorio.m.get(`${OP}|${CHAVE}`)!.ulbra_mensagem_id).toBe("msg-99");
  });
  it("qualquer erro da chamada é ambíguo: vira FALHA_INCERTA e bloqueia repetição (sem recusa por código)", async () => {
    const { d, provedorEnvio } = deps();
    provedorEnvio.modo = "queda";
    const r = await enviarResposta(pedido(), d);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("FALHA_INCERTA");
    const again = await enviarResposta(pedido({ chave: "outra-chave-depois-do-erro" }), d);
    expect(again.situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas.length).toBe(1);
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
    expect((await enviarResposta(pedido(), d)).situacao).toBe("JA_PROCESSADO");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
  it("o envio registra a prévia que o autorizou", async () => {
    const { d, repositorio } = deps();
    await enviarResposta(pedido(), d, "11111111-1111-1111-1111-111111111111");
    expect(repositorio.m.get(`${OP}|${CHAVE}`)!.previa_id).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("hash do conteúdo", () => {
  it("é determinístico e ignora espaços nas pontas, mas muda com qualquer alteração de conteúdo", async () => {
    expect(await hashConteudo("oi")).toBe(await hashConteudo("  oi  "));
    expect(await hashConteudo("oi")).not.toBe(await hashConteudo("oi!"));
    expect(await hashConteudo("oi")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("chave idempotente ligada ao conteúdo e falha incerta sem reenvio", () => {
  it("mesma chave com OUTRO texto gera conflito explícito e não envia", async () => {
    const { d, provedorEnvio } = deps();
    await enviarResposta(pedido(), d);
    const r = await enviarResposta(pedido({ texto: "texto diferente" }), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["CHAVE_COM_OUTRO_CONTEUDO"]);
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
  it("mesma chave com OUTRO atendimento gera conflito explícito", async () => {
    const { d, provedorEnvio } = deps();
    await enviarResposta(pedido(), d);
    const r = await enviarResposta(pedido({ atendimento_id: "ffffffffffffffffffffffff" }), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["CHAVE_COM_OUTRO_CONTEUDO"]);
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
  it("após FALHA_INCERTA, OUTRA chave para o mesmo texto NÃO reenvia (bloqueio explícito)", async () => {
    const { d, provedorEnvio } = deps();
    provedorEnvio.modo = "queda";
    await enviarResposta(pedido(), d);
    provedorEnvio.modo = "ok";
    const r = await enviarResposta(pedido({ chave: "outra-chave-clique-0003" }), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["FALHA_INCERTA_PENDENTE_CONFERENCIA"]);
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
  it("sem atendente lido, o envio nunca sai (fonte ainda não definida)", async () => {
    const { d, provedorEnvio } = deps();
    const r = await enviarResposta(pedido({ atendente_ulbra: null }), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("ATENDENTE_ULBRA_NAO_LIDO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
});

describe("índice de texto em aberto: concorrência entre requisições com chaves diferentes", () => {
  it("se o banco recusa por texto em aberto, o envio não sai e a chave não é reutilizada", async () => {
    const { d, provedorEnvio, repositorio } = deps();
    // Outra requisição já tem este texto em aberto (ainda não visível para a verificação prévia).
    repositorio.m.set("outro|chave-outra-requisicao", { chave: "chave-outra-requisicao", operador_email: "outro", atendimento_id: pedido().atendimento_id, texto: "Olá, em que posso ajudar?", status: "PENDENTE", ulbra_mensagem_id: null, motivo: null, criado_em_ms: AGORA, previa_id: null });
    const r = await enviarResposta(pedido({ chave: "chave-nova-0009" }), d);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toEqual(["ENVIO_EM_ABERTO_MESMO_TEXTO"]);
    expect(provedorEnvio.chamadas).toEqual([]);
  });
});

class RepoComFalha extends RepoMemoria {
  falharEm: string | null = null;
  async atualizar(o: string, c: string, campos: Partial<Envio>) {
    if (this.falharEm && campos.status === this.falharEm) throw new Error("FALHA_DB_" + this.falharEm);
    return super.atualizar(o, c, campos);
  }
}

describe("falhas de persistência antes e depois da chamada externa", () => {
  it("falha ao marcar ENVIANDO (antes da chamada): o provedor NÃO é chamado", async () => {
    const repo = new RepoComFalha();
    repo.falharEm = "ENVIANDO";
    const { d, provedorEnvio } = deps({ repositorio: repo });
    await expect(enviarResposta(pedido(), d)).rejects.toThrow("FALHA_DB_ENVIANDO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
  it("falha ao marcar ENVIADO (depois da chamada): vira FALHA_INCERTA, bloqueia reenvio e nunca fica 'seguro reenviar'", async () => {
    const repo = new RepoComFalha();
    repo.falharEm = "ENVIADO";
    const { d, provedorEnvio } = deps({ repositorio: repo });
    const r = await enviarResposta(pedido(), d);
    expect(provedorEnvio.chamadas.length).toBe(1);
    expect(r.situacao === "PROCESSADO" && r.envio.status).toBe("FALHA_INCERTA");
    const again = await enviarResposta(pedido({ chave: "outra-chave-depois-da-falha" }), d);
    expect(again.situacao).toBe("BLOQUEADO");
    expect(provedorEnvio.chamadas.length).toBe(1);
  });
  it("texto de 4096 caracteres, acentuado e não repetitivo, é enviado normalmente", async () => {
    const alfabeto = "áéíóúçãõàêôabcdefghijklmnopqrstuvwxyzÁÉÍÓÚÇ0123456789 ";
    let seed = 7;
    let texto = "";
    while (texto.length < 4096) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      texto += alfabeto[seed % alfabeto.length];
    }
    const { d, provedorEnvio } = deps();
    const r = await enviarResposta(pedido({ texto }), d);
    expect(r.situacao).toBe("PROCESSADO");
    expect(provedorEnvio.chamadas[0].texto.length).toBe(4096);
  });
});

describe("conferência administrativa de envio em aberto", () => {
  const abertoFalha = (): Envio => ({ chave: CHAVE, operador_email: OP, atendimento_id: pedido().atendimento_id, texto: "x", status: "FALHA_INCERTA", ulbra_mensagem_id: null, motivo: "ECONNRESET", criado_em_ms: AGORA, previa_id: null });
  it("resolve FALHA_INCERTA com motivo, sem reenviar", async () => {
    const repo = new RepoMemoria();
    repo.m.set(`${OP}|${CHAVE}`, abertoFalha());
    const { d, provedorEnvio } = deps({ repositorio: repo });
    const r = await resolverEnvioAberto(abertoFalha(), { operador_email: OP, chave: CHAVE, decisao: "CONFIRMADO_NAO_ENVIADO", motivo: "conferido na Mensageria: não há mensagem", conferido_por: "gestao@x" }, repo);
    expect(r.situacao).toBe("RESOLVIDO");
    expect(repo.m.get(`${OP}|${CHAVE}`)!.status).toBe("CONFIRMADO_NAO_ENVIADO");
    expect(provedorEnvio.chamadas).toEqual([]);
  });
  it("sem motivo, a conferência é recusada", async () => {
    const repo = new RepoMemoria();
    const r = await resolverEnvioAberto(abertoFalha(), { operador_email: OP, chave: CHAVE, decisao: "CONFIRMADO_ENVIADO", motivo: "ok", conferido_por: "g" }, repo);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("MOTIVO_OBRIGATORIO");
  });
  it("envio já fechado (ENVIADO) não é reaberto por conferência", async () => {
    const repo = new RepoMemoria();
    const fechado = { ...abertoFalha(), status: "ENVIADO" as const };
    const r = await resolverEnvioAberto(fechado, { operador_email: OP, chave: CHAVE, decisao: "CONFIRMADO_ENVIADO", motivo: "motivo suficiente aqui", conferido_por: "g" }, repo);
    expect(r.situacao === "BLOQUEADO" && r.motivos).toContain("ENVIO_JA_RESOLVIDO_OU_FECHADO");
  });
});
