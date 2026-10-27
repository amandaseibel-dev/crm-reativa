// CARIMBO DO RETORNO (27/10/2026). `data_retorno` sem `retorno_origem` é
// retorno sem dono: o prazo de máquina herdava o selo OPERADOR do compromisso
// anterior e aparecia no "Meu dia" como compromisso que ninguém marcou,
// enquanto a data que o operador digitou fora da tabulação nascia AUTOMATICO e
// não aparecia. Medido em 15 e 22/10/2026: só 3,2% dos 13.293 retornos tinham
// selo OPERADOR, e 141 dos 183 "retornos de hoje" vinham de um lote de quatro
// meses antes.
//
// Duas provas aqui: a REGRA (`camposDeRetorno`, que é pura) e os PONTOS de
// gravação, por leitura do fonte -- como PainelCarteira.meuDia.test.js e
// ManualOperacao.portas.test.js, porque nenhum dos cinco pontos depende de
// montar a página. Disciplina de âncora: as linhas de comentário são filtradas
// antes de qualquer asserção, e cada âncora é a CHAMADA, nunca o comentário.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

// Dublê do banco só para `lerRetornoAtual`: um objeto com a cadeia
// select/eq/maybeSingle. `respostaDoBanco` é trocada por teste.
let respostaDoBanco = { data: null, error: null };
vi.mock("../services/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => respostaDoBanco }) }),
    }),
  },
}));

import {
  camposDeRetorno,
  camposDeRetornoAutomatico,
  compromissoFuturoDoOperador,
  lerRetornoAtual,
  CAMPOS_RETORNO_LIMPO,
  RETORNO_ORIGEM_OPERADOR,
  RETORNO_ORIGEM_AUTOMATICO,
} from "./tabulacoes";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, "..");

function semComentario(texto) {
  return texto
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

function codigo(caminho) {
  return semComentario(readFileSync(resolve(SRC, caminho), "utf8"));
}

describe("camposDeRetorno -- a regra do carimbo", () => {
  it("data digitada pelo operador é compromisso: carimba OPERADOR", () => {
    expect(camposDeRetorno(RETORNO_ORIGEM_OPERADOR, "2026-11-03")).toEqual({
      data_retorno: "2026-11-03",
      retorno_origem: "OPERADOR",
    });
  });

  it("não apaga hora nem prioridade do compromisso quando a tela não tem os campos", () => {
    const campos = camposDeRetorno(RETORNO_ORIGEM_OPERADOR, "2026-11-03");
    expect(campos).not.toHaveProperty("hora_retorno");
    expect(campos).not.toHaveProperty("retorno_prioritario");
  });

  it("grava a hora e a prioridade que o operador digitou, quando existem", () => {
    expect(camposDeRetorno(RETORNO_ORIGEM_OPERADOR, "2026-11-03", { hora: "14:30", prioritario: true })).toEqual({
      data_retorno: "2026-11-03",
      retorno_origem: "OPERADOR",
      hora_retorno: "14:30",
      retorno_prioritario: true,
    });
  });

  it("prazo do sistema carimba AUTOMATICO e leva embora hora e prioridade do retorno anterior", () => {
    expect(camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, "2026-11-10")).toEqual({
      data_retorno: "2026-11-10",
      retorno_origem: "AUTOMATICO",
      hora_retorno: null,
      retorno_prioritario: false,
    });
  });

  it("prazo automático ignora hora e prioridade oferecidas por quem chama", () => {
    const campos = camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, "2026-11-10", { hora: "09:00", prioritario: true });
    expect(campos.hora_retorno).toBeNull();
    expect(campos.retorno_prioritario).toBe(false);
  });

  it("passa o valor da data INTACTO -- a tela escolhe entre YYYY-MM-DD e timestamp", () => {
    const iso = "2026-11-10T12:34:56.000Z";
    expect(camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, iso).data_retorno).toBe(iso);
  });

  it("sem data não grava nada: apagar retorno é decisão de quem chama", () => {
    expect(camposDeRetorno(RETORNO_ORIGEM_OPERADOR, "")).toEqual({});
    expect(camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, null)).toEqual({});
    expect(camposDeRetorno(RETORNO_ORIGEM_OPERADOR, undefined)).toEqual({});
  });

  it("origem não declarada é erro de programação, não um retorno sem dono", () => {
    expect(() => camposDeRetorno("", "2026-11-03")).toThrow();
    expect(() => camposDeRetorno("OPERADOR_EM_CONFIRMACAO", "2026-11-03")).toThrow();
  });
});

