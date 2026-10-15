// Guardas da PRIORIDADE marcada pelo operador na tabulacao
// (`alunos.retorno_prioritario`, migration 20261015150000). Leitura do
// codigo-fonte, como os outros testes estruturais do PainelCarteira.
//
// O que protegem: a marca so nasce de compromisso do operador, cai quando o
// compromisso acaba (tratado, prazo automatico, tabulacao sem retorno) e chega
// a tela pelo select da carteira.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "PainelCarteira.jsx"), "utf8");

describe("PainelCarteira: prioridade do retorno", () => {
  it("pede a coluna no select da carteira (sem ela a marca nao chega na tela)", () => {
    expect(SRC).toMatch(/data_retorno,retorno_origem,hora_retorno,retorno_prioritario,retorno_confirmado_em/);
  });

  it("so grava prioridade em retorno DIGITADO pelo operador; prazo automatico nasce falso", () => {
    // Ha DOIS caminhos de gravacao de retorno: o modal (atualizacaoAluno) e a
    // tabulacao rapida da linha (camposAluno). Ancorar no primeiro `if
    // (desfecho.data_retorno)` pegaria o caminho errado -- por isso a ancora e
    // a variavel do modal.
    const inicio = SRC.indexOf("atualizacaoAluno.data_retorno = desfecho.data_retorno;");
    const bloco = SRC.slice(inicio, inicio + 1200);
    expect(bloco).toMatch(/atualizacaoAluno\.retorno_prioritario = desfecho\.motivo === "DIGITADA" \? Boolean\(retornoPrioritario\) : false;/);
    // Tabulou sem agendar: a marca cai.
    expect(bloco).toMatch(/\} else \{[\s\S]{0,200}atualizacaoAluno\.retorno_prioritario = false;/);
  });

  it("na tabulacao rapida, prazo automatico tambem derruba a marca", () => {
    const inicio = SRC.indexOf("camposAluno.data_retorno = desfecho.data_retorno;");
    const bloco = SRC.slice(inicio, inicio + 600);
    expect(bloco).toMatch(/camposAluno\.retorno_prioritario = false;/);
  });

  it("marcar o retorno como tratado tira a prioridade", () => {
    const bloco = SRC.slice(SRC.indexOf("async function confirmarRetornoAgenda"), SRC.indexOf("async function confirmarRetornoAgenda") + 1400);
    expect(bloco).toMatch(/update\(\{ retorno_prioritario: false \}\)/);
    expect(bloco).toMatch(/if \(confirmar\)/);
  });

  it("a caixa exige data: prioridade sem compromisso nao existe", () => {
    const bloco = SRC.slice(SRC.indexOf("caixaPrioridade} title"), SRC.indexOf("caixaPrioridade} title") + 700);
    expect(bloco).toMatch(/type="checkbox"/);
    expect(bloco).toMatch(/disabled=\{!retornoData\}/);
  });
});
