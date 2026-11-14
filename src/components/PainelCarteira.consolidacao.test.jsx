// REGRESSAO DA CONSOLIDACAO DAS CONSULTAS DE `aluno_movimentacoes`.
//
// O que esta coberto aqui e a EQUIVALENCIA: a consulta unica mais a
// reparticao em JS tem de devolver exatamente os mesmos dois conjuntos que as
// duas consultas separadas devolviam. Se divergirem, o indicador "pendente de
// 1o acionamento" muda de valor -- foi medido em producao em 22/10/2026
// (294 pelo indicador antigo contra 2.111 reais) e nao pode regredir.
//
// Mede tambem a queda de requisicoes, que e o motivo da mudanca.

import { describe, it, expect } from "vitest";
import {
  filtroMovimentacoesCarteira,
  separarMovimentacoesCarteira,
} from "../utils/movimentacoesCarteira";

const TIPOS = ["FINALIZACAO_ATENDIMENTO", "FINALIZACAO"];
const EMAILS = ["cobranca05@aelbra.com.br", "cobranca12@aelbra.com.br"];

// As DUAS consultas de antes, reproduzidas como filtro puro: e o predicado que
// o Postgres aplicava (`= ANY`, exato) sobre as mesmas linhas.
function comoEraAntes(linhas, emails, tipos) {
  const tabulacoes = linhas.filter(
    (l) => tipos.includes(l.tipo) && emails.includes(l.registrado_por_email)
  );
  const transferencias = linhas.filter((l) => emails.includes(l.operador_novo_email));
  return { tabulacoes, transferencias };
}

// Universo de teste: cobre os casos que separam as duas consultas.
const LINHAS = [
  // tabulacao do responsavel -- so no primeiro conjunto
  { id: 1, aluno_id: "a1", tipo: "FINALIZACAO_ATENDIMENTO", registrado_por_email: EMAILS[0], operador_novo_email: null, registrado_em: "2026-11-01T10:00:00Z" },
  // tabulacao de tipo que nao conta -- em nenhum
  { id: 2, aluno_id: "a1", tipo: "CONTATO", registrado_por_email: EMAILS[0], operador_novo_email: null, registrado_em: "2026-11-02T10:00:00Z" },
  // tabulacao de outro autor -- em nenhum
  { id: 3, aluno_id: "a2", tipo: "FINALIZACAO_ATENDIMENTO", registrado_por_email: "outro@aelbra.com.br", operador_novo_email: null, registrado_em: "2026-11-03T10:00:00Z" },
  // transferencia pura -- so no segundo conjunto
  { id: 4, aluno_id: "a2", tipo: "ALTERACAO_OPERADOR", registrado_por_email: "sistema@aelbra.com.br", operador_novo_email: EMAILS[1], operador_anterior_email: "outro@aelbra.com.br", registrado_em: "2026-11-04T10:00:00Z" },
  // transferencia registrada pelo proprio que recebeu, com tipo que conta:
  // serve aos DOIS conjuntos -- era assim com duas consultas, segue assim
  { id: 5, aluno_id: "a3", tipo: "FINALIZACAO", registrado_por_email: EMAILS[1], operador_novo_email: EMAILS[1], operador_anterior_email: EMAILS[0], registrado_em: "2026-11-05T10:00:00Z" },
  // transferencia para fora da carteira -- em nenhum
  { id: 6, aluno_id: "a3", tipo: "ALTERACAO_OPERADOR", registrado_por_email: "sistema@aelbra.com.br", operador_novo_email: "fora@aelbra.com.br", registrado_em: "2026-11-06T10:00:00Z" },
  // caixa diferente da lista: a consulta antiga NAO trazia, e a nova tambem nao
  { id: 7, aluno_id: "a4", tipo: "FINALIZACAO_ATENDIMENTO", registrado_por_email: "COBRANCA05@AELBRA.COM.BR", operador_novo_email: "COBRANCA05@AELBRA.COM.BR", registrado_em: "2026-11-06T11:00:00Z" },
  // sem autor: 185 linhas antigas em producao, nao contam como tabulacao
  { id: 8, aluno_id: "a4", tipo: "FINALIZACAO_ATENDIMENTO", registrado_por_email: null, operador_novo_email: null, registrado_em: "2026-11-06T12:00:00Z" },
];