describe("os pontos de prazo do sistema leem a ficha antes de gravar", () => {
  // Etapa 2 (27/10/2026): os três passam por `camposDeRetornoAutomatico`, que
  // LÊ `data_retorno`/`retorno_origem` e devolve `{}` quando há compromisso
  // OPERADOR futuro. Chamar `camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, ...)`
  // direto voltaria a sobrescrever o combinado -- por isso a ausência também
  // é cobrada.
  const PONTOS_AUTOMATICOS = [
    { arquivo: "pages/EnvioGmailLote.jsx", chamada: "camposDeRetornoAutomatico(a.id, proximoDiaUtil(tpl?.dias_retorno || 10))", antigo: "data_retorno: proximoDiaUtil(" },
    { arquivo: "pages/FilaFinanceiro.jsx", chamada: "camposDeRetornoAutomatico(alunoId, daquiA7Dias.toISOString())", antigo: "data_retorno: daquiA7Dias" },
    { arquivo: "pages/PainelAdm.jsx", chamada: "camposDeRetornoAutomatico(alunoId, daquiA7Dias.toISOString())", antigo: "data_retorno: daquiA7Dias" },
  ];

  for (const ponto of PONTOS_AUTOMATICOS) {
    it(`${ponto.arquivo}: lê a ficha e deixa o helper decidir`, () => {
      const fonte = codigo(ponto.arquivo);
      expect(fonte).toContain(`await ${ponto.chamada}`);
      expect(fonte).not.toContain(ponto.antigo);
      expect(fonte).not.toContain("camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO");
    });
  }

  it("o status do encaminhamento continua sendo gravado, mesmo sem tocar no retorno", () => {
    for (const arquivo of ["pages/FilaFinanceiro.jsx", "pages/PainelAdm.jsx"]) {
      const fonte = codigo(arquivo);
      expect(fonte, arquivo).toContain("...camposRetorno,");
      expect(fonte, arquivo).toContain('status_jornada: "Enviado ao financeiro"');
    }
    const lote = codigo("pages/EnvioGmailLote.jsx");
    expect(lote).toContain("...camposRetorno,");
    expect(lote).toContain('status_jornada: "RETORNAR_DEPOIS"');
  });
});

describe("os pontos em que o humano digita a data carimbam OPERADOR", () => {
  // Troca de responsável na ficha e na fila: as duas telas aceitam uma data
  // digitada junto com o novo dono. Antes gravavam `extraAluno.data_retorno`
  // cru, então o compromisso nascia AUTOMATICO e não aparecia no "Meu dia".
  for (const caminho of ["pages/Aluno.jsx", "pages/FilaOperacional.jsx"]) {
    it(`${caminho}: a data da troca de responsável é compromisso do operador`, () => {
      const fonte = codigo(caminho);
      expect(fonte).toContain("camposDeRetorno(RETORNO_ORIGEM_OPERADOR, paraDataLocalBR(");
      expect(fonte).not.toContain("extraAluno.data_retorno =");
    });
  }

  it("a tabulação continua sendo a dona da régua de prazo nos dois caminhos", () => {
    for (const caminho of ["pages/Aluno.jsx", "pages/FilaOperacional.jsx", "components/PainelCarteira.jsx"]) {
      const fonte = codigo(caminho);
      expect(fonte).toContain("desfechoDaTabulacao(");
      expect(fonte).toContain("retorno_origem");
    }
  });
});

// PRESERVAÇÃO DO COMBINADO (Etapa 2). Datas construídas em horário LOCAL de
// propósito: `new Date("2026-10-28")` seria lida como UTC e viraria 27/10 à
// noite no Brasil, o que faria o teste mudar de resultado conforme a hora.
const HOJE = new Date(2026, 9, 27, 10, 0); // terça, 27/10/2026, 10h local
const AMANHA = "2026-10-28";
const ONTEM = "2026-10-26";
const DAQUI_7 = "2026-11-03T12:00:00.000Z";

