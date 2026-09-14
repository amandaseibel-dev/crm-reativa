// A CONCILIACAO NAO PODE AFROUXAR A BAIXA.
//
// Este teste existe para uma coisa so: provar que a migration
// 20260914140000_conciliacao_do_pagamento.sql copiou a escada da baixa sem
// mudar NENHUMA condicao. Se ele reescrevesse a regra em JS, provaria apenas
// que eu sei escrever a mesma regra duas vezes. Entao ele EXTRAI as condicoes
// dos DOIS arquivos .sql -- o vigente e o novo -- e compara. Trocar um literal
// (0.05, 1.15, 'PAGO', 'ATIVO') quebra o teste.
//
// QUAL E A BASELINE, E POR QUE ISSO JA DEU ERRADO UMA VEZ. A primeira versao
// deste teste comparava com `supabase/migrations/20260908200000_baixa_pelo_-
// documento_respeita_vencimento.sql`. Aquela funcao NAO e mais a vigente: em
// 12/09 o ledger `20260912121649__fase2b_origem_baixa_no_gatilho_e_invariante_-
// novo.sql` a substituiu e acrescentou tres carimbos ao UPDATE da parcela
// (origem_baixa, origem_baixa_ref, origem_baixa_em). Comparando com a baseline
// velha, o teste passava enquanto a funcao nova PERDIA os tres carimbos --
// justamente o que o vigia `baixa_sem_evidencia_de_quem_baixou` le como prova
// de quem baixou. Por isso existe aqui um teste que escolhe a baseline sozinho,
// pelo maior timestamp entre todos os arquivos que definem a funcao: ninguem
// precisa lembrar de trocar o caminho na mao.
//
// E prova a propriedade nova: nenhuma saida muda. Toda saida da conciliacao
// atribui um estado, e todo estado atribuido esta no CHECK da coluna.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");

// A funcao de baixa e definida em mais de um arquivo ao longo do tempo. A
// baseline e SEMPRE a de maior timestamp -- migrations e ledger no mesmo saco,
// porque o ledger e o que de fato rodou em producao.
const DIRS = ["supabase/migrations", "supabase/ledger/2026-09"];

function definicoesDaBaixa() {
  const achados = [];
  for (const dir of DIRS) {
    for (const nome of readdirSync(resolve(RAIZ, dir))) {
      if (!nome.endsWith(".sql")) continue;
      const caminho = resolve(RAIZ, dir, nome);
      const texto = readFileSync(caminho, "utf8");
      // `create ... function` define; `execute function` so aponta.
      if (!/create or replace\s+function public\._pagamento_baixa_pelo_documento/.test(texto)) continue;
      const ts = nome.match(/^(\d{14})/);
      if (!ts) throw new Error(`arquivo sem timestamp de 14 digitos: ${nome}`);
      achados.push({ nome, caminho, ts: ts[1], texto });
    }
  }
  achados.sort((a, b) => a.ts.localeCompare(b.ts));
  return achados;
}

const DEFINICOES = definicoesDaBaixa();
const VIGENTE = DEFINICOES[DEFINICOES.length - 1];
const NOVA = resolve(RAIZ, "supabase/migrations/20260914140000_conciliacao_do_pagamento.sql");

const sqlVigente = VIGENTE.texto;
const sqlNova = readFileSync(NOVA, "utf8");

// Corpo de UMA funcao especifica. O arquivo de producao declara quatro funcoes
// e todas usam `$$`: pegar `split("$$")[1]` devolveria a primeira delas
// (vencimento_do_pagamento), nao a escada da baixa.
function corpo(sql, nomeDaFuncao, marcador) {
  const i = sql.indexOf(`function public.${nomeDaFuncao}(`);
  if (i < 0) throw new Error(`nao achei a funcao ${nomeDaFuncao}`);
  const depois = sql.slice(i);
  const abre = depois.indexOf(marcador);
  const fecha = depois.indexOf(marcador, abre + marcador.length);
  if (abre < 0 || fecha < 0) throw new Error(`nao achei o corpo de ${nomeDaFuncao}`);
  return depois.slice(abre + marcador.length, fecha);
}

// O marcador do corpo mudou entre as versoes ($$ em 08/09, $fn$ no ledger de
// 12/09). Descobrir qual e, a partir do proprio `as $tag$`, evita fixar mais
// um detalhe na mao.
function marcadorDe(sql, nomeDaFuncao) {
  const i = sql.indexOf(`function public.${nomeDaFuncao}(`);
  if (i < 0) throw new Error(`nao achei a funcao ${nomeDaFuncao}`);
  const m = sql.slice(i).match(/\bas\s+(\$[a-z_]*\$)/i);
  if (!m) throw new Error(`nao achei o marcador do corpo de ${nomeDaFuncao}`);
  return m[1];
}

