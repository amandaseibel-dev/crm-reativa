// PROVA DO PACOTE DE NOVEMBRO: com os cursores que estão em produção em
// 11/11/2026 (cursor nulo, pendente 07/11 21:51:43.559Z, topo 08/11
// 20:24:13.586Z, posição nula) e `desde` = 01/11, a coleta chega a 01/11 em
// várias execuções com teto, sem perder nem repetir conversa, e só fecha
// COMPLETO quando o piso passa do início. Nada chama a Mensageria.
import { describe, it, expect } from "vitest";
import {
  LIMITE_PAGINA,
  TETO_TOTAL_MAX,
  classificarHttp,
  colherConversas,
  ehParada,
  erroMcp,
  lerParametros,
  modoDoCiclo,
  novaJanela,
  type Janela,
} from "./sincronizar.ts";

const PENDENTE = "2026-11-07T21:51:43.559Z";
const TOPO = "2026-11-08T20:24:13.586Z";
const DESDE = "2026-11-01T03:00:00.000Z"; // meia-noite de 01/11 em Brasília

type Item = { id: string; em: string; equipe?: string };
function apiSimulada(lista: Item[]) {
  const chamadas: number[] = [];
  const ordenada = () => [...lista].sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0));
  const buscar = async (pagina: number) => {
    chamadas.push(pagina);
    const fatia = ordenada().slice((pagina - 1) * LIMITE_PAGINA, pagina * LIMITE_PAGINA);
    return {
      conversas: fatia.map((i) => ({
        id: i.id, canal: "whatsapp", situacao: "active", equipe: i.equipe ?? "Reativa",
        cliente: { id: `cli-${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em, ultimaMensagem: { quem: "cliente", em: i.em, trecho: "..." },
      })),
      paginacao: { total: lista.length },
    };
  };
  return { buscar, chamadas };
}

// Caixa plausível: ~160 conversas/dia de todas as equipes, 5% Reativa.
function caixaDeProducao(): { lista: Item[]; esperado: Set<string> } {
  const lista: Item[] = [];
  const esperado = new Set<string>();
  let n = 0;
  const addDia = (ano: number, mes: number, dia: number, qtd: number) => {
    for (let k = 0; k < qtd; k++) {
      const h = String(Math.floor((k * 24) / qtd)).padStart(2, "0");
      const m = String((k * 7) % 60).padStart(2, "0");
      const em = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}T${h}:${m}:00.000Z`;
      const reativa = k % 20 === 0;
      const id = `${mes}-${dia}-${k}`;
      lista.push({ id, em, equipe: reativa ? "Reativa" : "Outra" });
      // esperado: Reativa e >= desde. O trecho (pendente, topo] já processado em
      // 08/11 É relido quando a 1ª execução para acima do topo antigo: a janela
      // guarda UM intervalo processado, e o novo pendente fica acima dele. Não
      // se perde nada; custa ~3 páginas a mais e a gravação (upsert) não duplica.
      if (reativa && em >= DESDE) esperado.add(id);
      n++;
    }
  };
  for (let d = 25; d <= 31; d++) addDia(2026, 10, d, 160);
  for (let d = 1; d <= 11; d++) addDia(2026, 11, d, 160);
  // o grupo exato do piso pendente é relido (não se presume visto)
  lista.push({ id: "grupo-piso", em: PENDENTE, equipe: "Reativa" });
  esperado.add("grupo-piso");
  return { lista, esperado };
}

describe("novembro com os cursores de produção", () => {
  it("várias execuções com teto chegam a 01/11 sem perder nem repetir, e só a última fecha COMPLETO", async () => {
    const { lista, esperado } = caixaDeProducao();
    let janela: Janela = { cursor: null, pendente: PENDENTE, topo: TOPO, desde: DESDE };
    let posicao: { offset: number } | undefined;
    const coletadas: string[] = [];
    let execucoes = 0;
    let leiturasTotal = 0;
    let completou = false;
    const pisos = new Set<string>();
    while (!completou && execucoes < 20) {
      execucoes++;
      expect(modoDoCiclo(janela)).toBe("BACKLOG");
      const api = apiSimulada(lista);
      // teto por execução = 12 leituras (HARD_LEITURAS), como em produção
      const c = await colherConversas(api.buscar, janela, { maxPaginas: 12, hardLeituras: 12, posicao });
      leiturasTotal += c.leituras;
      coletadas.push(...c.conversas.map((x) => x.ulbra_conversa_id));
      if (!c.truncado) { completou = true; break; }
      // enquanto INCOMPLETO, o pendente fica dentro do período e a janela não fecha
      expect(c.pendente_proximo !== null && c.pendente_proximo >= DESDE).toBe(true);
      pisos.add(c.pendente_proximo!);
      janela = { ...novaJanela(janela, c), desde: DESDE };
      posicao = c.offset_pendente != null ? { offset: c.offset_pendente } : undefined;
    }
    expect(completou).toBe(true);
    expect(execucoes).toBeGreaterThan(1);
    // sem perda: tudo que era esperado veio
    expect(new Set(coletadas)).toEqual(esperado);
    // repetição só do grupo do piso de cada ciclo INCOMPLETO (relido de propósito:
    // "nunca se presume visto"); a gravação é por upsert, então não duplica no espelho
    const repetidas = coletadas.length - new Set(coletadas).size;
    expect(repetidas).toBeLessThanOrEqual(execucoes - 1);
    for (const id of coletadas.filter((x, i) => coletadas.indexOf(x) !== i)) {
      expect(pisos.has(lista.find((x) => x.id === id)!.em)).toBe(true);
    }
    // o trecho (pendente, topo] relido é o único custo extra: nada abaixo de 01/11 entra
    for (const id of coletadas) {
      expect(lista.find((x) => x.id === id)!.em >= DESDE).toBe(true);
    }
    // depois do COMPLETO, o próximo ciclo é incremental a partir do topo real
    const fim = novaJanela(janela, { conversas: [], leituras: 0, truncado: false, piso_coletado: null, topo_coletado: null, pendente_proximo: null, offset_pendente: null });
    expect(modoDoCiclo(fim)).toBe("INCREMENTAL");
    // custo: ~36 páginas de novembro + ~3 do trecho relido + retomadas; cabe no teto de 110
    expect(leiturasTotal).toBeLessThan(60);
    expect(leiturasTotal).toBeGreaterThanOrEqual(36);
  });

  it("execução cortada pelo orçamento NÃO fecha completo: pendente guardado dentro do período", async () => {
    const { lista } = caixaDeProducao();
    const api = apiSimulada(lista);
    let saldo = 2;
    const c = await colherConversas(api.buscar, { cursor: null, pendente: PENDENTE, topo: TOPO, desde: DESDE }, {
      maxPaginas: 12, hardLeituras: 12, pode: () => saldo-- > 0,
    });
    expect(c.truncado).toBe(true);
    expect(c.pendente_proximo! >= DESDE).toBe(true);
  });
});

describe("teto acumulado e parada dura", () => {
  const AGORA = Date.parse("2026-11-11T12:00:00Z");
  it("teto_total é lido (1..500) e recusado fora disso", () => {
    expect(lerParametros(JSON.stringify({ teto_total: 110, teto_chamadas: 12, desde: "2026-11-01", detalhes: 5 }), AGORA))
      .toEqual({ teto_chamadas: 12, teto_total: 110, desde: "2026-11-01T03:00:00.000Z", detalhes: 5 });
    expect(lerParametros(JSON.stringify({ teto_total: 0 }), AGORA)).toBe("INVALIDO");
    expect(lerParametros(JSON.stringify({ teto_total: TETO_TOTAL_MAX + 1 }), AGORA)).toBe("INVALIDO");
    expect(lerParametros(JSON.stringify({ teto_total: 10.5 }), AGORA)).toBe("INVALIDO");
  });
  it("401/403 autenticação, 429 limite, 5xx e rede servidor: todos são parada, sem repetição", () => {
    expect(classificarHttp(401)).toBe("ULBRA_AUTENTICACAO");
    expect(classificarHttp(403)).toBe("ULBRA_AUTENTICACAO");
    expect(classificarHttp(429)).toBe("ULBRA_LIMITE");
    expect(classificarHttp(500)).toBe("ULBRA_SERVIDOR");
    expect(classificarHttp(503)).toBe("ULBRA_SERVIDOR");
    expect(classificarHttp(null)).toBe("ULBRA_INDISPONIVEL");
    expect(classificarHttp(406)).toBe("ULBRA_HTTP_406");
    for (const s of [401, 429, 500, null, 406]) {
      const e = erroMcp(s);
      expect(ehParada(e)).toBe(true);
      expect(e.message).toBe(classificarHttp(s));
    }
    expect(ehParada(new Error("qualquer"))).toBe(false);
  });
});
