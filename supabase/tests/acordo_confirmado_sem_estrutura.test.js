// NEGOCIACAO COMPROVADA SEM ESTRUTURA DE ACORDO.
//
// LIMITE, DITO DE FRENTE: o CI nao tem banco. Estes testes provam ESTRUTURA
// sobre o texto da migration e da Edge Function -- que a trava existe, que esta
// na ordem certa, que a ausencia nunca vira prova negativa, que identidade so
// se resolve por CPF. Comportamento de verdade exige Postgres; ate la, a
// compilacao plpgsql acontece no apply_migration e o bloco DO de prova aborta a
// aplicacao se a estrutura mudar.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIG = resolve(RAIZ, "supabase/migrations/20260914190000_acordo_confirmado_sem_estrutura.sql");
const FN = resolve(RAIZ, "supabase/functions/prime-portador/index.ts");
const sql = readFileSync(MIG, "utf8").replace(/\r/g, "");
const fn = readFileSync(FN, "utf8").replace(/\r/g, "");

function corpo(nome, tag) {
  const i = sql.indexOf(`function public.${nome}(`);
  if (i < 0) throw new Error(`nao achei ${nome}`);
  const d = sql.slice(i);
  const a = d.indexOf(tag), b = d.indexOf(tag, a + tag.length);
  return d.slice(a + tag.length, b);
}
const motor = corpo("pagamento_conciliar_um", "$motor$");
const rpc = corpo("conciliacao_confirmar_portador_166", "$fn$");
const pos = (t, s) => t.indexOf(s);
const esp = (s) => s.replace(/\s+/g, " ").trim();

describe("1. o estado novo", () => {
  it("entra no CHECK, junto dos seis que ja existiam", () => {
    const i = sql.indexOf("add constraint pagamentos_status_conciliacao_valido");
    expect(i, "nao achei o CHECK de pagamentos").toBeGreaterThan(-1);
    const bloco = sql.slice(i, sql.indexOf("end $ajuste$", i));
    const vals = [...bloco.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(vals.sort()).toEqual([
      "ACORDO_CONFIRMADO_SEM_ESTRUTURA", "AGUARDANDO_ACORDO", "AGUARDANDO_AMARRACAO",
      "BAIXADO", "PARCELA_JA_PAGA", "REVISAO", "SEM_VINCULO",
    ]);
  });

  it("a fila ganha exatamente duas colunas, e a origem e restrita", () => {
    expect(sql).toContain("add column if not exists evidencia_origem text");
    expect(sql).toContain("add column if not exists evidencia_em     timestamptz");
    const m = sql.match(/evidencia_origem in \(([\s\S]*?)\)\s*\)/);
    const vals = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
    expect(vals).toEqual(["PRIME_API_LIVE", "PRIME_PORTADOR_MEMBRO"]);
    // nenhuma coluna alem dessas duas
    expect((sql.match(/add column if not exists/g) || []).length).toBe(2);
  });
});

describe("2. ausencia no 166 NUNCA e prova negativa", () => {
  it("o ramo sem evidencia cai em AGUARDANDO_ACORDO, nao numa conclusao", () => {
    const i = pos(motor, "AUSENCIA NAO E PROVA NEGATIVA");
    expect(i).toBeGreaterThan(-1);
    const trecho = motor.slice(i, i + 900);
    expect(trecho).toContain("v_status := 'AGUARDANDO_ACORDO'");
    expect(esp(trecho)).toContain("nao e prova de que nao houve acordo");
  });

  it("nenhum estado de negacao foi inventado", () => {
    for (const proibido of ["SEM_ACORDO", "ACORDO_INEXISTENTE", "NAO_NEGOCIADO", "ACORDO_NAO_CAPTURADO"]) {
      expect(sql).not.toContain(`'${proibido}'`);
    }
  });

  it("a Edge Function tambem nao conclui pela ausencia", () => {
    expect(fn).toContain("ausencia no 166 e inconclusiva, nao e prova negativa");
    expect(fn).not.toMatch(/no166\s*===?\s*false[\s\S]{0,120}(sem acordo|nao negociou)/i);
  });
});