describe("prazo automático não passa por cima de compromisso do operador", () => {
  it("compromisso OPERADOR futuro: não grava NADA de retorno", () => {
    expect(
      camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7, {
        retornoAtual: { data: AMANHA, origem: "OPERADOR" },
        hoje: HOJE,
      })
    ).toEqual({});
  });

  it("preserva data, hora e prioridade por NÃO escrever nenhuma das três", () => {
    const campos = camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7, {
      retornoAtual: { data: AMANHA, origem: "OPERADOR" },
      hoje: HOJE,
    });
    expect(campos).not.toHaveProperty("data_retorno");
    expect(campos).not.toHaveProperty("hora_retorno");
    expect(campos).not.toHaveProperty("retorno_prioritario");
    expect(campos).not.toHaveProperty("retorno_origem");
  });

  it("OPERADOR_EM_CONFIRMACAO também é compromisso do operador", () => {
    expect(
      camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7, {
        retornoAtual: { data: AMANHA, origem: "OPERADOR_EM_CONFIRMACAO" },
        hoje: HOJE,
      })
    ).toEqual({});
  });

  it("compromisso VENCIDO não protege: o prazo automático entra e limpa hora e prioridade", () => {
    expect(
      camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7, {
        retornoAtual: { data: ONTEM, origem: "OPERADOR" },
        hoje: HOJE,
      })
    ).toEqual({
      data_retorno: DAQUI_7,
      retorno_origem: "AUTOMATICO",
      hora_retorno: null,
      retorno_prioritario: false,
    });
  });

  it("compromisso de HOJE não é futuro -- o dia corrente já é do motor da fila", () => {
    const campos = camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7, {
      retornoAtual: { data: "2026-10-27", origem: "OPERADOR" },
      hoje: HOJE,
    });
    expect(campos.retorno_origem).toBe("AUTOMATICO");
  });

  it("retorno AUTOMATICO futuro não protege nada: só o combinado protege", () => {
    const campos = camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7, {
      retornoAtual: { data: AMANHA, origem: "AUTOMATICO" },
      hoje: HOJE,
    });
    expect(campos.data_retorno).toBe(DAQUI_7);
  });

  it("sem retornoAtual o comportamento é o de antes -- e é por isso que a leitura é cobrada nos pontos", () => {
    expect(camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, DAQUI_7).retorno_origem).toBe("AUTOMATICO");
  });

  it("data digitada pelo operador SUBSTITUI o combinado anterior: é o novo combinado", () => {
    const campos = camposDeRetorno(RETORNO_ORIGEM_OPERADOR, "2026-12-01", {
      retornoAtual: { data: AMANHA, origem: "OPERADOR" },
      hoje: HOJE,
    });
    expect(campos).toEqual({ data_retorno: "2026-12-01", retorno_origem: "OPERADOR" });
  });

  it("o predicado é um só, e é o mesmo do caso MANTIDA da tabulação", () => {
    expect(compromissoFuturoDoOperador({ data: AMANHA, origem: "OPERADOR" }, HOJE)).toEqual({ data: AMANHA, origem: "OPERADOR" });
    expect(compromissoFuturoDoOperador({ data: ONTEM, origem: "OPERADOR" }, HOJE)).toBeNull();
    expect(compromissoFuturoDoOperador({ data: AMANHA, origem: "AUTOMATICO" }, HOJE)).toBeNull();
    expect(compromissoFuturoDoOperador(null, HOJE)).toBeNull();
  });
});

