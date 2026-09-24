import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// COLETA DO PORTADOR 202 (REATIVA COBRANCA JUDICIAL) -- ETAPA OBSERVACIONAL.
//
// Amanda, 24/09/2026: "quero SOMENTE tornar a condicao juridica atual
// verificavel. Nao implemente ainda `titulo_reativar`, nao reative titulos e
// nao altere comportamento de cobranca."
//
// Estes testes existem para que a proxima pessoa que mexer aqui nao transforme
// uma coleta em uma acao. Eles travam tres coisas:
//   1. a migration nao escreve em NENHUMA tabela operacional (so `auditoria`,
//      que e rastro do disparo);
//   2. a resposta de filiacao e de TRES valores, e ausencia so vira 'NAO' com
//      snapshot completo e valido -- nunca por falha de API ou paginacao;
//   3. o mutirao de 166/195 continua intocado.

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");

const nome = readdirSync(MIGRACOES).find((n) => n.endsWith("_prime_portador_202_observacional.sql"));
const sql = nome ? readFileSync(join(MIGRACOES, nome), "utf8") : "";
// Comentario nao e codigo: proibir uma palavra sem tirar os comentarios antes
// faz o teste acusar a propria explicacao do que ele proibe.
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// Tudo que move dinheiro, cobranca ou fila. A coleta nao pode tocar em nada disto.
const TABELAS_OPERACIONAIS = [
  "acordos_titulos", "acordos", "parcelas", "alunos", "casos", "pagamentos",
  "baixas_pagamento", "carteira_operador", "prime_conferencia_decisao",
  "acordo_titulo_vinculo", "conciliacao_pagamento_conferido",
];

describe("coleta observacional do portador 202", () => {
  it("a migration existe", () => {
    expect(nome, "migration nao encontrada").toBeTruthy();
  });

  it("nao escreve em nenhuma tabela operacional", () => {
    for (const tabela of TABELAS_OPERACIONAIS) {
      const dml = new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?${tabela}\\b`, "i");
      expect(codigo, `a coleta nao pode escrever em ${tabela}`).not.toMatch(dml);
    }
  });

  it("o unico insert e o rastro em auditoria", () => {
    const inserts = codigo.match(/insert\s+into\s+(public\.)?(\w+)/gi) || [];
    expect(inserts.length).toBe(1);
    expect(inserts[0].toLowerCase()).toContain("auditoria");
  });

  it("nao altera situacao, status nem saldo de titulo", () => {
    expect(codigo).not.toMatch(/set\s+situacao\s*=/i);
    expect(codigo).not.toMatch(/set\s+status\s*=/i);
    expect(codigo).not.toMatch(/saldo_total\s*=/i);
  });

  it("nao reativa nada: nenhuma funcao de reversao nasce aqui", () => {
    for (const proibido of ["titulo_reativar", "reativar_titulo", "descancelar"]) {
      expect(codigo, `${proibido} nao pertence a esta etapa`).not.toContain(proibido);
    }
    // e nao cria o botao na tela
    const front = readdirSync(join(RAIZ, "src", "components"));
    expect(front.join(" ")).not.toMatch(/ReativarTitulo/);
  });

  it("as leituras sao STABLE (nao podem ter efeito colateral)", () => {
    const estado = codigo.slice(codigo.indexOf("prime_portador_snapshot_estado"));
    expect(estado.slice(0, 400)).toMatch(/\bstable\b/i);
    const juridico = codigo.slice(codigo.indexOf("function public.prime_aluno_no_juridico"));
    expect(juridico.slice(0, 400)).toMatch(/\bstable\b/i);
  });

  it("ausencia so vira NAO com snapshot valido -- presenca vale sempre", () => {
    const f = codigo.slice(codigo.indexOf("function public.prime_aluno_no_juridico"));
    const corpo = f.slice(0, f.indexOf("$function$;"));
    // a ordem importa: o 'SIM' da presenca vem ANTES de qualquer avaliacao de
    // validade, e o 'NAO' vem DEPOIS do teste de valido.
    const posSim = corpo.indexOf("'SIM'");
    const posValido = corpo.indexOf("'valido'");
    const posNao = corpo.lastIndexOf("'NAO'");
    expect(posSim).toBeGreaterThan(-1);
    expect(posValido).toBeGreaterThan(posSim);
    expect(posNao).toBeGreaterThan(posValido);
    // e o unico caminho para 'NAO' passa pelo return de INDETERMINADO logo acima
    expect(corpo).toMatch(/if not coalesce\(\(v_estado->>'valido'\)::boolean, false\) then\s*return 'INDETERMINADO';/);
  });

  it("CPF ilegivel nunca conclui ausencia", () => {
    const f = codigo.slice(codigo.indexOf("function public.prime_aluno_no_juridico"));
    expect(f.slice(0, 900)).toMatch(/length\(v_cpf\) <> 11[\s\S]{0,120}return 'INDETERMINADO'/);
  });

  it("o disparo da coleta e restrito a gestao", () => {
    const f = codigo.slice(codigo.indexOf("function public.prime_portador_202_coletar"));
    expect(f.slice(0, 600)).toMatch(/usuario_e_gestao/);
    expect(f.slice(0, 600)).toMatch(/42501/);
  });

  it("nao mexe no mutirao de 166/195", () => {
    expect(codigo).not.toMatch(/create or replace function public\.prime_portador_mutirao/i);
    expect(codigo).not.toMatch(/cron\.(schedule|alter_job|unschedule)/i);
  });

  it("o 202 e nomeado pelo papel correto", () => {
    expect(sql).toMatch(/REATIVA COBRANCA JUDICIAL/i);
  });
});
