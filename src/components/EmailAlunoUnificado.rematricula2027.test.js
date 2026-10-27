import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `email_templates` so existe em producao, entao nao da para testar a tabela
// aqui. O que ESTE teste protege e o CONTRATO da migration: que ela retire o
// modelo antigo sem apagar nada, que o texto dos dois modelos novos seja
// exatamente o que a gestao pediu, e que nenhuma mao futura "simplifique" o
// update num delete. Mesmo padrao de PainelCarteira.faixaPrioridade.test.js,
// que tambem asserta sobre o fonte.
const AQUI = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(AQUI, "..", "..", "supabase", "migrations", "20261023184500_modelos_email_rematricula_2027_1.sql"),
  "utf8"
);

// Sem comentarios: o que o Postgres de fato executa.
const EXECUTAVEL = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

// Textos exatos do pedido da gestao de 23/10/2026. Se alguem reescrever a
// copy, este teste cai -- e e isso que se quer: a copy foi aprovada assim.
const MODELO_1 = {
  chave: "rematricula_2027_1_vaga",
  assunto: "💙 Seu próximo semestre começa aqui! Rematrículas 2027/1 abertas",
  p1: "As rematrículas para o semestre 2027/1 já estão abertas, e queremos te ajudar a garantir sua vaga para o próximo semestre! 💙",
  p2: "Estamos com condições especiais de negociação para facilitar esse processo. Entre em contato conosco e vamos encontrar a melhor opção para você continuar sua jornada acadêmica! 🎓✨",
};
const MODELO_2 = {
  chave: "rematricula_2027_1_condicoes",
  assunto: "🎓 Rematrículas 2027/1 abertas: confira suas condições especiais!",
  p1: "🎓 As rematrículas para o semestre 2027/1 já estão abertas!",
  p2: "Aproveite nossas condições especiais de negociação e regularize sua situação para garantir sua vaga no próximo semestre. Entre em contato conosco e saiba mais! 💙",
};

describe("Rematrícula 2027/1: o modelo antigo sai sem perder histórico", () => {
  it("tira 'Reta final' das opções ativas por ativo = false", () => {
    expect(EXECUTAVEL).toMatch(/update\s+public\.email_templates\s+set\s+ativo\s*=\s*false\s+where\s+chave\s*=\s*'reta_final_matricula'/i);
  });

  it("NÃO apaga nem derruba nada -- sem delete, drop ou truncate", () => {
    expect(EXECUTAVEL.toLowerCase()).not.toContain("delete from");
    expect(EXECUTAVEL.toLowerCase()).not.toContain("drop ");
    expect(EXECUTAVEL.toLowerCase()).not.toContain("truncate");
  });

  it("não toca a tabela de histórico de envio", () => {
    // O histórico é texto livre em aluno_movimentacoes.descricao, sem FK. A
    // migration só pode preservá-lo se nunca mencionar a tabela num comando.
    expect(EXECUTAVEL).not.toContain("aluno_movimentacoes");
  });

  it("não reescreve o rótulo nem o texto do modelo antigo", () => {
    // `situacao` do modelo antigo é o rótulo que o histórico já gravou 171
    // vezes; mudá-lo faria a linha divergir do histórico. O único campo que a
    // migration altera nessa linha é `ativo`.
    const update = EXECUTAVEL.match(/update\s+public\.email_templates[\s\S]*?;/i)[0];
    expect(update).not.toMatch(/situacao\s*=/i);
    expect(update).not.toMatch(/assunto\s*=/i);
    expect(update).not.toMatch(/corpo_html\s*=/i);
    expect(update).not.toMatch(/corpo_texto\s*=/i);
  });

  it("é guardada por to_regclass -- não quebra em banco sem a tabela", () => {
    expect(EXECUTAVEL).toMatch(/to_regclass\('public\.email_templates'\)\s+is\s+null/i);
  });
});

describe("Rematrícula 2027/1: os dois modelos novos", () => {
  for (const [nome, m] of [["modelo 1", MODELO_1], ["modelo 2", MODELO_2]]) {
    describe(nome, () => {
      it("entra com a chave e o assunto exatos do pedido", () => {
        expect(EXECUTAVEL).toContain(`'${m.chave}'`);
        expect(EXECUTAVEL).toContain(m.assunto);
      });

      it("traz o texto aprovado, no HTML e no texto puro", () => {
        // Duas ocorrências de cada parágrafo: uma no corpo_html, uma no
        // corpo_texto. Menos que isso significa que uma das versões divergiu.
        for (const par of [m.p1, m.p2]) {
          const n = EXECUTAVEL.split(par).length - 1;
          expect(n, `"${par.slice(0, 40)}..." aparece ${n}x`).toBe(2);
        }
      });
    });
  }

  it("ambos entram ATIVOS e marcados como novos para o operador", () => {
    // As telas leem `.eq("ativo", true)`, e AvisoTemplateNovo usa `novo`.
    // A tupla final de cada insert é: permite_anexo, ativo, dias_retorno, novo.
    const tuplas = EXECUTAVEL.match(/^\s*false,\s*true,\s*7,\s*true\s*$/gm) || [];
    expect(tuplas.length).toBe(2);
  });

  it("entram no fim da lista (7 e 8) para não mover nenhum modelo atual", () => {
    expect(EXECUTAVEL).toMatch(/'Rematrícula 2027\/1 — garanta sua vaga',\s*\n\s*7,/);
    expect(EXECUTAVEL).toMatch(/'Rematrícula 2027\/1 — condições especiais',\s*\n\s*8,/);
  });

  it("é reaplicável: on conflict pela chave única, nunca um segundo insert", () => {
    const conflitos = EXECUTAVEL.match(/on conflict \(chave\) do update/g) || [];
    expect(conflitos.length).toBe(2);
  });

  it("não dispara envio: nenhuma chamada de e-mail na migration", () => {
    expect(EXECUTAVEL.toLowerCase()).not.toContain("net.http");
    expect(EXECUTAVEL.toLowerCase()).not.toContain("pg_net");
    expect(EXECUTAVEL.toLowerCase()).not.toContain("cron.schedule");
  });
});