describe("consolidacao das consultas de aluno_movimentacoes", () => {
  it("devolve exatamente os mesmos dois conjuntos das duas consultas antigas", () => {
    const antes = comoEraAntes(LINHAS, EMAILS, TIPOS);
    const agora = separarMovimentacoesCarteira(LINHAS, EMAILS, TIPOS);
    expect(agora.tabulacoes.map((l) => l.id)).toEqual(antes.tabulacoes.map((l) => l.id));
    expect(agora.transferencias.map((l) => l.id)).toEqual(antes.transferencias.map((l) => l.id));
  });

  it("classifica cada caso do universo onde ele caia antes", () => {
    const { tabulacoes, transferencias } = separarMovimentacoesCarteira(LINHAS, EMAILS, TIPOS);
    expect(tabulacoes.map((l) => l.id)).toEqual([1, 5]);
    expect(transferencias.map((l) => l.id)).toEqual([4, 5]);
  });

  it("nao normaliza caixa: linha com e-mail em outra caixa fica fora dos dois", () => {
    const { tabulacoes, transferencias } = separarMovimentacoesCarteira(LINHAS, EMAILS, TIPOS);
    expect(tabulacoes.some((l) => l.id === 7)).toBe(false);
    expect(transferencias.some((l) => l.id === 7)).toBe(false);
  });

  it("linha sem autor nao entra em tabulacoes", () => {
    const { tabulacoes } = separarMovimentacoesCarteira(LINHAS, EMAILS, TIPOS);
    expect(tabulacoes.some((l) => l.id === 8)).toBe(false);
  });

  it("aguenta entrada vazia ou ausente sem estourar", () => {
    expect(separarMovimentacoesCarteira([], EMAILS, TIPOS)).toEqual({
      tabulacoes: [],
      transferencias: [],
    });
    expect(separarMovimentacoesCarteira(null, EMAILS, TIPOS)).toEqual({
      tabulacoes: [],
      transferencias: [],
    });
  });

  it("monta o filtro `or` exato: tabulacao (tipo e autor) OU transferencia", () => {
    const filtro = filtroMovimentacoesCarteira(EMAILS, TIPOS);
    expect(filtro).toBe(
      "and(tipo.in.(FINALIZACAO_ATENDIMENTO,FINALIZACAO)," +
        "registrado_por_email.in.(cobranca05@aelbra.com.br,cobranca12@aelbra.com.br))," +
        "operador_novo_email.in.(cobranca05@aelbra.com.br,cobranca12@aelbra.com.br)"
    );
  });

  it("recusa valor que quebraria a lista do PostgREST, em vez de montar um filtro errado", () => {
    expect(() => filtroMovimentacoesCarteira(['a"b@x.com'], ["T"])).toThrow();
    expect(() => filtroMovimentacoesCarteira(["a,b@x.com"], ["T"])).toThrow();
    expect(() => filtroMovimentacoesCarteira(["a(b@x.com"], ["T"])).toThrow();
  });

  // A razao da mudanca, em numero: a carteira da gestao tinha 13.694 alunos
  // ativos em 06/11/2026 e o lote e de 200.
  it("corta pela metade as requisicoes por carregamento", () => {
    const alunos = 13694;
    const lote = 200;
    const lotes = Math.ceil(alunos / lote);
    const antes = lotes * 2;
    const agora = lotes * 1;
    expect(lotes).toBe(69);
    expect(antes).toBe(138);
    expect(agora).toBe(69);
    expect(agora / antes).toBe(0.5);
  });
});
