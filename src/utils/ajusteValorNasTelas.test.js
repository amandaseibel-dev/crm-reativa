// GUARDA: nenhuma tela de SALDO OPERACIONAL volta a somar sem o ajuste.
//
// POR QUE ESTE TESTE EXISTE. Em 07/10/2026 a operação relatou "o valor foi
// atualizado mas não alterou o saldo". A causa não estava no banco: a migration
// 20260914100000 (`ajuste_de_valor_cobravel`) criou `valor_cobranca_ajustado` e
// TODO leitor de backend passou a coalescê-lo na frente
// (`coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, ...)`), inclusive a
// RPC `aluno_saldo_pendente_detalhe` que alimenta o card "Valor em aberto" da
// ficha. O que estava errado eram as telas que somam título a título NO
// CLIENTE: `Aluno.jsx`, `PainelCarteira.jsx`, `CRM.jsx` e `FilaOperacional.jsx`
// liam `valor_em_aberto/saldo_corrigido/valor_original` direto, sem o ajuste --
// e NENHUMA das quatro pedia a coluna no `select`, então o ajuste não chegava
// nem a ser transferido ao navegador.
//
// O comentário em `Aluno.jsx` já previa exatamente esta falha: "se divergir
// daqui, a ficha passa a contar diferente do resto do sistema sem ninguém
// perceber". Divergiu, e ninguém percebeu até a operação reclamar. Um comentário
// não é guarda; este teste é.
//
// ESTE TESTE NASCE JUNTO COM A CORREÇÃO, e não depois dela. Medido em 15/10/2026
// com `git log --all -S'utils/ajusteValor' -- <as quatro telas>`: ZERO commits.
// As quatro nunca aplicaram o ajuste em commit nenhum, em ref nenhum -- não foi
// regressão de merge. Uma versão anterior deste arquivo ficou meses como arquivo
// NÃO RASTREADO no checkout de trabalho, falhando só na máquina de quem o
// escreveu enquanto o CI nunca o viu, porque a correção que ele cobra nunca foi
// commitada. Guarda fora do git não é guarda.
//
// O QUE ELE COBRA, e nada além disso:
//   1. a tela pede `valor_cobranca_ajustado` em todo `select` de
//      `acordos_titulos` do qual ela soma saldo -- sem a coluna, qualquer
//      fórmula no cliente está cega;
//   2. a tela aplica o ajuste (`temAjusteValor`/`valorOperacionalTitulo`, de
//      `utils/ajusteValor`) em vez de reescrever a regra na mão.
//
// Ele NÃO verifica a ordem da regra-base de cada tela. Elas divergem entre si
// hoje (umas põem `valor_em_aberto` antes de `saldo_corrigido`, outras o
// contrário, e o backend põe `saldo_corrigido` na frente) e unificar isso muda
// número na tela -- é decisão da gestão, não de teste. Por isso a correção que
// acompanha este teste põe SÓ o ajuste na frente, com
// `if (temAjusteValor(t)) return Number(t.valor_cobranca_ajustado);`, e deixa a
// regra-base de cada tela exatamente como estava.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

// As telas que mostram SALDO OPERACIONAL do aluno/carteira somando título a
// título no cliente. Quem entrar nesta lista entra junto com a correção.
const TELAS_DE_SALDO = [
  "src/pages/Aluno.jsx",
  "src/components/PainelCarteira.jsx",
  "src/pages/CRM.jsx",
  "src/pages/FilaOperacional.jsx",
  "src/components/FinanceiroAluno.jsx",
];

// FORA desta guarda, de propósito -- cada uma por um motivo que não é descuido:
//
//   origemDoAcordo.js        valor HISTÓRICO do título (`valor_original` na
//                            frente, por desenho): serve para descobrir de onde
//                            o acordo veio, não para cobrar.
//   Borderos.jsx             escreve `saldo_corrigido` na importação do borderô;
//                            é a origem do valor, não leitor dele.
//   ConfirmarPagamento.jsx   valor usado para CONFIRMAR pagamento.
//   VincularMensalidadesAcordo.jsx  valor usado para MONTAR acordo.
//
// As duas últimas não são exibição: mudam o que é gravado. O backend já aplica
// o ajuste nesse caminho (`acordo_avista_previa`), então a divergência é real --
// mas alinhá-las muda valor de acordo e de baixa, e isso precisa de decisão da
// gestão, não de um teste. Mantidas fora e registradas, não silenciadas.
const FORA_DA_GUARDA = [
  "src/utils/origemDoAcordo.js",
  "src/pages/Borderos.jsx",
  "src/components/ConfirmarPagamento.jsx",
  "src/components/VincularMensalidadesAcordo.jsx",
];

