// SANTANDER · ENTREGA B — IMPRESSÃO DIGITAL E AS GARANTIAS DA FUNÇÃO QUE GRAVA
//
// O QUE ESTE ARQUIVO PROVA
//   * a digital muda quando QUALQUER campo normalizado muda, e quando as linhas
//     trocam de ordem -- é o que a torna útil como conferência;
//   * campo novo no normalizador entra na digital sozinho (chaves ordenadas, não
//     lista fixa), que é a falha silenciosa que o desenho evita;
//   * a função que grava não aceita linhas do cliente, recusa token de rotina,
//     exige a digital e chama exatamente duas RPCs;
//   * o gateway exige JWT, declarado no config.toml.
//
// A IDEMPOTÊNCIA (repetir o mesmo arquivo) é provada em PostgreSQL real, com o
// corpo vivo da RPC, em supabase/tests/santander_importar_idempotencia.test.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digitalConfere,
  impressaoDigital,
  normalizarPlanilha,
  textoParaDigital,
} from "../santander-previa/planilha.ts";

const AQUI = dirname(fileURLToPath(import.meta.url));

// Duas linhas no formato do extrato: A instituição | B "matrícula - nome" |
// C título | D operador | E boleto | F convênio | G vencimento | H valor
// original | I honorário | J data pagamento | K valor pago
// Datas em dd/mm/aaaa, que e uma das representacoes reais do arquivo. Usar
// "2026-10-01" aqui nao serve: `paraDataISO` so entende dd/mm/aaaa, `Date` e
// serial do Excel, entao ISO com hifen normaliza para null -- e dois nulls nao
// movem a digital, o que esconderia justamente o campo que se quis testar.
const L1 = ["ULBRA", "2026002333 - ALUNO UM", "50640", "MARIA.SILVA", "50640510001", "0272047",
  "10/09/2026", 500, 50, "01/10/2026", 500];
const L2 = ["ULBRA", "2026002334 - ALUNO DOIS", "50641", "JOAO.SOUZA", "50641510001", "0272047",
  "10/09/2026", 300, 30, "01/10/2026", 300];

const digitalDe = (linhas) => impressaoDigital(normalizarPlanilha(linhas));

describe("impressao digital do conteudo normalizado", () => {
  it("o mesmo conteudo da sempre a mesma digital", async () => {
    expect(await digitalDe([L1, L2])).toBe(await digitalDe([L1, L2]));
  });

  it("e um sha-256 em hex", async () => {
    expect(await digitalDe([L1])).toMatch(/^[0-9a-f]{64}$/);
  });

  // Cada campo que a importacao grava, um por um. Se qualquer um destes deixar
  // de mover a digital, a conferencia passa a ser decorativa.
  const mexidas = [
    ["valor pago", (l) => { const c = [...l]; c[10] = 501; return c; }],
    ["honorario", (l) => { const c = [...l]; c[8] = 51; return c; }],
    ["data de pagamento", (l) => { const c = [...l]; c[9] = "02/10/2026"; return c; }],
    ["vencimento", (l) => { const c = [...l]; c[6] = "11/09/2026"; return c; }],
    ["valor original", (l) => { const c = [...l]; c[7] = 499; return c; }],
    ["numero da parcela", (l) => { const c = [...l]; c[4] = "50640510002"; return c; }],
    ["titulo", (l) => { const c = [...l]; c[2] = "50999"; return c; }],
    ["operador", (l) => { const c = [...l]; c[3] = "JOAO.SOUZA"; return c; }],
    ["matricula", (l) => { const c = [...l]; c[1] = "2026009999 - ALUNO UM"; return c; }],
    ["nome do aluno", (l) => { const c = [...l]; c[1] = "2026002333 - OUTRO NOME"; return c; }],
  ];
  for (const [campo, mexer] of mexidas) {
    it(`muda quando muda ${campo}`, async () => {
      expect(await digitalDe([mexer(L1)])).not.toBe(await digitalDe([L1]));
    });
  }

  it("muda quando as linhas trocam de ordem", async () => {
    expect(await digitalDe([L2, L1])).not.toBe(await digitalDe([L1, L2]));
  });

  it("muda quando uma linha e removida", async () => {
    expect(await digitalDe([L1])).not.toBe(await digitalDe([L1, L2]));
  });

  // Linha repetida identica NAO pode colapsar na digital: a RPC e que decide
  // descartar duplicata exata, e ela precisa receber o que o arquivo tinha.
  it("duas linhas identicas nao viram uma", async () => {
    expect(await digitalDe([L1, L1])).not.toBe(await digitalDe([L1]));
  });

  it("a contagem de linhas entra no texto assinado", async () => {
    expect(JSON.parse(textoParaDigital(normalizarPlanilha([L1, L2]))).n).toBe(2);
  });

  // A garantia estrutural: chaves ordenadas, entao todo campo do normalizador
  // esta coberto -- inclusive um que venha a ser acrescentado depois.
  it("cobre TODOS os campos do normalizador, sem lista fixa", () => {
    const [linha] = normalizarPlanilha([L1]);
    const campos = Object.keys(linha);
    const assinado = textoParaDigital([linha]);
    expect(campos.length).toBeGreaterThan(10);
    for (const campo of campos) expect(assinado).toContain(`"${campo}"`);
  });

  it("linha descartada pelo filtro nao entra na digital", async () => {
    const titulo = ["Data de Pagamento: 01/10/2026", "", "", "", "", "", "", "", "", "", ""];
    expect(await digitalDe([titulo, L1])).toBe(await digitalDe([L1]));
  });
});

