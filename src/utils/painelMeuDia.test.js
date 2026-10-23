import { describe, it, expect } from "vitest";
import {
  JANELA_ATRASO_DIAS,
  JANELA_BOLETOS_DIAS,
  JANELA_RETORNOS_DIAS,
  agruparRetornosPorDia,
  boletosProximosDoVencimento,
  contarRetornoAutomaticoHoje,
  ehRetornoDoOperador,
  fimDaJanela,
  horaRetornoVencida,
  retornosAgendados,
  retornosAtrasados,
  retornosDoDia,
  retornosPendentes,
  rotuloDoDia,
  separarAgendaPorOrigem,
  somaBoletos,
  somaEmAberto,
} from "./painelMeuDia";

const HOJE = "2026-10-15";

const caso = (o) => ({
  id: "a1",
  nome: "Aluna Um",
  nome_aluno: "Aluna Um",
  telefone: "51999990000",
  valor_em_aberto: 1200.5,
  data_retorno: HOJE,
  retorno_origem: "OPERADOR",
  hora_retorno: "14:30:00",
  retorno_confirmado_em: null,
  responsavel_atual_email: "cobranca06@aelbra.com.br",
  ...o,
});

const acordosMap = (linhas) => new Map(linhas.map((a) => [a.id, a]));
const alunosMap = (linhas) => new Map(linhas.map((a) => [String(a.id), a]));

const ACORDO_ATIVO = { id: "c1", aluno_id: "a1", numero_acordo: 71903, status: "ATIVO", operador_responsavel_email: "cobranca06@aelbra.com.br" };
const ALUNO = { id: "a1", nome: "Aluna Um", nome_aluno: "Aluna Um" };

const parcela = (o) => ({ id: "p1", acordo_id: "c1", numero: 3, status: "A_VENCER", vencimento: "2026-10-17", valor: 665.98, boleto: "571903000300", boleto_confiavel: true, ...o });

describe("retornos agendados do dia", () => {
  it("entra so o retorno de hoje marcado pelo operador", () => {
    const lista = retornosAgendados(
      [
        caso(),
        caso({ id: "a2", retorno_origem: "AUTOMATICO" }), // prazo da tabulacao: fora
        caso({ id: "a3", data_retorno: "2026-10-16" }), // amanha: fora
        caso({ id: "a4", data_retorno: "2026-10-14" }), // ontem: fora
        caso({ id: "a5", data_retorno: null }),
      ],
      HOJE
    );
    expect(lista.map((r) => r.id)).toEqual(["a1"]);
    expect(lista[0]).toMatchObject({ aluno_id: "a1", nome: "Aluna Um", hora_retorno: "14:30", tratado: false });
  });

  it("origem OPERADOR_* tambem conta, e a ordem segue a hora combinada (sem hora por ultimo)", () => {
    const lista = retornosAgendados(
      [
        caso({ id: "sem-hora", hora_retorno: null, nome_aluno: "Zelia" }),
        caso({ id: "tarde", hora_retorno: "16:00" }),
        caso({ id: "manha", hora_retorno: "09:15", retorno_origem: "OPERADOR_TABULACAO" }),
      ],
      HOJE
    );
    expect(lista.map((r) => r.id)).toEqual(["manha", "tarde", "sem-hora"]);
  });

  it("retorno ja confirmado continua na lista, marcado, e sai da contagem de pendentes", () => {
    const lista = retornosAgendados([caso(), caso({ id: "a2", retorno_confirmado_em: "2026-10-15T12:00:00Z" })], HOJE);
    expect(lista).toHaveLength(2);
    expect(retornosPendentes(lista).map((r) => r.id)).toEqual(["a1"]);
  });

  it("sem data de hoje valida devolve lista vazia", () => {
    expect(retornosAgendados([caso()], "")).toEqual([]);
    expect(retornosAgendados(null, HOJE)).toEqual([]);
  });
});

