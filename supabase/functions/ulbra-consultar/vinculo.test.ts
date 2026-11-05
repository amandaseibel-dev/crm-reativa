// Testa a REGRA de vínculo seguro: quem pode nascer, quem é barrado e por quê.
// Roda em Node (sem DOM), sem banco e sem rede.
import { describe, it, expect, vi } from "vitest";
import { CONFIANCA, decidirVinculo, precisaReconfirmar } from "./vinculo.ts";

const CLIENTE_A = "6a8353957e2e9cae71e8207f";
const CLIENTE_B = "6a8353957e2e9cae71e82080";

/** Achado "encontrou o cliente X e está no escopo". */
function achou(id: string, extra: Partial<{ equipe: string | null; em_atendimento: boolean }> = {}) {
  return { ulbra_cliente_id: id, equipe: extra.equipe ?? "Reativa", em_atendimento: extra.em_atendimento ?? false, fora_do_escopo: false };
}
/** Achado "consultou e não encontrou". */
const nadaAchado = { ulbra_cliente_id: null, equipe: null, em_atendimento: false, fora_do_escopo: false };
const foraDoEscopo = { ulbra_cliente_id: null, equipe: null, em_atendimento: false, fora_do_escopo: true };

const clienteLivre = async () => false;
const clienteOcupado = async () => true;

// ===========================================================================
// 1. VALIDAÇÃO POR CPF — o portão novo
// ===========================================================================
describe("vínculo seguro: validação por CPF", () => {
  it("CPF confirma e telefone concorda → cria com confiança alta_cpf", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: achou(CLIENTE_A),
      telefone_e164: "+5551999990000",
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toEqual({
      acao: "criar",
      ulbra_cliente_id: CLIENTE_A,
      confianca: "alta_cpf",
      origem: "cpf",
      telefone_e164: "+5551999990000",
      equipe: "Reativa",
      em_atendimento: false,
      telefone_concordou: true,
      telefone_fora_do_escopo: false,
    });
  });

  it("CPF confirma sozinho (aluno sem telefone) → cria, origem sempre cpf", async () => {
    const d = await decidirVinculo({
      existente: null,
      porCpf: achou(CLIENTE_A),
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toMatchObject({ acao: "criar", origem: "cpf", confianca: "alta_cpf", telefone_concordou: false, telefone_e164: null });
  });

  it("o nível gravado automaticamente é SEMPRE alta_cpf, nunca o legado 'alta'", async () => {
    const d = await decidirVinculo({ existente: null, porCpf: achou(CLIENTE_A), clienteJaDeOutroAluno: clienteLivre });
    expect(d.acao).toBe("criar");
    if (d.acao !== "criar") return;
    expect(d.confianca).toBe(CONFIANCA.ALTA_CPF);
    expect(d.confianca).not.toBe(CONFIANCA.LEGADO_ALTA);
  });
});

// ===========================================================================
// 2. O DEFEITO DA ETAPA 1 — telefone sozinho já não grava nada
// ===========================================================================
describe("vínculo seguro: telefone não é identidade", () => {
  it("só o telefone achou (CPF consultado e não achou) → BLOQUEIA, não grava", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: nadaAchado,
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toEqual({
      acao: "bloquear",
      motivo: "CONFIRMACAO_MANUAL_SO_TELEFONE",
      ulbra_cliente_id_candidato: CLIENTE_A,
    });
  });

  it("telefone achou e aluno NÃO tem CPF cadastrado → BLOQUEIA com motivo próprio", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: undefined, // não havia CPF para consultar
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toEqual({
      acao: "bloquear",
      motivo: "CONFIRMACAO_MANUAL_SEM_CPF",
      ulbra_cliente_id_candidato: CLIENTE_A,
    });
  });

  it("o candidato achado pelo telefone é PRESERVADO na recusa, para conferência", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: nadaAchado,
      clienteJaDeOutroAluno: clienteLivre,
    });
    // Barrar não é esquecer: a gestão precisa saber QUEM era o candidato.
    expect(d.acao === "bloquear" && d.ulbra_cliente_id_candidato).toBe(CLIENTE_A);
  });

  it("nenhum caminho do telefone sozinho chega a 'criar'", async () => {
    for (const porCpf of [undefined, nadaAchado, foraDoEscopo]) {
      const d = await decidirVinculo({
        existente: null,
        porTelefone: achou(CLIENTE_A),
        porCpf,
        clienteJaDeOutroAluno: clienteLivre,
      });
      expect(d.acao).not.toBe("criar");
    }
  });
});

