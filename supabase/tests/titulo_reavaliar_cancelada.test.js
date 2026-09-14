// TITULO CANCELADO NAO PODE SER REABERTO PELA REAVALIACAO AUTOMATICA.
//
// POR QUE ESTE TESTE LE O .SQL EM VEZ DE REESCREVER A REGRA EM JS. Se o teste
// tivesse a sua propria copia da condicao, ele passaria mesmo que a migration
// dissesse outra coisa -- provaria apenas que eu sei escrever a regra duas
// vezes. Entao ele EXTRAI as condicoes de parada do proprio arquivo da
// migration e avalia essas condicoes. Trocar um literal no SQL quebra o teste.
//
// E ele tambem compara o corpo da funcao com a definicao que estava em
// producao em 13/09/2026 (supabase/audits/titulo_reavaliar_producao_20260913.sql,
// md5 17abaf4f192c127be95647ca86a472e3), exigindo que a unica diferenca seja o
// bloco novo. Isso e o que prova "nao mudei mais nada" -- a funcao nao tinha
// definicao no repositorio, so em producao, entao nao havia com o que diffar.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");

const MIGRATION = resolve(
  RAIZ,
  "supabase/migrations/20260913230000_titulo_reavaliar_cancelada_e_estado_terminal.sql",
);
const PRODUCAO = resolve(RAIZ, "supabase/audits/titulo_reavaliar_producao_20260913.sql");

const sqlMigration = readFileSync(MIGRATION, "utf8");
const sqlProducao = readFileSync(PRODUCAO, "utf8");

// Corpo = o que esta entre os dois marcadores $function$.
function corpoDaFuncao(sql) {
  const partes = sql.split("$function$");
  if (partes.length < 3) throw new Error("nao achei o corpo entre $function$");
  return partes[1];
}

// Cada `if <condicoes> then return; end if;` do corpo vira uma lista de testes.
// Reconhece so as duas formas usadas: `upper(coalesce(v_x,'')) = 'LIT'` e
// `lower(coalesce(v_x,'')) in ('a','b')` / `= 'a'`. Qualquer forma nova cai
// fora e o teste de cobertura das guardas acusa.
function guardasDeParada(corpo) {
  const blocos = [...corpo.matchAll(/if\s+([\s\S]*?)\s+then\s*\n?\s*return;\s*\n?\s*end if;/g)];
  return blocos
    .map((m) => m[1])
    .filter((cond) => cond.includes("v_situacao") || cond.includes("v_status"))
    .map((cond) => {
      const termos = [...cond.matchAll(
        /(upper|lower)\(coalesce\((v_situacao|v_status),''\)\)\s*(=|in)\s*(\([^)]*\)|'[^']*')/g,
      )].map(([, caixa, campo, operador, alvo]) => ({
        campo,
        caixa,
        valores: [...alvo.matchAll(/'([^']*)'/g)].map((v) => v[1]),
        operador,
      }));
      if (termos.length === 0) throw new Error("guarda sem termo reconhecido: " + cond);
      return termos;
    });
}

const corpoMigration = corpoDaFuncao(sqlMigration);
const guardas = guardasDeParada(corpoMigration);

// Aplica as guardas extraidas do SQL a um titulo. true = a funcao para aqui.
function paraAntesDeReavaliar({ situacao, status }) {
  const valor = { v_situacao: situacao ?? "", v_status: status ?? "" };
  return guardas.some((termos) =>
    termos.some((t) => {
      const lido = t.caixa === "upper"
        ? String(valor[t.campo] ?? "").toUpperCase()
        : String(valor[t.campo] ?? "").toLowerCase();
      return t.valores.includes(lido);
    }),
  );
}

describe("migration: titulo cancelado e estado terminal", () => {
  it("o corpo e o de producao com UM unico bloco acrescentado", () => {
    const producao = corpoDaFuncao(sqlProducao);
    const novo = corpoMigration;
    // Tudo que existia continua existindo, na mesma ordem: removendo o bloco
    // novo, o corpo volta a ser identico ao de producao.
    const semGuardaNova = novo.replace(
      /\n\n {2}-- Ja cancelada:[\s\S]*?\n {2}end if;\n/,
      "\n",
    );
    expect(semGuardaNova).toBe(producao);
    expect(novo).not.toBe(producao); // e o bloco novo existe mesmo
  });

  it("a migration nao tem DML: so CREATE OR REPLACE e COMMENT", () => {
    // Fora do corpo da funcao nao pode haver insert/update/delete/truncate.
    const semComentario = sqlMigration
      .split("\n")
      .filter((linha) => !linha.trimStart().startsWith("--"))
      .join("\n");
    const pedacos = semComentario.split("$function$");
    const foraDoCorpo = pedacos[0] + pedacos.slice(2).join("$function$");
    expect(foraDoCorpo).not.toMatch(/\b(insert|delete|truncate|alter table|drop)\b/i);
    expect(foraDoCorpo.match(/\bupdate\b/gi)).toBeNull();
    expect(sqlMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.titulo_reavaliar/);
  });

  it("a guarda nova usa o vocabulario real da tabela, sem inventar estado", () => {
    const valores = guardas.flat().flatMap((t) => t.valores);
    // Medido em producao em 13/09/2026: acordos_titulos so tem PAGO/quitada e
    // CANCELADA/cancelada como estados terminais. 'paga' ja vinha de antes.
    expect(new Set(valores)).toEqual(new Set(["PAGO", "quitada", "paga", "CANCELADA", "cancelada"]));
  });

  // ---- tabela verdade: o que muda e o que nao muda ----

  it("titulo tipo_boleto='Acordo' cancelado permanece CANCELADA", () => {
    // O estado do titulo e o mesmo seja mensalidade ou boleto do proprio acordo:
    // titulo_reavaliar nao le tipo_boleto. Este e o caso que a regra de
    // trg_titulos_por_status_acordo passa a produzir a partir de agora.
    expect(paraAntesDeReavaliar({ situacao: "CANCELADA", status: "cancelada" })).toBe(true);
  });

  it("mensalidade ABERTA continua sendo reavaliada como hoje", () => {
    expect(paraAntesDeReavaliar({ situacao: "ABERTO", status: "em_aberto" })).toBe(false);
  });

  it("titulo NEGOCIADO/vinculada continua sendo reavaliado como hoje", () => {
    expect(paraAntesDeReavaliar({ situacao: "NEGOCIADO", status: "vinculada" })).toBe(false);
  });

  it("titulo DUPLICADA continua sendo reavaliado (o desfazer dele e outro caminho)", () => {
    expect(paraAntesDeReavaliar({ situacao: "DUPLICADA", status: "em_aberto" })).toBe(false);
  });

  it("titulo PAGO continua protegido", () => {
    expect(paraAntesDeReavaliar({ situacao: "PAGO", status: "quitada" })).toBe(true);
    expect(paraAntesDeReavaliar({ situacao: "ABERTO", status: "quitada" })).toBe(true);
    expect(paraAntesDeReavaliar({ situacao: "ABERTO", status: "paga" })).toBe(true);
  });

  it("a protecao nao depende de caixa nem de valor nulo", () => {
    expect(paraAntesDeReavaliar({ situacao: "cancelada", status: "CANCELADA" })).toBe(true);
    expect(paraAntesDeReavaliar({ situacao: null, status: "cancelada" })).toBe(true);
    expect(paraAntesDeReavaliar({ situacao: null, status: null })).toBe(false);
  });
});
