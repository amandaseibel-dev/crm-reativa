import { describe, it, expect, vi } from "vitest";
import { conversaParaLer, criarLeituraHistorico, historicoInicial, podeLerHistoricoNaCentral } from "./ulbraHistoricoSelecao";

const resposta = (id) => ({ ok: true, pagina: { mensagens: [{ quem: "cliente", texto: `msg ${id}` }] } });

function deferido() {
  let resolve;
  const promessa = new Promise((r) => { resolve = r; });
  return { promessa, resolve };
}

describe("histórico sob clique", () => {
  it("criar o controle não lê nada (sem chamada automática)", () => {
    const leitor = vi.fn();
    criarLeituraHistorico(leitor);
    expect(leitor).not.toHaveBeenCalled();
    expect(historicoInicial().estado).toBe("indisponivel");
  });

  it("lê uma vez, no clique, e entrega o estado carregando e depois o resultado", async () => {
    const leitor = vi.fn(async () => resposta("a"));
    const controle = criarLeituraHistorico(leitor);
    const estados = [];
    await controle.ver("conv-1", (e) => estados.push(e.estado));
    expect(leitor).toHaveBeenCalledTimes(1);
    expect(leitor).toHaveBeenCalledWith("conv-1");
    expect(estados).toEqual(["carregando", "ok"]);
  });

  it("troca de seleção: resposta atrasada da conversa anterior é ignorada", async () => {
    const pendente = deferido();
    const leitor = vi.fn(() => pendente.promessa);
    const controle = criarLeituraHistorico(leitor);
    const recebidos = [];
    const lendo = controle.ver("conv-A", (e) => recebidos.push(e));
    controle.cancelar(); // o usuário trocou de conversa
    pendente.resolve(resposta("A"));
    await lendo;
    expect(recebidos.map((e) => e.estado)).toEqual(["carregando"]);
  });

  it("depois de trocar, o clique seguinte lê só a conversa nova", async () => {
    const leitor = vi.fn(async (id) => resposta(id));
    const controle = criarLeituraHistorico(leitor);
    const recebidos = [];
    controle.cancelar();
    await controle.ver("conv-B", (e) => recebidos.push(e));
    expect(leitor.mock.calls).toEqual([["conv-B"]]);
    expect(recebidos.at(-1).estado).toBe("ok");
  });

  it("falha de rede vira erro, sem derrubar a tela", async () => {
    const controle = criarLeituraHistorico(async () => { throw new Error("rede"); });
    const recebidos = [];
    await controle.ver("conv-1", (e) => recebidos.push(e));
    expect(recebidos.at(-1).estado).toBe("erro");
  });
});

describe("conversa sem vínculo nunca é lida", () => {
  it("sem aluno_id devolve null (o chamador não consulta)", () => {
    expect(conversaParaLer({ tipo: "resposta", alunoId: null, bruto: { conversa_id: "c2" } })).toBeNull();
  });

  it("com aluno_id devolve o id da conversa", () => {
    expect(conversaParaLer({ tipo: "resposta", alunoId: "al-1", bruto: { conversa_id: "c1" } })).toBe("c1");
  });

  it("item que não é resposta não lê histórico", () => {
    expect(conversaParaLer({ tipo: "sem_interacao", alunoId: "al-3", bruto: {} })).toBeNull();
  });
});

describe("porta da Central", () => {
  it("com HISTORICO_DISPONIVEL desligada, nenhum item pode ler o histórico (nem botão nem chamada)", () => {
    expect(podeLerHistoricoNaCentral({ tipo: "resposta", alunoId: "al-1", bruto: { conversa_id: "c1" } })).toBe(false);
  });
});