// ===========================================================================
// 2b. O LIMITE DA DETECÇÃO DE DISCORDÂNCIA — dito, não escondido
// ===========================================================================
describe("vínculo seguro: telefone fora do escopo do token", () => {
  it("telefone fora do escopo + CPF confirma → cria pelo CPF, mas REGISTRA o caso", async () => {
    const d = await decidirVinculo({
      existente: null,
      // A Mensageria diz "existe, equipe Financeiro" e NÃO devolve o id:
      // não há como comparar com o cliente do CPF.
      porTelefone: foraDoEscopo,
      porCpf: achou(CLIENTE_A),
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toMatchObject({
      acao: "criar",
      ulbra_cliente_id: CLIENTE_A,
      // Não é concordância: é impossibilidade de comparar.
      telefone_concordou: false,
      telefone_fora_do_escopo: true,
    });
  });

  it("telefone concordando de verdade não é marcado como fora do escopo", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: achou(CLIENTE_A),
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toMatchObject({ telefone_concordou: true, telefone_fora_do_escopo: false });
  });
});

// ===========================================================================
// 3. AMBIGUIDADE — chaves discordantes bloqueiam, sem desempate
// ===========================================================================
describe("vínculo seguro: ambiguidade", () => {
  it("telefone→A e CPF→B → BLOQUEIA sem escolher nenhum dos dois", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: achou(CLIENTE_B),
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toEqual({
      acao: "bloquear",
      motivo: "AMBIGUO_CHAVES_DISCORDANTES",
      // Nenhum candidato é oferecido: oferecer um é escolher por palpite.
      ulbra_cliente_id_candidato: null,
    });
  });

  it("na ambiguidade nem o CPF 'ganha': a recusa é anterior a qualquer preferência", async () => {
    const consulta = vi.fn(clienteLivre);
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: achou(CLIENTE_B),
      clienteJaDeOutroAluno: consulta,
    });
    expect(d.acao).toBe("bloquear");
    // Barra antes de ir ao banco: discordância não vira consulta de duplicata.
    expect(consulta).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. DUPLICIDADE — um cliente da Mensageria por aluno ativo
// ===========================================================================
describe("vínculo seguro: duplicidade de cliente", () => {
  it("CPF confirma mas o cliente já é de outro aluno → BLOQUEIA", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: achou(CLIENTE_A),
      clienteJaDeOutroAluno: clienteOcupado,
    });
    expect(d).toEqual({
      acao: "bloquear",
      motivo: "DUPLICADO_CLIENTE_DE_OUTRO_ALUNO",
      ulbra_cliente_id_candidato: CLIENTE_A,
    });
  });

  it("a duplicata é checada com o cliente do CPF, não com o do telefone", async () => {
    const consulta = vi.fn(clienteLivre);
    await decidirVinculo({
      existente: null,
      porTelefone: achou(CLIENTE_A),
      porCpf: achou(CLIENTE_A),
      clienteJaDeOutroAluno: consulta,
    });
    expect(consulta).toHaveBeenCalledWith(CLIENTE_A);
  });

  it("erro ao checar duplicata FECHA (trata como duplicado), não libera", async () => {
    const d = await decidirVinculo({
      existente: null,
      porCpf: achou(CLIENTE_A),
      clienteJaDeOutroAluno: async () => { throw new Error("banco fora"); },
    });
    expect(d).toMatchObject({ acao: "bloquear", motivo: "DUPLICADO_CLIENTE_DE_OUTRO_ALUNO" });
  });
});

