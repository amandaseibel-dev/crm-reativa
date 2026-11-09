// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  CENTRAL_ULBRA_LIBERADA_OPERADORES,
  descreverColeta,
  filtrarSemInteracao,
  fmtData,
  fmtEspera,
  haMais,
  hrefFicha,
  juntarPaginas,
  lerFiltros,
  paraBusca,
  podeVerCentralUlbra,
  salvarPosicao,
  tomarPosicao,
} from "./ulbraCentral";

describe("porta da Central ULBRA", () => {
  it("nesta entrega os operadores NÃO estão liberados", () => {
    expect(CENTRAL_ULBRA_LIBERADA_OPERADORES).toBe(false);
  });
  it("gestão vê; operador não vê enquanto não liberado; sem e-mail ninguém vê", () => {
    expect(podeVerCentralUlbra("Amanda.Seibel@aelbra.com.br ")).toBe(true);
    expect(podeVerCentralUlbra("cobranca10@aelbra.com.br")).toBe(false);
    expect(podeVerCentralUlbra("")).toBe(false);
    expect(podeVerCentralUlbra(null)).toBe(false);
  });
  it("com a liberação ligada, operador com e-mail vê; sem e-mail continua fora", () => {
    expect(podeVerCentralUlbra("cobranca10@aelbra.com.br", true)).toBe(true);
    expect(podeVerCentralUlbra("", true)).toBe(false);
  });
});

describe("estado da coleta", () => {
  const base = { ultima_execucao: "2026-11-08T21:23:00Z", atraso_min: 660, ultimo_ciclo: "OK" };
  it("MANUAL é neutro e diz atualização manual com a data", () => {
    const d = descreverColeta({ ...base, estado: "MANUAL" });
    expect(d.tom).toBe("cinza");
    expect(d.titulo).toBe("Atualização manual");
    expect(d.texto).toMatch(/Última coleta em \d{2}\/\d{2}/);
    expect(d.texto).toMatch(/Não há sincronização automática ativa/);
    expect(d.detalhe).toBeNull();
  });
  it("ATRASADA e FALHA são estados diferentes de MANUAL", () => {
    expect(descreverColeta({ ...base, estado: "ATRASADA" })).toMatchObject({ tom: "ambar", titulo: "Coleta automática atrasada" });
    const f = descreverColeta({ ...base, estado: "FALHA", ultimo_ciclo: "FALHOU", ultimo_erro: "HTTP_500" });
    expect(f.tom).toBe("vermelho");
    expect(f.texto).toMatch(/HTTP_500/);
  });
  it("coleta incompleta aparece mesmo em modo manual, e muda o tom", () => {
    const d = descreverColeta({ ...base, estado: "MANUAL", ultimo_ciclo: "INCOMPLETO", ultimo_erro: "BACKLOG_OU_ORCAMENTO" });
    expect(d.tom).toBe("ambar");
    expect(d.detalhe).toMatch(/incompleta \(BACKLOG_OU_ORCAMENTO\)/);
  });
  it("ciclo pulado por orçamento é dito como tal", () => {
    expect(descreverColeta({ ...base, estado: "MANUAL", ultimo_ciclo: "PULADO_ORCAMENTO" }).detalhe).toMatch(/pulado por falta de orçamento/);
  });
  it("sem ciclo e estado desconhecido não inventam data", () => {
    expect(descreverColeta({ estado: "SEM_CICLO" }).titulo).toBe("Nenhuma coleta feita ainda");
    expect(descreverColeta(null).texto).toMatch(/sem registro/);
  });
});

describe("formatos", () => {
  it("tempo de espera", () => {
    expect(fmtEspera(4)).toBe("4 min");
    expect(fmtEspera(125)).toBe("2 h 05 min");
    expect(fmtEspera(3000)).toBe("2 d 2 h");
    expect(fmtEspera(null)).toBe("tempo não disponível");
  });
  it("data pura não passa por fuso", () => {
    expect(fmtData("2026-11-01")).toBe("01/11/2026");
    expect(fmtData(null)).toBe("nunca");
  });
  it("link da ficha leva o aluno e a origem", () => {
    expect(hrefFicha("abc 1")).toBe("/aluno?alunoId=abc%201&origem=ulbra");
  });
});

describe("filtros na URL", () => {
  it("lê, normaliza e descarta faixa inválida", () => {
    expect(lerFiltros("?operador=COBRANCA10@aelbra.com.br&faixa=critico")).toEqual({ operador: "cobranca10@aelbra.com.br", faixa: "CRITICO" });
    expect(lerFiltros("?faixa=qualquer")).toEqual({ operador: "", faixa: "" });
  });
  it("ida e volta preserva os filtros", () => {
    const f = { operador: "op@x", faixa: "PERDENDO" };
    expect(lerFiltros(paraBusca(f))).toEqual(f);
    expect(paraBusca({ operador: "", faixa: "" })).toBe("");
  });
  it("faixa filtra só a lista de sem interação", () => {
    const l = [{ aluno_id: 1, faixa: "PERDENDO" }, { aluno_id: 2, faixa: "CRITICO" }];
    expect(filtrarSemInteracao(l, "CRITICO")).toEqual([l[1]]);
    expect(filtrarSemInteracao(l, "")).toEqual(l);
    expect(filtrarSemInteracao(null, "CRITICO")).toEqual([]);
  });
});

describe("páginas", () => {
  it("junta sem repetir e sem perder, na ordem recebida", () => {
    const p0 = { respostas: [{ conversa_id: "a" }, { conversa_id: "b" }], sem_interacao: [{ aluno_id: 1 }], novos: [] };
    const p1 = { respostas: [{ conversa_id: "b" }, { conversa_id: "c" }], sem_interacao: [], novos: [{ atendimento_id: "x" }] };
    const j = juntarPaginas([p0, p1]);
    expect(j.respostas.map((r) => r.conversa_id)).toEqual(["a", "b", "c"]);
    expect(j.sem_interacao).toHaveLength(1);
    expect(j.novos).toHaveLength(1);
  });
  it("sabe quando ainda há linha no banco fora da tela", () => {
    expect(haMais({ respostas: 3, sem_interacao: 0, novos: 0 }, { respostas: [1, 2], sem_interacao: [], novos: [] })).toBe(true);
    expect(haMais({ respostas: 2, sem_interacao: 0, novos: 0 }, { respostas: [1, 2], sem_interacao: [], novos: [] })).toBe(false);
    expect(haMais(null, null)).toBe(false);
  });
});

describe("posição ao voltar da ficha", () => {
  beforeEach(() => sessionStorage.clear());
  it("devolve rolagem e páginas para a MESMA combinação de filtros, uma única vez", () => {
    salvarPosicao({ busca: "?faixa=CRITICO", rolagem: 840, paginas: 3 });
    expect(tomarPosicao("?faixa=CRITICO")).toEqual({ rolagem: 840, paginas: 3 });
    expect(tomarPosicao("?faixa=CRITICO")).toBeNull();
  });
  it("filtros diferentes não herdam a posição", () => {
    salvarPosicao({ busca: "?faixa=CRITICO", rolagem: 840, paginas: 3 });
    expect(tomarPosicao("")).toBeNull();
  });
});
