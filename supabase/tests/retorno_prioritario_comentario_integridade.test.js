// COMENTARIO DA COLUNA retorno_prioritario: integridade da migration que falta aplicar.
//
// A coluna public.alunos.retorno_prioritario entrou em producao em 15/10/2026 por fora do
// canal de migrations. O arquivo 20261015150000_retorno_prioritario.sql tem DUAS
// instrucoes -- `alter table` e `comment on column` -- e, medido em 19/10/2026, so a
// primeira esta refletida: col_description da coluna em producao era null.
//
// Como a gestao escolheu REPARAR O REGISTRO daquela versao (preservando o numero
// 20261015150000, sem executar DDL), aquele arquivo fica FECHADO: um `supabase db push`
// futuro nunca mais o executa. O comentario so chega por
// 20261019160000_retorno_prioritario_comentario_da_coluna.sql.
//
// O que este teste protege:
//   1. o texto do comentario e o MESMO do arquivo de 15/10, byte a byte -- o repo nao
//      pode passar a ter duas versoes do mesmo texto divergindo em silencio;
//   2. a migration nova NAO faz mais nada alem do comentario -- nenhum alter, update,
//      delete, drop, create, grant, indice, funcao, gatilho ou policy;
//   3. o rollback apaga o comentario (o estado anterior real era null) e nada mais.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

const ORIGINAL = "supabase/migrations/20261015150000_retorno_prioritario.sql";
const NOVA = "supabase/migrations/20261019160000_retorno_prioritario_comentario_da_coluna.sql";
const RB = "supabase/rollbacks/20261019160000_retorno_prioritario_comentario_da_coluna.rollback.sql";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** O bloco `comment on column ... is '...';` como esta no arquivo, sem normalizar nada. */
function blocoComentario(texto) {
  const i = texto.indexOf("comment on column public.alunos.retorno_prioritario");
  if (i < 0) throw new Error("nao achei o comment on column");
  const fim = texto.indexOf("';", i);
  if (fim < 0) throw new Error("nao achei o fim do literal");
  return texto.slice(i, fim + 2);
}

/** Linhas de codigo: sem comentario `--` e sem linhas vazias. */
const codigo = (texto) =>
  texto
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--") && l.trim() !== "")
    .join("\n");

describe("comentario da coluna retorno_prioritario", () => {
  it("o texto e byte a byte o do arquivo de 15/10", () => {
    const original = blocoComentario(ler(ORIGINAL));
    const nova = blocoComentario(ler(NOVA));
    expect(nova).toBe(original);
    expect(md5(nova)).toBe("3092f78547ba2c21be2259ca072a230d");
    expect(nova.length).toBe(296);
  });

  it("a migration nova NAO faz nada alem do comentario", () => {
    const c = codigo(ler(NOVA));
    // uma unica instrucao, e e o comentario
    expect(c.startsWith("comment on column public.alunos.retorno_prioritario")).toBe(true);
    expect((c.match(/;/g) || []).length).toBe(1);
    for (const proibido of [
      "alter table", "update ", "delete ", "drop ", "truncate",
      "create ", "grant ", "revoke ", "insert into", "do $",
    ]) {
      expect(c.toLowerCase(), `a migration nao pode conter "${proibido}"`).not.toContain(proibido);
    }
  });

  it("o rollback apaga o comentario e nada mais", () => {
    const c = codigo(ler(RB));
    expect(c.trim()).toBe("comment on column public.alunos.retorno_prioritario is null;");
  });

  it("o arquivo de 15/10 continua intocado nas suas DUAS instrucoes", () => {
    // a regularizacao nao pode reescrever migration historica
    const c = codigo(ler(ORIGINAL));
    expect(c).toContain("add column if not exists retorno_prioritario boolean not null default false");
    expect(c).toContain("comment on column public.alunos.retorno_prioritario");
    expect((c.match(/;/g) || []).length).toBe(2);
  });

  it("os nomes seguem o padrao de migration e de rollback", () => {
    expect(NOVA).toMatch(/supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/);
    expect(RB).toMatch(/supabase\/rollbacks\/\d{14}_[a-z0-9_]+\.rollback\.sql$/);
    // mesmo numero de versao nos dois
    const v = (p) => p.match(/(\d{14})/)[1];
    expect(v(RB)).toBe(v(NOVA));
  });
});