describe("leitura da ficha: falha FECHA, não abre", () => {
  it("lê data e origem da ficha", async () => {
    respostaDoBanco = { data: { data_retorno: AMANHA, retorno_origem: "OPERADOR" }, error: null };
    await expect(lerRetornoAtual("aluno-1")).resolves.toEqual({ ok: true, retorno: { data: AMANHA, origem: "OPERADOR" } });
  });

  it("ficha sem retorno é leitura BEM-SUCEDIDA com retorno nulo", async () => {
    respostaDoBanco = { data: { data_retorno: null, retorno_origem: null }, error: null };
    const r = await lerRetornoAtual("aluno-1");
    expect(r.ok).toBe(true);
    expect(r.retorno).toEqual({ data: null, origem: null });
  });

  it("erro de leitura: ok=false, e o prazo automático NÃO toca no retorno", async () => {
    respostaDoBanco = { data: null, error: { message: "timeout" } };
    expect((await lerRetornoAtual("aluno-1")).ok).toBe(false);
    await expect(camposDeRetornoAutomatico("aluno-1", DAQUI_7, { hoje: HOJE })).resolves.toEqual({});
  });

  it("sem id não consulta e não grava retorno", async () => {
    expect(await lerRetornoAtual(null)).toEqual({ ok: false, retorno: null });
    await expect(camposDeRetornoAutomatico(null, DAQUI_7, { hoje: HOJE })).resolves.toEqual({});
  });

  it("com compromisso futuro na ficha, o ponto automático recebe {}", async () => {
    respostaDoBanco = { data: { data_retorno: AMANHA, retorno_origem: "OPERADOR" }, error: null };
    await expect(camposDeRetornoAutomatico("aluno-1", DAQUI_7, { hoje: HOJE })).resolves.toEqual({});
  });

  it("sem compromisso na ficha, o prazo automático entra carimbado", async () => {
    respostaDoBanco = { data: { data_retorno: null, retorno_origem: null }, error: null };
    await expect(camposDeRetornoAutomatico("aluno-1", DAQUI_7, { hoje: HOJE })).resolves.toEqual({
      data_retorno: DAQUI_7,
      retorno_origem: "AUTOMATICO",
      hora_retorno: null,
      retorno_prioritario: false,
    });
  });
});

// SINCRONIZAÇÃO: `alunos` é a fonte, `alunos_unificados` é espelho. O gatilho
// `trg_sincronizar_alunos_unificados`, em `public.alunos`, copia data, hora e
// origem para o espelho pela `chave_unificacao` (medido em produção em
// 27/10/2026: 12.397 de 12.397 linhas com retorno têm origem). Gravar retorno
// no espelho põe o dado no lugar errado, sem carimbo, e a próxima mudança da
// ficha desfaz. Nenhuma tela pode voltar a fazer isso.
const CAMPOS_DE_RETORNO = ["data_retorno", "hora_retorno", "retorno_origem", "retorno_prioritario"];

function updatesNoEspelho(fonte) {
  const blocos = [];
  let i = fonte.indexOf('from("alunos_unificados")');
  while (i !== -1) {
    const fim = fonte.indexOf(".eq(", i);
    blocos.push(fonte.slice(i, fim === -1 ? i + 1200 : fim));
    i = fonte.indexOf('from("alunos_unificados")', i + 1);
  }
  return blocos;
}

describe("sincronização: ninguém grava retorno no espelho", () => {
  it("nenhum update em alunos_unificados carrega campo de retorno", () => {
    const culpados = [];
    for (const p of fontesDoSrc()) {
      const fonte = semComentario(readFileSync(p, "utf8"));
      for (const bloco of updatesNoEspelho(fonte)) {
        if (!bloco.includes(".update(")) continue;
        for (const campo of CAMPOS_DE_RETORNO) {
          if (bloco.includes(`${campo}:`)) culpados.push(`${p.slice(SRC.length + 1)} :: ${campo}`);
        }
      }
    }
    expect(culpados.sort()).toEqual([]);
  });

  it("a ficha unificada grava o retorno em alunos, pela chave de unificação", () => {
    const fonte = codigo("components/AgendaAlunoUnificado.jsx");
    expect(fonte).toContain('.from("alunos")');
    expect(fonte).toContain("camposDeRetorno(RETORNO_ORIGEM_OPERADOR, form.data_retorno");
    expect(fonte).toContain('.eq("chave_unificacao", aluno.chave_unificacao)');
    // Sem data o retorno é apagado com carimbo, não deixado pela metade.
    expect(fonte).toContain("CAMPOS_RETORNO_LIMPO");
  });

  it("apagar o retorno derruba também hora, prioridade e origem", () => {
    expect(CAMPOS_RETORNO_LIMPO).toEqual({
      data_retorno: null,
      retorno_origem: null,
      hora_retorno: null,
      retorno_prioritario: false,
    });
  });

  it("a fila operacional não tem mais o update de retorno no espelho", () => {
    const fonte = codigo("pages/FilaOperacional.jsx");
    expect(fonte).not.toContain('from("alunos_unificados")');
  });
});

