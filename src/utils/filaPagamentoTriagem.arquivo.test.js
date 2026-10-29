import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resumoPorArquivo, recorteDoArquivo, SEM_ARQUIVO } from "./filaPagamentoTriagem";

// A fila oficial e `fila_pagamento_sem_vinculo`, e ela ja guardava
// `importacao_id` e `arquivo_nome` -- em 23/10/2026, preenchidos nas 420
// pendencias abertas em producao (420/420). Estes testes cobrem a leitura
// desse dado na tela; a classificacao em si continua toda no banco.
const LINHAS = [
  { pagamento_id: "p1", importacao_id: "imp-a", arquivo_nome: "santander_0930.csv", valor_pago: 100 },
  { pagamento_id: "p2", importacao_id: "imp-a", arquivo_nome: "santander_0930.csv", valor_pago: 50.5 },
  { pagamento_id: "p3", importacao_id: "imp-a", arquivo_nome: "santander_0930.csv", valor_pago: 10 },
  { pagamento_id: "p4", importacao_id: "imp-b", arquivo_nome: "santander_1001.csv", valor_pago: 900 },
  { pagamento_id: "p5", importacao_id: null, arquivo_nome: null, valor_pago: 7 },
];

describe("resumoPorArquivo", () => {
  it("agrupa por arquivo e soma o valor", () => {
    const r = resumoPorArquivo(LINHAS);
    const a = r.find((x) => x.arquivo_nome === "santander_0930.csv");
    expect(a.itens).toBe(3);
    expect(a.valor).toBeCloseTo(160.5, 2);
    expect(a.importacao_id).toBe("imp-a");
  });

  it("ordena pelo que mais pesa em QUANTIDADE, nao em valor", () => {
    // imp-b tem R$ 900 numa linha so; imp-a tem 3 linhas e R$ 160,50.
    // A fila e trabalho a fazer: 3 pendencias pesam mais que 1.
    const r = resumoPorArquivo(LINHAS);
    expect(r[0].arquivo_nome).toBe("santander_0930.csv");
    expect(r[1].arquivo_nome).toBe("santander_1001.csv");
  });

  it("o balde sem arquivo vai por ULTIMO, mesmo sendo o maior", () => {
    const muitosSemArquivo = [
      ...Array.from({ length: 9 }, (_, i) => ({ pagamento_id: `s${i}`, arquivo_nome: null, valor_pago: 1 })),
      { pagamento_id: "x", importacao_id: "imp-a", arquivo_nome: "um.csv", valor_pago: 1 },
    ];
    const r = resumoPorArquivo(muitosSemArquivo);
    expect(r[0].arquivo_nome).toBe("um.csv");
    expect(r[r.length - 1].arquivo_nome).toBe(SEM_ARQUIVO);
    expect(r[r.length - 1].itens).toBe(9);
  });

  it("nao inventa importacao_id para o balde sem arquivo", () => {
    const r = resumoPorArquivo([{ pagamento_id: "p", importacao_id: "imp-z", arquivo_nome: "   " }]);
    expect(r[0].arquivo_nome).toBe(SEM_ARQUIVO);
    expect(r[0].importacao_id).toBeNull();
  });

  it("valor nao numerico nao contamina a soma", () => {
    const r = resumoPorArquivo([
      { pagamento_id: "p1", arquivo_nome: "a.csv", valor_pago: 10 },
      { pagamento_id: "p2", arquivo_nome: "a.csv", valor_pago: null },
      { pagamento_id: "p3", arquivo_nome: "a.csv", valor_pago: "nao e numero" },
    ]);
    expect(r[0].itens).toBe(3);
    expect(r[0].valor).toBe(10);
  });

  it("aguenta entrada vazia e nula", () => {
    expect(resumoPorArquivo([])).toEqual([]);
    expect(resumoPorArquivo(null)).toEqual([]);
    expect(resumoPorArquivo(undefined)).toEqual([]);
  });
});