// ===========================================================================
// 5. PROTEÇÃO DOS VÍNCULOS ANTIGOS — nunca sobrescrever, nunca apagar
// ===========================================================================
describe("vínculo seguro: proteção do vínculo que já existe", () => {
  it("vínculo ativo é devolvido como está, sem consultar nem regravar", async () => {
    const consulta = vi.fn(clienteLivre);
    const d = await decidirVinculo({
      existente: { ulbra_cliente_id: CLIENTE_A, confianca: "alta_cpf", origem: "cpf" },
      // Mesmo que a Mensageria agora aponte OUTRO cliente, o gravado manda.
      porTelefone: achou(CLIENTE_B),
      porCpf: achou(CLIENTE_B),
      clienteJaDeOutroAluno: consulta,
    });
    expect(d).toEqual({
      acao: "manter_existente",
      ulbra_cliente_id: CLIENTE_A,
      confianca: "alta_cpf",
      origem: "cpf",
      reconfirmar_recomendado: false,
    });
    expect(consulta).not.toHaveBeenCalled();
  });

  it("legado da Etapa 1 (origem telefone, selo 'alta') é mantido MAS marcado para reconferência", async () => {
    const d = await decidirVinculo({
      existente: { ulbra_cliente_id: CLIENTE_A, confianca: "alta", origem: "telefone" },
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toMatchObject({
      acao: "manter_existente",
      ulbra_cliente_id: CLIENTE_A,
      reconfirmar_recomendado: true,
    });
  });

  it("nenhuma entrada leva a apagar ou trocar vínculo existente", async () => {
    const casos = [
      { confianca: "alta", origem: "telefone" },
      { confianca: "alta_cpf", origem: "cpf" },
      { confianca: "ambigua", origem: "manual" },
      { confianca: "reconfirmar", origem: "telefone" },
    ];
    for (const c of casos) {
      const d = await decidirVinculo({
        existente: { ulbra_cliente_id: CLIENTE_A, ...c },
        porCpf: achou(CLIENTE_B),
        clienteJaDeOutroAluno: clienteLivre,
      });
      expect(d.acao).toBe("manter_existente");
      expect(d.acao === "manter_existente" && d.ulbra_cliente_id).toBe(CLIENTE_A);
    }
  });
});

describe("precisaReconfirmar", () => {
  it("só alta_cpf dispensa reconferência", () => {
    expect(precisaReconfirmar({ ulbra_cliente_id: "x", confianca: "alta_cpf", origem: "cpf" })).toBe(false);
  });

  it("legado 'alta', 'ambigua' e 'reconfirmar' pedem reconferência", () => {
    expect(precisaReconfirmar({ ulbra_cliente_id: "x", confianca: "alta", origem: "cpf" })).toBe(true);
    expect(precisaReconfirmar({ ulbra_cliente_id: "x", confianca: "ambigua", origem: "manual" })).toBe(true);
    expect(precisaReconfirmar({ ulbra_cliente_id: "x", confianca: "reconfirmar", origem: "cpf" })).toBe(true);
  });

  it("origem telefone pede reconferência mesmo com selo desconhecido", () => {
    expect(precisaReconfirmar({ ulbra_cliente_id: "x", confianca: "qualquer_outro", origem: "telefone" })).toBe(true);
  });
});

// ===========================================================================
// 6. NADA ENCONTRADO
// ===========================================================================
describe("vínculo seguro: nada encontrado", () => {
  it("as duas chaves vazias → NAO_ENCONTRADO", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: nadaAchado,
      porCpf: nadaAchado,
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toEqual({ acao: "nao_encontrado", motivo: "NAO_ENCONTRADO" });
  });

  it("existe em equipe fora do escopo → FORA_DO_ESCOPO", async () => {
    const d = await decidirVinculo({
      existente: null,
      porTelefone: foraDoEscopo,
      porCpf: nadaAchado,
      clienteJaDeOutroAluno: clienteLivre,
    });
    expect(d).toEqual({ acao: "nao_encontrado", motivo: "FORA_DO_ESCOPO" });
  });
});
