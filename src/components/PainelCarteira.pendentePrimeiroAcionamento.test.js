// Ligacao do "Pendente de 1o acionamento" na Minha Carteira. Leitura do
// codigo-fonte, como os outros testes estruturais do PainelCarteira (a tela
// inteira nao renderiza em teste). A regra esta em
// src/utils/primeiroAcionamento.test.js.
//
// O que estas guardas protegem:
//   - o indicador le a carteira ATUAL e so ela;
//   - as duas consultas sao paginadas (o teto de 1.000 linhas do PostgREST ja
//     truncava a consulta antiga em silencio) e restritas aos responsaveis;
//   - o indicador e o filtro existentes foram REAPROVEITADOS, sem card novo;
//   - fila inteligente, prioridades, fidelizacao e distribuicao nao sao tocadas.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(AQUI, "PainelCarteira.jsx"), "utf8");
const BLOCO = SRC.slice(
  SRC.indexOf("// PENDENTE DE 1o ACIONAMENTO"),
  SRC.indexOf("const diasUteis = diasUteisTranscorridos(hoje);")
);

describe("PainelCarteira: pendente de 1o acionamento", () => {
  it("o bloco do indicador existe e usa a regra do util", () => {
    expect(BLOCO.length).toBeGreaterThan(0);
    expect(BLOCO).toMatch(/idsPendentesPrimeiroAcionamento\(\{/);
    expect(SRC).toMatch(/import \{ idsPendentesPrimeiroAcionamento, agruparPorAluno \} from "\.\.\/utils\/primeiroAcionamento"/);
  });

  it("le a carteira ATUAL (listaAtiva) -- nao a base nem outra fila", () => {
    expect(BLOCO).toMatch(/casos: listaAtiva,/);
    expect(BLOCO).toMatch(/const idsCarteira = listaAtiva\.map/);
  });

  // As DUAS consultas viraram UMA (ver PainelCarteira.consolidacao.test.jsx,
  // que compara linha a linha a saida nova contra o filtro das duas antigas).
  // As garantias abaixo sao as mesmas de antes -- mudou so como se escrevem.
  it("a consulta e paginada e restrita aos responsaveis da carteira", () => {
    // Sem paginar, `.in()` devolve no maximo 1.000 linhas e responde 206: com
    // ~7 movimentacoes por aluno o lote de 200 estoura e o aluno volta sem as
    // tabulacoes dele, aparecendo como pendente sem ser.
    expect(BLOCO.match(/buscarTudo\(\(de, ate\) =>/g)).toHaveLength(1);
    expect(BLOCO.match(/\.range\(de, ate\)/g)).toHaveLength(1);
    // Restricao aos responsaveis: o filtro e montado a partir deles, e a
    // consulta so sai quando ha responsavel na carteira.
    expect(BLOCO).toMatch(/filtroMovimentacoesCarteira\(emailsResponsaveis, TIPOS_ACIONAMENTO\)/);
    expect(BLOCO).toMatch(/\.or\(filtroOu\)/);
    expect(BLOCO).toMatch(/if \(emailsResponsaveis\.length\)/);
  });

  it("a consulta traz autor, tipo e data (sem elas nao da para separar o dono atual)", () => {
    expect(BLOCO).toMatch(/"aluno_id,tipo,registrado_por_email,operador_novo_email,operador_anterior_email,registrado_em"/);
  });

  it("a consulta traz os dois lados da troca, e a reparticao devolve os dois conjuntos", () => {
    // operador_novo + operador_anterior: e o par que prova a troca de mao.
    expect(BLOCO).toMatch(/operador_novo_email,operador_anterior_email/);
    expect(BLOCO).toMatch(/separarMovimentacoesCarteira\(linhas, emailsResponsaveis, TIPOS_ACIONAMENTO\)/);
    expect(BLOCO).toMatch(/tabulacoes: tabLote, transferencias: transfLote/);
  });

  it("o filtro cobre os DOIS predicados -- nenhum dos dois lados some", () => {
    const i = SRC.indexOf("export function filtroMovimentacoesCarteira");
    const fn = SRC.slice(i, i + 600);
    expect(i).toBeGreaterThan(-1);
    expect(fn).toMatch(/tipo\.in\./);
    expect(fn).toMatch(/registrado_por_email\.in\./);
    expect(fn).toMatch(/operador_novo_email\.in\./);
  });

  it("o indicador e o filtro existentes foram reaproveitados: nenhum card novo", () => {
    // Mesmo id de KPI de sempre; so o rotulo mudou.
    expect(SRC).toMatch(/onKpiClick\("semPrimeiroAcionamento"\)/);
    expect(SRC).toMatch(/<span style=\{S\.desRot\}>Pendente de 1º acionamento<\/span>/);
    expect(SRC).not.toMatch(/Sem 1o acionamento/);
    expect(SRC.match(/kpi === "semPrimeiroAcionamento"/g)).toHaveLength(1);
  });

  it("abrir o card filtra a carteira carregada -- nunca traz caso de fora dela", () => {
    const i = SRC.indexOf('kpi === "semPrimeiroAcionamento"');
    const ramo = SRC.slice(i, i + 500);
    expect(ramo).toMatch(/const idset = new Set\(semPrimeiroIds\);/);
    expect(ramo).toMatch(/dados = casos\.filter\(\(a\) => idset\.has\(String\(a\.id\)\)\);/);
  });

  it("o indicador nao mexe em fila, prioridade, fidelizacao nem distribuicao", () => {
    expect(BLOCO).not.toMatch(/setCasos\(|setOrdenacao|setFiltroPrioridade|setFiltroStatus|responsavel_atual_email:|\.update\(|\.rpc\(/);
  });
});
