// CONFERÊNCIA POR ARQUIVO — os rótulos e o fechamento das contas.
//
// O fechamento também é testado em PostgreSQL real
// (supabase/tests/importacao_conferencia_por_arquivo.test.js). Aqui se prova a
// outra metade: que a TELA detecta quando a conta não fecha, em vez de exibir
// um número que não soma. Sem isto, um defeito futuro na view apareceria como
// um resumo silenciosamente errado.
import { describe, it, expect } from "vitest";
import {
  CATEGORIAS,
  contagem,
  dinheiro,
  evidenciaDaLinha,
  fechamento,
  motivoDaLinha,
  resumoDoArquivo,
  rotuloArquivo,
  rotuloCategoria,
} from "./conferenciaPorArquivo";

// Os números do cenário da bancada, para os dois lados falarem a mesma língua.
const ARQUIVO = {
  importacao_id: "aaaaaaaa-0000-0000-0000-00000000000a",
  arquivo_nome: "arquivo-A.xlsx",
  importado_em: "2026-10-23T12:00:00",
  importacao_status: "CONCLUIDO",
  pagamentos: 6,
  valor_total: 2100,
  baixa_registrada_crm: 2, baixa_registrada_valor: 300,
  baixa_pendente: 1, baixa_pendente_valor: 500,
  divergencia: 1, divergencia_valor: 300,
  sem_vinculo: 1, sem_vinculo_valor: 400,
  fora_da_janela: 1, fora_da_janela_valor: 600,
  nao_classificado: 0,
  com_suspeita_duplicidade: 1,
  pendencias_historicas_relacionadas: 1,
};

describe("o fechamento das contas", () => {
  it("fecha quando as categorias somam o arquivo", () => {
    const f = fechamento(ARQUIVO);
    expect(f.fecha).toBe(true);
    expect(f.qtdSoma).toBe(6);
    expect(f.valorSoma).toBe(2100);
  });

  // O teste que dá valor ao anterior: se a conta não fechasse, `fecha` seria
  // true por engano e a tela mostraria resumo errado sem avisar.
  it("NAO fecha quando falta um pagamento na partição", () => {
    const f = fechamento({ ...ARQUIVO, divergencia: 0, divergencia_valor: 0 });
    expect(f.fecha).toBe(false);
    expect(f.qtdSoma).toBe(5);
    expect(f.qtdTotal).toBe(6);
  });

  it("NAO fecha quando o valor divergir, mesmo com a contagem certa", () => {
    const f = fechamento({ ...ARQUIVO, divergencia_valor: 299 });
    expect(f.fecha).toBe(false);
    expect(f.qtdSoma).toBe(f.qtdTotal);
  });

  // Centavos: comparar float direto erraria por arredondamento.
  it("fecha com centavos, sem erro de ponto flutuante", () => {
    const f = fechamento({
      ...ARQUIVO,
      valor_total: 0.3,
      baixa_registrada_valor: 0.1, baixa_pendente_valor: 0.1, divergencia_valor: 0.1,
      sem_vinculo_valor: 0, fora_da_janela_valor: 0,
    });
    expect(f.fecha).toBe(true);
  });

  it("arquivo nulo nao quebra", () => {
    expect(fechamento(null).fecha).toBe(true);
    expect(resumoDoArquivo(null)).toEqual([]);
  });
});

describe("o resumo", () => {
  it("traz as seis categorias na ordem de trabalho", () => {
    expect(resumoDoArquivo(ARQUIVO).map((c) => c.chave)).toEqual([
      "DIVERGENCIA", "SEM_VINCULO", "BAIXA_PENDENTE",
      "BAIXA_REGISTRADA_CRM", "FORA_DA_JANELA", "NAO_CLASSIFICADO",
    ]);
  });

  // Categoria com zero NAO desaparece: sumir faria a gestao nao saber se e zero
  // ou se a tela deixou de contar.
  it("categoria com zero continua aparecendo", () => {
    const r = resumoDoArquivo(ARQUIVO).find((c) => c.chave === "NAO_CLASSIFICADO");
    expect(r.qtd).toBe(0);
  });

  it("cada categoria leva quantidade e valor do arquivo", () => {
    const porChave = Object.fromEntries(resumoDoArquivo(ARQUIVO).map((c) => [c.chave, c]));
    expect(porChave.BAIXA_REGISTRADA_CRM.qtd).toBe(2);
    expect(porChave.BAIXA_REGISTRADA_CRM.valor).toBe(300);
    expect(porChave.FORA_DA_JANELA.valor).toBe(600);
    // NAO_CLASSIFICADO nao tem coluna de valor na RPC: valor nulo, nao zero
    expect(porChave.NAO_CLASSIFICADO.valor).toBeNull();
  });
});

