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

  it("os boletos saem das parcelas ja carregadas; a unica consulta e a de nomes que faltam", () => {
    const bloco = SRC.slice(SRC.indexOf("<PainelMeuDia"), SRC.indexOf("<PainelMeuDia") + 800);
    expect(bloco).not.toMatch(/supabase\.(from|rpc)/);
    expect(SRC).toMatch(/const boletosDaJanela = boletosProximosDoVencimento\(parcelas, \{/);
    // A consulta de nomes so existe quando falta nome, e so pede nome.
    expect(SRC).toMatch(/if \(semNome\.length > 0\)/);
    expect(SRC).toMatch(/\.select\("id,nome,nome_aluno"\)/);
    // Nenhuma RPC nova foi criada para este bloco.
    expect(SRC).not.toMatch(/rpc\("(boletos_a_vencer|meu_dia_[a-z_]+)"/);
  });

  it("retorno e so o que o operador agendou; o automatico e contador", () => {
    expect(UTIL).toMatch(/startsWith\("OPERADOR"\)/);
    expect(SRC).toMatch(/retornosAgendados\(casos, hojeLocalBR\(\), JANELA_RETORNOS_DIAS, finAlunos\)/);
    expect(SRC).toMatch(/contarRetornoAutomaticoHoje\(kpis\.retornosHoje, retornosDoDia\(retornosDaSemana, hojeLocalBR\(\)\)\)/);
  });

  it("a visao semanal cabe na mesma carga: a semana sai dos mesmos casos da carteira", () => {
    expect(SRC).toMatch(/retornosAgendados\(casos,/);
    const bloco = SRC.slice(SRC.indexOf("<PainelMeuDia"), SRC.indexOf("<PainelMeuDia") + 800);
    expect(bloco).toMatch(/retornos=\{retornosDaSemana\}/);
    // O check manda o estado desejado: marca e desmarca pelo mesmo caminho.
    expect(bloco).toMatch(/onConfirmarRetorno=\{\(id, confirmar\) => confirmarRetornoAgenda\(id, confirmar\)\}/);
  });

  it("o alerta D-2 nao se repete: os cards so recebem o que ficou fora da janela", () => {
    // A garantia e a mesma de sempre -- o que o "Meu dia" ja mostra nao volta
    // nos cards. Desde 21/10/2026 a lista de fora da janela e PARTIDA em duas
    // (a vencer x vencida), porque a M2 trouxe ~144 vencidas por operador e um
    // card so deixava a tela longa demais. As duas derivam de alertasForaDaJanela,
    // entao a garantia continua valendo por construcao.
    expect(SRC).toMatch(/const alertasForaDaJanela = useMemo\(/);
    expect(SRC).toMatch(/naJanela\.has\(String\(a\.parcela_id\)\)/);

    const aVencer = SRC.slice(SRC.indexOf("const alertasAVencerFora"), SRC.indexOf("const alertasAVencerFora") + 220);
    const vencidos = SRC.slice(SRC.indexOf("const alertasVencidos"), SRC.indexOf("const alertasVencidos") + 220);
    expect(aVencer).toMatch(/alertasForaDaJanela\.filter/);
    expect(vencidos).toMatch(/alertasForaDaJanela\.filter/);

    // Particao por SINAL de dias_restantes: disjunta e exaustiva.
    expect(aVencer).toMatch(/Number\(a\.dias_restantes\) >= 0/);
    expect(vencidos).toMatch(/Number\(a\.dias_restantes\) < 0/);

    // Os dois cards sao alimentados pelas duas listas, e nenhum recebe a lista
    // inteira de novo.
    expect(SRC).toMatch(/alertas=\{alertasAVencerFora\}/);
    expect(SRC).toMatch(/alertas=\{alertasVencidos\}/);
    expect(SRC).not.toMatch(/alertas=\{alertasForaDaJanela\}/);

    // So o card das VENCIDAS abre compacto: o de "a vencer" e curto por
    // natureza e nao precisa de teto.
    const cardVencidas = SRC.slice(SRC.indexOf("alertas={alertasVencidos}"), SRC.indexOf("alertas={alertasVencidos}") + 300);
    expect(cardVencidas).toMatch(/limite=\{LIMITE_ALERTA_VENCIDO\}/);
    expect(SRC).toMatch(/const LIMITE_ALERTA_VENCIDO = \d+;/);
  });
});

// Correcao dos dois defeitos vistos na tela em 15/10/2026 (frente em producao).
describe("PainelCarteira: valor e nome do bloco Meu dia", () => {
  it("o retorno usa o consolidado da carteira, nao a coluna zerada do caso", () => {
    expect(SRC).toMatch(/retornosAgendados\(casos, hojeLocalBR\(\), JANELA_RETORNOS_DIAS, finAlunos\)/);
    // O memo precisa refazer quando o consolidado chega: ele vem depois da
    // primeira pintura, e sem a dependencia a linha ficaria em R$ 0,00.
    const memo = SRC.slice(SRC.indexOf("const retornosDaSemana = useMemo"), SRC.indexOf("const retornosDaSemana = useMemo") + 250);
    expect(memo).toMatch(/\[casos, finAlunos\]/);
  });

  it("busca o nome do aluno de acordo que nao esta na carteira, em lote e sem derrubar a tela", () => {
    const bloco = SRC.slice(SRC.indexOf("const boletosDaJanela ="), SRC.indexOf("setBoletosAVencer(boletosDaJanela)"));
    expect(bloco).toMatch(/filter\(\(b\) => !alunoInfo\.has\(String\(b\.aluno_id\)\)\)/);
    expect(bloco).toMatch(/\.in\("id", semNome\.slice\(i, i \+ 300\)\)/);
    expect(bloco).toMatch(/UUID_RE\.test\(id\)/); // id invalido derruba a consulta inteira
    expect(bloco).toMatch(/catch[\s\S]{0,200}console\.error/);
  });
});