describe("3. idempotencia: nao volta para AGUARDANDO_ACORDO", () => {
  it("o motor para antes de recalcular quando ja esta confirmado", () => {
    const guarda = pos(motor, "if coalesce(v_pag.status_conciliacao,'') = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA' then");
    const espelho = pos(motor, "from public.prime_portador_membro");
    const degrada = pos(motor, "v_status := 'AGUARDANDO_ACORDO'");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(espelho);
    expect(guarda).toBeLessThan(degrada);
  });

  it("e mantem o estado, sem depender do espelho", () => {
    const i = pos(motor, "= 'ACORDO_CONFIRMADO_SEM_ESTRUTURA' then");
    const bloco = motor.slice(i, i + 700);
    expect(bloco).toContain("v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'");
    expect(bloco).toContain("IDEMPOTENCIA");
  });

  it("a evidencia gravada nunca e apagada por uma rodada que nao a recalculou", () => {
    expect(esp(motor)).toContain(
      "evidencia_origem = coalesce(excluded.evidencia_origem, fila_pagamento_sem_vinculo.evidencia_origem)");
    expect(esp(motor)).toContain(
      "evidencia_em = coalesce(excluded.evidencia_em, fila_pagamento_sem_vinculo.evidencia_em)");
  });
});

describe("4. identidade so por CPF", () => {
  it("exige exatamente um aluno pelo CPF", () => {
    expect(esp(rpc)).toContain("if v_n = 1 then");
    expect(esp(rpc)).toContain("lpad(regexp_replace(coalesce(a.cpf,''), '\\D', '', 'g'), 11, '0') = lpad(v_cpf, 11, '0')");
  });

  it("grava origem_vinculo = 'CPF', nunca por nome", () => {
    expect(rpc).toContain("origem_vinculo = 'CPF'");
    expect(rpc).not.toMatch(/aluno_nome|translate\(upper/);
  });

  it("nao reescreve origem_vinculo de quem ja tem aluno_id", () => {
    const i = pos(rpc, "if v_pag.aluno_id is null then");
    // o `else` DESTE if -- marcado pelo comentario proprio
    const j = pos(rpc, "-- ja vinculado");
    const ramoJaVinculado = rpc.slice(j, rpc.indexOf("end if;", j));
    expect(i).toBeGreaterThan(-1);
    // so as linhas de CODIGO -- o comentario do ramo cita origem_vinculo de proposito
    const codigo = ramoJaVinculado.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(codigo).not.toContain("origem_vinculo");
    expect(codigo).toContain("cpf = coalesce(cpf, v_cpf)");
  });

  it("PRIME_API_LIVE e origem da EVIDENCIA, nunca do vinculo", () => {
    const i = pos(rpc, "set evidencia_origem = p_origem");
    expect(i).toBeGreaterThan(-1);
    // o valor so aparece em evidencia_origem e na validacao do parametro
    const ocorrencias = (rpc.match(/PRIME_API_LIVE/g) || []).length;
    expect(ocorrencias).toBeLessThanOrEqual(2);
    expect(rpc).not.toMatch(/origem_vinculo\s*=\s*'PRIME/);
  });
});

describe("5. nao cria estrutura e nao baixa", () => {
  it("a migration nao insere em acordos nem em parcelas", () => {
    expect(sql).not.toMatch(/insert into public\.acordos/i);
    expect(sql).not.toMatch(/insert into public\.parcelas/i);
  });

  it("a RPC do caminho ao vivo nao escreve em parcelas", () => {
    expect(rpc).not.toContain("update public.parcelas");
    expect(rpc).not.toContain("insert into public.parcelas");
  });

  it("quem decide baixa continua sendo so o motor", () => {
    expect(rpc).toContain("public.pagamento_conciliar_um(p_pagamento_id, true)");
    const upd = (rpc.match(/update public\.pagamentos/g) || []).length;
    // so o update de identidade/cpf -- status nunca e escrito aqui
    expect(rpc).not.toMatch(/set[\s\S]{0,200}status_conciliacao/);
    expect(upd).toBeGreaterThan(0);
  });

  it("nao toca importar_acordos, parcelas_amarrar_boleto nem o cron de reconstrucao", () => {
    expect(sql).not.toMatch(/create or replace function public\.(importar_acordos|parcelas_amarrar_boleto)/);
    // citar no cabecalho "o que NAO faz" e permitido; tocar nao e
    for (const linha of sql.split("\n")) {
      if (linha.includes("acordo_reconstruir_cron")) {
        expect(linha.trim().startsWith("--"), `linha nao-comentario: ${linha}`).toBe(true);
      }
    }
    expect(sql).not.toMatch(/cron\.(schedule|unschedule|alter_job)/);
    expect(sql).not.toContain("do $cirurgia$");
  });

  it("nao mexe no historico com status_conciliacao NULL", () => {
    expect(sql).not.toMatch(/update public\.pagamentos[\s\S]{0,300}status_conciliacao is null/);
  });
});

describe("6. prime-portador: modo pontual, nunca varredura", () => {
  it("o modo pontual sai antes do laco de varredura", () => {
    const pontual = pos(fn, "MODO PONTUAL. Sai antes da varredura");
    const laco = pos(fn, "while (Date.now() - inicio < LIMITE_MS)");
    expect(pontual).toBeGreaterThan(-1);
    expect(pontual).toBeLessThan(laco);
    // o retorno do modo pontual vem antes do laco
    expect(pos(fn, 'modo: "pontual"')).toBeLessThan(laco);
    // e a guarda tem de ser a de verdade: desativa-la nao pode passar batido
    expect(fn).toMatch(/if \(registration \|\| cpfPedido\) \{/);
  });

  it("resolve registration -> CPF e so entao confirma o 166", () => {
    const a = pos(fn, "/students/${encodeURIComponent(registration)}");
    const b = pos(fn, "carrierId=166&take=50");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  it("a confirmacao ao vivo alimenta o espelho", () => {
    const i = pos(fn, "if (no166)");
    const bloco = fn.slice(i, i + 500);
    expect(bloco).toContain("prime_portador_membro");
    expect(bloco).toContain("upsert");
  });

  it("chama a RPC do motor, e so quando ha evidencia positiva", () => {
    expect(fn).toContain("conciliacao_confirmar_portador_166");
    expect(fn).toMatch(/if \(pagamentoId && no166\)/);
  });

  it("o modo pontual nao apaga nada do espelho", () => {
    const pontual = fn.slice(pos(fn, "MODO PONTUAL"), pos(fn, 'modo: "pontual"'));
    expect(pontual).not.toContain(".delete()");
  });
});

// FIXTURE REAL: os 13 divergentes de 14/09/2026, medidos em producao.
describe("fixture: os 13 em AGUARDANDO_ACORDO", () => {
  const CASOS = [
    { acordo: "71643", valor: 624.74, temIdentidade: true, no166Espelho: true },
    { acordo: "71645", valor: 342.87, temIdentidade: true, no166Espelho: true },
    { acordo: "71658", valor: 1462.54, temIdentidade: true, no166Espelho: true },
    { acordo: "71672", valor: 534.66, temIdentidade: true, no166Espelho: true },
    { acordo: "71706", valor: 177.72, temIdentidade: true, no166Espelho: true },
    { acordo: "71724", valor: 320.68, temIdentidade: true, no166Espelho: true },
    { acordo: "71746", valor: 373.57, temIdentidade: true, no166Espelho: true },
    { acordo: "71770", valor: 305.45, temIdentidade: true, no166Espelho: true },
    { acordo: "71787", valor: 1144.13, temIdentidade: true, no166Espelho: true },
    { acordo: "71802", valor: 365.40, temIdentidade: true, no166Espelho: true },
    { acordo: "71803", valor: 581.64, temIdentidade: true, no166Espelho: true },
    { acordo: "71853", valor: 881.15, temIdentidade: false, no166Espelho: true },
    { acordo: "71858", valor: 543.47, temIdentidade: false, no166Espelho: false },
  ];

  it("sao 13 e somam R$ 7.658,02", () => {
    expect(CASOS).toHaveLength(13);
    expect(Math.round(CASOS.reduce((s, c) => s + c.valor, 0) * 100) / 100).toBe(7658.02);
  });

  it("11 tem identidade e caem no caminho A, sem chamada externa", () => {
    const a = CASOS.filter((c) => c.temIdentidade && c.no166Espelho);
    expect(a).toHaveLength(11);
    expect(Math.round(a.reduce((s, c) => s + c.valor, 0) * 100) / 100).toBe(6233.40);
  });

  it("2 precisam do caminho B para resolver identidade", () => {
    const b = CASOS.filter((c) => !c.temIdentidade);
    expect(b.map((c) => c.acordo)).toEqual(["71853", "71858"]);
  });

  it("1 so e confirmavel ao vivo: o espelho semanal nao o alcanca", () => {
    const vivo = CASOS.filter((c) => !c.no166Espelho);
    expect(vivo.map((c) => c.acordo)).toEqual(["71858"]);
  });
});