// CATRACA, POR PONTO DE GRAVAÇÃO -- não por arquivo.
//
// A primeira versão deste bloco pulava o ARQUIVO inteiro quando ele importava
// `camposDeRetorno` ou `desfechoDaTabulacao`. Isso dava passe vitalício aos
// cinco arquivos corrigidos: `src/pages/FilaOperacional.jsx` grava
// `data_retorno` em `alunos_unificados` SEM carimbo e passava, porque o mesmo
// arquivo carimba em outro ponto. Verde falso -- exatamente o que o preâmbulo
// de `docs/PREMISSAS.md` descreve ("nada quebrou, nenhum alarme tocou").
//
// Agora cada OCORRÊNCIA é julgada. Primeiro saem as que já são a regra do
// repositório (a linha chama `camposDeRetorno`, ou copia o `desfecho` da
// tabulação, ou mora no próprio `utils/tabulacoes.js`, coberto pelos testes de
// unidade acima). O que sobra tem de estar declarado abaixo, com o motivo
// escrito. A lista só encolhe: ponto NOVO que grave retorno sem carimbo
// reprova aqui.
//
// `trecho` é a LINHA INTEIRA, comparada por igualdade (sem os espaços das
// pontas). Não é substring de propósito: `p_data_retorno: dataRetorno || null,`
// contém `data_retorno: dataRetorno || null,`, e com substring uma entrada
// passava a contar a ocorrência da outra.
const PONTOS_DECLARADOS = [
  // --- Carimbo feito no BANCO, não na tela: a RPC `sistema_assumir_receptivo`
  // grava `retorno_origem = OPERADOR` desde `20260910190000`.
  { arquivo: "pages/BaseReceptiva.jsx", trecho: "p_data_retorno: dataRetorno || null,", vezes: 1, motivo: "a RPC do receptivo carimba OPERADOR no banco" },
  { arquivo: "pages/BaseReceptiva.jsx", trecho: "data_retorno: dataRetorno || null,", vezes: 2, motivo: "objeto inerte (void atualizacao) + insert em historico_atendimentos" },

  // --- Tabela sem a coluna: `casos` não tem `retorno_origem` (ver comentário
  // da migration `20261019132433`), e `historico_casos` é histórico.
  { arquivo: "pages/CRM.jsx", trecho: "data_retorno: dataRetorno || null,", vezes: 1, motivo: "insert em historico_casos (histórico)" },
  { arquivo: "pages/CRM.jsx", trecho: "data_retorno: novaDataRetorno,", vezes: 1, motivo: "update em casos, tabela sem retorno_origem" },
  { arquivo: "pages/CRM.jsx", trecho: "data_retorno: dataRetorno,", vezes: 1, motivo: "update em casos, tabela sem retorno_origem" },

  // --- Não é gravação em ficha: histórico, estado de formulário ou
  // localStorage. Entram na lista para ficarem visíveis, não porque faltam.
  { arquivo: "pages/Aluno.jsx", trecho: "data_retorno: retorno,", vezes: 1, motivo: "insert em aluno_movimentacoes (histórico)" },
  { arquivo: "pages/FilaOperacional.jsx", trecho: "data_retorno: retorno,", vezes: 1, motivo: "insert em aluno_movimentacoes (histórico)" },
  { arquivo: "pages/CRM.jsx", trecho: "data_retorno: c.dataRetorno,", vezes: 1, motivo: "objeto do localStorage" },
  { arquivo: "pages/AgendaOperacional.jsx", trecho: "data_retorno: item.data_retorno || null,", vezes: 1, motivo: "tela órfã desde 28/08/2026; objeto do localStorage" },
  { arquivo: "components/AgendaAlunoUnificado.jsx", trecho: 'data_retorno: "",', vezes: 1, motivo: "estado inicial do formulário" },
  { arquivo: "components/AgendaAlunoUnificado.jsx", trecho: "data_retorno: aluno.data_retorno || \"\",", vezes: 1, motivo: "estado do formulário" },
  { arquivo: "components/AgendaAlunoUnificado.jsx", trecho: "onChange={(e) => setForm({ ...form, data_retorno: e.target.value })}", vezes: 1, motivo: "onChange do formulário" },

  // --- Leitura, não gravação.
  { arquivo: "utils/carteiraFila.js", trecho: "const retornoHoje = a.data_retorno === hoje;", vezes: 1, motivo: "comparação" },
  { arquivo: "components/PainelCarteira.jsx", trecho: "return a.data_retorno === hojeLocalBR();", vezes: 1, motivo: "comparação" },
];

