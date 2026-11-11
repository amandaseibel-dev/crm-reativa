import { describe, it, expect } from "vitest";
import { avisosParaUsuario, pendenciasDaEquipe } from "./avisosRespostasColetadas";

const EM = "2026-11-10T10:00:00Z";
const ANTES = "2026-11-09T08:00:00Z";
const conv = (over) => ({ ulbra_conversa_id: "c1", aluno_id: "a1", ultima_mensagem_quem: "cliente", ultima_mensagem_cliente_em: EM, ...over });
const CARTEIRA = [{ aluno_id: "a1", responsavel_email: "cobranca10@aelbra.com.br" }];

describe("quem recebe", () => {
  it("só o responsável interno recebe o aviso", () => {
    const r = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", vistoAte: "2026-11-09T00:00:00Z" });
    expect(r.avisos).toHaveLength(1);
    const outro = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "cobranca05@aelbra.com.br", vistoAte: "2026-11-09T00:00:00Z" });
    expect(outro.avisos).toEqual([]);
  });
  it("gestão não recebe aviso individual, mas vê as pendências da equipe", () => {
    expect(avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "amanda.seibel@aelbra.com.br", ehGestao: true }).avisos).toEqual([]);
    expect(pendenciasDaEquipe({ conversas: [conv({})], carteira: CARTEIRA })[0].responsavel).toBe("cobranca10@aelbra.com.br");
  });
  it("operador não-responsável NÃO vira destinatário pela visibilidade", () => {
    const r = avisosParaUsuario({ conversas: [conv({})], carteira: [], email: "cobranca10@aelbra.com.br" });
    expect(r.avisos).toEqual([]);
  });
});

describe("só resposta do aluno", () => {
  it("mensagem do operador nunca gera aviso", () => {
    const r = avisosParaUsuario({ conversas: [conv({ ultima_mensagem_quem: "operador" })], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br" });
    expect(r.avisos).toEqual([]);
  });
});

describe("leitura por usuário", () => {
  it("gestão ler não apaga o aviso do operador", () => {
    // a gestão tem sua própria leitura; a do operador continua pendente
    const oper = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", lidoAte: {} });
    const gestao = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "amanda.seibel@aelbra.com.br", ehGestao: true, lidoAte: { c1: EM } });
    expect(oper.avisos).toHaveLength(1);
    expect(gestao.avisos).toEqual([]);
  });
  it("ler a própria resposta tira só o aviso daquele usuário", () => {
    const r = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", lidoAte: { c1: EM } });
    expect(r.avisos).toEqual([]);
  });
});

describe("sem alerta indevido", () => {
  it("carga inicial mostra pendências mas NÃO conta como novidade", () => {
    const r = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", vistoAte: null });
    expect(r.avisos).toHaveLength(1);
    expect(r.novos).toEqual([]);
  });
  it("resposta nova depois do último visto vira novidade; antiga não", () => {
    const novo = avisosParaUsuario({ conversas: [conv({})], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", vistoAte: "2026-11-10T09:00:00Z" });
    expect(novo.novos).toHaveLength(1);
    const velho = avisosParaUsuario({ conversas: [conv({ ultima_mensagem_cliente_em: ANTES })], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", vistoAte: "2026-11-10T09:00:00Z" });
    expect(velho.novos).toEqual([]);
  });
  it("corrigir o vínculo (identidade) não gera aviso: a data da mensagem não muda", () => {
    // a conversa passa a ter responsável só depois da correção; a mensagem é de ANTES do último visto
    const r = avisosParaUsuario({ conversas: [conv({ ultima_mensagem_cliente_em: ANTES })], carteira: CARTEIRA, email: "cobranca10@aelbra.com.br", vistoAte: "2026-11-09T12:00:00Z" });
    expect(r.novos).toEqual([]);
  });
});
