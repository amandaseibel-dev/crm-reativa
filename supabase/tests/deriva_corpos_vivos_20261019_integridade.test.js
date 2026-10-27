// INTEGRIDADE DO REGISTRO DOCUMENTAL DOS CORPOS VIVOS (19/10/2026).
//
// supabase/audits/acoes_massivas_deriva_corpos_vivos_producao_20261019.sql e
// supabase/audits/acoes_massivas_universo_corpo_vivo_producao_20261019.sql guardam
// o corpo que ESTA RODANDO em producao de funcoes cujo SQL nao e recuperavel do
// registro de migrations: as tres versoes de 15/10 gravaram descricao em
// portugues no campo `statements`, nao comando.
//
// Um registro assim so vale se for byte a byte. Este teste confere, a cada CI,
// que cada corpo transcrito ainda bate com o md5 e o tamanho medidos em
// producao, que os arquivos continuam marcados como NAO REAPLICAVEIS, e -- o
// mais importante -- que ninguem reintroduza a regressao de fuso no gatilho do
// acionamento.
//
// Os md5 abaixo foram lidos de producao em 19/10/2026 por
// `select md5(prosrc), length(prosrc) from pg_proc`. Estao repetidos aqui de
// proposito: se alguem editar o cabecalho de um arquivo de registro para
// esconder uma corrupcao, o teste ainda quebra.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

const REGISTRO = "supabase/audits/acoes_massivas_deriva_corpos_vivos_producao_20261019.sql";
const REGISTRO_UNIVERSO = "supabase/audits/acoes_massivas_universo_corpo_vivo_producao_20261019.sql";

const SQL = ler(REGISTRO);
const SQL_UNIVERSO = ler(REGISTRO_UNIVERSO);

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** prosrc = exatamente o texto entre os delimitadores $function$ do pg_get_functiondef. */
function corpoDe(texto, nome) {
  const i = texto.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (i < 0) throw new Error(`nao achei a definicao de ${nome}`);
  const abre = texto.indexOf("AS $function$", i);
  if (abre < 0) throw new Error(`nao achei 'AS $function$' de ${nome}`);
  const ini = abre + "AS $function$".length;
  const fim = texto.indexOf("$function$", ini);
  if (fim < 0) throw new Error(`nao achei o fechamento de ${nome}`);
  return texto.slice(ini, fim);
}

// medidos em producao em 19/10/2026
const TRANSCRITOS = [
  { nome: "fn_atualizar_ultimo_acionamento", md5: "e1bfc3930535104ec515f8c514e0b0d7", chars: 987, onde: REGISTRO },
  { nome: "acoes_massivas_fora_do_universo", md5: "c2c7514c42e9a1cb22271d0bd3b05c63", chars: 1075, onde: REGISTRO },
  { nome: "acoes_massivas_universo", md5: "f49209f6358dc9b0c22199c455d6d87d", chars: 13970, onde: REGISTRO_UNIVERSO },
];

// registrados por identidade, sem corpo transcrito (nao tem deriva)
const SO_IDENTIDADE = [
  { nome: "fn_sync_acionamento_alunos_para_casos", md5: "ea3034d6bfc5b7b0dcd58f9c257efa8e", chars: 456 },
  { nome: "registrar_acao_massiva", md5: "633a4ebe34819048da2e7b0247e53ac2", chars: 6774 },
];

// Estas duas escrevem na ficha pelo caminho da acao massiva. status_jornada e
// proibido ali: trg_tabulacao_efeito_financeiro e trg_tabulacao_redireciona so
// disparam quando ele muda. O universo fica fora da lista porque e LEITURA --
// ele le a.status_jornada de proposito.
const SEM_STATUS_JORNADA = ["fn_atualizar_ultimo_acionamento", "acoes_massivas_fora_do_universo"];

const texto = (onde) => (onde === REGISTRO_UNIVERSO ? SQL_UNIVERSO : SQL);

