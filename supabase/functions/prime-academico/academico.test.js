// Testes da leitura da resposta de `students_search`.
//
// O que estes testes protegem:
//   1. a DISTINÇÃO entre os três desfechos. Achatar falha de rede em "sem
//      resultado" faria a tela dizer que o aluno não tem vínculo por causa de
//      um timeout -- é o erro mais caro possível aqui;
//   2. que o desfecho é calculado DEPOIS do filtro por CPF, senão uma busca que
//      só traz terceiros vira "COM_VINCULOS" com tabela vazia;
//   3. que a paginação não perde linha em silêncio.

import { describe, it, expect } from "vitest";
import {
  desfecho, devePedirMaisUma, formatarCpf, lerPagina, paginouAteOFim,
  registrationDoCabecalho, vinculosDaResposta,
} from "./academico.ts";

const CPF = "111.111.111-11"; // ficticio
const linha = (o = {}) => ({ cpf: CPF, registration: "990100001", course: "A", ...o });

describe("formatarCpf", () => {
  it("formata, porque o search só encontra CPF com pontuação", () => {
    expect(formatarCpf("11111111111")).toBe(CPF);
    expect(formatarCpf(CPF)).toBe(CPF);
    expect(formatarCpf(" 111 111 111 11 ")).toBe(CPF);
  });
  it("recusa o que não é CPF em vez de mandar lixo para a API", () => {
    for (const v of [null, undefined, "", "123", "0212330209", "021233020901", "abc"]) {
      expect(formatarCpf(v), String(v)).toBeNull();
    }
  });
});

describe("lerPagina", () => {
  it("separa lista vazia de corpo ilegível", () => {
    expect(lerPagina({ items: [], totalItems: 0 })).toEqual({ items: [], totalItems: 0 });
    // `items: null` é "não entendi", e NÃO "não tem nada"
    for (const d of [null, {}, { items: null }, { items: "x" }, 42, "texto"]) {
      expect(lerPagina(d).items, JSON.stringify(d)).toBeNull();
    }
  });
  it("totalItems fica nulo quando a API não manda o número", () => {
    expect(lerPagina({ items: [] }).totalItems).toBeNull();
  });
});

describe("devePedirMaisUma — a paginação não pode perder linha", () => {
  it("pede mais quando a página veio cheia e ainda falta", () => {
    expect(devePedirMaisUma(50, 50, 50, 120, 500)).toBe(true);
  });
  it("para quando a página veio menor que o pedido (era a última)", () => {
    expect(devePedirMaisUma(70, 20, 50, null, 500)).toBe(false);
  });
  it("para quando a página veio vazia", () => {
    expect(devePedirMaisUma(50, 0, 50, null, 500)).toBe(false);
  });
  it("para quando já juntou o total anunciado", () => {
    expect(devePedirMaisUma(100, 50, 50, 100, 500)).toBe(false);
  });
  it("para no teto, para não girar para sempre se a API repetir a página", () => {
    expect(devePedirMaisUma(500, 50, 50, 99999, 500)).toBe(false);
  });
  it("mas o teto NÃO é prova de fim — é desistência", () => {
    // A distinção existe porque parar no teto não pode virar COM_VINCULOS.
    expect(paginouAteOFim(500, 50, 50, 99999)).toBe(false);
  });
  it("continua quando a API não diz o total mas a página veio cheia", () => {
    // Sem `totalItems`, parar aqui perderia a página seguinte em silêncio.
    expect(devePedirMaisUma(50, 50, 50, null, 500)).toBe(true);
  });
});

describe("paginouAteOFim — o que conta como prova de fim", () => {
  it("página vazia, página curta e total atingido são prova", () => {
    expect(paginouAteOFim(50, 0, 50, null)).toBe(true);
    expect(paginouAteOFim(70, 20, 50, null)).toBe(true);
    expect(paginouAteOFim(100, 50, 50, 100)).toBe(true);
  });
  it("página cheia sem total conhecido NÃO é prova", () => {
    expect(paginouAteOFim(50, 50, 50, null)).toBe(false);
  });
});

