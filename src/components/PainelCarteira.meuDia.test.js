// Garantias do bloco "Meu dia" dentro do PainelCarteira (leitura do
// codigo-fonte; o componente e grande demais para montar em teste -- mesmo
// motivo de PainelCarteira.alertaD2.test.js).
//
// O que estas checagens protegem, decidido com a gestao em 15/10/2026:
//  1. o bloco aparece na tela inicial do operador, nao atras de um clique;
//  2. ele nao abre consulta nova ao banco -- sai das parcelas que a carteira ja
//     carrega (foi assim que ele passou a existir sem custo de carregamento);
//  3. o retorno listado e so o que o OPERADOR agendou (o prazo automatico da
//     tabulacao vira contador), que e o recorte que torna a lista utilizavel;
//  4. o alerta D-2 nao aparece duas vezes na mesma tela.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(AQUI, "PainelCarteira.jsx"), "utf8");
const UTIL = readFileSync(resolve(AQUI, "../utils/painelMeuDia.js"), "utf8");

describe("PainelCarteira: bloco Meu dia", () => {
  it("renderiza o bloco com os retornos do dia e os boletos a vencer", () => {
    expect(SRC).toMatch(/<PainelMeuDia/);
    const bloco = SRC.slice(SRC.indexOf("<PainelMeuDia"), SRC.indexOf("<PainelMeuDia") + 800);
    expect(bloco).toMatch(/retornos=\{retornosDaSemana\}/);
    expect(bloco).toMatch(/boletos=\{boletosDoDia\}/);
    expect(bloco).toMatch(/retornoAutomaticoHoje=\{retornoAutomaticoHoje\}/);
  });

  it("o bloco nao faz consulta propria: os boletos saem das parcelas ja carregadas", () => {
    const bloco = SRC.slice(SRC.indexOf("<PainelMeuDia"), SRC.indexOf("<PainelMeuDia") + 800);
    expect(bloco).not.toMatch(/supabase\.(from|rpc)/);
    expect(SRC).toMatch(/setBoletosAVencer\(\s*boletosProximosDoVencimento\(parcelas, \{/);
    // Nenhuma RPC nova foi criada para este bloco.
    expect(SRC).not.toMatch(/rpc\("(boletos_a_vencer|meu_dia_[a-z_]+)"/);
  });

  it("retorno e so o que o operador agendou; o automatico e contador", () => {
    expect(UTIL).toMatch(/startsWith\("OPERADOR"\)/);
    expect(SRC).toMatch(/retornosAgendados\(casos, hojeLocalBR\(\), JANELA_RETORNOS_DIAS\)/);
    expect(SRC).toMatch(/contarRetornoAutomaticoHoje\(kpis\.retornosHoje, retornosDoDia\(retornosDaSemana, hojeLocalBR\(\)\)\)/);
  });

  it("a visao semanal cabe na mesma carga: a semana sai dos mesmos casos da carteira", () => {
    expect(SRC).toMatch(/retornosAgendados\(casos,/);
    const bloco = SRC.slice(SRC.indexOf("<PainelMeuDia"), SRC.indexOf("<PainelMeuDia") + 800);
    expect(bloco).toMatch(/retornos=\{retornosDaSemana\}/);
    // O check manda o estado desejado: marca e desmarca pelo mesmo caminho.
    expect(bloco).toMatch(/onConfirmarRetorno=\{\(id, confirmar\) => confirmarRetornoAgenda\(id, confirmar\)\}/);
  });

  it("o alerta D-2 nao se repete: o painel antigo so recebe o que ficou fora da janela", () => {
    const card = SRC.slice(SRC.indexOf("<AlertasParcelaAcordo"), SRC.indexOf("<AlertasParcelaAcordo") + 400);
    expect(card).toMatch(/alertas=\{alertasForaDaJanela\}/);
    expect(SRC).toMatch(/const alertasForaDaJanela = useMemo\(/);
  });
});