describe("recorteDoArquivo", () => {
  it("sem id devolve null -- 'sem filtro', nao 'nenhum resultado'", () => {
    expect(recorteDoArquivo(LINHAS, "")).toBeNull();
    expect(recorteDoArquivo(LINHAS, null)).toBeNull();
    expect(recorteDoArquivo(LINHAS, "   ")).toBeNull();
  });

  it("descreve o recorte do arquivo escolhido", () => {
    const r = recorteDoArquivo(LINHAS, "imp-a");
    expect(r.arquivo_nome).toBe("santander_0930.csv");
    expect(r.itens).toBe(3);
    expect(r.valor).toBeCloseTo(160.5, 2);
  });

  it("recorte sem pendencia devolve itens 0, nao null", () => {
    // A diferenca importa na tela: 0 e "este arquivo nao tem pendencia",
    // null seria "nao ha recorte" -- sao avisos diferentes.
    const r = recorteDoArquivo(LINHAS, "imp-inexistente");
    expect(r).not.toBeNull();
    expect(r.itens).toBe(0);
    expect(r.arquivo_nome).toBe("");
  });

  it("acha o nome mesmo que a primeira linha do arquivo venha sem ele", () => {
    const r = recorteDoArquivo(
      [
        { pagamento_id: "p1", importacao_id: "imp-c", arquivo_nome: null, valor_pago: 1 },
        { pagamento_id: "p2", importacao_id: "imp-c", arquivo_nome: "achado.csv", valor_pago: 2 },
      ],
      "imp-c",
    );
    expect(r.arquivo_nome).toBe("achado.csv");
    expect(r.itens).toBe(2);
  });
});

// A migration tem uma armadilha que custa caro se alguem "simplificar": o
// `where` combina duas condicoes opcionais, e sem os parenteses
// `A or B and C` liga como `A or (B and C)` -- com categoria nula a condicao
// inteira viraria TRUE e o filtro por arquivo seria ignorado EM SILENCIO.
describe("contrato da migration 20261023190000", () => {
  const AQUI = dirname(fileURLToPath(import.meta.url));
  const SQL = readFileSync(
    join(AQUI, "..", "..", "supabase", "migrations", "20261023190000_fila_triagem_arquivo_e_filtro.sql"),
    "utf8",
  );
  const EXEC = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

  it("as duas condicoes do where estao parentetizadas", () => {
    expect(EXEC).toMatch(/where \(p_categoria is null or t\.categoria = p_categoria\)/);
    expect(EXEC).toMatch(/and \(p_importacao_id is null or f\.importacao_id = p_importacao_id\)/);
  });

  it("derruba a assinatura de 2 argumentos antes de criar a de 3", () => {
    // `create or replace` com lista de argumentos diferente cria uma SEGUNDA
    // funcao, e a chamada por argumento nomeado da tela ficaria ambigua.
    const posDrop = EXEC.indexOf("drop function if exists public.fila_pagamento_triagem_ler(text, integer)");
    const posCreate = EXEC.indexOf("create or replace function public.fila_pagamento_triagem_ler(");
    expect(posDrop).toBeGreaterThanOrEqual(0);
    expect(posCreate).toBeGreaterThan(posDrop);
  });

  it("o join na fila e LEFT -- a fila nunca encolhe por falta do dado novo", () => {
    expect(EXEC).toMatch(/left join public\.fila_pagamento_sem_vinculo f on f\.pagamento_id = t\.pagamento_id/);
  });

  it("repoe os grants que o drop levou", () => {
    expect(EXEC).toMatch(/revoke all on function public\.fila_pagamento_triagem_ler\(text, integer, uuid\) from public/);
    expect(EXEC).toMatch(/grant execute on function public\.fila_pagamento_triagem_ler\(text, integer, uuid\) to authenticated/);
    expect(EXEC).toMatch(/grant execute on function public\.fila_pagamento_triagem_ler\(text, integer, uuid\) to service_role/);
  });

  it("mantem o portao de gestao com a guarda de identidade nula", () => {
    expect(EXEC).toMatch(/not coalesce\(public\.usuario_e_gestao\(\), false\)/);
    expect(EXEC).toMatch(/errcode = '42501'/);
  });

  it("nao escreve em nada -- so leitura", () => {
    for (const proibido of ["insert into", "update public.", "delete from", "truncate", "alter table"]) {
      expect(EXEC.toLowerCase()).not.toContain(proibido);
    }
  });
});
