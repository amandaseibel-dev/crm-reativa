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

  it("as duas consultas sao paginadas e restritas aos responsaveis da carteira", () => {
    // Sem paginar, `.in()` devolve no maximo 1.000 linhas e responde 206: com
    // ~7 tabulacoes por aluno o lote de 200 estourava e o aluno voltava sem as
    // tabulacoes dele, aparecendo como pendente sem ser.
    expect(BLOCO.match(/buscarTudo\(\(de, ate\) =>/g)).toHaveLength(2);
    expect(BLOCO.match(/\.range\(de, ate\)/g)).toHaveLength(2);
    expect(BLOCO).toMatch(/\.in\("registrado_por_email", emailsResponsaveis\)/);
    expect(BLOCO).toMatch(/\.in\("operador_novo_email", emailsResponsaveis\)/);
  });

  it("a consulta de tabulacao traz autor e data (sem elas nao da para separar o dono atual)", () => {
    expect(BLOCO).toMatch(/\.select\("aluno_id,registrado_por_email,registrado_em"\)/);
    expect(BLOCO).toMatch(/\.in\("tipo", TIPOS_ACIONAMENTO\)/);
  });

  it("a consulta de atribuicao traz os dois lados da troca", () => {
    expect(BLOCO).toMatch(/\.select\("aluno_id,operador_novo_email,operador_anterior_email,registrado_em"\)/);
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