describe("desfecho — calculado DEPOIS do filtro por CPF", () => {
  it("COM_VINCULOS só quando há linha DESTA pessoa", () => {
    expect(desfecho(null, false, [linha()])).toBe("COM_VINCULOS");
  });

  it("SEM_RESULTADO quando a API respondeu e sobrou zero após o filtro", () => {
    // Este é o caso que a versão anterior errava: `items` tinha linhas, mas
    // nenhuma da pessoa. Dizia COM_VINCULOS e mostrava tabela vazia.
    expect(desfecho(null, false, [])).toBe("SEM_RESULTADO");
  });

  it("FALHA_COMUNICACAO quando houve falha — e isto NÃO é 'sem resultado'", () => {
    for (const f of ["HTTP 500", "HTTP 401", "falha de rede: TypeError"]) {
      expect(desfecho(f, false, []), f).toBe("FALHA_COMUNICACAO");
    }
  });

  it("corpo ilegível é FALHA, nunca 'vazio'", () => {
    expect(desfecho(null, true, [])).toBe("FALHA_COMUNICACAO");
  });

  it("PAGINACAO_INCOMPLETA quando há linhas mas não houve prova de fim", () => {
    // Bateu no teto: há dado, e ele não pode ser apresentado como lista
    // completa. COM_VINCULOS aqui afirmaria um total que ninguém mediu.
    expect(desfecho(null, false, [linha()], false)).toBe("PAGINACAO_INCOMPLETA");
  });

  it("sem linha nenhuma e SEM prova de fim é INCOMPLETA, não SEM_RESULTADO", () => {
    // ESTE TESTE AFIRMAVA O CONTRÁRIO, e estava errado -- ele fixava o defeito
    // em vez de pegá-lo. "Nada chegou desta pessoa" e "a busca acabou sem achar
    // nada dela" são coisas diferentes: a primeira não é resposta, é ausência
    // de resposta. Tratá-las igual fazia uma autorização negada virar
    // "consultado, sem vínculo" -- e, por ser desfecho completo, substituir a
    // última consulta boa da ficha. Lista vazia só conclui depois do fim.
    expect(desfecho(null, false, [], false)).toBe("PAGINACAO_INCOMPLETA");
  });

  it("SEM_RESULTADO exige a busca TERMINADA", () => {
    expect(desfecho(null, false, [], true)).toBe("SEM_RESULTADO");
  });

  it("falha manda mesmo que tenham sobrado linhas de páginas anteriores", () => {
    // Página 1 veio, página 2 falhou: a lista está incompleta e não se sabe o
    // quanto. Gravar como COM_VINCULOS afirmaria uma lista completa.
    expect(desfecho("HTTP 503", false, [linha()])).toBe("FALHA_COMUNICACAO");
  });
});