describe("visao semanal dos retornos", () => {
  it("a janela da semana pega de hoje ate hoje+6, e o dia de cada linha vem junto", () => {
    const lista = retornosAgendados(
      [
        caso({ id: "hoje" }),
        caso({ id: "amanha", data_retorno: "2026-10-16" }),
        caso({ id: "ultimo", data_retorno: "2026-10-21" }),
        caso({ id: "fora", data_retorno: "2026-10-22" }),
        caso({ id: "ontem", data_retorno: "2026-10-14" }),
      ],
      HOJE,
      JANELA_RETORNOS_DIAS
    );
    expect(lista.map((r) => r.id)).toEqual(["hoje", "amanha", "ultimo"]);
    expect(lista[0].data).toBe(HOJE);
    expect(JANELA_RETORNOS_DIAS).toBe(6);
  });

  it("retornosDoDia tira so os de hoje de dentro da semana", () => {
    const semana = retornosAgendados([caso({ id: "hoje" }), caso({ id: "amanha", data_retorno: "2026-10-16" })], HOJE, JANELA_RETORNOS_DIAS);
    expect(retornosDoDia(semana, HOJE).map((r) => r.id)).toEqual(["hoje"]);
  });

  it("o rotulo do dia nao depende do locale da maquina", () => {
    expect(rotuloDoDia(HOJE, HOJE)).toBe("Hoje");
    expect(rotuloDoDia("2026-10-16", HOJE)).toBe("Amanhã");
    expect(rotuloDoDia("2026-10-17", HOJE)).toBe("sáb 17/10");
    expect(rotuloDoDia("2026-10-19", HOJE)).toBe("seg 19/10");
  });

  it("agrupa por dia, em ordem, contando o que falta tratar em cada um", () => {
    const semana = retornosAgendados(
      [
        caso({ id: "b", data_retorno: "2026-10-16" }),
        caso({ id: "a", hora_retorno: "08:00" }),
        caso({ id: "c", data_retorno: "2026-10-16", retorno_confirmado_em: "2026-10-15T10:00:00Z" }),
      ],
      HOJE,
      JANELA_RETORNOS_DIAS
    );
    const grupos = agruparRetornosPorDia(semana, HOJE);
    expect(grupos.map((g) => g.rotulo)).toEqual(["Hoje", "Amanhã"]);
    expect(grupos.map((g) => g.itens.length)).toEqual([1, 2]);
    expect(grupos.map((g) => g.pendentes)).toEqual([1, 1]);
  });

  it("dia sem retorno nao vira grupo vazio", () => {
    const grupos = agruparRetornosPorDia(retornosAgendados([caso()], HOJE, JANELA_RETORNOS_DIAS), HOJE);
    expect(grupos).toHaveLength(1);
  });
});

