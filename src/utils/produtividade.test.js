import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAUSAS,
  agruparPonto,
  chaveDia,
  corteDoPeriodo,
  cruzarPresencaProducao,
  diaParaData,
  duracaoMinutos,
  entradasPorDia,
  pendenciasPorOperador,
  serieAcionamentos,
  ultimosDias,
} from "./produtividade";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FONTE_UTIL = readFileSync(resolve(AQUI, "produtividade.js"), "utf8");
const FONTE_TELA = readFileSync(
  resolve(AQUI, "..", "pages", "ProdutividadeOperacional.jsx"), "utf8");

// Os comentarios dos dois arquivos CITAM de proposito o que nao se usa (a
// coluna zerada, as listas divergentes de acionamento) -- e a documentacao da
// decisao. O que os testes de fonte cobram e o CODIGO, sem comentario.
const semComentarios = (fonte) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
const CODIGO_UTIL = semComentarios(FONTE_UTIL);
const CODIGO_TELA = semComentarios(FONTE_TELA);

// Instante LOCAL fixo, montado por partes. Nada de string com Z: a maquina da
// Amanda roda em BRT e o CI em UTC, e um teste que depende do fuso passa aqui e
// quebra la (erro ja cometido no PR #472).
const umDia = (ano, mes, dia, hora = 12, minuto = 0) => new Date(ano, mes - 1, dia, hora, minuto);

const HOJE = umDia(2026, 10, 22, 10, 0);

describe("dia de calendario", () => {
  it("coluna de DATA nao passa por fuso -- o dia e o que esta escrito", () => {
    // o bug que isto trava: new Date("2026-10-21") e meia-noite UTC e, em
    // BRT, voltaria 2026-10-20 para a coluna inteira.
    expect(chaveDia("2026-10-21")).toBe("2026-10-21");
  });

  it("timestamp vira o dia de quem esta olhando", () => {
    expect(chaveDia(umDia(2026, 10, 21, 23, 30))).toBe("2026-10-21");
    expect(chaveDia(umDia(2026, 10, 21, 0, 5))).toBe("2026-10-21");
  });

  it("vazio e lixo devolvem null em vez de hoje", () => {
    expect(chaveDia(null)).toBeNull();
    expect(chaveDia("")).toBeNull();
    expect(chaveDia("nao e data")).toBeNull();
  });

  it("diaParaData e o par de chaveDia (ida e volta)", () => {
    expect(chaveDia(diaParaData("2026-10-21"))).toBe("2026-10-21");
    expect(diaParaData("xx")).toBeNull();
  });
});