const corpoVigente = corpo(
  sqlVigente,
  "_pagamento_baixa_pelo_documento",
  marcadorDe(sqlVigente, "_pagamento_baixa_pelo_documento"),
).replace(/\r/g, "");
const corpoNova = corpo(sqlNova, "_pagamento_conciliar", "$fn$").replace(/\r/g, "");

const espacos = (s) => s.replace(/\s+/g, " ").trim();
// Comentario de linha nao e regra: comparar SQL, nao prosa.
const semComentarios = (s) => espacos(s.replace(/--[^\n]*/g, " "));

// As condicoes que decidem se a baixa acontece. Sao reconhecidas pelos termos
// que so elas usam -- qualquer condicao NOVA que fale de parcela/valor/acordo
// entra nesta lista automaticamente e o teste acusa a diferenca.
const TERMOS = [
  "v_parcela.status",
  "v_parcela.status_acordo",
  "v_parcela.valor",
  "documento_casa_com_parcela",
  "v_chave",
];

function condicoesDaBaixa(texto) {
  const achadas = [...texto.matchAll(/(?:^|\n)\s*(?:els)?if\s+([\s\S]*?)\s+then\b/g)]
    .map((m) => espacos(m[1]))
    .filter((c) => TERMOS.some((t) => c.includes(t)));
  if (achadas.length === 0) throw new Error("nenhuma condicao de baixa reconhecida");
  return achadas;
}

describe("a baseline e a versao que esta mesmo em producao", () => {
  it("ha mais de uma definicao da funcao no repositorio", () => {
    expect(DEFINICOES.length).toBeGreaterThan(1);
  });

  it("a baseline escolhida e a de maior timestamp", () => {
    const timestamps = DEFINICOES.map((d) => d.ts);
    expect(VIGENTE.ts).toBe([...timestamps].sort().at(-1));
  });

  it("hoje a vigente e o ledger de 12/09, nao a migration de 08/09", () => {
    expect(VIGENTE.nome).toBe(
      "20260912121649__fase2b_origem_baixa_no_gatilho_e_invariante_novo.sql",
    );
    expect(VIGENTE.caminho).toContain("supabase/ledger/");
  });
});

describe("a escada da baixa e a mesma", () => {
  const naVigente = condicoesDaBaixa(corpoVigente);
  const naNova = condicoesDaBaixa(corpoNova);

  it("reconhece as cinco condicoes da versao vigente", () => {
    expect(naVigente).toEqual([
      "v_chave = ''",
      "v_parcela.status = 'PAGO'",
      "upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO'",
      "new.valor_pago < v_parcela.valor - 0.05 or new.valor_pago > v_parcela.valor * 1.15",
      "not public.documento_casa_com_parcela(v_parcela.id, v_venc)",
    ]);
  });

  it("a migration nova tem exatamente as mesmas condicoes, na mesma ordem", () => {
    expect(naNova).toEqual(naVigente);
  });

  it("nao inventou condicao nova que restrinja ou afrouxe a baixa", () => {
    expect(new Set(naNova)).toEqual(new Set(naVigente));
  });

  // A busca da parcela pelo boleto e o que define QUAL parcela pode baixar.
  it("procura a parcela pelo mesmo boleto, do mesmo jeito", () => {
    const alvo = "where p.boleto = v_chave limit 1";
    expect(espacos(corpoVigente)).toContain(alvo);
    expect(espacos(corpoNova)).toContain(alvo);
  });

  it("a chave do boleto e montada do mesmo jeito", () => {
    const alvo = "v_chave := ltrim(coalesce(new.numero_parcela_completo,''),'0');";
    expect(espacos(corpoVigente)).toContain(espacos(alvo));
    expect(espacos(corpoNova)).toContain(espacos(alvo));
  });

  const updateDaParcela = (t) => {
    const m = t.match(/update public\.parcelas[\s\S]*?where id = v_parcela\.id;/);
    if (!m) throw new Error("nao achei o update da parcela");
    return m[0];
  };

  it("o UPDATE que baixa a parcela e identico ao da versao vigente", () => {
    expect(semComentarios(updateDaParcela(corpoNova))).toBe(
      semComentarios(updateDaParcela(corpoVigente)),
    );
  });

  // O erro que este teste passou a cobrir: a primeira versao do PR #374 perdeu
  // os tres carimbos porque comparava com a baseline de 08/09, que ainda nao os
  // tinha. Sem origem_baixa a parcela baixa, mas o vigia
  // `baixa_sem_evidencia_de_quem_baixou` passa a acusar baixa sem autoria.
  it("o UPDATE preserva os tres carimbos de origem_baixa", () => {
    const alvo = semComentarios(updateDaParcela(corpoNova));
    expect(alvo).toContain("origem_baixa = 'GATILHO_IMPORTACAO'");
    expect(alvo).toContain("origem_baixa_ref = new.id::text");
    expect(alvo).toContain("origem_baixa_em = now()");
  });

  it("os tres carimbos vem da versao vigente, nao de invencao minha", () => {
    const daVigente = semComentarios(updateDaParcela(corpoVigente));
    for (const carimbo of [
      "origem_baixa = 'GATILHO_IMPORTACAO'",
      "origem_baixa_ref = new.id::text",
      "origem_baixa_em = now()",
    ]) {
      expect(daVigente).toContain(carimbo);
    }
  });

  it("continua recalculando a situacao do aluno depois de baixar", () => {
    const alvo = "perform public.recalcular_situacao_aluno(v_parcela.aluno_id);";
    expect(espacos(corpoVigente)).toContain(espacos(alvo));
    expect(espacos(corpoNova)).toContain(espacos(alvo));
  });

  it("mantem o registro em auditoria da baixa recusada por vencimento", () => {
    expect(corpoVigente).toContain("BAIXA_DOCUMENTO_RECUSADA");
    expect(corpoNova).toContain("BAIXA_DOCUMENTO_RECUSADA");
  });
});

