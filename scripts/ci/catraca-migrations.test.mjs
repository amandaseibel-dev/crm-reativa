// Testes da CATRACA DAS MIGRATIONS.
//
// Cada caso monta um repositório Git TEMPORÁRIO, com migrations de mentira,
// e roda o script de verdade contra ele. Nenhuma migration real do projeto é
// tocada — o que se testa é a regra, não o conteúdo do repo.
//
// O repositório-base de cada teste reproduz as três situações que existem hoje
// no projeto: migration normal, par de migrations com a MESMA versão (o legado
// que precisa ser tolerado) e SQL histórico no ledger.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "catraca-migrations.mjs");

let repo;
let baseSha;

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function escrever(caminho, conteudo) {
  const destino = join(repo, caminho);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo);
}
function commit(mensagem) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", mensagem]);
  return git(["rev-parse", "HEAD"]).trim();
}

/** Roda a catraca. Devolve { ok, saida } — nunca lança, para o teste inspecionar. */
function catraca() {
  try {
    const saida = execFileSync("node", [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CATRACA_BASE: baseSha, GITHUB_BASE_REF: "" },
    });
    return { ok: true, saida };
  } catch (e) {
    return { ok: false, saida: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "catraca-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "teste@local"]);
  git(["config", "user.name", "Teste"]);
  git(["config", "commit.gpgsign", "false"]);

  // legado: migration normal
  escrever("supabase/migrations/20260101120000_primeira.sql", "select 1;\n");
  // legado: DUAS migrations com a MESMA versão -- o que existe hoje 22 vezes
  escrever("supabase/migrations/20260102120000_uma_coisa.sql", "select 2;\n");
  escrever("supabase/migrations/20260102120000_outra_coisa.sql", "select 3;\n");
  // legado: rollback usa de propósito o MESMO timestamp da migration
  escrever("supabase/rollbacks/20260101120000_primeira_down.sql", "select 0;\n");
  // ledger histórico
  escrever("supabase/ledger/2026-01/20260103120000__ja_rodou.sql", "select 4;\n");
  escrever("supabase/ledger/2026-01/INDICE.tsv", "version\tnome\n20260103120000\tja_rodou\n");
  escrever("supabase/ledger/LEIA-ME.md", "# ledger\n");
  baseSha = commit("base legacy");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("catraca das migrations — o que PASSA", () => {
  it("estado legacy intocado passa (inclusive com as duplicadas antigas)", () => {
    escrever("README.md", "nada a ver com migrations\n");
    commit("mudanca sem migration");
    const r = catraca();
    expect(r.ok).toBe(true);
    expect(r.saida).toContain("nada piorou");
  });

  it("migration nova e válida passa", () => {
    escrever("supabase/migrations/20260301090000_adiciona_coluna.sql", "alter table x add column y int;\n");
    commit("migration nova");
    const r = catraca();
    expect(r.ok).toBe(true);
    expect(r.saida).toContain("migrations novas: 1");
  });

  it("ledger novo e válido passa", () => {
    escrever("supabase/ledger/2026-03/20260302090000__rodou_em_prod.sql", "select 9;\n");
    commit("ledger novo");
    const r = catraca();
    expect(r.ok).toBe(true);
    expect(r.saida).toContain("ledger novo: 1");
  });

  it("documentação e INDICE.tsv do ledger podem evoluir", () => {
    escrever("supabase/ledger/LEIA-ME.md", "# ledger\n\nregra nova documentada\n");
    escrever("supabase/ledger/2026-01/INDICE.tsv", "version\tnome\n20260103120000\tja_rodou\n20260302090000\toutra\n");
    escrever("supabase/ledger/2026-01/20260103120000__NOTA.md", "# nota\n");
    commit("documentacao do ledger");
    const r = catraca();
    expect(r.ok).toBe(true);
  });

  it("rollback com o MESMO timestamp da migration nova passa (auxiliares são isentos)", () => {
    escrever("supabase/migrations/20260301090000_adiciona_coluna.sql", "alter table x add column y int;\n");
    escrever("supabase/rollbacks/20260301090000_adiciona_coluna_down.sql", "alter table x drop column y;\n");
    commit("migration + rollback pareados");
    const r = catraca();
    expect(r.ok).toBe(true);
  });
});

describe("catraca das migrations — o que FALHA", () => {
  it("duas migrations novas com a mesma versão, no mesmo PR", () => {
    escrever("supabase/migrations/20260301090000_uma.sql", "select 1;\n");
    escrever("supabase/migrations/20260301090000_outra.sql", "select 2;\n");
    commit("duas com a mesma versao");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M6-VERSAO-REPETIDA-NO-PR");
    expect(r.saida).toContain("20260301090000");
  });

  it("reutilização de um timestamp que já existe na base", () => {
    escrever("supabase/migrations/20260101120000_reaproveitando.sql", "select 1;\n");
    commit("reusa timestamp existente");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M5-VERSAO-JA-EXISTE");
    expect(r.saida).toContain("PRIMARY KEY");
  });

  it("a 23ª duplicidade: terceiro arquivo numa versão já duplicada no legado", () => {
    escrever("supabase/migrations/20260102120000_terceira_coisa.sql", "select 99;\n");
    commit("terceiro arquivo na versao ja duplicada");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M5-VERSAO-JA-EXISTE");
    // a mensagem mostra os DOIS arquivos legacy que já ocupam a versão
    expect(r.saida).toContain("20260102120000_uma_coisa.sql");
    expect(r.saida).toContain("20260102120000_outra_coisa.sql");
  });

  it("edição de migration antiga", () => {
    escrever("supabase/migrations/20260101120000_primeira.sql", "select 1; -- mexi aqui\n");
    commit("editei migration antiga");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("I1-MIGRATION-ALTERADA");
  });

  it("deleção de migration antiga", () => {
    unlinkSync(join(repo, "supabase/migrations/20260101120000_primeira.sql"));
    commit("apaguei migration antiga");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("I2-MIGRATION-APAGADA");
  });

  it("rename de migration antiga", () => {
    renameSync(
      join(repo, "supabase/migrations/20260101120000_primeira.sql"),
      join(repo, "supabase/migrations/20260101120000_primeira_renomeada.sql"),
    );
    commit("renomeei migration antiga");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toMatch(/I3-MIGRATION-RENOMEADA|I2-MIGRATION-APAGADA/);
  });

  it("arquivo com `__` dentro de supabase/migrations/", () => {
    escrever("supabase/migrations/20260301090000__parece_ledger.sql", "select 1;\n");
    commit("arquivo de ledger na pasta de migrations");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M4-UNDERSCORE-DUPLO");
  });

  it("SQL histórico do ledger copiado para migrations/ é apontado como tal", () => {
    escrever("supabase/migrations/20260103120000__ja_rodou.sql", "select 4;\n");
    commit("copiei ledger para migrations");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M4-UNDERSCORE-DUPLO");
    expect(r.saida).toContain("já existe no ledger");
  });

  it("alteração de SQL histórico do ledger", () => {
    escrever("supabase/ledger/2026-01/20260103120000__ja_rodou.sql", "select 4; -- mexi\n");
    commit("mexi no ledger");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("I4-LEDGER-SQL-ALTERADO");
    expect(r.saida).toContain("md5");
  });

  it("deleção de SQL histórico do ledger", () => {
    unlinkSync(join(repo, "supabase/ledger/2026-01/20260103120000__ja_rodou.sql"));
    commit("apaguei ledger");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("I5-LEDGER-SQL-APAGADO");
  });

  it("versão com menos de 14 dígitos", () => {
    escrever("supabase/migrations/2026030109000_curta.sql", "select 1;\n");
    commit("timestamp curto");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M2-VERSAO-14-DIGITOS");
    expect(r.saida).toContain("13 dígitos");
  });

  it("migration sem descrição depois do timestamp", () => {
    escrever("supabase/migrations/20260301090000.sql", "select 1;\n");
    commit("sem descricao");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M3-SEM-DESCRICAO");
  });

  it("nome completamente fora do padrão", () => {
    escrever("supabase/migrations/ajuste_rapido.sql", "select 1;\n");
    commit("nome sem timestamp");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M1-NOME-FORA-DO-PADRAO");
  });

  it("SQL novo com timestamp de 14 dígitos fora dos diretórios previstos", () => {
    escrever("banco/20260301090000_solta_por_ai.sql", "select 1;\n");
    commit("sql fora de lugar");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M7-FORA-DE-MIGRATIONS");
  });

  it("ledger novo fora da convenção de dois underscores", () => {
    escrever("supabase/ledger/2026-03/20260302090000_um_underscore.sql", "select 1;\n");
    commit("ledger com um underscore");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("L1-NOME-FORA-DO-PADRAO");
  });

  it("a mensagem de erro diz arquivo, versão, regra e como corrigir", () => {
    escrever("supabase/migrations/20260101120000_reaproveitando.sql", "select 1;\n");
    commit("reusa timestamp");
    const r = catraca();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("arquivo :");
    expect(r.saida).toContain("versão  :");
    expect(r.saida).toContain("motivo  :");
    expect(r.saida).toContain("corrigir:");
  });
});
