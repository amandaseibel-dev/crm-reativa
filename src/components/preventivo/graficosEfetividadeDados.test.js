// O QUE ESTE ARQUIVO PROTEGE: o gráfico nunca mentir.
//
//   1. ausência de medição NÃO vira 0% — a ação sai do gráfico e é nomeada;
//   2. os três motivos de "sem régua" aparecem com o nome certo, na ordem certa;
//   3. a taxa por canal é soma ponderada, não média de médias;
//   4. contexto e canal não se misturam;
//   5. nenhuma conta nova: a taxa por ação é a que o banco mandou.
import { describe, it, expect } from "vitest";
import {
  dadosPorAcao, dadosPorContextoCanal, motivoSemRegua, CONTEXTOS_ROTULO,
} from "./graficosEfetividadeDados";

// Uma linha como `preventivo_resultados_por_acao` devolve.
const acao = (over = {}) => ({
  id: over.id || "a1",
  nome: over.nome || "Ação",
  canal: over.canal || "WHATSAPP",
  contexto: over.contexto || "BOLETO_VENCIDO",
  alunos_acionados: 100,
  alunos_regularizados: 25,
  titulos_acionados: 100,
  regularizados_entre_remessas: 25,
  valor_acionado: "10000.00",
  valor_regularizado: "2500.00",
  taxa_regularizacao: 25,
  taxa_regularizacao_alunos: 25,
  taxa_regularizacao_valor: 25,
  aguardando_envio_confirmado: false,
  aguardando_proxima_remessa: false,
  ...over,
});

// Como o banco devolve ação sem envio confirmado: tudo que é resultado em null.
const semEnvio = (over = {}) => acao({
  aguardando_envio_confirmado: true,
  alunos_regularizados: null,
  regularizados_entre_remessas: null,
  valor_regularizado: null,
  taxa_regularizacao: null,
  taxa_regularizacao_alunos: null,
  taxa_regularizacao_valor: null,
  ...over,
});

const semRemessa = (over = {}) => semEnvio({
  aguardando_envio_confirmado: false,
  aguardando_proxima_remessa: true,
  ...over,
});

