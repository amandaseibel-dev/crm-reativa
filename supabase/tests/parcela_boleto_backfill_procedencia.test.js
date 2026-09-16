// BACKFILL DO BOLETO POR PROCEDENCIA -- ESTRUTURA (o texto da migration).
//
// O arquivo irmao executa a migration num Postgres real. Este prova, no texto,
// o que o comportamento sozinho nao enxerga: so UM trigger suprimido, pelo nome;
// lock antes da validacao; UPDATE de uma coluna so; valores aprovados pinados; e
// seguranca provada por ESTADO EXPLICITO, sem inferencia de XID.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(AQUI, "..", "..",
  "supabase/migrations/20260916120000_backfill_boleto_parcela_por_procedencia.sql");
const fonte = readFileSync(MIG, "utf8").replace(/\r/g, "");
const codigo = fonte.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const pos = (s) => codigo.indexOf(s);
const DISABLE = "alter table public.parcelas disable trigger trg_recalc_parcela;";
const ENABLE = "alter table public.parcelas enable trigger trg_recalc_parcela;";

describe("1. valores aprovados pinados", () => {
  const constante = (nome) => (codigo.match(new RegExp(`${nome}\\s+constant\\s+\\w+\\s+:=\\s+([^;]+);`)) ?? [])[1];
  it("SHA256 canonico", () => {
    expect(constante("c_hash_aprovado")).toBe("'53d4b1a0169952ca51c979e10f36fa66a31bd33ac1bce7ad5c97ff68dd08cc73'");
  });
  it("748 parcelas, 301 acordos, 256 alunos, 2644 nulos e 12461 preenchidos", () => {
    expect(constante("c_qtd")).toBe("748");
    expect(constante("c_acordos")).toBe("301");
    expect(constante("c_alunos")).toBe("256");
    expect(constante("c_nulos_antes")).toBe("2644");
    expect(constante("c_preenchidos_antes")).toBe("12461");
  });
  it("trigger, definicao exata e md5 do corpo da funcao", () => {
    expect(constante("c_trigger")).toBe("'trg_recalc_parcela'");
    expect(constante("c_trigger_def")).toBe(
      "'CREATE TRIGGER trg_recalc_parcela AFTER INSERT OR DELETE OR UPDATE ON public.parcelas FOR EACH ROW EXECUTE FUNCTION _trg_recalc_por_parcela()'");
    expect(constante("c_funcao_md5")).toBe("'8632b2fcc49b7899fd48dc3801f6a309'");
  });
});

describe("2. seguranca por estado explicito, sem inferencia de XID", () => {
  it("nenhum mecanismo de XID no SQL de producao", () => {
    for (const t of ["pg_xact_status", "xid8", "xmin", "pg_current_xact_id", "pg_snapshot_xmax", "pg_current_snapshot"]) {
      expect(codigo, t).not.toContain(t);
    }
  });
  it("hash PRE e POS de alunos e casos dos alunos do lote", () => {
    for (const v of ["v_alunos_pre", "v_alunos_pos", "v_casos_pre", "v_casos_pos"]) expect(codigo).toContain(v);
    expect(codigo).toContain("if v_alunos_pos is distinct from v_alunos_pre then");
    expect(codigo).toContain("if v_casos_pos is distinct from v_casos_pre then");
  });
  it("hashes PRE sao capturados antes do DISABLE e conferidos depois do ENABLE", () => {
    expect(pos("into v_alunos_pre")).toBeLessThan(pos(DISABLE));
    expect(pos("into v_casos_pre")).toBeLessThan(pos(DISABLE));
    expect(pos("into v_alunos_pos")).toBeGreaterThan(pos(ENABLE));
    expect(pos("into v_casos_pos")).toBeGreaterThan(pos(ENABLE));
  });
  it("demais linhas pertinentes tambem tem PRE e POS", () => {
    for (const b of ["acordos", "titulos", "pagamentos", "trilha", "quarentena", "parcelas_sem_boleto", "boleto_fora"]) {
      expect(codigo).toContain(`into v_${b}_pre`);
      expect(codigo).toContain(`v_${b}_pos is distinct from v_${b}_pre`);
    }
  });
});

