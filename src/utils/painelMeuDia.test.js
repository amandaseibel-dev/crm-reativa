import { describe, it, expect } from "vitest";
import {
  JANELA_BOLETOS_DIAS,
  JANELA_RETORNOS_DIAS,
  agruparRetornosPorDia,
  boletosProximosDoVencimento,
  contarRetornoAutomaticoHoje,
  fimDaJanela,
  retornosAgendados,
  retornosDoDia,
  retornosPendentes,
  rotuloDoDia,
  somaBoletos,
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
