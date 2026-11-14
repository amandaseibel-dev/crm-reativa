// GIRO: evento administrativo na ficha -- invariantes das duas migrations.
//
// Trava o que, se mudar sem querer, muda o efeito em producao sem aparecer:
// o backfill so insere, o executor so grava quando o responsavel muda de
// verdade, nenhum dos dois toca na distribuicao ja executada, e nenhum dos
// dois volta a usar `lote_id` -- que e lote de ACAO MASSIVA, com FK propria.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

const EXECUTOR = ler("supabase/migrations/20261016210000_giro_movimentacao_coluna_propria.sql");
const BACKFILL = ler("supabase/migrations/20261016210500_giro_2026_10_backfill_movimentacao.sql");

// Comentarios fora: senao uma explicacao em prosa faria o teste passar.
const semComentario = (sql) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

const EXEC_SQL = semComentario(EXECUTOR);
const BACK_SQL = semComentario(BACKFILL);

describe("nenhum dos dois volta a usar lote_id", () => {
  // Citar `lote_id` em texto é esperado -- o comentário da coluna nova existe
  // justamente para avisar que não é ele. O que não pode é ESCREVER no campo.
  const naoEscreveEmLoteId = (sql) => {
    expect(sql).not.toMatch(/on conflict \(lote_id/);
    expect(sql).not.toMatch(/,\s*lote_id\s*\)/); // lista de colunas do insert
    expect(sql).not.toMatch(/set[^;]*\blote_id\s*=/i);
  };

  it("o executor usa a coluna própria", () => {
    expect(EXEC_SQL).toContain("giro_simulacao_id");
    naoEscreveEmLoteId(EXEC_SQL);
  });

  it("o backfill usa a coluna própria", () => {
    expect(BACK_SQL).toContain("giro_simulacao_id");
    naoEscreveEmLoteId(BACK_SQL);
  });

  it("ninguém cria linha em acoes_massivas_lotes para o giro", () => {
    for (const sql of [EXEC_SQL, BACK_SQL]) {
      expect(sql).not.toMatch(/insert\s+into\s+public\.acoes_massivas_lotes/i);
    }
  });

  it("a coluna nasce nula e o índice é parcial", () => {
    expect(EXEC_SQL).toMatch(/add column if not exists giro_simulacao_id uuid/);
    expect(EXEC_SQL).toMatch(/create unique index if not exists ux_aluno_mov_giro_aluno/);
    expect(EXEC_SQL).toMatch(/where giro_simulacao_id is not null/);
  });
});

describe("o backfill só acrescenta", () => {
  it("não atualiza nem apaga nada", () => {
    expect(BACK_SQL).not.toMatch(/\bupdate\s+public\./i);
    expect(BACK_SQL).not.toMatch(/\bdelete\s+from\b/i);
    expect(BACK_SQL).not.toMatch(/\btruncate\b/i);
    expect(BACK_SQL).not.toMatch(/\bdrop\s+/i);
  });

  it("escreve só em aluno_movimentacoes", () => {
    const inserts = [...BACK_SQL.matchAll(/insert\s+into\s+(public\.[a-z_]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["public.aluno_movimentacoes"]);
  });

  it("não toca no giro já executado", () => {
    for (const alvo of ["casos", "calibragem_auditoria", "calibragem_simulacoes",
                        "acordos", "parcelas", "acordos_titulos", "alunos"]) {
      expect(BACK_SQL).not.toMatch(new RegExp(`(update|insert\\s+into|delete\\s+from)\\s+public\\.${alvo}\\b`, "i"));
    }
  });

  it("lê exclusivamente a auditoria daquele giro", () => {
    expect(BACK_SQL).toContain("from public.calibragem_auditoria");
    expect(BACK_SQL).toContain("437f434b-e781-4357-a5ef-3fcd8e9d4770");
    expect(BACK_SQL).toContain("a.evento = 'MOVIMENTACAO_NIVELAMENTO'");
  });

  it("para cedo se a coluna ou o índice não existirem", () => {
    expect(BACK_SQL).toMatch(/giro_simulacao_id nao existe/);
    expect(BACK_SQL).toMatch(/ux_aluno_mov_giro_aluno nao existe/);
  });
});

describe("as quatro garantias estão nas duas migrations", () => {
  const ambas = { executor: EXEC_SQL, backfill: BACK_SQL };

  for (const [nome, sql] of Object.entries(ambas)) {
    it(`${nome}: só grava quando o responsável muda de verdade`, () => {
      expect(sql).toMatch(/operador_anterior_email is distinct from|de_email is distinct from/);
    });

    it(`${nome}: um registro por aluno`, () => {
      expect(sql).toMatch(/distinct on \((c\.aluno_id|a\.aluno_id)\)/);
    });

    it(`${nome}: idempotente pelo identificador do giro e aluno`, () => {
      expect(sql).toMatch(
        /on conflict \(giro_simulacao_id, aluno_id\) where giro_simulacao_id is not null do nothing/,
      );
    });

    it(`${nome}: usa o tipo que NÃO conta como acionamento`, () => {
      expect(sql).toContain("ALTERACAO_OPERADOR");
      for (const proibido of ["FINALIZACAO_ATENDIMENTO", "EM_ATENDIMENTO", "CONTATO",
                              "ACAO_MASSIVA_EXTERNA", "LINK_ENVIADO_AO_ALUNO",
                              "ASSUMIU_ATENDIMENTO"]) {
        expect(sql).not.toContain(proibido);
      }
    });

    it(`${nome}: não escreve acionamento, retorno nem fidelização`, () => {
      expect(sql).not.toMatch(/data_ultimo_acionamento/);
      expect(sql).not.toMatch(/data_retorno/);
      expect(sql).not.toMatch(/giro_fidelizacao_ate/);
    });

    it(`${nome}: carrega o motivo e a origem no texto`, () => {
      expect(sql).toContain("Motivo: Giro de carteira 2026/1 e 2026/2");
      expect(sql).toContain("Carteira geral / sem responsável anterior");
    });
  }
});

describe("o executor muda por patch ancorado, não por reescrita", () => {
  it("confere a âncora e a unicidade dela antes de trocar o corpo", () => {
    expect(EXEC_SQL).toContain("pg_get_functiondef");
    expect(EXEC_SQL).toMatch(/ancora nao encontrada/);
    expect(EXEC_SQL).toMatch(/ancora ambigua/);
  });

  it("é idempotente pela coluna própria, não pela simples presença do insert", () => {
    // Se olhasse só por 'aluno_movimentacoes', pularia um corpo que tivesse a
    // versão errada por lote_id e deixaria o executor quebrado.
    expect(EXEC_SQL).toMatch(/position\('giro_simulacao_id' in v_def\) > 0/);
  });

  it("substitui a versão antiga por lote_id em vez de aceitá-la", () => {
    expect(EXEC_SQL).toMatch(/position\('aluno_movimentacoes' in v_def\) > 0/);
    expect(EXEC_SQL).toMatch(/versao antiga do insert nao localizada/);
  });

  it("não redefine o executor nem a simulação por create or replace", () => {
    expect(EXEC_SQL).not.toMatch(/create or replace function public\.giro_2026_10_executar_lote_impl/);
    expect(EXEC_SQL).not.toMatch(/create or replace function public\.giro_2026_10_simular/);
  });

  it("não mexe na distribuição", () => {
    for (const marca of ["order by s2 desc", "generate_series(1, tgt - q)",
                         "case when k % 2 = 1", "calibragem_definir_teto"]) {
      expect(EXEC_SQL).not.toContain(marca);
    }
  });
});