describe("registro documental dos corpos vivos de 19/10/2026", () => {
  it.each(TRANSCRITOS)("$nome: o corpo transcrito bate com producao por md5 e tamanho", ({ nome, md5: esperado, chars, onde }) => {
    const corpo = corpoDe(texto(onde), nome);
    expect(corpo.length).toBe(chars);
    expect(md5(corpo)).toBe(esperado);
  });

  it.each([REGISTRO, REGISTRO_UNIVERSO])("%s esta marcado como nao reaplicavel e aborta se executado inteiro", (arquivo) => {
    const t = ler(arquivo);
    expect(t).toMatch(/NAO REAPLICAR/);
    const guarda = t.indexOf("raise exception");
    const primeiroCreate = t.indexOf("CREATE OR REPLACE FUNCTION");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(primeiroCreate);
  });

  it.each([...TRANSCRITOS, ...SO_IDENTIDADE])("$nome: md5 e tamanho estao escritos no proprio registro", ({ nome, md5: esperado }) => {
    expect(SQL).toContain(`${nome}(`);
    expect(SQL).toContain(`md5=${esperado}`);
  });

  it("a definicao inteira do universo tambem esta conferida, nao so o corpo", () => {
    // o arquivo guarda a definicao completa: CREATE ... $function$ ... $function$
    const i = SQL_UNIVERSO.indexOf("CREATE OR REPLACE FUNCTION public.acoes_massivas_universo(");
    const defi = SQL_UNIVERSO.slice(i).replace(/;\n$/, "");
    expect(defi.length).toBe(14609);
    expect(md5(defi)).toBe("425a3961a1479ac91f0a6e00218bc66c");
    expect(defi.split("\n").length).toBe(276);
  });

  it("as duas linhas que 20261015124500 mudou estao no corpo vivo", () => {
    const corpo = corpoDe(SQL_UNIVERSO, "acoes_massivas_universo");
    expect(corpo).toContain("a.data_retorno, a.retorno_origem,");
    expect(corpo).toContain("upper(coalesce(k.retorno_origem, '')) like 'OPERADOR%'");
  });

  it.each(SEM_STATUS_JORNADA)("%s: o corpo transcrito nao encosta em status_jornada", (nome) => {
    const semComentario = corpoDe(SQL, nome).replace(/--[^\n]*/g, "");
    expect(semComentario).not.toContain("status_jornada");
  });

  it("o arquivo local responsaveis_por_lado esta registrado como NAO versionado, com a prova", () => {
    expect(SQL).toMatch(/NAO VERSIONADO/);
    expect(SQL).toContain("acoes_massivas_normalizar_responsaveis");
    expect(SQL).toContain("responsaveis_mensalidade");
    // e de fato nao esta versionado nesta arvore
    const migrations = readdirSync(resolve(RAIZ, "supabase/migrations"));
    expect(migrations.filter((f) => f.includes("responsaveis_por_lado"))).toEqual([]);
  });
});

// =============================================================================
// PROTECAO CONTRA A REGRESSAO DE FUSO (UTC x America/Sao_Paulo)
// =============================================================================
// casos.data_ultimo_acionamento governa fidelizacao de 10 dias, "nunca
// acionado" e cobertura. Producao grava o dia de America/Sao_Paulo; o arquivo
// 20261003083400 do repo grava new.registrado_em::date, em UTC. Perto da
// virada do dia os dois divergem, e reaplicar o arquivo antigo faria o campo
// regredir.
//
// A protecao possivel SEM tocar producao e esta: qualquer migration NOVA que
// redefina o gatilho tem de usar o fuso. O arquivo historico de 03/10 fica como
// esta -- ele e o registro do que foi aplicado naquele dia, e reescrever
// historico seria pior.
describe("protecao contra regressao de fuso no gatilho do acionamento", () => {
  const DEFINE = "function public.fn_atualizar_ultimo_acionamento";
  const CORTE = "20261015154500"; // versao que levou o gatilho para o fuso de Brasilia

  const arquivosQueDefinem = () => {
    const dir = resolve(RAIZ, "supabase/migrations");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(resolve(dir, f), "utf8").includes(DEFINE))
      .sort();
  };

  it("o estado correto esta registrado no repo, com o fuso", () => {
    const corpo = corpoDe(SQL, "fn_atualizar_ultimo_acionamento");
    expect(corpo).toContain("(new.registrado_em at time zone 'America/Sao_Paulo')::date");
    // as 2 ocorrencias que a versao 20261015154500 descreve: no SET e no WHERE
    const ocorrencias = corpo.split("at time zone 'America/Sao_Paulo'").length - 1;
    expect(ocorrencias).toBe(2);
  });

  it("nenhuma migration a partir de 20261015154500 redefine o gatilho em UTC", () => {
    const novas = arquivosQueDefinem().filter((f) => f.slice(0, 14) >= CORTE);
    for (const f of novas) {
      const t = readFileSync(resolve(RAIZ, "supabase/migrations", f), "utf8");
      const i = t.indexOf(DEFINE);
      const trecho = t.slice(i);
      expect(trecho, `${f} redefine o gatilho sem o fuso de Brasilia`).toContain("America/Sao_Paulo");
    }
  });

  it("o risco esta documentado onde quem for reaplicar vai ler", () => {
    expect(SQL).toMatch(/UNICO CASO EM QUE O ARQUIVO DO REPO E PIOR QUE PRODUCAO/);
    expect(SQL).toContain("20261003083400");
    expect(SQL).toContain("UTC");
    // e a lista de arquivos que definem o gatilho tem de incluir o de 03/10,
    // para ninguem achar que a regressao e teorica
    expect(arquivosQueDefinem().some((f) => f.startsWith("20261003083400"))).toBe(true);
  });
});