describe("vinculosDaResposta", () => {
  it("preserva a ORDEM e todas as linhas, inclusive semelhantes com status diferentes", () => {
    // A estrutura medida e registrada em
    // docs/integracoes/prime-mapa-identificadores.md: três vínculos com curso,
    // campus e turno idênticos e status diferentes. Nenhum pode desaparecer.
    const itens = [
      linha({ course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "AD", status: "Reopção de Curso" }),
      linha({ course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "AD", status: "Cancelado" }),
      linha({ course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "AD", status: null }),
    ];
    const v = vinculosDaResposta(itens, CPF);
    expect(v).toHaveLength(3);
    expect(v.map((x) => x.status)).toEqual(["Reopção de Curso", "Cancelado", null]);
  });

  it("descarta linha de OUTRA pessoa, porque o search é substring", () => {
    const v = vinculosDaResposta(
      [linha({ course: "A" }), linha({ cpf: "999.999.999-99", course: "B" })], CPF);
    expect(v).toHaveLength(1);
    expect(v[0].course).toBe("A");
  });

  it("busca que só traz terceiros sobra zero — e vira SEM_RESULTADO", () => {
    const v = vinculosDaResposta([linha({ cpf: "999.999.999-99" })], CPF);
    expect(v).toHaveLength(0);
    expect(desfecho(null, false, v)).toBe("SEM_RESULTADO");
  });

  it("compara CPF em dígitos, não em texto formatado", () => {
    expect(vinculosDaResposta([linha({ cpf: "11111111111" })], CPF)).toHaveLength(1);
  });

  it("guarda a matrícula EM CADA LINHA", () => {
    const v = vinculosDaResposta(
      [linha({ registration: "111" }), linha({ registration: "222" })], CPF);
    expect(v.map((x) => x.registration)).toEqual(["111", "222"]);
  });

  it("matrícula numérica vira texto, para não perder zero à esquerda na volta", () => {
    expect(vinculosDaResposta([linha({ registration: 990100001 })], CPF)[0].registration)
      .toBe("990100001");
  });

  it("guarda graduated e admissionYear sem derivar um do status", () => {
    // Medido: há linha com status 'Mudança de Campus' e graduated true --
    // um não se deriva do outro. Ver docs/integracoes/prime-api.md.
    const v = vinculosDaResposta(
      [linha({ status: "Mudança de Campus", graduated: true, admissionYear: 2023 })], CPF);
    expect(v[0]).toMatchObject({ status: "Mudança de Campus", graduated: true, admissionYear: 2023 });
  });

  it("devolve lista vazia sem estourar quando não há linha nenhuma", () => {
    expect(vinculosDaResposta([], CPF)).toEqual([]);
  });
});

