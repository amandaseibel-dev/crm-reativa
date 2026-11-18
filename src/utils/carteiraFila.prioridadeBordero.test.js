import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ordenarCasos,
  snapshotDoGuiado,
  ehPrioridadeBordero,
  excluidoDoGuiado,
  recorteProntoParaGuiado,
} from "./carteiraFila";

// Decisão do banco (RPC carteira_prioridade_bordero), indexada por aluno_id.
const decisao = (over) => ({
  em_populacao_2026: true,
  prioridade: true,
  exclui_guiado: false,
  motivo_exclusao: null,
  saldo_bordero_2026: 1000,
  acionado_desde_entrada: false,
  envio_realizado: false,
  resposta_recebida: false,
  ...over,
});

const mapa = {
  a: decisao({ saldo_bordero_2026: 100 }),
  b: decisao({ saldo_bordero_2026: 9000 }),
  c: decisao({ prioridade: false, exclui_guiado: true, motivo_exclusao: "BLOQUEADO" }),
  d: decisao({ prioridade: false, exclui_guiado: true, motivo_exclusao: "PAGAMENTO_PENDENTE" }),
  e: decisao({ prioridade: false, exclui_guiado: true, motivo_exclusao: "LOTE_PENDENTE" }),
  f: decisao({ prioridade: false, exclui_guiado: false, acionado_desde_entrada: true, resposta_recebida: true }),
};

const caso = (id) => ({ id, nome: `aluno ${id}` });

describe("prioridade vem do banco, por aluno_id", () => {
  it("prioriza quem o banco marcou", () => {
    expect(ehPrioridadeBordero(caso("a"), mapa)).toBe(true);
    expect(ehPrioridadeBordero(caso("f"), mapa)).toBe(false);
  });
  it("sem decisão, nunca prioriza", () => {
    expect(ehPrioridadeBordero(caso("zzz"), mapa)).toBe(false);
    expect(ehPrioridadeBordero(caso("a"), null)).toBe(false);
  });
});

describe("exclusão do guiado é fail-closed", () => {
  it("bloqueado, pagamento pendente e lote pendente são excluídos", () => {
    expect(excluidoDoGuiado(caso("c"), mapa)).toBe(true);
    expect(excluidoDoGuiado(caso("d"), mapa)).toBe(true);
    expect(excluidoDoGuiado(caso("e"), mapa)).toBe(true);
  });
  it("aluno sem linha no mapa é excluído (ausência não libera)", () => {
    expect(excluidoDoGuiado(caso("zzz"), mapa)).toBe(true);
  });
  it("mapa null (carregando ou falhou) exclui todos", () => {
    expect(excluidoDoGuiado(caso("a"), null)).toBe(true);
  });
  it("contato e resposta não excluem do guiado, só tiram a prioridade", () => {
    expect(excluidoDoGuiado(caso("f"), mapa)).toBe(false);
  });
  it("snapshot só traz quem tem decisão liberada, na ordem visível", () => {
    const lista = [caso("c"), caso("a"), caso("zzz"), caso("d"), caso("b"), caso("f")];
    expect(snapshotDoGuiado(lista, mapa)).toEqual(["a", "b", "f"]);
  });
  it("snapshot com mapa null vem vazio", () => {
    expect(snapshotDoGuiado([caso("a"), caso("b")], null)).toEqual([]);
  });
  it("recorte não libera enquanto a decisão não carregou", () => {
    expect(recorteProntoParaGuiado({ prioridadeCarregada: false })).toBe(false);
    expect(recorteProntoParaGuiado({ prioridadeCarregada: true })).toBe(true);
  });
});

describe("ordenação Fila inteligente usa a prioridade do banco", () => {
  it("coloca a prioridade à frente dentro da mesma faixa", () => {
    const lista = [caso("zzz"), caso("a")];
    const ordenada = ordenarCasos(lista, { ordenacao: "inteligente", prioridadeBordero: mapa });
    expect(ordenada[0].id).toBe("a");
  });
  it("preserva ordenação escolhida manualmente", () => {
    const lista = [
      { id: "a", valor_em_aberto: 10 },
      { id: "b", valor_em_aberto: 500 },
    ];
    expect(ordenarCasos(lista, { ordenacao: "valor_asc", prioridadeBordero: mapa }).map((x) => x.id)).toEqual(["a", "b"]);
    expect(ordenarCasos(lista, { ordenacao: "valor_desc", prioridadeBordero: mapa }).map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("migration carteira_prioridade_bordero (guardas de texto; comportamento em PGlite pendente)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "../../supabase/migrations/20261117100000_carteira_prioridade_bordero.sql"), "utf-8");
  it("chave aluno_id e sem CPF no retorno", () => {
    expect(sql).toContain("p_aluno_ids uuid[]");
    expect(sql).not.toMatch(/cpf_limpo\s+text/);
  });
  it("autorização interna: JWT, usuário ativo e gestão", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("auth.email()");
    expect(sql).toContain("public.usuario_e_gestao()");
    expect(sql).toContain("u.ativo");
  });
  it("UTC e entrada mais recente", () => {
    expect(sql).toContain("max((i.created_at at time zone 'UTC'))");
    expect(sql).not.toContain("America/Sao_Paulo");
  });
  it("não altera eh_tipo_acionamento e usa os três tipos da §9", () => {
    expect(sql).not.toMatch(/create or replace function public\.eh_tipo_acionamento/i);
    expect(sql).toContain("'FINALIZACAO_ATENDIMENTO', 'ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL'");
  });
  it("grants restritos e rollback escrito", () => {
    expect(sql).toContain("revoke all on function public.carteira_prioridade_bordero(uuid[]) from anon");
    expect(sql).toContain("drop function if exists public.carteira_prioridade_bordero(uuid[])");
  });
});
