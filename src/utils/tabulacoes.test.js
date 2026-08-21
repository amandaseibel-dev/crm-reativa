import { describe, it, expect, vi } from "vitest";

vi.mock("../services/supabase", () => ({ supabase: {} }));

import {
  FALLBACK_TABULACOES,
  acharTabulacao,
  opcoesTabulacao,
  rotuloTabulacao,
  proximaAcaoDeTabulacao,
  blocoDaTabulacao,
  retornoAutomaticoDeTabulacao,
  retornoEhManual,
} from "./tabulacoes";

const CATALOGO = FALLBACK_TABULACOES;

// Terça-feira, 2026-08-18 -- base estável pra contar dias úteis.
const TERCA = new Date(2026, 7, 18);
// Sexta-feira, 2026-08-21.
const SEXTA = new Date(2026, 7, 21);

describe("rotuloTabulacao", () => {
  it("usa o rótulo do catálogo", () => {
    expect(rotuloTabulacao(CATALOGO, "ALUNO_EM_NEGOCIACAO_24H")).toBe("Em negociação");
  });

  it("torna legível um código fora do catálogo em vez de quebrar", () => {
    // Códigos que existem na base mas nunca foram tabulação (situação/legado).
    expect(rotuloTabulacao(CATALOGO, "SEM_SALDO_EM_ABERTO")).toBe("Sem saldo em aberto");
  });

  it("devolve texto livre legado como está", () => {
    expect(rotuloTabulacao(CATALOGO, "Novo caso")).toBe("Novo caso");
  });

  it("não quebra sem código", () => {
    expect(rotuloTabulacao(CATALOGO, null)).toBe("-");
  });
});

describe("opcoesTabulacao", () => {
  it("esconde as inativas", () => {
    const codigos = opcoesTabulacao(CATALOGO, "").map((t) => t.codigo);
    expect(codigos).not.toContain("LINK_ENVIADO_AO_ALUNO"); // inativa no seed
    expect(codigos).toContain("CONTATAR");
  });

  it("esconde as que bloqueiam acionamento de quem não é gestão", () => {
    const operador = opcoesTabulacao(CATALOGO, "").map((t) => t.codigo);
    expect(operador).not.toContain("JURIDICO");

    const gestao = opcoesTabulacao(CATALOGO, "", { podeVerTudo: true }).map((t) => t.codigo);
    expect(gestao).toContain("JURIDICO");
  });

  // O ponto central do pedido: desativar uma tabulação não pode trocar
  // silenciosamente a tabulação de quem já está nela.
  it("mantém o código atual na lista mesmo depois de desativado", () => {
    const semCatalogo = CATALOGO.map((t) =>
      t.codigo === "MENSAGEM_ENVIADA" ? { ...t, ativa: false } : t
    );
    const opcoes = opcoesTabulacao(semCatalogo, "MENSAGEM_ENVIADA");
    expect(opcoes[0].codigo).toBe("MENSAGEM_ENVIADA");
    expect(opcoes[0].rotulo).toContain("inativa");
  });

  it("mantém um código que nem existe no catálogo", () => {
    const opcoes = opcoesTabulacao(CATALOGO, "TABULACAO_ANTIGA_QUALQUER");
    expect(opcoes[0].codigo).toBe("TABULACAO_ANTIGA_QUALQUER");
  });
});

describe("retornoAutomaticoDeTabulacao", () => {
  it("agenda em dias úteis a partir de hoje", () => {
    // MENSAGEM_ENVIADA = 2 dias úteis; terça 18 -> quinta 20.
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "MENSAGEM_ENVIADA", TERCA)).toBe("2026-08-20");
  });

  it("pula fim de semana", () => {
    // NAO_LOCALIZADO = 1 dia útil; sexta 21 -> segunda 24.
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "NAO_LOCALIZADO", SEXTA)).toBe("2026-08-24");
  });

  it("não agenda nada no modo MANUAL (operador escolhe)", () => {
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "RETORNAR_DEPOIS", TERCA)).toBeNull();
    expect(retornoEhManual(CATALOGO, "RETORNAR_DEPOIS")).toBe(true);
  });

  it("não agenda nada no modo NENHUM", () => {
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "CONTATAR", TERCA)).toBeNull();
  });

  it("não agenda para código desconhecido", () => {
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "INEXISTENTE", TERCA)).toBeNull();
  });

  it("aceita prazo 0 (mesmo dia)", () => {
    const cat = [
      { codigo: "HOJE_MESMO", rotulo: "Hoje", ativa: true, retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 0 },
    ];
    expect(retornoAutomaticoDeTabulacao(cat, "HOJE_MESMO", TERCA)).toBe("2026-08-18");
  });

  // Garantia da regra "respeita o que já está agendado": a função só produz
  // data nova a partir de HOJE, no ato de tabular. Ela não conhece nem recebe
  // o retorno já gravado, então não tem como sobrescrevê-lo.
  it("é pura -- mesma entrada, mesma saída, sem tocar em estado", () => {
    const a = retornoAutomaticoDeTabulacao(CATALOGO, "ACORDO_FECHADO", TERCA);
    const b = retornoAutomaticoDeTabulacao(CATALOGO, "ACORDO_FECHADO", TERCA);
    expect(a).toBe(b);
    expect(a).toBe("2026-08-20");
  });
});

describe("regras derivadas", () => {
  it("mantém as próximas ações que já existiam", () => {
    expect(proximaAcaoDeTabulacao(CATALOGO, "RETORNAR_DEPOIS")).toBe("RETORNAR");
    expect(proximaAcaoDeTabulacao(CATALOGO, "ALUNO_EM_NEGOCIACAO_24H")).toBe("RETORNAR");
    expect(proximaAcaoDeTabulacao(CATALOGO, "ACORDO_FECHADO")).toBe("ACOMPANHAR_PAGAMENTO");
    expect(proximaAcaoDeTabulacao(CATALOGO, "NAO_LOCALIZADO")).toBe("TENTAR_NOVO_CONTATO");
    expect(proximaAcaoDeTabulacao(CATALOGO, "LINK_PRONTO_PARA_ENVIO")).toBe("ENVIAR_LINK_AO_ALUNO");
    expect(proximaAcaoDeTabulacao(CATALOGO, "CONTATAR")).toBe("CONTATAR");
    expect(proximaAcaoDeTabulacao(CATALOGO, "QUALQUER_OUTRA")).toBe("CONTATAR");
  });

  it("mantém o bloco da ficha que abre sozinho", () => {
    expect(blocoDaTabulacao(CATALOGO, "SOLICITADO_LINK")).toBe("link");
    expect(blocoDaTabulacao(CATALOGO, "TERMO_ENVIADO_ADM")).toBe("termo");
    expect(blocoDaTabulacao(CATALOGO, "AGUARDANDO_BAIXA")).toBe("financeiro");
    expect(blocoDaTabulacao(CATALOGO, "BAIXA_REALIZADA")).toBe("confirmar");
    expect(blocoDaTabulacao(CATALOGO, "CONTATAR")).toBeNull();
  });

  it("acha por código em qualquer caixa", () => {
    expect(acharTabulacao(CATALOGO, "contatar")?.codigo).toBe("CONTATAR");
  });
});