describe("a fronteira que a gestao pediu para preservar", () => {
  it("o rotulo da baixa diz 'registrada no CRM', nao 'comprovada'", () => {
    expect(rotuloCategoria("BAIXA_REGISTRADA_CRM")).toBe("Baixa registrada no CRM");
    expect(rotuloCategoria("BAIXA_REGISTRADA_CRM")).not.toMatch(/comprovad/i);
  });

  it("a ajuda da baixa nega explicitamente a comprovacao bancaria", () => {
    expect(CATEGORIAS.BAIXA_REGISTRADA_CRM.ajuda).toMatch(/origem_baixa_ref/);
    expect(CATEGORIAS.BAIXA_REGISTRADA_CRM.ajuda).toMatch(/Não é afirmação de comprovação bancária/);
  });

  it("FORA_DA_JANELA e apresentada como decisao, nao como pendencia", () => {
    expect(CATEGORIAS.FORA_DA_JANELA.ajuda).toMatch(/Não é pendência/);
    expect(rotuloCategoria("FORA_DA_JANELA")).not.toMatch(/pendent/i);
  });

  it("categoria desconhecida devolve o proprio codigo, nao vazio", () => {
    expect(rotuloCategoria("COISA_NOVA")).toBe("COISA_NOVA");
    expect(rotuloCategoria(null)).toBe("—");
  });
});

describe("o rotulo do arquivo", () => {
  it("diz quantos pagamentos tem", () => {
    expect(rotuloArquivo(ARQUIVO)).toContain("6 pagamentos");
    expect(rotuloArquivo({ ...ARQUIVO, pagamentos: 1 })).toContain("1 pagamento");
  });

  // Em producao sao 230 importacoes sem pagamento: precisam dizer isso em vez
  // de desaparecer da lista.
  it("arquivo sem pagamento diz 'nenhum pagamento'", () => {
    expect(rotuloArquivo({ ...ARQUIVO, pagamentos: 0 })).toContain("nenhum pagamento");
  });

  it("status diferente de CONCLUIDO aparece no rotulo", () => {
    expect(rotuloArquivo({ ...ARQUIVO, importacao_status: "SUBSTITUIDA" })).toContain("SUBSTITUIDA");
    expect(rotuloArquivo(ARQUIVO)).not.toContain("CONCLUIDO");
  });

  it("arquivo sem nome nao vira rotulo vazio", () => {
    expect(rotuloArquivo({ ...ARQUIVO, arquivo_nome: null })).toContain("(sem nome)");
  });
});

describe("motivo e evidencia da linha", () => {
  it("o motivo vem do vocabulario da #737", () => {
    expect(motivoDaLinha({ categoria: "SEM_VINCULO", triagem_subcategoria: "acordo_ausente_no_crm" }))
      .toBe("Acordo não está no CRM");
    expect(motivoDaLinha({ categoria: "BAIXA_PENDENTE", triagem_subcategoria: "escolher_aluno_sugerido" }))
      .toBe("Há sugestão de aluno para escolher");
  });

  it("sem subcategoria cai no motivo cru, e nunca em vazio", () => {
    expect(motivoDaLinha({ categoria: "DIVERGENCIA", triagem_motivo: "texto cru do motor" }))
      .toBe("texto cru do motor");
    expect(motivoDaLinha({ categoria: "BAIXA_REGISTRADA_CRM" })).toBe("Baixa registrada");
    expect(motivoDaLinha({ categoria: "FORA_DA_JANELA" })).toBe("Anterior a 14/09/2026");
    expect(motivoDaLinha(null)).toBe("—");
  });

  it("a evidencia so existe quando ha parcela apontando", () => {
    expect(evidenciaDaLinha({ categoria: "DIVERGENCIA" })).toBeNull();
    const e = evidenciaDaLinha({
      parcela_baixada_id: "aa111111-0000-0000-0000-000000000001",
      baixa_origem: "GATILHO_IMPORTACAO",
      baixa_em: "2026-10-20T10:00:00Z",
    });
    expect(e).toContain("GATILHO_IMPORTACAO");
  });

  it("parcela sem origem registrada nao finge ter origem", () => {
    expect(evidenciaDaLinha({ parcela_baixada_id: "x", baixa_origem: null, baixa_em: null }))
      .toBe("origem não registrada");
  });
});

describe("formatacao", () => {
  it("dinheiro e contagem em pt-BR, e nulo nao vira NaN", () => {
    expect(dinheiro(2100)).toMatch(/2\.100,00/);
    expect(dinheiro(null)).toMatch(/0,00/);
    expect(contagem(1322)).toBe("1.322");
    expect(contagem(undefined)).toBe("0");
  });
});
