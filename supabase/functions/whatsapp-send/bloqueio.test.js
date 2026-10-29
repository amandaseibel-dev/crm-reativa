// Testes do registro de bloqueio de cadência da `whatsapp-send`.
//
// O QUE ESTES TESTES PROTEGEM. Em 26/10/2026 um operador do Comercial estourou
// a cota de 2 conversas novas do dia e, em vez do 403 com a frase
// "você já iniciou 2 conversas novas hoje neste número", recebeu um 500 mudo. A
// causa: `.catch(() => {})` encadeado no retorno de `supabase.rpc()`, que é
// thenable mas não é Promise. O erro nascia ANTES de a RPC sair, escapava do
// handler e virava 500 — e, de quebra, whatsapp_cadencia_bloqueios ficou com
// zero linhas desde 20/08/2026, data em que o encadeamento foi publicado.
//
// O caso 6 é o âncora da regressão: ele dubla o PostgrestFilterBuilder com a
// MESMA forma que o de produção tem (then sim, catch não) e prova, no mesmo
// arquivo, que o padrão antigo estoura e o novo não.
//
// O QUE ELES NÃO COBREM, DE PROPÓSITO: as travas da RPC
// `whatsapp_preparar_envio` (canal inativo, canal desconectado, remetente
// autorizado, dono da conversa) e os limites de `whatsapp_cadencia_checar`.
// Aquilo é regra de banco, vive em migration e não muda aqui — estes casos
// começam do ponto em que a RPC JÁ barrou e devolveu o motivo em `details`.

import { describe, it, expect } from "vitest";
import { MOTIVOS_DE_BLOQUEIO, motivoRegistravel, registrarBloqueio } from "./bloqueio.ts";

// Dublê do PostgrestFilterBuilder: thenable, SEM `catch`. É o ponto do teste —
// se um dia a forma mudar, o caso 6 avisa.
function comoOPostgrest(resposta) {
  return {
    then: (resolver) => Promise.resolve(resposta).then(resolver),
  };
}

describe("whatsapp-send / motivoRegistravel", () => {
  it("1. motivo da lista fechada é registrável", () => {
    expect(motivoRegistravel({ details: "LIMITE_OPERADOR" })).toBe("LIMITE_OPERADOR");
    for (const m of MOTIVOS_DE_BLOQUEIO) {
      expect(motivoRegistravel({ details: m })).toBe(m);
    }
  });

  it("2. INTERVALO_MINIMO fica FORA: é o 'espere N segundos' do uso normal", () => {
    expect(motivoRegistravel({ details: "INTERVALO_MINIMO" })).toBeNull();
  });

  it("3. trava de acesso não tem `details` e não vira registro", () => {
    expect(motivoRegistravel({ message: "canal inativo" })).toBeNull();
    expect(motivoRegistravel({ details: null })).toBeNull();
    expect(motivoRegistravel(null)).toBeNull();
    expect(motivoRegistravel(undefined)).toBeNull();
  });
});

describe("whatsapp-send / registrarBloqueio", () => {
  it("4. caminho feliz: RPC responde sem erro -> registrado", async () => {
    const r = await registrarBloqueio(() => comoOPostgrest({ data: null, error: null }));
    expect(r).toEqual({ registrado: true });
  });

  it("5. erro DEVOLVIDO em { data, error } não lança e não é tratado como sucesso", async () => {
    const r = await registrarBloqueio(() =>
      comoOPostgrest({ data: null, error: { message: "permission denied for table" } })
    );
    expect(r).toEqual({ registrado: false, porque: "permission denied for table" });
  });

  it("6. REGRESSÃO 26/10/2026: o que a RPC devolve NÃO tem .catch", async () => {
    const builder = comoOPostgrest({ data: null, error: null });

    // A forma exata que causou o incidente.
    expect(typeof builder.then).toBe("function");
    expect(builder.catch).toBeUndefined();
    expect(() => builder.catch(() => {})).toThrow(TypeError);

    // E o código de hoje atravessa essa mesma forma sem estourar.
    await expect(registrarBloqueio(() => builder)).resolves.toEqual({ registrado: true });
  });

  it("7. exceção de verdade (rede/abort) é contida", async () => {
    const r = await registrarBloqueio(() => Promise.reject(new Error("connection reset")));
    expect(r).toEqual({ registrado: false, porque: "connection reset" });
  });

  it("8. estouro SÍNCRONO dentro do thunk também é contido", async () => {
    const r = await registrarBloqueio(() => {
      throw new TypeError("comoOperador.rpc(...).catch is not a function");
    });
    expect(r.registrado).toBe(false);
    expect(r.porque).toContain("catch is not a function");
  });

  it("9. resposta vazia (sem campo error) conta como registrada", async () => {
    await expect(registrarBloqueio(() => comoOPostgrest(undefined))).resolves.toEqual({
      registrado: true,
    });
  });

  it("10. registrarBloqueio NUNCA rejeita, qualquer que seja a falha", async () => {
    const falhas = [
      () => comoOPostgrest({ error: { message: "x" } }),
      () => Promise.reject(new Error("y")),
      () => {
        throw new Error("z");
      },
      () => comoOPostgrest({ error: {} }),
    ];
    for (const f of falhas) {
      await expect(registrarBloqueio(f)).resolves.toBeDefined();
    }
  });
});
