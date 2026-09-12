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

/**
 * Roda a catraca. Devolve { ok, saida } — nunca lança, para o teste inspecionar.
 * Sem argumento, simula o caso simples: base explícita no commit-base do teste.
 * Com `env`, simula os eventos do CI (pull_request, push) sobrescrevendo só o
 * que interessa — inclusive com string vazia, que é o caso do pull_request.
 */
function catraca(env = {}) {
  const ambiente = {
    ...process.env,
    CATRACA_BASE: baseSha,
    GITHUB_BASE_REF: "",
    ...env,
  };
  try {
    const saida = execFileSync("node", [SCRIPT], { cwd: repo, encoding: "utf8", env: ambiente });
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

  it("base inexistente falha fechado, não passa em silêncio", () => {
    escrever("README.md", "nada demais\n");
    commit("commit qualquer");
    const r = catraca({ CATRACA_BASE: "naoexiste1234567890" });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("não consegui resolver a base");
    expect(r.saida).toContain("informada em CATRACA_BASE");
  });

  it("SHA de zeros (push que criou o ref) falha fechado", () => {
    escrever("README.md", "nada demais\n");
    commit("commit qualquer");
    const r = catraca({ CATRACA_BASE: "0".repeat(40) });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("SHA de zeros");
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

// ---------------------------------------------------------------------------
// COMO A BASE É DESCOBERTA EM CADA EVENTO DO CI.
//
// Era aqui o furo: no evento `push` em main, depois do push `origin/main` já
// aponta para o próprio HEAD. A catraca concluía `baseSha === headSha` e saía
// sem olhar o commit que acabou de entrar. O workflow passou a informar
// `CATRACA_BASE=${{ github.event.before }}`, e em `pull_request` esse valor vem
// vazio — vazio não pode interceptar o fallback.
// ---------------------------------------------------------------------------
describe("catraca das migrations — resolução da base por evento", () => {
  it("pull_request: base é o branch de destino, e a alteração ruim é detectada", () => {
    // o CI de PR não define CATRACA_BASE; quem resolve é GITHUB_BASE_REF.
    // `origin/main` precisa existir como ref remota, como existe no checkout real.
    git(["update-ref", "refs/remotes/origin/main", baseSha]);
    git(["checkout", "-q", "-b", "feature"]);
    escrever("supabase/migrations/20260101120000_reaproveitando.sql", "select 1;\n");
    commit("migration ruim no branch da feature");

    const r = catraca({ CATRACA_BASE: "", GITHUB_BASE_REF: "main" });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("M5-VERSAO-JA-EXISTE");
    expect(r.saida).toContain("origin/main");
  });

  it("pull_request: CATRACA_BASE vazio NÃO intercepta o fallback", () => {
    git(["update-ref", "refs/remotes/origin/main", baseSha]);
    git(["checkout", "-q", "-b", "feature"]);
    escrever("supabase/migrations/20260301090000_valida.sql", "select 1;\n");
    commit("migration boa");

    // string vazia e string só com espaço têm de cair no fallback, não virar base
    for (const vazio of ["", "   "]) {
      const r = catraca({ CATRACA_BASE: vazio, GITHUB_BASE_REF: "main" });
      expect(r.ok).toBe(true);
      expect(r.saida).toContain("base origin/main");
      expect(r.saida).toContain("migrations novas: 1");
    }
  });

  it("push em main: migration ruim do commit que acabou de entrar é detectada", () => {
    // Simula o que o CI vê: HEAD é o commit novo em main, e `origin/main` JÁ
    // aponta para ele — a situação que antes fazia a catraca sair calada.
    escrever("supabase/migrations/20260101120000_reaproveitando.sql", "select 1;\n");
    const shaAnterior = baseSha;
    const shaNovo = commit("push direto em main com migration ruim");
    git(["update-ref", "refs/remotes/origin/main", shaNovo]);

    // sem CATRACA_BASE, o fallback acharia origin/main == HEAD e sairia em paz:
    const semBase = catraca({ CATRACA_BASE: "", GITHUB_BASE_REF: "" });
    expect(semBase.ok).toBe(true);
    expect(semBase.saida).toContain("é o próprio HEAD");

    // com github.event.before, o commit novo é de fato verificado:
    const comBase = catraca({ CATRACA_BASE: shaAnterior, GITHUB_BASE_REF: "" });
    expect(comBase.ok).toBe(false);
    expect(comBase.saida).toContain("M5-VERSAO-JA-EXISTE");
  });

  it("push em main sem mexer em migration nem ledger passa", () => {
    escrever("src/qualquer.js", "export const x = 1;\n");
    const shaAnterior = baseSha;
    const shaNovo = commit("push em main sem migration");
    git(["update-ref", "refs/remotes/origin/main", shaNovo]);

    const r = catraca({ CATRACA_BASE: shaAnterior, GITHUB_BASE_REF: "" });
    expect(r.ok).toBe(true);
    expect(r.saida).toContain("nada piorou");
    expect(r.saida).toContain("migrations novas: 0");
  });

  it("PR atualizado: violação de um commit ANTERIOR do mesmo PR continua sendo vista", () => {
    // Regressão de um defeito real (12/09/2026): o workflow passava
    // CATRACA_BASE=github.event.before sem condicionar ao evento. O payload de
    // `pull_request` com action `synchronize` também traz `before`, e ali ele é o
    // head ANTERIOR DO PR. Resultado: um PR atualizado passava a ser verificado
    // só a partir do último push, e a violação do primeiro commit sumia.
    //
    // A base de um PR é SEMPRE o branch de destino, em qualquer action.
    git(["update-ref", "refs/remotes/origin/main", baseSha]);
    git(["checkout", "-q", "-b", "feature"]);

    escrever("supabase/migrations/20260101120000_reaproveitando.sql", "select 1;\n");
    const commit1 = commit("commit 1 do PR: migration ruim");

    escrever("README.md", "segundo push, sem tocar em migration\n");
    commit("commit 2 do PR: nada de migration");

    // ERRADO (o que o defeito fazia): base = head anterior do PR -> passa,
    // porque o ÚLTIMO push não mexeu em migration.
    const comoEra = catraca({ CATRACA_BASE: commit1, GITHUB_BASE_REF: "main" });
    expect(comoEra.ok).toBe(true);

    // CERTO: em pull_request o CATRACA_BASE vem vazio e a base é o destino.
    const comoDeveSer = catraca({ CATRACA_BASE: "", GITHUB_BASE_REF: "main" });
    expect(comoDeveSer.ok).toBe(false);
    expect(comoDeveSer.saida).toContain("M5-VERSAO-JA-EXISTE");
    expect(comoDeveSer.saida).toContain("origin/main");
  });

  it("push em main que altera migration antiga é detectado", () => {
    escrever("supabase/migrations/20260101120000_primeira.sql", "select 1; -- mexi em main\n");
    const shaAnterior = baseSha;
    const shaNovo = commit("push em main editando migration antiga");
    git(["update-ref", "refs/remotes/origin/main", shaNovo]);

    const r = catraca({ CATRACA_BASE: shaAnterior, GITHUB_BASE_REF: "" });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain("I1-MIGRATION-ALTERADA");
  });
});