describe("3. supressao de UM trigger so, com estado conferido", () => {
  it("exatamente um DISABLE e um ENABLE, literais, pelo nome", () => {
    expect(codigo.match(/disable trigger/gi)).toHaveLength(1);
    expect(codigo.match(/enable trigger/gi)).toHaveLength(1);
    expect(codigo).toContain(DISABLE);
    expect(codigo).toContain(ENABLE);
  });
  it("nunca DISABLE TRIGGER ALL/USER nem session_replication_role", () => {
    expect(codigo).not.toMatch(/disable trigger (all|user)/i);
    expect(codigo).not.toMatch(/session_replication_role/i);
  });
  it("depois do DISABLE: confere D e confere que os outros nao mudaram, ANTES do UPDATE", () => {
    const entre = codigo.slice(pos(DISABLE), pos("update public.parcelas p"));
    expect(entre).toContain("v_estado is distinct from 'D'");
    expect(entre).toContain("v_outros_desligado is distinct from v_outros_antes");
  });
  it("depois do ENABLE: confere O, definicao, md5 da funcao e o conjunto inteiro", () => {
    const depois = codigo.slice(pos(ENABLE));
    expect(depois).toContain("v_estado is distinct from 'O'");
    expect(depois).toContain("v_def is distinct from c_trigger_def");
    expect(depois).toContain("v_md5 is distinct from c_funcao_md5");
    expect(depois).toContain("v_trg_depois is distinct from v_trg_antes");
  });
  it("disable antes do UPDATE, enable depois", () => {
    expect(pos(DISABLE)).toBeLessThan(pos("update public.parcelas p"));
    expect(pos(ENABLE)).toBeGreaterThan(pos("update public.parcelas p"));
  });
});

describe("4. lock e ordem", () => {
  it("SET LOCAL lock_timeout curto e a primeira acao", () => {
    expect(codigo).toContain("set local lock_timeout = '3s';");
    expect(pos("set local lock_timeout")).toBeLessThan(pos("lock table"));
  });
  it("ACCESS EXCLUSIVE em parcelas, uma unica vez, antes de validar e recalcular", () => {
    const lock = pos("lock table public.parcelas in access exclusive mode");
    expect(codigo.match(/lock table/gi)).toHaveLength(1);
    expect(codigo).not.toMatch(/share row exclusive/i);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(pos("from pg_trigger t"));
    expect(lock).toBeLessThan(pos("create temp table _cand"));
  });
  it("todas as exigencias rodam antes da supressao", () => {
    const disable = pos(DISABLE);
    for (const t of ["v_n <> c_qtd", "v_distintas <> c_qtd", "v_boletos <> c_qtd", "v_acordos <> c_acordos",
      "v_alunos <> c_alunos", "v_hash is distinct from c_hash_aprovado", "backup_titulo_id <> backup_parcela_id + 1",
      "p.status = 'PAGO' and p.pago_em is null", "v_nulos <> c_nulos_antes"]) {
      expect(pos(t), t).toBeGreaterThan(-1);
      expect(pos(t), t).toBeLessThan(disable);
    }
  });
});

describe("5. escrita: um UPDATE, uma coluna", () => {
  it("exatamente um UPDATE, em public.parcelas, SET so boleto", () => {
    expect(codigo.match(/\bupdate\s+public\./gi)).toHaveLength(1);
    const set = codigo.match(/update public\.parcelas p\s+set ([\s\S]*?)\s+from _cand c/)[1];
    expect(set.trim()).toBe("boleto = c.boleto_novo");
  });
  it("nunca sobrescreve e exige row_count", () => {
    expect(codigo).toMatch(/where p\.id = c\.parcela_id\s+and p\.boleto is null;/);
    expect(codigo).toContain("get diagnostics v_rows = row_count");
    expect(codigo).toContain("if v_rows <> c_qtd then");
  });
  it("sem INSERT, DELETE ou TRUNCATE em tabela real", () => {
    expect(codigo).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(codigo).not.toMatch(/\bdelete\s+from\b/i);
    expect(codigo).not.toMatch(/\btruncate\b/i);
  });
});

describe("6. escopo", () => {
  it("nao executa recalculo, conciliacao nem altera funcao", () => {
    expect(codigo).not.toMatch(/recalcular_situacao_aluno\s*\(/);
    expect(codigo).not.toContain("pagamento_conciliar_um");
    expect(codigo).not.toMatch(/create\s+or\s+replace\s+function/i);
  });
  it("zero candidatas aborta -- nunca e caminho de sucesso", () => {
    expect(codigo).toMatch(/if v_n = 0 then\s+raise exception/);
  });
});