describe("registrationDoCabecalho", () => {
  it("preenche quando todas as linhas concordam", () => {
    expect(registrationDoCabecalho([{ registration: "1" }, { registration: "1" }])).toBe("1");
  });
  it("fica nulo quando divergem, em vez de escolher uma", () => {
    // A informação por linha é que manda; escolher aqui daria a impressão de
    // que a pessoa "tem" aquela matrícula.
    expect(registrationDoCabecalho([{ registration: "1" }, { registration: "2" }])).toBeNull();
  });
  it("fica nulo quando não há matrícula nenhuma", () => {
    expect(registrationDoCabecalho([{ registration: null }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// O LAÇO REAL, com Prime simulado
// ---------------------------------------------------------------------------
// Aqui roda `paginarComAutorizacao`, que é o mesmo código do `index.ts` -- não
// uma reimplementação. O Prime é dublado, e a autorização também, porque o que
// se mede é a COREOGRAFIA: autorizar antes de buscar, parar na negativa, e não
// afirmar lista completa quando foi interrompida.
import { paginarComAutorizacao } from "./academico.ts";

const pagina = (n, total) => ({
  http: 200, ok: true,
  texto: JSON.stringify({ items: Array.from({ length: n }, () => ({ cpf: "111.111.111-11" })), totalItems: total }),
});

describe("paginarComAutorizacao — o caminho real", () => {
  it("autoriza ANTES de buscar, em toda página", async () => {
    const ordem = [];
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => { ordem.push("autoriza"); return { ok: true }; },
      buscar: async (skip) => { ordem.push("busca:" + skip); return pagina(skip < 4 ? 2 : 1, 5); },
    });
    expect(r.brutos).toHaveLength(5);
    expect(r.chegouAoFim).toBe(true);
    expect(r.negou).toBeNull();
    // nunca uma busca sem autorização imediatamente antes
    expect(ordem).toEqual(["autoriza","busca:0","autoriza","busca:2","autoriza","busca:4"]);
  });

  it("INTERRUPÇÃO APÓS VÁRIAS PÁGINAS: para na negativa e não busca de novo", async () => {
    let n = 0;
    const buscas = [];
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => (++n <= 3 ? { ok: true } : { ok: false, motivo: "SEM_ORCAMENTO" }),
      buscar: async (skip) => { buscas.push(skip); return pagina(2, 999); },
    });
    expect(buscas).toEqual([0, 2, 4]);     // três páginas, e parou
    expect(r.requisicoes).toBe(3);
    expect(r.negou).toBe("SEM_ORCAMENTO");
    // TEM dado, mas não é lista completa -- é o que vira PAGINACAO_INCOMPLETA
    expect(r.brutos).toHaveLength(6);
    expect(r.chegouAoFim).toBe(false);
    expect(desfecho(null, false, r.brutos, r.chegouAoFim)).toBe("PAGINACAO_INCOMPLETA");
  });

  it("EXPIRAÇÃO DA EXECUÇÃO no meio da consulta para sem chamar o Prime", async () => {
    let n = 0;
    const buscas = [];
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => (++n === 1 ? { ok: true } : { ok: false, motivo: "EXECUCAO_SUPERADA" }),
      buscar: async (skip) => { buscas.push(skip); return pagina(2, 999); },
    });
    expect(buscas).toEqual([0]);
    expect(r.negou).toBe("EXECUCAO_SUPERADA");
    expect(r.requisicoes).toBe(1);
  });

  it("negada a PRIMEIRA página, o Prime não é chamado nenhuma vez", async () => {
    const buscas = [];
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => ({ ok: false, motivo: "LOTE_INTERROMPIDO" }),
      buscar: async (skip) => { buscas.push(skip); return pagina(2, 9); },
    });
    expect(buscas).toEqual([]);
    expect(r.requisicoes).toBe(0);
    expect(r.brutos).toHaveLength(0);
    // Negada antes da primeira chamada: nada foi perguntado à Ulbra. O desfecho
    // não pode afirmar nada sobre os vínculos dela.
    expect(r.chegouAoFim).toBe(false);
    expect(desfecho(null, false, r.brutos, r.chegouAoFim)).toBe("PAGINACAO_INCOMPLETA");
  });

  it("a requisição é contada mesmo quando a rede morre depois de autorizar", async () => {
    // Autorizada e debitada no banco: a chamada saiu. Não contar aqui faria o
    // teto divergir do que a API recebeu.
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => ({ ok: true }),
      buscar: async () => ({ erro: "falha de rede: TypeError" }),
    });
    expect(r.requisicoes).toBe(1);
    expect(r.falha).toMatch(/falha de rede/);
  });

  it("sem piloto (ficha), não há autorização e a paginação corre normal", async () => {
    const r = await paginarComAutorizacao({
      take: 2, teto: 100, autorizar: null,
      buscar: async (skip) => pagina(skip < 2 ? 2 : 1, 3),
    });
    expect(r.brutos).toHaveLength(3);
    expect(r.chegouAoFim).toBe(true);
    expect(r.negou).toBeNull();
  });

  it("HTTP 429 para na hora, com o status preservado para interromper o lote", async () => {
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => ({ ok: true }),
      buscar: async () => ({ http: 429, ok: false, texto: "" }),
    });
    expect(r.httpStatus).toBe(429);
    expect(r.falha).toBe("HTTP 429");
    expect(r.requisicoes).toBe(1);
  });

  it("corpo ilegível no meio é FALHA, e não 'acabou'", async () => {
    let n = 0;
    const r = await paginarComAutorizacao({
      take: 2, teto: 100,
      autorizar: async () => ({ ok: true }),
      buscar: async () => (++n === 1 ? pagina(2, 99) : { http: 200, ok: true, texto: "isto nao e json" }),
    });
    expect(r.paginaIlegivel).toBe(true);
    expect(desfecho(null, true, r.brutos, r.chegouAoFim)).toBe("FALHA_COMUNICACAO");
  });
});
