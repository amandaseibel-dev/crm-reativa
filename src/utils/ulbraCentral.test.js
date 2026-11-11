// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  deveNotificar,
  rotuloResponsabilidade,
  CENTRAL_ULBRA_LIBERADA_OPERADORES,
  descreverColeta,
  filtrarSemInteracao,
  fmtData,
  fmtEspera,
  haMais,
  hrefFicha,
  juntarPaginas,
  lerFiltros,
  listaPrioridade,
  paraBusca,
  podeVerCentralUlbra,
  rotuloPeriodo,
  VISOES,
  consultaMensageriaNaFicha,
  salvarPosicao,
  tomarPosicao,
} from "./ulbraCentral";

describe("porta da Central ULBRA (liberação geral)", () => {
  const op = { perfil: "operador", ativo: true };
  it("a liberação geral está ligada, sem lista nominal", () => {
    expect(CENTRAL_ULBRA_LIBERADA_OPERADORES).toBe(true);
  });
  it("gestão vê sempre; sem e-mail ninguém vê", () => {
    expect(podeVerCentralUlbra("Amanda.Seibel@aelbra.com.br ")).toBe(true);
    expect(podeVerCentralUlbra("amanda.seibel@aelbra.com.br", { perfil: "gerencia", ativo: true })).toBe(true);
    expect(podeVerCentralUlbra("")).toBe(false);
    expect(podeVerCentralUlbra(null, op)).toBe(false);
  });
  it("todo operador ativo com perfil operacional vê: não há mais exclusividade do cobranca10", () => {
    expect(podeVerCentralUlbra("cobranca10@aelbra.com.br", op)).toBe(true);
    expect(podeVerCentralUlbra("cobranca05@aelbra.com.br", op)).toBe(true);
    expect(podeVerCentralUlbra("cobranca99@aelbra.com.br", { perfil: "supervisor" })).toBe(true);
    expect(podeVerCentralUlbra("x@aelbra.com.br", { perfil: "administrativo" })).toBe(true);
  });
  it("cadastro inativo e conta de painel continuam bloqueados, mesmo com perfil operacional", () => {
    expect(podeVerCentralUlbra("cobranca05@aelbra.com.br", { perfil: "operador", ativo: false })).toBe(false);
    expect(podeVerCentralUlbra("painel.tv@reativa.local", op)).toBe(false);
    expect(podeVerCentralUlbra("PAINEL.TV@reativa.local", { perfil: "gerencia", ativo: true })).toBe(false);
  });
  it("perfil não operacional (diretoria, auditor) ou ausente não entra pela liberação geral", () => {
    expect(podeVerCentralUlbra("dir@aelbra.com.br", { perfil: "diretoria", ativo: true })).toBe(false);
    expect(podeVerCentralUlbra("aud@aelbra.com.br", { perfil: "auditor", ativo: true })).toBe(false);
    expect(podeVerCentralUlbra("cobranca05@aelbra.com.br")).toBe(false);
    expect(podeVerCentralUlbra("cobranca05@aelbra.com.br", {})).toBe(false);
  });
  it("com a liberação desligada, só a gestão vê", () => {
    expect(podeVerCentralUlbra("cobranca10@aelbra.com.br", op, false)).toBe(false);
    expect(podeVerCentralUlbra("amanda.seibel@aelbra.com.br", op, false)).toBe(true);
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
    expect(lerFiltros("?operador=COBRANCA10@aelbra.com.br&faixa=critico")).toEqual({ operador: "cobranca10@aelbra.com.br", faixa: "CRITICO", visao: "cartoes", conv: "" });
    expect(lerFiltros("?faixa=qualquer")).toEqual({ operador: "", faixa: "", visao: "cartoes", conv: "" });
  });
  it("ida e volta preserva os filtros", () => {
    const f = { operador: "op@x", faixa: "PERDENDO", visao: "cartoes", conv: "" };
    expect(lerFiltros(paraBusca(f))).toEqual(f);
    expect(paraBusca({ operador: "", faixa: "", visao: "cartoes", conv: "" })).toBe("");
  });

  it("visão de conversas e conversa selecionada vão para a URL e voltam", () => {
    const f = { operador: "", faixa: "", visao: "conversas", conv: "r:abc-1" };
    expect(paraBusca(f)).toBe("?visao=conversas&conv=r%3Aabc-1");
    expect(lerFiltros(paraBusca(f))).toEqual(f);
    expect(lerFiltros("?visao=qualquer").visao).toBe("cartoes");
  });

  it("listaPrioridade: respostas, depois sem interação, depois novos; mantém a ordem do banco", () => {
    const dados = {
      respostas: [{ conversa_id: "c2", nome: "B", espera_min: 50, aluno_id: "a2" }, { conversa_id: "c1", nome: "A", espera_min: 9, aluno_id: null }],
      sem_interacao: [{ aluno_id: "s1", nome: "S", dias_sem_acionamento: 12, faixa: "CRITICO" }],
      novos: [{ atendimento_id: "n1", nome: "N", espera_min: 3, aluno_id: "a9" }],
    };
    const ordem = listaPrioridade(dados, "").map((i) => i.tipo);
    expect(ordem).toEqual(["resposta", "resposta", "sem_interacao", "novo"]);
    expect(listaPrioridade(dados, "PERDENDO").map((i) => i.tipo)).toEqual(["resposta", "resposta", "novo"]);
    expect(listaPrioridade(dados, "")[0].nome).toBe("B");
    expect(listaPrioridade(dados, "")[2].dias_sem_acionamento).toBe(12);
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

describe("responsabilidade: ver não é responder", () => {
  it("a definir pela gestão não recebe aviso nem vira de um operador", () => {
    const item = { responsabilidade: "A_DEFINIR", notificar: true, minha: false };
    expect(deveNotificar(item)).toBe(false);
    expect(rotuloResponsabilidade(item)).toBe("Responsabilidade a definir pela gestão");
  });
  it("responsável comprovado recebe aviso e é identificado como sua responsabilidade", () => {
    const item = { responsabilidade: "CARTEIRA", notificar: true, minha: true };
    expect(deveNotificar(item)).toBe(true);
    expect(rotuloResponsabilidade(item)).toBe("responsabilidade sua");
  });
  it("quem só vê não recebe aviso e não é apresentado como responsável", () => {
    const item = { responsabilidade: "ASSUMIDO", notificar: false, minha: false, responsavel_e_outro: true };
    expect(deveNotificar(item)).toBe(false);
    expect(rotuloResponsabilidade(item)).toBe("responsável: outro operador");
  });
  it("sem campo de responsabilidade não inventa rótulo", () => {
    expect(rotuloResponsabilidade({})).toBeNull();
    expect(deveNotificar(null)).toBe(false);
  });
});

describe("liberação geral: não existe mais lista nominal de piloto", () => {
  it("cobranca10 e cobranca05 entram pela mesma regra; sem perfil operacional nenhum dos dois entra", () => {
    const op = { perfil: "operador", ativo: true };
    expect(podeVerCentralUlbra("cobranca10@aelbra.com.br", op)).toBe(true);
    expect(podeVerCentralUlbra("cobranca05@aelbra.com.br", op)).toBe(true);
    expect(podeVerCentralUlbra("cobranca10@aelbra.com.br")).toBe(false);
    expect(podeVerCentralUlbra("")).toBe(false);
  });
});

describe("ficha aberta pela Central não consulta a Mensageria", () => {
  it("origem=ulbra desliga a consulta; ficha comum continua consultando", () => {
    expect(consultaMensageriaNaFicha("?alunoId=al-1&origem=ulbra")).toBe(false);
    expect(consultaMensageriaNaFicha("?alunoId=al-1")).toBe(true);
    expect(consultaMensageriaNaFicha("")).toBe(true);
  });
});

describe("visão Mensageria (período)", () => {
  it("é uma visão própria, separada da carteira interna, e vai e volta pela URL", () => {
    expect(VISOES).toContain("mensageria");
    expect(lerFiltros("?visao=mensageria").visao).toBe("mensageria");
    expect(paraBusca({ operador: "", faixa: "", visao: "mensageria", conv: "" })).toBe("?visao=mensageria");
  });
  it("rotula o período pelo mês de Brasília; sem data diz período atual", () => {
    expect(rotuloPeriodo("2026-11-01T03:00:00.000Z")).toBe("novembro de 2026");
    expect(rotuloPeriodo("2026-12-01T02:59:00.000Z")).toBe("novembro de 2026"); // ainda 30/11 23:59 em Brasília
    expect(rotuloPeriodo(null)).toBe("período atual");
    expect(rotuloPeriodo("lixo")).toBe("período atual");
  });
});