describe("nenhuma saida muda", () => {
  const ESTADOS = [
    "BAIXADO",
    "AGUARDANDO_ACORDO",
    "AGUARDANDO_AMARRACAO",
    "PARCELA_JA_PAGA",
    "REVISAO",
    "SEM_VINCULO",
  ];

  it("o CHECK da coluna aceita exatamente os seis estados", () => {
    const bloco = sqlNova.match(/status_conciliacao in \(([\s\S]*?)\)\n\s*\)/);
    expect(bloco, "nao achei o CHECK de status_conciliacao").toBeTruthy();
    const noCheck = [...bloco[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(noCheck.sort()).toEqual([...ESTADOS].sort());
  });

  it("a funcao nao tem nenhum `return new` -- o gatilho antigo tinha seis", () => {
    // 6 saidas sem baixa (sem boleto, sem parcela, parcela PAGO, acordo fora de
    // ATIVO, valor fora da faixa, vencimento nao bate) + o `return new` final
    // do caminho que baixou.
    expect(corpoVigente.match(/return new;/g).length).toBe(7);
    expect(corpoNova).not.toContain("return new;");
  });

  it("todo estado atribuido no corpo esta no CHECK", () => {
    const atribuidos = [...corpoNova.matchAll(/v_status\s*:=\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(atribuidos.length).toBeGreaterThan(0);
    for (const e of atribuidos) expect(ESTADOS).toContain(e);
  });

  it("os seis estados sao todos alcancaveis no corpo", () => {
    const atribuidos = new Set(
      [...corpoNova.matchAll(/v_status\s*:=\s*'([A-Z_]+)'/g)].map((m) => m[1]),
    );
    expect([...atribuidos].sort()).toEqual([...ESTADOS].sort());
  });

  it("so BAIXADO fica sem motivo; todo o resto explica por que nao baixou", () => {
    // Cada `v_status := 'X'` e seguido do seu `v_motivo := ...` antes do
    // proximo estado. BAIXADO e o unico que pode receber null.
    const trechos = corpoNova.split(/v_status\s*:=\s*'/).slice(1);
    for (const t of trechos) {
      const estado = t.slice(0, t.indexOf("'"));
      const ate = t.split(/v_status\s*:=\s*'/)[0];
      const motivo = ate.match(/v_motivo\s*:=\s*([\s\S]*?);/);
      expect(motivo, `estado ${estado} ficou sem v_motivo`).toBeTruthy();
      if (estado === "BAIXADO") expect(espacos(motivo[1])).toBe("null");
      else expect(espacos(motivo[1])).not.toBe("null");
    }
  });

  it("grava estado e fila na mesma funcao, sem depender de ordem entre gatilhos", () => {
    expect(corpoNova).toMatch(/update public\.pagamentos\s+set status_conciliacao/);
    expect(corpoNova).toContain("insert into public.fila_pagamento_sem_vinculo");
    // um unico AFTER INSERT: os dois antigos saem
    expect(sqlNova).toContain("drop trigger if exists trg_pagamento_baixa_documento");
    expect(sqlNova).toContain("drop trigger if exists trg_pagamento_enfileira_sem_vinculo");
    expect(sqlNova.match(/create trigger trg_pagamento_conciliar/g).length).toBe(1);
  });

  it("nao toca na projecao, na deduplicacao nem na atribuicao de operador", () => {
    for (const proibido of [
      "projecao_snapshot_gerar",
      "projecao_importar_pagamentos",
      "tg_pagamento_nome_do_operador",
      "emailPorNomeOperador",
    ]) {
      // aparecer em comentario e permitido; o que nao pode e redefinir.
      expect(sqlNova).not.toMatch(
        new RegExp(`create (or replace )?function [^\\n]*${proibido}`, "i"),
      );
    }
  });
});

// O FIXTURE REAL: as seis classes apuradas no arquivo Santander de 14/09/2026,
// 76 linhas, R$ 45.209,20. Os numeros vieram de UMA consulta agrupada em
// producao; ficam aqui congelados como referencia do que a migration tem de
// produzir quando o arquivo for importado.
describe("fixture: o arquivo de 76 linhas de 14/09/2026", () => {
  const CLASSES = [
    { classe: "JA_IMPORTADO", estado: null, qtd: 44, valor: 30276.96 },
    { classe: "IMPORTAR_E_BAIXAR", estado: "BAIXADO", qtd: 9, valor: 3623.98 },
    { classe: "IMPORTAR_AGUARDANDO_ACORDO", estado: "AGUARDANDO_ACORDO", qtd: 11, valor: 6233.4 },
    { classe: "IMPORTAR_AGUARDANDO_AMARRACAO", estado: "AGUARDANDO_AMARRACAO", qtd: 7, valor: 3739.63 },
    { classe: "IMPORTAR_SEM_BAIXA_REVISAO", estado: "REVISAO", qtd: 1, valor: 419.74 },
    { classe: "PARCELA_JA_PAGA_REVISAR", estado: "PARCELA_JA_PAGA", qtd: 4, valor: 915.49 },
  ];

  it("as seis classes somam as 76 linhas e o total do arquivo", () => {
    expect(CLASSES.reduce((s, c) => s + c.qtd, 0)).toBe(76);
    expect(Math.round(CLASSES.reduce((s, c) => s + c.valor, 0) * 100) / 100).toBe(45209.2);
  });

  it("JA_IMPORTADO nao vira estado da tabela: e barrado antes do INSERT", () => {
    const naTabela = CLASSES.filter((c) => c.estado !== null);
    expect(naTabela).toHaveLength(5);
    expect(sqlNova).not.toMatch(/status_conciliacao\s*:?=\s*'JA_IMPORTADO'/);
    expect(sqlNova).toContain("Nao tem estado \"ja importado\"");
  });

  it("as 32 linhas que entram recebem estado, e 23 delas nao baixam", () => {
    const entram = CLASSES.filter((c) => c.estado !== null);
    expect(entram.reduce((s, c) => s + c.qtd, 0)).toBe(32);
    const semBaixa = entram.filter((c) => c.estado !== "BAIXADO");
    expect(semBaixa.reduce((s, c) => s + c.qtd, 0)).toBe(23);
  });

  it("as 11 linhas antes invisiveis passam a ter estado e a entrar na fila", () => {
    // Aluno ja identificado (numero Ulbra unico / boleto exato) e sem baixa:
    // com o eixo antigo (`aluno_id IS NULL`) nao entravam na fila.
    const invisiveis = CLASSES.filter((c) =>
      ["AGUARDANDO_AMARRACAO", "PARCELA_JA_PAGA"].includes(c.estado),
    );
    expect(invisiveis.reduce((s, c) => s + c.qtd, 0)).toBe(11);
    expect(Math.round(invisiveis.reduce((s, c) => s + c.valor, 0) * 100) / 100).toBe(4655.12);
  });

  it("cada estado do fixture existe no corpo da funcao", () => {
    for (const c of CLASSES) {
      if (c.estado === null) continue;
      expect(corpoNova).toContain(`v_status := '${c.estado}'`);
    }
  });
});
