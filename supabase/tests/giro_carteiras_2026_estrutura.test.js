// GIRO DAS CARTEIRAS 2026/1 e 2026/2 -- invariantes estruturais da migration.
//
// Trava o que a gestao decidiu em 16/10 e o que, se mudar sem querer, muda o
// efeito do giro em producao sem ninguem perceber. Nao substitui o teste de
// comportamento; cobre o que so se ve lendo o arquivo -- em especial os patches
// ancorados em funcoes de producao, que nao da para rodar fora dela.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIG = readFileSync(
  resolve(RAIZ, "supabase/migrations/20261016190000_giro_carteiras_2026_1_2026_2.sql"),
  "utf8",
);

// Comentarios fora: senao um exemplo ou uma explicacao em prosa faria o teste
// passar (ou reprovar) por texto que o banco nunca executa.
const SQL = MIG.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("o giro so mexe em quem ele deve mexer", () => {
  it("nao escreve em acordo, parcela nem titulo", () => {
    for (const alvo of ["acordos", "parcelas", "acordos_titulos", "acordo_titulo_vinculo"]) {
      expect(SQL).not.toMatch(new RegExp(`update\\s+public\\.${alvo}\\b`, "i"));
      expect(SQL).not.toMatch(new RegExp(`insert\\s+into\\s+public\\.${alvo}\\b`, "i"));
      expect(SQL).not.toMatch(new RegExp(`delete\\s+from\\s+public\\.${alvo}\\b`, "i"));
    }
  });

  it("nao apaga nem trunca nada", () => {
    expect(SQL).not.toMatch(/\bdrop\s+table\b/i);
    expect(SQL).not.toMatch(/\btruncate\b/i);
    expect(SQL).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("o universo exclui parcela de acordo e titulo de acordo", () => {
    expect(SQL).toContain("t.acordo_id is null");
    expect(SQL).toContain("coalesce(t.tipo_boleto,'') <> 'Acordo'");
    expect(SQL).toContain("titulo_superado_por_acordo");
  });

  it("nao reativa o giro de 10/09 nem mexe nas funcoes dele", () => {
    expect(SQL).not.toContain("GIRO_DESATIVADO");
    expect(SQL).not.toMatch(/function public\.calibragem_simular_giro_2026/);
    expect(SQL).not.toMatch(/function public\.calibragem_executar_giro_lote_impl/);
  });
});

describe("a distribuicao e a de duas passadas com prioridade 2026/2", () => {
  it("a passada A ordena pelo saldo de 2026/2", () => {
    expect(SQL).toMatch(/order by s2 desc, cpf_chave[\s\S]*?from _cpf where tem2/);
  });

  it("a passada B tem cota por operador", () => {
    expect(SQL).toContain("generate_series(1, tgt - q)");
    expect(SQL).toMatch(/count\(\*\) \/ v_n_ops base, count\(\*\) % v_n_ops rem/);
  });

  it("a passada B alterna a direcao a cada rodada", () => {
    // Sem a alternancia o consolidado abre de 1,45% para 2,81% (medido 16/10).
    expect(SQL).toContain("case when k % 2 = 1 then t else -t end");
  });

  it("para se algum CPF ficar sem operador", () => {
    expect(SQL).toMatch(/if exists \(select 1 from _cpf where slot is null\) then[\s\S]*?raise exception/);
  });

  it("o saldo do CPF soma por aluno distinto, nunca por caso", () => {
    expect(SQL).toMatch(/from _elegivel group by cpf_chave/);
  });
});

describe("as guardas distinguem a MARCA da DATA", () => {
  it("a liberacao automatica olha a marca -- preserva o responsavel ate alguem assumir", () => {
    expect(SQL).toContain("v_c.giro_fidelizacao_ate is not null");
  });

  it("o teto tambem olha a marca", () => {
    expect(SQL).toContain("c.giro_fidelizacao_ate IS NULL");
  });

  it("as acoes massivas olham a DATA -- o aluno volta a aparecer em 27/10", () => {
    expect(SQL).toContain("public.caso_em_giro_fidelizacao(gc.giro_fidelizacao_ate)");
    expect(SQL).toContain("giro_fidelizado");
  });

  it("assumir olha a DATA, com as duas respostas possiveis", () => {
    expect(SQL).toContain("public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate)");
    expect(SQL).toContain("v_new.giro_fidelizacao_ate is null");
  });

  it("toda ancora de patch e verificada antes de trocar o corpo", () => {
    const blocos = SQL.split(/do \$mig\$/).slice(1);
    expect(blocos.length).toBeGreaterThanOrEqual(4);
    for (const b of blocos) {
      expect(b).toMatch(/position\(/);
      expect(b).toMatch(/raise (exception|notice)/);
    }
  });
});

describe("os limites de seguranca estao no arquivo", () => {
  it("o teto vai a 700, dentro da faixa aceita pela funcao", () => {
    expect(SQL).toContain("calibragem_definir_teto(700, null)");
    const m = SQL.match(/calibragem_definir_teto\((\d+), null\)/);
    expect(Number(m[1])).toBeGreaterThanOrEqual(50);
    expect(Number(m[1])).toBeLessThanOrEqual(3000);
  });

  it("o executor recusa teto insuficiente", () => {
    expect(SQL).toMatch(/Teto da carteira abaixo do necessário/);
    expect(SQL).toContain("calibragem_teto_operador(o->>'op_email')");
  });

  it("a execucao exige simulacao aprovada e trava contra o desfazer", () => {
    expect(SQL).toContain("'APROVADA','EXECUTANDO'");
    expect(SQL).toContain("pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'))");
  });

  it("a auditoria permite desfazer pelo caminho que ja existe", () => {
    expect(SQL).toContain("'MOVIMENTACAO_NIVELAMENTO'");
    expect(SQL).toContain("'GIRO_2026_10'");
  });

  it("a simulacao nao move nada: so grava RASCUNHO", () => {
    const simular = SQL.split("giro_2026_10_simular")[1].split("giro_2026_10_executar_lote_impl")[0];
    expect(simular).toContain("'RASCUNHO'");
    expect(simular).not.toMatch(/update public\.casos/);
  });

  it("a fidelizacao excepcional termina em 26/10/2026", () => {
    expect(SQL).toContain("date '2026-10-26'");
  });
});
