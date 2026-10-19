// INTEGRIDADE DO REGISTRO DOCUMENTAL DOS CORPOS VIVOS (19/10/2026).
//
// supabase/audits/acoes_massivas_deriva_corpos_vivos_producao_20261019.sql guarda
// o corpo que ESTA RODANDO em producao de funcoes cujo SQL nao e recuperavel do
// registro de migrations (as tres versoes de 15/10 gravaram descricao em
// portugues no campo `statements`, nao comando).
//
// Um registro assim so vale se for byte a byte. Este teste confere, a cada CI,
// que cada corpo transcrito ainda bate com o md5 e o tamanho medidos em
// producao -- e que o arquivo continua marcado como NAO REAPLICAVEL.
//
// Os md5 abaixo foram lidos de producao em 19/10/2026 por
// `select md5(prosrc), length(prosrc) from pg_proc`. Estao repetidos aqui de
// proposito: se alguem editar o cabecalho do arquivo de registro para esconder
// uma corrupcao, o teste ainda quebra.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ARQUIVO = "supabase/audits/acoes_massivas_deriva_corpos_vivos_producao_20261019.sql";
const SQL = readFileSync(resolve(RAIZ, ARQUIVO), "utf8");

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** prosrc = exatamente o texto entre os delimitadores $function$ do pg_get_functiondef. */
function corpoDe(nome) {
  const i = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (i < 0) throw new Error(`nao achei a definicao de ${nome} em ${ARQUIVO}`);
  const abre = SQL.indexOf("AS $function$", i);
  if (abre < 0) throw new Error(`nao achei 'AS $function$' de ${nome}`);
  const ini = abre + "AS $function$".length;
  const fim = SQL.indexOf("$function$", ini);
  if (fim < 0) throw new Error(`nao achei o fechamento de ${nome}`);
  return SQL.slice(ini, fim);
}

// medidos em producao em 19/10/2026
const TRANSCRITOS = [
  { nome: "fn_atualizar_ultimo_acionamento", md5: "e1bfc3930535104ec515f8c514e0b0d7", chars: 987 },
  { nome: "acoes_massivas_fora_do_universo", md5: "c2c7514c42e9a1cb22271d0bd3b05c63", chars: 1075 },
];

// registrados por identidade, sem corpo transcrito
const SO_IDENTIDADE = [
  { nome: "acoes_massivas_universo", md5: "f49209f6358dc9b0c22199c455d6d87d", chars: 13970 },
  { nome: "fn_sync_acionamento_alunos_para_casos", md5: "ea3034d6bfc5b7b0dcd58f9c257efa8e", chars: 456 },
  { nome: "registrar_acao_massiva", md5: "633a4ebe34819048da2e7b0247e53ac2", chars: 6774 },
];

describe("registro documental dos corpos vivos de 19/10/2026", () => {
  it.each(TRANSCRITOS)("$nome: o corpo transcrito bate com producao por md5 e tamanho", ({ nome, md5: esperado, chars }) => {
    const corpo = corpoDe(nome);
    expect(corpo.length).toBe(chars);
    expect(md5(corpo)).toBe(esperado);
  });

  it("o arquivo esta marcado como NAO REAPLICAR e aborta se for executado inteiro", () => {
    expect(SQL).toMatch(/NAO REAPLICAR/);
    // a guarda vem ANTES de qualquer CREATE: executar o arquivo de uma vez aborta
    const guarda = SQL.indexOf("raise exception");
    const primeiroCreate = SQL.indexOf("CREATE OR REPLACE FUNCTION");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(primeiroCreate);
  });

  it.each([...TRANSCRITOS, ...SO_IDENTIDADE])("$nome: md5 e tamanho estao escritos no proprio registro", ({ nome, md5: esperado, chars }) => {
    expect(SQL).toContain(`${nome}(`);
    expect(SQL).toContain(`md5=${esperado}`);
    // o tamanho aparece com separador de milhar ou cru, dependendo da secao
    const cru = String(chars);
    const comPonto = chars.toLocaleString("pt-BR");
    expect(SQL.includes(`chars=${cru}`) || SQL.includes(cru) || SQL.includes(comPonto)).toBe(true);
  });

  it("o universo e declarado como NAO transcrito, com a lacuna medida", () => {
    expect(SQL).toMatch(/CORPO NAO TRANSCRITO AQUI, DE PROPOSITO/);
    // a cadeia medida e a sobra tem de estar registradas, nao presumidas
    expect(SQL).toContain("3c1fa046");
    expect(SQL).toContain("75e2517e");
    expect(SQL).toContain("eb60bb84");
    expect(SQL).toMatch(/41 caracteres e 5 linhas/);
  });

  it("as duas linhas que 20261015124500 mudou estao registradas", () => {
    expect(SQL).toContain("a.data_retorno, a.retorno_origem,");
    expect(SQL).toContain("upper(coalesce(k.retorno_origem, '')) like 'OPERADOR%'");
  });

  it("nenhum corpo transcrito encosta em status_jornada", () => {
    for (const { nome } of TRANSCRITOS) {
      const semComentario = corpoDe(nome).replace(/--[^\n]*/g, "");
      expect(semComentario).not.toContain("status_jornada");
    }
  });
});