const ESCREVE = /(data_retorno\s*:|\.data_retorno\s*=|p_data_retorno\s*:)/;

// Linha que JÁ passa pela regra do repositório.
function peloCarimbo(linha, arquivo) {
  if (arquivo === "utils/tabulacoes.js") return true; // a regra mora aqui
  return linha.includes("camposDeRetorno") || linha.includes("desfecho.data_retorno");
}

function fontesDoSrc(dir = SRC, acc = []) {
  for (const nome of readdirSync(dir)) {
    const p = resolve(dir, nome);
    if (statSync(p).isDirectory()) {
      fontesDoSrc(p, acc);
    } else if (/\.jsx?$/.test(nome) && !nome.includes(".test.")) {
      acc.push(p);
    }
  }
  return acc;
}

function pontosEncontrados() {
  const achados = [];
  for (const p of fontesDoSrc()) {
    const arquivo = p.slice(SRC.length + 1);
    const linhas = readFileSync(p, "utf8").split("\n");
    for (const linha of linhas) {
      if (linha.trim().startsWith("//")) continue;
      if (!ESCREVE.test(linha)) continue;
      if (peloCarimbo(linha, arquivo)) continue;
      achados.push({ arquivo, linha: linha.trim() });
    }
  }
  return achados;
}

describe("catraca: nenhum ponto novo grava data_retorno sem carimbar a origem", () => {
  it("todo ponto que grava data_retorno fora da regra está declarado, com motivo", () => {
    const declarados = [];
    for (const d of PONTOS_DECLARADOS) {
      expect(d.motivo, `${d.arquivo} :: ${d.trecho}`).toBeTruthy();
      for (let i = 0; i < d.vezes; i += 1) declarados.push(`${d.arquivo} :: ${d.trecho}`);
    }
    const achados = pontosEncontrados().map((a) => {
      const casa = PONTOS_DECLARADOS.find((d) => d.arquivo === a.arquivo && a.linha === d.trecho);
      return casa ? `${a.arquivo} :: ${casa.trecho}` : `${a.arquivo} :: ${a.linha}`;
    });
    expect(achados.sort()).toEqual(declarados.sort());
  });

  it("nenhum ponto declarado desapareceu do fonte -- a lista não fica mentindo", () => {
    const achados = pontosEncontrados();
    for (const d of PONTOS_DECLARADOS) {
      const vezes = achados.filter((a) => a.arquivo === d.arquivo && a.linha === d.trecho).length;
      expect(vezes, `${d.arquivo} :: ${d.trecho}`).toBe(d.vezes);
    }
  });

  it("os pontos corrigidos saíram da lista: passam pela regra, não por exceção", () => {
    const porExcecao = new Set(PONTOS_DECLARADOS.map((d) => d.arquivo));
    const achados = pontosEncontrados();
    for (const arquivo of ["pages/EnvioGmailLote.jsx", "pages/FilaFinanceiro.jsx", "pages/PainelAdm.jsx"]) {
      expect(porExcecao.has(arquivo), arquivo).toBe(false);
      expect(achados.filter((a) => a.arquivo === arquivo), arquivo).toEqual([]);
    }
    // `Aluno.jsx` e `FilaOperacional.jsx` continuam na lista por OUTROS pontos
    // (histórico e a ficha unificada bloqueada); o que não pode sobrar é a
    // gravação crua da troca de responsável.
    for (const arquivo of ["pages/Aluno.jsx", "pages/FilaOperacional.jsx"]) {
      const cru = achados.filter((a) => a.arquivo === arquivo && a.linha.includes("extraAluno.data_retorno"));
      expect(cru, arquivo).toEqual([]);
    }
  });
});