describe("gráficos do Preventivo — os dados", () => {
  it("ação sem envio confirmado NÃO entra no gráfico e não vira 0%", () => {
    const { medidas, aguardando } = dadosPorAcao([semEnvio({ nome: "Mensalidade de outubro" })]);
    expect(medidas).toEqual([]);
    expect(aguardando).toHaveLength(1);
    expect(aguardando[0].nome).toBe("Mensalidade de outubro");
    expect(aguardando[0].motivo).toBe("aguardando envio confirmado");
    // o ponto todo: nenhum zero foi inventado
    expect(JSON.stringify(medidas)).not.toContain("0");
  });

  it("ação com envio e sem remessa seguinte também fica fora", () => {
    const { medidas, aguardando } = dadosPorAcao([semRemessa({ nome: "Enviada" })]);
    expect(medidas).toEqual([]);
    expect(aguardando[0].motivo).toBe("aguardando próxima remessa");
  });

  it("os três motivos têm nome próprio e a falta de envio vem antes", () => {
    expect(motivoSemRegua({ sem_remessa: true })).toBe("sem remessa vinculada");
    expect(motivoSemRegua({ aguardando_envio_confirmado: true, aguardando_proxima_remessa: true }))
      .toBe("aguardando envio confirmado");
    expect(motivoSemRegua({ aguardando_proxima_remessa: true })).toBe("aguardando próxima remessa");
    expect(motivoSemRegua(acao())).toBe(null);
  });

  it("taxa zero MEDIDA entra no gráfico — zero medido não é ausência", () => {
    const { medidas, aguardando } = dadosPorAcao([
      acao({ alunos_regularizados: 0, taxa_regularizacao_alunos: 0, valor_regularizado: "0.00", taxa_regularizacao_valor: 0 }),
    ]);
    expect(aguardando).toEqual([]);
    expect(medidas).toHaveLength(1);
    expect(medidas[0].taxa_alunos).toBe(0);
  });

  it("a taxa da barra é a que o banco mandou, sem recálculo", () => {
    // propositalmente incoerente: 25/100 seria 25%, mas o banco disse 31,4
    const { medidas } = dadosPorAcao([acao({ taxa_regularizacao_alunos: 31.4 })]);
    expect(medidas[0].taxa_alunos).toBe(31.4);
  });

  it("o tooltip recebe os cinco campos pedidos", () => {
    const { medidas } = dadosPorAcao([acao()]);
    const m = medidas[0];
    expect(m.alunos_acionados).toBe(100);
    expect(m.alunos_regularizados).toBe(25);
    expect(m.valor_acionado).toBe("10000.00");
    expect(m.valor_regularizado).toBe("2500.00");
    expect(m.taxa_valor).toBe(25);
  });

  it("mistura de medida e não medida: só a medida desenha", () => {
    const { medidas, aguardando } = dadosPorAcao([
      acao({ id: "m", nome: "Medida" }),
      semEnvio({ id: "s", nome: "Sem envio" }),
    ]);
    expect(medidas.map((x) => x.nome)).toEqual(["Medida"]);
    expect(aguardando.map((x) => x.nome)).toEqual(["Sem envio"]);
  });

  it("lista vazia ou indefinida não quebra", () => {
    expect(dadosPorAcao([])).toEqual({ medidas: [], aguardando: [] });
    expect(dadosPorAcao(undefined)).toEqual({ medidas: [], aguardando: [] });
    expect(dadosPorContextoCanal(undefined)).toEqual({ grupos: [], aguardando: [] });
  });

  it("a taxa por canal é SOMA PONDERADA, não média de médias", () => {
    // 1 aluno de 1 regularizado (100%) + 8.000 com 800 (10%).
    // Média de médias daria 55%. O certo é 801/8001 = 10,0%.
    const { grupos } = dadosPorContextoCanal([
      acao({ id: "p", alunos_acionados: 1, alunos_regularizados: 1, taxa_regularizacao_alunos: 100 }),
      acao({ id: "g", alunos_acionados: 8000, alunos_regularizados: 800, taxa_regularizacao_alunos: 10 }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].WHATSAPP).toBe(10);
    expect(grupos[0].WHATSAPP_dados).toMatchObject({ acoes: 2, acionados: 8001, regularizados: 801 });
  });

  it("separa contexto e canal sem misturar", () => {
    const { grupos } = dadosPorContextoCanal([
      acao({ id: "1", contexto: "BOLETO_VENCIDO", canal: "WHATSAPP", alunos_acionados: 100, alunos_regularizados: 40 }),
      acao({ id: "2", contexto: "BOLETO_VENCIDO", canal: "EMAIL", alunos_acionados: 100, alunos_regularizados: 10 }),
      acao({ id: "3", contexto: "PROXIMO_VENCIMENTO", canal: "WHATSAPP", alunos_acionados: 50, alunos_regularizados: 30 }),
    ]);
    const bv = grupos.find((g) => g.contexto === "BOLETO_VENCIDO");
    const pv = grupos.find((g) => g.contexto === "PROXIMO_VENCIMENTO");
    expect(bv.WHATSAPP).toBe(40);
    expect(bv.EMAIL).toBe(10);
    expect(pv.WHATSAPP).toBe(60);
    expect(pv.EMAIL).toBeUndefined();          // canal sem ação medida não desenha
    expect(bv.rotulo).toBe(CONTEXTOS_ROTULO.BOLETO_VENCIDO);
  });

  it("contexto cujas ações todas aguardam não cria grupo vazio", () => {
    const { grupos, aguardando } = dadosPorContextoCanal([
      semEnvio({ id: "x", contexto: "PROXIMO_VENCIMENTO", nome: "Só aguardando" }),
    ]);
    expect(grupos).toEqual([]);
    expect(aguardando).toHaveLength(1);
  });

  it("SEM_CONTEXTO aparece com rótulo legível", () => {
    const { grupos } = dadosPorContextoCanal([acao({ contexto: "SEM_CONTEXTO" })]);
    expect(grupos[0].rotulo).toBe("Sem contexto");
  });

  it("os grupos saem em ordem alfabética estável", () => {
    const { grupos } = dadosPorContextoCanal([
      acao({ id: "1", contexto: "PROXIMO_VENCIMENTO" }),
      acao({ id: "2", contexto: "BOLETO_VENCIDO" }),
    ]);
    expect(grupos.map((g) => g.rotulo)).toEqual(["Boleto vencido", "Próximo ao vencimento"]);
  });
});