describe("contador do retorno automatico", () => {
  it("e a diferenca entre a contagem de hoje e o que o operador agendou", () => {
    expect(contarRetornoAutomaticoHoje(413, [{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(410);
  });

  it("nunca negativo: contagem menor que a lista (teto de paginacao) vira zero", () => {
    expect(contarRetornoAutomaticoHoje(2, [{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(0);
    expect(contarRetornoAutomaticoHoje(undefined, [{ id: 1 }])).toBe(0);
  });
});

describe("boletos proximos do vencimento", () => {
  const base = { acordoById: acordosMap([ACORDO_ATIVO]), alunoById: alunosMap([ALUNO]), hoje: HOJE };

  it("lista a parcela viva de acordo ativo dentro da janela, com acordo, parcela, valor e dias restantes", () => {
    const lista = boletosProximosDoVencimento([parcela()], base);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      aluno_id: "a1",
      aluno_nome: "Aluna Um",
      numero_acordo: 71903,
      numero_parcela: 3,
      parcela_id: "p1",
      valor: 665.98,
      vencimento: "2026-10-17",
      dias_restantes: 2,
      boleto: "571903000300",
      responsavel_email: "cobranca06@aelbra.com.br",
      tem_alerta: false,
    });
  });

  it("vencimento de hoje entra; vencida e fora da janela ficam de fora", () => {
    const lista = boletosProximosDoVencimento(
      [
        parcela({ id: "hoje", vencimento: HOJE }),
        parcela({ id: "ontem", vencimento: "2026-10-14" }),
        parcela({ id: "ultimo-dia", vencimento: "2026-10-20" }),
        parcela({ id: "fora", vencimento: "2026-10-21" }),
      ],
      base
    );
    expect(lista.map((b) => b.parcela_id)).toEqual(["hoje", "ultimo-dia"]);
    expect(JANELA_BOLETOS_DIAS).toBe(5);
  });

  it("parcela paga/cancelada e acordo nao ATIVO nao viram boleto a vencer", () => {
    const acordos = acordosMap([ACORDO_ATIVO, { ...ACORDO_ATIVO, id: "c2", status: "CANCELADO" }, { ...ACORDO_ATIVO, id: "c3", status: "QUITADO" }]);
    const lista = boletosProximosDoVencimento(
      [
        parcela({ id: "paga", status: "PAGO" }),
        parcela({ id: "cancelada", status: "CANCELADA" }),
        parcela({ id: "de-acordo-cancelado", acordo_id: "c2" }),
        parcela({ id: "de-acordo-quitado", acordo_id: "c3" }),
        parcela({ id: "sem-acordo", acordo_id: "c9" }),
        parcela({ id: "viva" }),
      ],
      { ...base, acordoById: acordos }
    );
    expect(lista.map((b) => b.parcela_id)).toEqual(["viva"]);
  });

  it("boleto marcado como nao confiavel nao vai para a tela", () => {
    const lista = boletosProximosDoVencimento([parcela({ boleto_confiavel: false })], base);
    expect(lista[0].boleto).toBe("");
  });

  it("marca tem_alerta so na parcela com alerta D-2 aberto; ordena pelo mais urgente", () => {
    const lista = boletosProximosDoVencimento(
      [parcela({ id: "p2", vencimento: "2026-10-19", numero: 4 }), parcela({ id: "p1", vencimento: "2026-10-16", numero: 3 })],
      { ...base, alertasPorParcela: new Set(["p2"]) }
    );
    expect(lista.map((b) => b.parcela_id)).toEqual(["p1", "p2"]);
    expect(lista.map((b) => b.tem_alerta)).toEqual([false, true]);
  });

  it("soma e fim da janela servem o cabecalho", () => {
    const lista = boletosProximosDoVencimento([parcela(), parcela({ id: "p2", valor: 100 })], base);
    expect(somaBoletos(lista)).toBeCloseTo(765.98, 2);
    expect(fimDaJanela(HOJE)).toBe("2026-10-20");
    expect(fimDaJanela(HOJE, 2)).toBe("2026-10-17");
  });
});

// Defeitos vistos NA TELA em 15/10/2026, com a frente ja em producao:
// todo retorno mostrava "R$ 0,00" e os boletos de um operador mostravam
// "Aluno" no lugar do nome. Os dois passaram pelo preview porque la os dados
// ficticios tinham valor e nome preenchidos.
describe("valor do retorno vem do consolidado da carteira", () => {
  const comZero = {
    id: "a1",
    nome_aluno: "Aluna Um",
    data_retorno: HOJE,
    retorno_origem: "OPERADOR",
    valor_em_aberto: 0, // e assim que esta em producao na maioria dos casos
  };

  it("usa o total consolidado quando o caso tem detalhe", () => {
    const fin = { a1: { temDetalhe: true, total: 2480.9 } };
    expect(retornosAgendados([comZero], HOJE, 0, fin)[0].valor_em_aberto).toBe(2480.9);
  });

  it("sem consolidado, cai no valor do proprio caso (comportamento antigo)", () => {
    expect(retornosAgendados([{ ...comZero, valor_em_aberto: 55 }], HOJE, 0)[0].valor_em_aberto).toBe(55);
    expect(retornosAgendados([comZero], HOJE, 0, {})[0].valor_em_aberto).toBe(0);
  });

  it("detalhe sem total valido nao vira NaN na tela", () => {
    const fin = { a1: { temDetalhe: true, total: null } };
    expect(retornosAgendados([comZero], HOJE, 0, fin)[0].valor_em_aberto).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Aba "Atrasados" (22/10/2026): o retorno que o operador agendou, venceu e
// nao foi tratado. O que estas checagens protegem:
//  1. o filtro OPERADOR continua valendo (prazo automatico nao entra);
//  2. a janela e de JANELA_ATRASO_DIAS dias, igual a da Agenda embutida;
//  3. esta lista e a de `retornosAgendados` sao DISJUNTAS -- ninguem aparece
//     nas duas, e por isso nenhum numero da tela conta a mesma pessoa duas
//     vezes;
//  4. o tratado nao volta como pendencia.
// ---------------------------------------------------------------------
describe("retornos atrasados", () => {
  it("entra so o vencido, do operador, ainda sem tratamento", () => {
    const lista = retornosAtrasados(
      [
        caso({ id: "ontem", data_retorno: "2026-10-14" }),
        caso({ id: "hoje", data_retorno: HOJE }), // hoje e da aba Hoje
        caso({ id: "amanha", data_retorno: "2026-10-16" }), // futuro: fora
        caso({ id: "automatico", data_retorno: "2026-10-14", retorno_origem: "AUTOMATICO" }),
        caso({ id: "tratado", data_retorno: "2026-10-14", retorno_confirmado_em: "2026-10-14T18:00:00Z" }),
        caso({ id: "sem-data", data_retorno: null }),
      ],
      HOJE
    );
    expect(lista.map((r) => r.id)).toEqual(["ontem"]);
    expect(lista[0]).toMatchObject({ dias_atraso: 1, nome: "Aluna Um", tratado: false });
  });

  it("a janela para no limite: 7 dias atras entra, 8 nao", () => {
    const lista = retornosAtrasados(
      [
        caso({ id: "limite", data_retorno: "2026-10-08" }),
        caso({ id: "velho", data_retorno: "2026-10-07" }),
      ],
      HOJE
    );
    expect(lista.map((r) => r.id)).toEqual(["limite"]);
    expect(lista[0].dias_atraso).toBe(JANELA_ATRASO_DIAS);
  });

  it("mais antigo primeiro; dentro do mesmo dia o prioritario desempata", () => {
    const lista = retornosAtrasados(
      [
        caso({ id: "novo", data_retorno: "2026-10-14" }),
        caso({ id: "velho-comum", data_retorno: "2026-10-12", hora_retorno: "09:00" }),
        caso({ id: "velho-prioritario", data_retorno: "2026-10-12", hora_retorno: "17:00", retorno_prioritario: true }),
      ],
      HOJE
    );
    // A data manda sobre a prioridade: o prioritario do dia 12 nao pula para
    // depois do dia 14, e dentro do dia 12 ele vem antes mesmo com hora pior.
    expect(lista.map((r) => r.id)).toEqual(["velho-prioritario", "velho-comum", "novo"]);
  });

  it("nenhum caso aparece nas duas listas (atrasados x agendados)", () => {
    const casos = [
      caso({ id: "ontem", data_retorno: "2026-10-14" }),
      caso({ id: "hoje", data_retorno: HOJE }),
      caso({ id: "quinta", data_retorno: "2026-10-16" }),
    ];
    const atrasados = retornosAtrasados(casos, HOJE).map((r) => r.id);
    const agendados = retornosAgendados(casos, HOJE, JANELA_RETORNOS_DIAS).map((r) => r.id);
    expect(atrasados).toEqual(["ontem"]);
    expect(agendados).toEqual(["hoje", "quinta"]);
    expect(atrasados.filter((id) => agendados.includes(id))).toEqual([]);
  });

  it("sem hoje valido devolve lista vazia, sem explodir", () => {
    expect(retornosAtrasados([caso({ data_retorno: "2026-10-14" })], null)).toEqual([]);
    expect(retornosAtrasados(null, HOJE)).toEqual([]);
  });

  it("usa o consolidado da carteira no valor, como a aba de hoje", () => {
    const lista = retornosAtrasados(
      [caso({ id: "a1", data_retorno: "2026-10-14" })],
      HOJE,
      JANELA_ATRASO_DIAS,
      { a1: { temDetalhe: true, total: 4321.99 } }
    );
    expect(lista[0].valor_em_aberto).toBe(4321.99);
  });
});

describe("prioritarios no chip do dia", () => {
  it("conta so o prioritario que ainda falta tratar", () => {
    const retornos = retornosAgendados(
      [
        caso({ id: "p1", retorno_prioritario: true }),
        caso({ id: "p2", retorno_prioritario: true, retorno_confirmado_em: "2026-10-15T12:00:00Z" }),
        caso({ id: "comum" }),
        caso({ id: "amanha", data_retorno: "2026-10-16" }),
      ],
      HOJE,
      JANELA_RETORNOS_DIAS
    );
    const grupos = agruparRetornosPorDia(retornos, HOJE);
    expect(grupos.map((g) => [g.rotulo, g.pendentes, g.prioritarios])).toEqual([
      ["Hoje", 2, 1],
      ["Amanhã", 1, 0],
    ]);
  });

  it("a ordem dos dias nao muda por causa da prioridade", () => {
    const retornos = retornosAgendados(
      [
        caso({ id: "hoje-comum" }),
        caso({ id: "amanha-prioritario", data_retorno: "2026-10-16", retorno_prioritario: true }),
      ],
      HOJE,
      JANELA_RETORNOS_DIAS
    );
    expect(agruparRetornosPorDia(retornos, HOJE).map((g) => g.data)).toEqual(["2026-10-15", "2026-10-16"]);
  });
});

describe("total em aberto da lista mostrada", () => {
  it("soma so os pendentes", () => {
    expect(
      somaEmAberto([
        { valor_em_aberto: 100.5, tratado: false },
        { valor_em_aberto: 200, tratado: true },
        { valor_em_aberto: 50.25, tratado: false },
      ])
    ).toBeCloseTo(150.75, 2);
  });

  it("lista vazia ou valor sujo nao viram NaN", () => {
    expect(somaEmAberto([])).toBe(0);
    expect(somaEmAberto(null)).toBe(0);
    expect(somaEmAberto([{ valor_em_aberto: null, tratado: false }, { tratado: false }])).toBe(0);
  });
});

describe("hora combinada que ja passou", () => {
  const item = (o) => ({ data: HOJE, hora_retorno: "14:30", tratado: false, ...o });

  it("passou da hora, no dia de hoje, com retorno pendente", () => {
    expect(horaRetornoVencida(item(), { hoje: HOJE, horaAgora: "15:00" })).toBe(true);
    expect(horaRetornoVencida(item(), { hoje: HOJE, horaAgora: "14:29" })).toBe(false);
    // Na hora exata o aviso da tela ja cobre; "vencida" e so depois dela.
    expect(horaRetornoVencida(item(), { hoje: HOJE, horaAgora: "14:30" })).toBe(false);
  });

  it("nao vale para tratado, sem hora, de outro dia, nem sem relogio", () => {
    expect(horaRetornoVencida(item({ tratado: true }), { hoje: HOJE, horaAgora: "23:00" })).toBe(false);
    expect(horaRetornoVencida(item({ hora_retorno: "" }), { hoje: HOJE, horaAgora: "23:00" })).toBe(false);
    expect(horaRetornoVencida(item({ data: "2026-10-16" }), { hoje: HOJE, horaAgora: "23:00" })).toBe(false);
    expect(horaRetornoVencida(item(), { hoje: HOJE, horaAgora: "" })).toBe(false);
    expect(horaRetornoVencida(item(), {})).toBe(false);
    expect(horaRetornoVencida(null, { hoje: HOJE, horaAgora: "23:00" })).toBe(false);
  });

  it("meia-noite e 9h nao se confundem: a comparacao e zero-padded", () => {
    expect(horaRetornoVencida(item({ hora_retorno: "09:00" }), { hoje: HOJE, horaAgora: "10:00" })).toBe(true);
    expect(horaRetornoVencida(item({ hora_retorno: "10:00" }), { hoje: HOJE, horaAgora: "09:00" })).toBe(false);
  });
});

// P3 (23/10/2026): separar compromisso do operador de prazo da tabulacao.
describe("origem do retorno", () => {
  it("OPERADOR, e so o prefixo OPERADOR, e compromisso do operador", () => {
    expect(ehRetornoDoOperador({ retorno_origem: "OPERADOR" })).toBe(true);
    // O prefixo existe porque a base tem variacoes ("OPERADOR_RECEPTIVO").
    expect(ehRetornoDoOperador({ retorno_origem: "OPERADOR_RECEPTIVO" })).toBe(true);
    expect(ehRetornoDoOperador({ retorno_origem: "AUTOMATICO" })).toBe(false);
    // Origem nula conta como automatica: em producao (22/10/2026) ha 8 fichas
    // com data de retorno e origem nula, e nenhuma delas e compromisso provado.
    expect(ehRetornoDoOperador({ retorno_origem: null })).toBe(false);
    expect(ehRetornoDoOperador({})).toBe(false);
    expect(ehRetornoDoOperador(null)).toBe(false);
    // Minuscula NAO passa -- o dado de producao e maiusculo e o criterio e o
    // mesmo que as duas funcoes da tela aplicam no proprio filtro.
    expect(ehRetornoDoOperador({ retorno_origem: "operador" })).toBe(false);
  });

  it("as tres leituras da origem concordam (guarda contra deriva)", () => {
    // `retornosAgendados` e `retornosAtrasados` repetem o literal
    // `startsWith("OPERADOR")` dentro do filtro, e os testes de producao
    // ancoram nesse literal. Se alguem mudar `ehRetornoDoOperador` e esquecer
    // as outras duas (ou o contrario), este teste reprova em vez de deixar as
    // leituras divergirem em silencio.
    const casos = [
      { id: "1", retorno_origem: "OPERADOR", data_retorno: HOJE },
      { id: "2", retorno_origem: "OPERADOR_RECEPTIVO", data_retorno: HOJE },
      { id: "3", retorno_origem: "AUTOMATICO", data_retorno: HOJE },
      { id: "4", retorno_origem: null, data_retorno: HOJE },
      { id: "5", retorno_origem: "operador", data_retorno: HOJE },
    ];
    const porPredicado = casos.filter((a) => ehRetornoDoOperador(a)).map((a) => a.id);
    expect(retornosAgendados(casos, HOJE).map((r) => r.id)).toEqual(porPredicado);

    const ontem = casos.map((a) => ({ ...a, data_retorno: "2026-10-14" }));
    expect(retornosAtrasados(ontem, HOJE).map((r) => r.id).sort()).toEqual([...porPredicado].sort());
  });

  it("conta as duas origens sem mexer na lista", () => {
    const lista = [
      { retorno_origem: "OPERADOR" },
      { retorno_origem: "AUTOMATICO" },
      { retorno_origem: "AUTOMATICO" },
      { retorno_origem: null },
    ];
    expect(separarAgendaPorOrigem(lista)).toEqual({ total: 4, agendados: 1, automaticos: 3 });
    // O total e sempre a soma das duas pontas: nenhuma linha se perde nem se
    // conta duas vezes, qualquer que seja a origem.
    const r = separarAgendaPorOrigem(lista);
    expect(r.agendados + r.automaticos).toBe(r.total);
    expect(lista).toHaveLength(4);
  });

  it("lista vazia ou invalida nao inventa numero", () => {
    expect(separarAgendaPorOrigem([])).toEqual({ total: 0, agendados: 0, automaticos: 0 });
    expect(separarAgendaPorOrigem(null)).toEqual({ total: 0, agendados: 0, automaticos: 0 });
    expect(separarAgendaPorOrigem(undefined)).toEqual({ total: 0, agendados: 0, automaticos: 0 });
  });
});
