import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// GUARDA DA CONFIRMACAO DE PAGAMENTO QUE RESOLVE O TITULO EM CONFIRMACAO.
//
// O caso que originou tudo (23/09/2026): a mensalidade que vira EM_CONFIRMACAO
// sai da cobranca, o saldo do aluno zera, e a fila do extrato -- que so aceita
// `saldo_total > 0.005` -- perdia o aluno inteiro. Eram 516 titulos / 307
// alunos / R$ 1.315.328,05 invisiveis, e a Conferencia Prime parada desde 19/09
// porque a fila dela nasce do titulo e o trabalho nasce do dinheiro.
//
// Estes testes nao olham numero de linha nem ordem de passo: olham as tres
// coisas que, se alguem desfizer sem perceber, quebram producao de um jeito
// silencioso.
//   1. o GRANT tem de voltar depois do DROP -- sem ele a tela responde
//      "permission denied" para a propria gestao;
//   2. nunca um revoke de authenticated -- o portao e interno
//      (`usuario_e_gestao`), regra da casa desde 12/09/2026;
//   3. a tela nao pode oferecer um botao que o backend recusa: a lista de
//      efeitos vinculaveis do JSX tem de ser exatamente a que o SQL classifica
//      como vinculavel.

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");
const TELA = join(RAIZ, "src", "pages", "ConferenciaPagamentos.jsx");

const nome = readdirSync(MIGRACOES).find((n) =>
  n.endsWith("_confirmacao_pagamento_resolve_em_confirmacao.sql"));
const sql = nome ? readFileSync(join(MIGRACOES, nome), "utf8") : "";
// Comentario nao conta como codigo: proibir um padrao sem tirar os comentarios
// antes ja fez teste acusar a propria explicacao do que ele proibia.
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const tela = readFileSync(TELA, "utf8");

const EFEITOS_QUE_VINCULAM = ["VIRA_NEGOCIADO", "VIRA_PAGO"];
const EFEITOS_QUE_O_BANCO_RECUSA = ["ACORDO_SEM_DINHEIRO_REAL", "ACORDO_CANCELADO", "SEM_ACORDO_SUGERIDO"];

describe("Confirmacao de Pagamento resolve o titulo em confirmacao", () => {
  it("a migration existe e refaz a funcao da fila", () => {
    expect(nome, "migration nao encontrada").toBeTruthy();
    expect(codigo).toMatch(/drop function if exists\s+public\.conferencia_pagamentos/i);
  });

  it("devolve o EXECUTE a authenticated depois do drop", () => {
    const posDrop = codigo.search(/drop function if exists\s+public\.conferencia_pagamentos/i);
    const posGrant = codigo.search(
      /grant execute on function\s+public\.conferencia_pagamentos\s*\([^)]*\)\s*\n?\s*to[^;]*authenticated/i);
    expect(posGrant, "sem o grant a tela quebra para a gestao").toBeGreaterThan(-1);
    expect(posGrant).toBeGreaterThan(posDrop);
  });

  it("a funcao de detalhe tambem nasce com EXECUTE", () => {
    expect(codigo).toMatch(
      /grant execute on function\s+public\.conferencia_em_confirmacao_do_aluno\s*\(uuid\)\s*\n?\s*to[^;]*authenticated/i);
  });

  it("nunca revoga de authenticated: o portao e interno", () => {
    expect(codigo).not.toMatch(/revoke[\s\S]{0,160}authenticated/i);
    expect(codigo).toMatch(/usuario_e_gestao/);
  });

  it("a segunda porta do universo so abre no modo Em confirmacao", () => {
    // Sem esta amarra a fila diaria ganharia os 316 alunos sem pagamento no
    // periodo -- trocaria um problema por outro.
    expect(codigo).toMatch(/from\s+emconf\s+e\s*where\s+v_so_confirmacao/i);
  });

  it("o saldo zerado deixa de excluir quem tem titulo esperando decisao", () => {
    expect(codigo).toMatch(
      /saldo_total\s*,\s*0\s*\)\s*>\s*0\.005\s+or\s+coalesce\s*\(\s*ec\.valor\s*,\s*0\s*\)\s*>\s*0\.005/i);
  });

  it("a tela so oferece vinculo nos efeitos que o banco aceita", () => {
    const bruto = (tela.match(/const EFEITO_VINCULA = new Set\(\[([^\]]*)\]/) || [])[1] || "";
    const lista = bruto.split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean).sort();
    expect(lista).toEqual(EFEITOS_QUE_VINCULAM);
    for (const efeito of lista) expect(codigo).toContain(`'${efeito}'`);
    for (const recusado of EFEITOS_QUE_O_BANCO_RECUSA) {
      expect(lista, `${recusado} e recusado pelo backend`).not.toContain(recusado);
      expect(codigo, `${recusado} tem de ser classificado no SQL`).toContain(`'${recusado}'`);
    }
  });

  it("a decisao continua nas RPCs da Conferencia Prime, sem regra nova na tela", () => {
    for (const rpc of ["prime_conferencia_vincular", "prime_conferencia_seguir_pagamento",
                       "prime_conferencia_rejeitar", "conferencia_em_confirmacao_do_aluno"]) {
      expect(tela, `a tela precisa chamar ${rpc}`).toContain(rpc);
    }
    // a tela nunca escreve no titulo por fora das RPCs
    expect(tela).not.toMatch(/from\(\s*["']acordos_titulos["']\s*\)/);
    expect(tela).not.toMatch(/from\(\s*["']prime_conferencia_decisao["']\s*\)/);
  });

  it("o motivo escrito e exigido antes de ir ao banco", () => {
    expect(tela).toMatch(/pedirMotivo\(/);
    expect(tela).toMatch(/pedirMotivo\([\s\S]{0,400}?,\s*10\)/);
  });
});