// Lista de colunas de `acordos_titulos` que pede valor. Pega tanto o literal
// dentro de `.select()` quanto a string montada em constante -- e SÓ ela:
//
//   * o literal tem de ser uma lista de colunas de ponta a ponta (letras,
//     dígitos, `_`, vírgula e espaço). É isso que impede o casamento de
//     atravessar aspas e varrer bloco de código no meio do caminho;
//   * tem de pedir `saldo_corrigido`, que só existe em `acordos_titulos`. Sem
//     essa exigência o `select` de `casos` do `PainelCarteira` entraria aqui --
//     ele também tem `valor_em_aberto`, mas é a coluna PERSISTIDA do caso, que
//     `recalcular_situacao_aluno` escreve no banco. Ajuste nenhum se aplica a
//     ela no cliente.
const SELECTS_COM_VALOR = /"[a-z0-9_,\s]*\bsaldo_corrigido\b[a-z0-9_,\s]*"/g;

// UM `select` fica fora, nomeado por inteiro e com motivo -- e por exclusao de
// escopo, nao por descuido:
//
//   `FinanceiroAluno.jsx`, o `select` de `titulosSelecionaveis` -- as
//   mensalidades que a gestao MARCA para montar um acordo. O valor dele nao e
//   exibicao: alimenta `usarSomaTitulos()` -> `novo.valorTotal` e
//   `somaTitulosMarcados`, isto e, vira valor de acordo GRAVADO e honorario.
//   O `valorTitulo()` do arquivo JA aplica o ajuste; o que falta e a coluna
//   chegar. Pedir a coluna aqui muda o total do acordo que a gestao monta --
//   exatamente a razao pela qual `VincularMensalidadesAcordo.jsx` e
//   `ConfirmarPagamento.jsx` estao em FORA_DA_GUARDA. Mesma decisao, mesmo
//   dono: a gestao, nao um teste.
//
//   O `select` de EXIBICAO do mesmo arquivo (o que alimenta a soma da ficha em
//   `valorOperacionalTitulo`) continua DENTRO da guarda -- e so este um que sai.
//
// A lista guarda a string do `select` por inteiro, de proposito: se alguem
// mexer nesse `select`, a excecao deixa de casar, a guarda volta a morder e o
// caso tem de ser redecidido em vez de herdado.
const SELECTS_FORA_DA_GUARDA = [
  '"id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, status, situacao"',
];

describe("ajuste de valor cobrável — as telas de saldo não podem ignorá-lo", () => {
  it.each(TELAS_DE_SALDO)("%s aplica o ajuste pela fórmula compartilhada", (arq) => {
    const src = ler(arq);
    expect(src).toMatch(/from "\.\.?\/(?:\.\.\/)?utils\/ajusteValor"/);
    expect(src).toMatch(/temAjusteValor|valorOperacionalTitulo/);
  });

  it.each(TELAS_DE_SALDO)("%s pede valor_cobranca_ajustado em todo select de valor", (arq) => {
    const src = ler(arq);
    const selects = (src.match(SELECTS_COM_VALOR) || []).filter(
      (s) => !SELECTS_FORA_DA_GUARDA.includes(s)
    );
    // Se um dia a tela parar de montar o select por string, o teste precisa
    // falhar em vez de passar vazio: lista vazia aqui é sinal de que a guarda
    // deixou de olhar o que importa.
    expect(selects.length).toBeGreaterThan(0);
    const cegos = selects.filter((s) => !s.includes("valor_cobranca_ajustado"));
    expect(cegos).toEqual([]);
  });

  it("as exceções continuam sendo só as registradas, e continuam existindo", () => {
    // Se uma exceção for corrigida (passar a aplicar o ajuste), ela deve SAIR
    // desta lista e ENTRAR em TELAS_DE_SALDO -- o teste força essa arrumação em
    // vez de deixar a lista virar folclore.
    for (const arq of FORA_DA_GUARDA) {
      expect(() => ler(arq)).not.toThrow();
    }
    expect(FORA_DA_GUARDA).toEqual([
      "src/utils/origemDoAcordo.js",
      "src/pages/Borderos.jsx",
      "src/components/ConfirmarPagamento.jsx",
      "src/components/VincularMensalidadesAcordo.jsx",
    ]);
  });

  it("o select fora da guarda continua existindo onde foi registrado", () => {
    // Excecao que nao casa mais com o codigo e excecao morta: ela passaria a
    // esconder NADA e a guarda ficaria frouxa em silencio. Se este teste
    // quebrar, o `select` mudou -- redecidir, nao atualizar a string no escuro.
    const financeiro = ler("src/components/FinanceiroAluno.jsx");
    for (const sel of SELECTS_FORA_DA_GUARDA) {
      expect(financeiro).toContain(sel);
    }
    expect(SELECTS_FORA_DA_GUARDA).toHaveLength(1);
  });
});