describe("comparacao de digitais", () => {
  it("confere iguais e recusa diferentes", () => {
    expect(digitalConfere("abc123", "abc123")).toBe(true);
    expect(digitalConfere("abc123", "abc124")).toBe(false);
  });
  it("recusa vazio, tamanhos diferentes e nao-string", () => {
    expect(digitalConfere("", "")).toBe(false);
    expect(digitalConfere("abc", "abcd")).toBe(false);
    expect(digitalConfere(null, "abc")).toBe(false);
    expect(digitalConfere(undefined, undefined)).toBe(false);
  });
});

describe("a funcao que grava: garantias no proprio texto", () => {
  const bruto = readFileSync(resolve(AQUI, "index.ts"), "utf8");
  // Confere o CODIGO, nao a prosa: os comentarios citam nomes de RPC e de
  // campos justamente para explicar as decisoes.
  const fonte = bruto
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("chama exatamente duas RPCs: o portao de gestao e a importacao", () => {
    const rpcs = [...fonte.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(rpcs).toEqual(["usuario_e_gestao", "projecao_importar_pagamentos"]);
  });

  // O ponto central da entrega: as linhas gravadas sao o parse DO SERVIDOR.
  it("p_linhas vem do parse do servidor, nunca do corpo da requisicao", () => {
    expect(fonte).toMatch(/p_linhas:\s*linhas\b/);
    expect(fonte).toMatch(/const linhas = normalizarPlanilha\(linhasBrutas\)/);
    // nenhum campo de linhas lido do formulario
    const lidosDoForm = [...fonte.matchAll(/form\.get\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(lidosDoForm).not.toContain("linhas");
    expect(lidosDoForm).not.toContain("p_linhas");
    expect(lidosDoForm.sort()).toEqual([
      "arquivo", "digital", "mes_referencia", "motivo_substituicao",
      "retroativo", "substituir_importacao_id",
    ]);
  });

  it("o usuario gravado vem do token, nao do corpo", () => {
    expect(fonte).toMatch(/p_usuario:\s*emailDaPessoa/);
    expect(fonte).toMatch(/auth\.getUser\(\)/);
  });

  it("recusa token de rotina: gravar dinheiro exige pessoa", () => {
    expect(fonte).toMatch(/x-rotina-token/);
    expect(fonte).toMatch(/ROTINA_NAO_IMPORTA/);
  });

  it("sem digital nao grava, e digital divergente devolve 409", () => {
    expect(fonte).toMatch(/DIGITAL_AUSENTE/);
    expect(fonte).toMatch(/DIGITAL_DIVERGENTE/);
    expect(fonte).toMatch(/if \(!digitalConfere\(digitalRecebida, digitalCalculada\)\)/);
  });

  it("recalcula a digital em vez de confiar na recebida", () => {
    expect(fonte).toMatch(/const digitalCalculada = await impressaoDigital\(linhas\)/);
  });

  // A ordem importa: a digital tem de ser conferida ANTES da chamada que grava.
  it("confere a digital antes de chamar a RPC de importacao", () => {
    expect(fonte.indexOf("digitalConfere")).toBeLessThan(fonte.indexOf("projecao_importar_pagamentos"));
  });

  it("usa o JWT de quem chamou, e nao a chave de servico", () => {
    expect(fonte).toMatch(/SUPABASE_ANON_KEY/);
    expect(fonte).not.toMatch(/SERVICE_ROLE/i);
  });

  it("o gateway exige JWT, declarado no config.toml", () => {
    const toml = readFileSync(resolve(AQUI, "..", "..", "config.toml"), "utf8");
    expect(toml).toMatch(/\[functions\.santander-importar\][\s\S]*?verify_jwt = true/);
  });
});