describe("janela do periodo", () => {
  it("7 dias terminam hoje, em ordem crescente, e contam 7", () => {
    const dias = ultimosDias(7, HOJE);
    expect(dias).toHaveLength(7);
    expect(dias[6]).toBe("2026-10-22");
    expect(dias[0]).toBe("2026-10-16");
    expect([...dias].sort()).toEqual(dias);
  });

  it("vira o mes sem buraco", () => {
    expect(ultimosDias(3, umDia(2026, 11, 1))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });

  it("o corte e a meia-noite local do primeiro dia da janela", () => {
    const corte = corteDoPeriodo(7, HOJE);
    expect(chaveDia(corte)).toBe("2026-10-16");
    expect(corte.getHours()).toBe(0);
    expect(corte.getMinutes()).toBe(0);
  });
});

describe("serie diaria de acionamentos", () => {
  const DIAS = ultimosDias(3, HOJE); // 20, 21, 22
  const MOVS = [
    { registrado_por_email: "COBRANCA05@aelbra.com.br", registrado_por_nome: "Luana", registrado_em: umDia(2026, 10, 20, 9) },
    { registrado_por_email: "cobranca05@aelbra.com.br", registrado_por_nome: "Luana", registrado_em: umDia(2026, 10, 22, 9) },
    { registrado_por_email: "cobranca05@aelbra.com.br", registrado_por_nome: "Luana", registrado_em: umDia(2026, 10, 22, 17) },
    { registrado_por_email: "cobranca06@aelbra.com.br", registrado_por_nome: "Mauricio", registrado_em: umDia(2026, 10, 21, 14) },
    // fora da janela: nao entra em dia nenhum nem no total
    { registrado_por_email: "cobranca06@aelbra.com.br", registrado_por_nome: "Mauricio", registrado_em: umDia(2026, 10, 10, 14) },
    // sem autor: a coluna estava preenchida em 100% das linhas de 7 dias
    // (medido 22/10/2026), mas se um dia vier nula nao vira operador fantasma
    { registrado_por_email: null, registrado_por_nome: null, registrado_em: umDia(2026, 10, 22, 11) },
  ];

  it("conta por operador e por dia, e o e-mail e a chave (maiuscula nao duplica)", () => {
    const serie = serieAcionamentos(MOVS, DIAS);
    expect(serie.operadores).toHaveLength(2);

    const luana = serie.operadores.find((o) => o.email === "cobranca05@aelbra.com.br");
    expect(luana.total).toBe(3);
    expect(luana.porDia["2026-10-20"]).toBe(1);
    expect(luana.porDia["2026-10-21"]).toBe(0);
    expect(luana.porDia["2026-10-22"]).toBe(2);
    expect(luana.nome).toBe("Luana");
  });

  it("total do periodo ignora o que caiu fora da janela e o que nao tem autor", () => {
    const serie = serieAcionamentos(MOVS, DIAS);
    expect(serie.total).toBe(4);
    expect(serie.totalPorDia["2026-10-22"]).toBe(2);
  });

  it("todo dia da janela existe na serie, mesmo zerado", () => {
    const serie = serieAcionamentos(MOVS, DIAS);
    expect(Object.keys(serie.totalPorDia)).toEqual(DIAS);
    for (const op of serie.operadores) expect(Object.keys(op.porDia)).toEqual(DIAS);
  });

  it("ordena do mais produtivo para o menos", () => {
    const serie = serieAcionamentos(MOVS, DIAS);
    expect(serie.operadores.map((o) => o.total)).toEqual([3, 1]);
  });

  it("sem linha nenhuma devolve zero, nao quebra", () => {
    const serie = serieAcionamentos([], DIAS);
    expect(serie.total).toBe(0);
    expect(serie.operadores).toEqual([]);
  });
});

describe("ponto por operador e por dia", () => {
  const EVENTOS = [
    { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGIN", criado_em: umDia(2026, 10, 22, 8, 0) },
    { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "PAUSA_ALMOCO_INICIO", criado_em: umDia(2026, 10, 22, 12, 0) },
    { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "PAUSA_ALMOCO_FIM", criado_em: umDia(2026, 10, 22, 13, 0) },
    { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGOUT", criado_em: umDia(2026, 10, 22, 18, 0) },
  ];

  it("jornada liquida desconta a pausa fechada", () => {
    const [linha] = agruparPonto(EVENTOS);
    expect(linha.dia).toBe("2026-10-22");
    expect(linha.minutosPausa).toBe(60);
    expect(linha.minutosTrabalhados).toBe(540); // 10h de janela - 1h de almoco
  });

  it("pausa em curso nao ganha fim inventado", () => {
    const [linha] = agruparPonto(EVENTOS.filter((e) => e.tipo !== "PAUSA_ALMOCO_FIM"));
    const almoco = linha.pausas.find((p) => p.label === "Almoço");
    expect(almoco.inicio).toBeTruthy();
    expect(almoco.fim).toBeNull();
    expect(almoco.duracao).toBeNull();
  });

  it("dia sem logout nao vira hora trabalhada", () => {
    const [linha] = agruparPonto(EVENTOS.filter((e) => e.tipo !== "LOGOUT"));
    expect(linha.logout).toBeNull();
    expect(linha.minutosTrabalhados).toBeNull();
  });

  it("login e a primeira batida e logout a ultima", () => {
    const comRepique = [
      ...EVENTOS,
      { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGIN", criado_em: umDia(2026, 10, 22, 9, 30) },
      { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGOUT", criado_em: umDia(2026, 10, 22, 19, 0) },
    ];
    const [linha] = agruparPonto(comRepique);
    expect(chaveDia(linha.login)).toBe("2026-10-22");
    expect(new Date(linha.login).getHours()).toBe(8);
    expect(new Date(linha.logout).getHours()).toBe(19);
  });

  it("separa operador e dia, e lista o dia mais recente primeiro", () => {
    const linhas = agruparPonto([
      ...EVENTOS,
      { email: "cobranca06@aelbra.com.br", nome: "Mauricio", tipo: "LOGIN", criado_em: umDia(2026, 10, 21, 8) },
    ]);
    expect(linhas).toHaveLength(2);
    expect(linhas[0].dia).toBe("2026-10-22");
    expect(linhas[1].dia).toBe("2026-10-21");
  });

  it("as tres pausas do ponto continuam sendo as tres", () => {
    expect(PAUSAS.map((p) => p.chave)).toEqual([
      "PAUSA_INTERVALO_1",
      "PAUSA_INTERVALO_2",
      "PAUSA_ALMOCO",
    ]);
  });
});

describe("presenca x producao", () => {
  const PONTO = agruparPonto([
    { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGIN", criado_em: umDia(2026, 10, 22, 8, 0) },
    { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGOUT", criado_em: umDia(2026, 10, 22, 18, 0) },
  ]);
  const DIAS = ultimosDias(2, HOJE); // 21 e 22

  it("junta acionamento e jornada do mesmo operador no mesmo dia", () => {
    const serie = serieAcionamentos(
      Array.from({ length: 60 }, () => ({
        registrado_por_email: "cobranca05@aelbra.com.br",
        registrado_por_nome: "Luana",
        registrado_em: umDia(2026, 10, 22, 9),
      })),
      DIAS,
    );
    const [linha] = cruzarPresencaProducao(PONTO, serie);
    expect(linha.acionamentos).toBe(60);
    expect(linha.minutosTrabalhados).toBe(600);
    expect(linha.porHora).toBe(6);
  });

  it("acionamento em dia SEM batida de ponto aparece marcado, nao desaparece", () => {
    const serie = serieAcionamentos(
      [{ registrado_por_email: "cobranca06@aelbra.com.br", registrado_por_nome: "Mauricio", registrado_em: umDia(2026, 10, 21, 9) }],
      DIAS,
    );
    const linhas = cruzarPresencaProducao(PONTO, serie);
    const semPonto = linhas.find((l) => l.email === "cobranca06@aelbra.com.br");
    expect(semPonto.semPonto).toBe(true);
    expect(semPonto.acionamentos).toBe(1);
    expect(semPonto.minutosTrabalhados).toBeNull();
    expect(semPonto.porHora).toBeNull();
  });

  it("dia com ponto e sem acionamento fica na tabela, com zero medido", () => {
    // zero com jornada medida e INFORMACAO (logado 10h, nao produziu), nao
    // ausencia de dado -- por isso 0 e nao null. A tela mostra "—" apenas
    // quando nao ha jornada para dividir.
    const linhas = cruzarPresencaProducao(PONTO, serieAcionamentos([], DIAS));
    expect(linhas).toHaveLength(1);
    expect(linhas[0].acionamentos).toBe(0);
    expect(linhas[0].minutosTrabalhados).toBe(600);
    expect(linhas[0].porHora).toBe(0);
  });

  it("sem jornada medida nao se divide por hora", () => {
    const soLogin = agruparPonto([
      { email: "cobranca05@aelbra.com.br", nome: "Luana", tipo: "LOGIN", criado_em: umDia(2026, 10, 22, 8) },
    ]);
    const serie = serieAcionamentos(
      [{ registrado_por_email: "cobranca05@aelbra.com.br", registrado_por_nome: "Luana", registrado_em: umDia(2026, 10, 22, 9) }],
      DIAS,
    );
    expect(cruzarPresencaProducao(soLogin, serie)[0].porHora).toBeNull();
  });
});

describe("pendencias por operador (mesmas regras do painel_geral)", () => {
  const ALUNOS = [
    {
      responsavel_atual_email: "cobranca05@aelbra.com.br",
      responsavel_atual_nome: "Luana",
      data_ultimo_acionamento: umDia(2026, 10, 1, 9), // 21 dias -> pendente
      data_retorno: "2026-10-22",
      status_atual: "ALUNO_EM_NEGOCIACAO_24H",
    },
    {
      responsavel_atual_email: "cobranca05@aelbra.com.br",
      responsavel_atual_nome: "Luana",
      data_ultimo_acionamento: umDia(2026, 10, 21, 9), // ontem -> em dia
      data_retorno: "2026-10-15", // vencido
      status_jornada: "outra coisa",
    },
    {
      responsavel_atual_email: "cobranca06@aelbra.com.br",
      responsavel_atual_nome: "Mauricio",
      data_ultimo_acionamento: null,
      data_retorno: null,
      status_acionamento: "ALUNO_EM_NEGOCIACAO_24H",
    },
    // sem dono: nao tem operador a quem atribuir pendencia
    { responsavel_atual_email: null, responsavel_atual_nome: null, data_retorno: "2026-10-22" },
  ];

  const { operadores, totais } = pendenciasPorOperador(ALUNOS, HOJE);

  it("carteira conta por responsavel atual e ignora quem nao tem dono", () => {
    expect(operadores).toHaveLength(2);
    expect(totais.carteira).toBe(3);
  });

  it("sem contato +10 dias usa o mesmo corte do painel_geral", () => {
    const luana = operadores.find((o) => o.email === "cobranca05@aelbra.com.br");
    expect(luana.semContato10).toBe(1);
  });

  it("data_ultimo_acionamento nula nao e pendencia inventada", () => {
    const mauricio = operadores.find((o) => o.email === "cobranca06@aelbra.com.br");
    expect(mauricio.semContato10).toBe(0);
  });

  it("negociacao 24h vale em qualquer uma das tres colunas de status", () => {
    expect(operadores.find((o) => o.email === "cobranca05@aelbra.com.br").negociacao24h).toBe(1);
    expect(operadores.find((o) => o.email === "cobranca06@aelbra.com.br").negociacao24h).toBe(1);
  });

  it("retorno de hoje e retorno vencido sao coisas diferentes", () => {
    const luana = operadores.find((o) => o.email === "cobranca05@aelbra.com.br");
    expect(luana.retornosHoje).toBe(1);
    expect(luana.retornosVencidos).toBe(1);
  });

  it("retorno no limite da janela nao escorrega de dia (fuso)", () => {
    const { operadores: ops } = pendenciasPorOperador(
      [{ responsavel_atual_email: "x@y.z", data_retorno: "2026-10-22" }],
      umDia(2026, 10, 22, 23, 50),
    );
    expect(ops[0].retornosHoje).toBe(1);
    expect(ops[0].retornosVencidos).toBe(0);
  });

  it("nao mede retorno cumprido: o campo esta zerado em producao", () => {
    // 0 de 18.435 alunos em 22/10/2026. Quem vai ligar isso e a frente do Meu
    // Dia; ate la, nada de proxy nem indicador "cumpridos" na tela.
    const selects = CODIGO_TELA.match(/\.select\([\s\S]*?\)/g) || [];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.join(" ")).not.toContain("retorno_confirmado_em");
    expect(CODIGO_UTIL).not.toContain("retorno_confirmado_em");
    expect(CODIGO_TELA).not.toContain("retorno_confirmado_em");
  });
});

describe("entradas na carteira por dia", () => {
  const DIAS = ultimosDias(3, HOJE);

  it("conta pela data em que o aluno passou ao responsavel atual", () => {
    const serie = entradasPorDia(
      [
        { responsavel_atual_email: "cobranca05@aelbra.com.br", responsavel_atual_nome: "Luana", responsavel_atual_em: umDia(2026, 10, 22, 7) },
        { responsavel_atual_email: "cobranca05@aelbra.com.br", responsavel_atual_nome: "Luana", responsavel_atual_em: umDia(2026, 10, 20, 7) },
        { responsavel_atual_email: "cobranca06@aelbra.com.br", responsavel_atual_nome: "Mauricio", responsavel_atual_em: umDia(2026, 10, 22, 7) },
        // entrada antiga: fora da janela
        { responsavel_atual_email: "cobranca06@aelbra.com.br", responsavel_atual_nome: "Mauricio", responsavel_atual_em: umDia(2026, 8, 1, 7) },
        // coluna vazia (2 de 7.623 em producao)
        { responsavel_atual_email: "cobranca06@aelbra.com.br", responsavel_atual_nome: "Mauricio", responsavel_atual_em: null },
      ],
      DIAS,
    );

    expect(serie.total).toBe(3);
    expect(serie.totalPorDia["2026-10-22"]).toBe(2);
    expect(serie.totalPorDia["2026-10-21"]).toBe(0);
    expect(serie.operadores.find((o) => o.email === "cobranca05@aelbra.com.br").total).toBe(2);
  });
});

describe("duracao em minutos", () => {
  it("arredonda e recusa ponta faltando", () => {
    expect(duracaoMinutos(umDia(2026, 10, 22, 8), umDia(2026, 10, 22, 8, 30))).toBe(30);
    expect(duracaoMinutos(null, umDia(2026, 10, 22, 8))).toBeNull();
    expect(duracaoMinutos(umDia(2026, 10, 22, 8), null)).toBeNull();
    expect(duracaoMinutos("nao e data", "tambem nao")).toBeNull();
  });
});

describe("o painel nao cria uma quarta definicao de acionamento", () => {
  it("a lista canonica vem de carteiraAcionada, nao e reescrita aqui", () => {
    // Ja existem tres listas divergentes (carteiraAcionada com 7 tipos,
    // PainelCarteira com 2, MeuDashboard com 11) mais a contagem do banco em
    // calibragem_efetividade. Uma quarta aqui seria metrica inventada.
    expect(CODIGO_UTIL).not.toContain("FINALIZACAO_ATENDIMENTO");
    expect(CODIGO_TELA).not.toContain("FINALIZACAO_ATENDIMENTO");
    expect(FONTE_TELA).toContain("TIPOS_ACIONAMENTO_INDIVIDUAL");
    expect(FONTE_TELA).toContain('from "../utils/carteiraAcionada"');
    expect(CODIGO_TELA).not.toContain("const TIPOS_ACIONAMENTO");
  });
});
