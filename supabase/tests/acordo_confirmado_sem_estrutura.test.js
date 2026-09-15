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
const disp = corpo("conciliacao_consultar_portador_pendentes", "$fn$");
const reproc = corpo("conciliacao_reprocessar", "$fn$");
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

  it("a fila ganha exatamente quatro colunas, e as duas restritas tem CHECK", () => {
    // alinhamento com espacos multiplos: normalizar antes de comparar
    expect(esp(sql)).toContain("add column if not exists evidencia_origem text");
    expect(esp(sql)).toContain("add column if not exists evidencia_em timestamptz");
    const m = sql.match(/evidencia_origem in \(([\s\S]*?)\)\s*\)/);
    const vals = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
    expect(vals).toEqual(["PRIME_API_LIVE", "PRIME_PORTADOR_MEMBRO"]);
    // a terceira e o controle de tentativa do caminho B
    expect(esp(sql)).toContain("add column if not exists consulta_portador_em timestamptz");
    // a quarta e o RESULTADO da consulta oficial, restrita a tres valores
    expect(esp(sql)).toContain("add column if not exists consulta_estrutura_resultado text");
    const r = sql.match(/consulta_estrutura_resultado in \(([\s\S]*?)\)\s*\)/);
    expect(r, "nao achei o CHECK de consulta_estrutura_resultado").toBeTruthy();
    const vr = [...r[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
    expect(vr).toEqual(["ENCONTRADA", "ERRO", "NAO_ENCONTRADA"]);
    // e nenhuma alem das quatro
    expect((sql.match(/add column if not exists/g) || []).length).toBe(4);
  });
});

describe("2. ausencia no 166 NUNCA e prova negativa", () => {
  it("o ramo sem evidencia cai em AGUARDANDO_ACORDO, nao numa conclusao", () => {
    const i = pos(motor, "AUSENCIA NAO E PROVA NEGATIVA");
    expect(i).toBeGreaterThan(-1);
    const trecho = motor.slice(i, pos(motor, "elsif v_livres > 0"));
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
    // o coalesce protege contra apagar; o case, contra rebaixar LIVE (teste 8)
    expect(esp(motor)).toContain(
      "else coalesce(excluded.evidencia_origem, fila_pagamento_sem_vinculo.evidencia_origem) end");
    expect(esp(motor)).toContain(
      "else coalesce(excluded.evidencia_em, fila_pagamento_sem_vinculo.evidencia_em) end");
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

// ---------------------------------------------------------------------------
// Correcoes da revisao do PR #379
// ---------------------------------------------------------------------------

describe("7. CPF exato na busca do 166 -- `search` e substring", () => {
  it("filtra pelo CPF identico antes de concluir no166", () => {
    expect(fn).toContain("const doCpf = achados.filter((i) => digitos(i?.cpf) === cpf)");
    expect(fn).toContain("const no166 = doCpf.length > 0");
    // o erro que isso corrige: aceitar qualquer linha devolvida
    expect(fn).not.toMatch(/const no166 = (achados|registrations)\.length > 0/);
  });

  it("as registrations saem apenas das linhas do proprio CPF", () => {
    expect(fn).toContain("doCpf.map((i) => i?.registration)");
    expect(fn).not.toMatch(/registrations = \[\.\.\.new Set\(achados\.map/);
  });

  it("registra se a registration do arquivo esta entre as do CPF", () => {
    expect(fn).toContain("registrationConfere");
    expect(fn).toContain("registrations.includes(registration)");
  });
});

describe("8. a origem LIVE nunca e rebaixada", () => {
  it("o ON CONFLICT preserva PRIME_API_LIVE em vez de trocar", () => {
    expect(esp(motor)).toContain(
      "evidencia_origem = case when fila_pagamento_sem_vinculo.evidencia_origem = 'PRIME_API_LIVE' then 'PRIME_API_LIVE'");
    expect(esp(motor)).toContain(
      "evidencia_em = case when fila_pagamento_sem_vinculo.evidencia_origem = 'PRIME_API_LIVE' then fila_pagamento_sem_vinculo.evidencia_em");
  });

  it("LIVE -> grava espelho -> motor -> continua LIVE", () => {
    // a Edge grava o espelho ANTES da RPC; a RPC marca LIVE; o motor roda depois
    const gravaEspelho = pos(fn, "prime_portador_membro");
    // a CHAMADA, nao a mencao: o comentario da etapa de identidade cita a RPC
    // para explicar por que NAO a usa ali
    const chamaRpc = pos(fn, 'supa.rpc("conciliacao_confirmar_portador_166"');
    expect(gravaEspelho).toBeLessThan(chamaRpc);
    // e a RPC marca LIVE antes de chamar o motor
    const marca = pos(rpc, "set evidencia_origem = p_origem");
    const motorCall = pos(rpc, "public.pagamento_conciliar_um(p_pagamento_id, true)");
    expect(marca).toBeGreaterThan(-1);
    expect(marca).toBeLessThan(motorCall);
    // entao a unica defesa possivel e a precedencia no ON CONFLICT
    expect(motor).toContain("PRECEDENCIA DA EVIDENCIA");
  });
});

describe("9. concordancia Santander antes de promover", () => {
  it("compara titulo_numero normalizado com o prefixo do boleto", () => {
    expect(esp(motor)).toContain("v_acordo_do_boleto := ltrim(v_pref, '0')");
    expect(esp(motor)).toContain(
      "v_tit := nullif(ltrim(regexp_replace(coalesce(v_pag.titulo_numero,''), '\\D', '', 'g'), '0'), '')");
    expect(esp(motor)).toContain("v_concorda := (v_tit is not null and v_tit = v_acordo_do_boleto)");
  });

  it("sem concordancia NAO promove: vai para REVISAO", () => {
    const i = pos(motor, "if not v_concorda then");
    expect(i).toBeGreaterThan(-1);
    const ramo = motor.slice(i, motor.indexOf("else", i));
    expect(ramo).toContain("v_status := 'REVISAO'");
    expect(ramo).not.toContain("ACORDO_CONFIRMADO_SEM_ESTRUTURA");
  });

  it("a promocao so acontece dentro do ramo que concorda", () => {
    const i = pos(motor, "if not v_concorda then");
    const fim = pos(motor, "          else\n            -- AUSENCIA NAO E PROVA NEGATIVA");
    const bloco = motor.slice(i, fim > i ? fim : i + 2000);
    const promocoes = (bloco.match(/v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'/g) || []).length;
    expect(promocoes).toBe(1);
  });

  it("o sufixo do boleto continua sem virar numero de parcela", () => {
    expect(motor).not.toMatch(/right\(.*numero_parcela_completo.*4\)/);
    expect(esp(motor)).toContain("nao e numero de parcela");
  });
});

describe("10. o caminho B e automatico", () => {
  it("o disparador existe e so olha AGUARDANDO_ACORDO", () => {
    expect(esp(disp)).toContain("p.status_conciliacao = 'AGUARDANDO_ACORDO'");
  });

  it("pula quem ja tem evidencia REGISTRADA, mas nao quem so esta no espelho", () => {
    expect(esp(disp)).toContain("f.evidencia_origem is null");
    // o espelho prova negociacao, nao ausencia de estrutura: nao pode ser filtro
    expect(disp).not.toMatch(/not exists[\s\S]{0,200}prime_portador_membro/);
  });

  it("so pega quem tem registration utilizavel", () => {
    expect(disp).toMatch(/~ '\^\\d\{6,12\}\$'/);
  });

  it("uma tentativa por dia por caso, marcada ANTES da chamada", () => {
    expect(esp(disp)).toContain("f.consulta_portador_em < now() - interval '24 hours'");
    const marca = pos(disp, "set consulta_portador_em = now()");
    const chamada = pos(disp, "net.http_post");
    expect(marca).toBeGreaterThan(-1);
    expect(marca).toBeLessThan(chamada);
  });

  it("teto pequeno por rodada e disjuntor de carga", () => {
    expect(sql).toContain("p_limite int default 5");
    expect(disp).toContain("sistema_sob_carga");
    expect(disp).toContain("limit greatest(coalesce(p_limite, 5), 0)");
  });

  it("reusa o padrao de net.http_post + x-rotina-token do Vault", () => {
    expect(disp).toContain("net.http_post");
    expect(disp).toContain("x-rotina-token");
    expect(disp).toContain("name = 'projeto_url'");
    expect(disp).toContain("name = 'prime_cadastro_token'");
  });

  it("a rodada horaria dispara, e so no modo aplicado", () => {
    expect(reproc).toContain("conciliacao_consultar_portador_pendentes(5)");
    const i = pos(reproc, "if p_aplicar then");
    const j = pos(reproc, "conciliacao_consultar_portador_pendentes");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("NUNCA dentro do gatilho de INSERT nem no motor", () => {
    expect(motor).not.toContain("net.http");
    expect(motor).not.toContain("conciliacao_consultar_portador_pendentes");
    expect(sql).toContain("o gatilho de INSERT faz chamada externa");
  });

  it("falha do disparo nao derruba a conciliacao", () => {
    expect(reproc).toContain("exception when others then");
  });
});

describe("11. hardening da RPC", () => {
  it("confere por conta propria a linha do 166 no espelho", () => {
    const i = pos(rpc, "SEM_EVIDENCIA_166_NO_ESPELHO");
    const marca = pos(rpc, "set evidencia_origem = p_origem");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(marca);
    expect(esp(rpc)).toContain("from public.prime_portador_membro m where m.portador = 166");
  });

  it("com aluno ja vinculado, exige que o CPF coincida", () => {
    const i = pos(rpc, "CPF_DIVERGE_DO_ALUNO_VINCULADO");
    expect(i).toBeGreaterThan(-1);
    expect(esp(rpc)).toContain("v_cpf_aluno <> lpad(v_cpf,11,'0')");
  });

  it("divergindo, para: nao altera identidade nem registra evidencia", () => {
    const i = pos(rpc, "if v_pag.aluno_id is not null then");
    const fim = rpc.indexOf("end if;", pos(rpc, "CPF_DIVERGE_DO_ALUNO_VINCULADO"));
    const ramo = rpc.slice(i, fim);
    expect(ramo).toContain("return jsonb_build_object('ok', false");
    expect(ramo).not.toContain("origem_vinculo");
    // e deixa rastro
    expect(ramo).toContain("insert into public.auditoria");
  });
});

// ---------------------------------------------------------------------------
// 12. A TENTATIVA OFICIAL VEM ANTES DO FALLBACK
// ---------------------------------------------------------------------------

describe("12. CRM sem acordo -> Prime /agreements -> se vazio -> 166 -> fallback", () => {
  it("a Edge consulta /agreements ANTES da busca do 166", () => {
    const agr = pos(fn, "/agreements`, chave)");
    const busca166 = pos(fn, "carrierId=166&take=50");
    expect(agr).toBeGreaterThan(-1);
    expect(agr).toBeLessThan(busca166);
    // e a guarda tem de ser a de verdade -- desativar a tentativa nao pode
    // passar batido so porque o texto continua no arquivo
    expect(fn).toMatch(
      /if \(registration\) \{\s*\n\s*tentadas\.push\(registration\);\s*\n\s*const a = await primeGet\(`\/students\//);
  });

  it("estrutura encontrada devolve ACORDO_ENCONTRADO_NA_API e NAO cai no fallback", () => {
    const i = pos(fn, "if (estrutura) {");
    const fim = pos(fn, 'A API respondeu "não tenho acordo"');
    const ramo = fn.slice(i, fim);
    expect(ramo).toContain("ACORDO_ENCONTRADO_NA_API");
    expect(ramo).toContain("return new Response");
    // sai antes de confirmar o 166
    expect(ramo).not.toContain("carrierId=166");
  });

  it("devolve o payload CRU e nao mapeia campo nenhum para acordos/parcelas", () => {
    expect(fn).toContain("itens_brutos");
    expect(fn).toContain("campos_detectados");
    expect(fn).not.toMatch(/from\(["']acordos["']\)/);
    expect(fn).not.toMatch(/from\(["']parcelas["']\)/);
    expect(fn).not.toMatch(/valor_total|qtd_parcelas|numero_ulbra/);
  });

  it("grava o payload real em auditoria -- e o artefato que falta", () => {
    expect(fn).toContain('acao: "ACORDO_ENCONTRADO_NA_API"');
    expect(fn).toContain('from("auditoria")');
  });

  it("reporta compatibilidade com titulo_numero, sem usar para mapear", () => {
    expect(fn).toContain("bate_titulo_numero");
    expect(fn).toContain("tem_newInstallments");
  });

  it("o motor le o RESULTADO da consulta, e o le antes de promover", () => {
    const decl = pos(motor, "select f.consulta_estrutura_resultado into v_estrutura");
    const uso = pos(motor, "and coalesce(v_estrutura,'') = 'NAO_ENCONTRADA' then");
    const promove = pos(motor, "v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';\n              v_motivo := 'negociacao comprovada: o aluno esta no portador 166");
    expect(decl).toBeGreaterThan(-1);
    expect(uso).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(uso);
    expect(uso).toBeLessThan(promove >= 0 ? promove : Number.MAX_SAFE_INTEGER);
  });

  it("sem consulta o caso fica pendente, e o motivo diz o que falta", () => {
    expect(esp(motor)).toContain("a API oficial ainda nao foi consultada para este caso");
  });

  // RESULTADO MEDIDO do caminho, nos 13 divergentes (14/09/2026)
  it("nos 13 medidos o caminho termina no fallback: /agreements vazio, 166 positivo", () => {
    const MEDIDO = { casos: 13, agreements_com_conteudo: 0, newInstallments: 0, no166: 13 };
    expect(MEDIDO.agreements_com_conteudo).toBe(0);
    expect(MEDIDO.newInstallments).toBe(0);
    expect(MEDIDO.no166).toBe(MEDIDO.casos);
  });
});

// ---------------------------------------------------------------------------
// 13. O RESULTADO DA CONSULTA, E NAO A TENTATIVA, DECIDE O FALLBACK
// ---------------------------------------------------------------------------
//
// `consulta_portador_em` e carimbada ANTES da chamada -- ela diz "tentei", e
// "tentei" nao distingue "a API respondeu que nao tem" de "a API caiu". O
// fallback so pode nascer do primeiro caso. Os oito testes abaixo sao os oito
// cenarios pedidos: os quatro da Edge (500, timeout, lista vazia, lista com
// item) e os quatro do motor (ENCONTRADA / ERRO / NULL nunca promovem; so
// NAO_ENCONTRADA + 166 + Santander coerente promove).

const recorder = corpo("conciliacao_registrar_consulta_estrutura", "$fn$");

// O trecho da Edge entre a tentativa oficial e a busca do 166.
const tentativa = fn.slice(pos(fn, "TENTATIVA OFICIAL, antes de qualquer fallback"), pos(fn, "carrierId=166&take=50"));

describe("13. Edge: cada resposta de /agreements grava o seu resultado", () => {
  it("a coluna so e escrita por uma RPC que valida o valor", () => {
    expect(recorder).toContain("not in ('NAO_ENCONTRADA','ENCONTRADA','ERRO')");
    expect(recorder).toContain("raise exception 'resultado invalido: %'");
    expect(recorder).toContain("set consulta_estrutura_resultado = p_resultado");
    // recorder PURO: nao decide nada, nao chama o motor, nao toca identidade
    expect(recorder).not.toContain("pagamento_conciliar_um");
    expect(recorder).not.toContain("update public.pagamentos");
    expect(recorder).not.toContain("evidencia_origem");
    // e a Edge escreve por ela, nao por UPDATE direto na tabela
    expect(fn).toContain('supa.rpc("conciliacao_registrar_consulta_estrutura"');
    expect(fn).not.toMatch(/from\(["']fila_pagamento_sem_vinculo["']\)/);
  });

  // (1) /agreements responde 500
  // (2) /agreements estoura o tempo
  // `primeGet` colapsa 4xx/5xx, timeout, excecao de rede e JSON invalido no
  // mesmo `ok: false` -- entao a MESMA guarda cobre os dois cenarios, e o
  // teste tem de provar que a guarda existe e que ela PARA a execucao.
  it("500 e timeout caem na mesma guarda, gravam ERRO e NAO consultam o 166", () => {
    // a guarda literal -- desativa-la tem de quebrar este teste
    expect(tentativa).toContain("if (!a.ok) {");
    const i = pos(tentativa, "if (!a.ok) {");
    const ramo = tentativa.slice(i, pos(tentativa, "const d: any = a.dados;"));
    expect(ramo).toContain('registraResultado("ERRO")');
    // PARA AQUI: o ramo devolve antes de qualquer coisa
    expect(ramo).toContain("return new Response");
    // e nao ha busca do 166 dentro dele
    expect(ramo).not.toContain("carrierId=166");
    // o ERRO e gravado ANTES do return, senao nao e gravado nunca
    expect(pos(ramo, 'registraResultado("ERRO")')).toBeLessThan(pos(ramo, "return new Response"));
  });

  it("primeGet devolve ok:false em 4xx/5xx, em excecao e em JSON invalido", () => {
    const pg = fn.slice(pos(fn, "async function primeGet"), pos(fn, "Deno.serve"));
    // 4xx/5xx
    expect(pg).toContain("if (!r.ok) return { ok: false as const, status: r.status };");
    // excecao de rede E json invalido: `await r.json()` esta DENTRO do try
    const tentar = pg.slice(pos(pg, "try {"), pos(pg, "} catch"));
    expect(tentar).toContain("await r.json()");
    // esgotadas as tentativas, ok:false -- nunca ok:true sem dados
    expect(pg).toContain("return { ok: false as const, status: 0 };");
  });

  it("200 com forma desconhecida e ERRO, nao 'zero itens'", () => {
    // `itens` so e [] quando a API REALMENTE devolveu uma lista; forma que nao
    // se reconhece vira null, e null cai no mesmo ERRO que a queda da API
    expect(tentativa).toContain("const itens: any[] | null = Array.isArray(d?.items) ? d.items");
    expect(tentativa).toContain(": (Array.isArray(d) ? d : null);");
    const i = pos(tentativa, "if (itens === null) {");
    expect(i).toBeGreaterThan(-1);
    const ramo = tentativa.slice(i, pos(tentativa, "if (itens.length > 0) {"));
    expect(ramo).toContain('registraResultado("ERRO")');
    expect(ramo).toContain("return new Response");
    expect(ramo).not.toContain("carrierId=166");
    // o fallback silencioso para lista vazia nao pode voltar
    expect(tentativa).not.toContain("Array.isArray(d) ? d : []");
  });

  // (3) lista vazia
  it("lista vazia grava NAO_ENCONTRADA e SEGUE para o 166", () => {
    const i = pos(tentativa, "} else {");
    expect(i).toBeGreaterThan(-1);
    const ramo = tentativa.slice(i, pos(tentativa, "veio estrutura -> NÃO é caso de fallback"));
    expect(ramo).toContain('registraResultado("NAO_ENCONTRADA")');
    // este e o unico ramo que nao devolve: a execucao continua para o 166
    expect(ramo).not.toContain("return new Response");
    expect(pos(fn, 'registraResultado("NAO_ENCONTRADA")'))
      .toBeLessThan(pos(fn, "carrierId=166&take=50"));
  });

  // (4) lista com item
  it("lista com item grava ENCONTRADA, devolve o payload e NAO consulta o 166", () => {
    const i = pos(tentativa, "if (itens.length > 0) {");
    expect(i).toBeGreaterThan(-1);
    const ramo = tentativa.slice(i, pos(tentativa, "} else {"));
    expect(ramo).toContain('registraResultado("ENCONTRADA")');
    const saida = fn.slice(pos(fn, "if (estrutura) {"), pos(fn, 'A API respondeu "não tenho acordo"'));
    expect(saida).toContain("ACORDO_ENCONTRADO_NA_API");
    expect(saida).toContain("return new Response");
    expect(saida).not.toContain("carrierId=166");
    // e continua sem criar acordo ou parcela
    expect(saida).not.toMatch(/from\(["'](acordos|parcelas)["']\)/);
  });

  it("a data de tentativa nunca e usada como resultado", () => {
    // na Edge a coluna aparece so em comentario -- codigo nenhum a le ou escreve
    const fnCodigo = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(fnCodigo).not.toContain("consulta_portador_em");
    // e o disparador so a usa como janela de 24h
    expect(disp).toContain("f.consulta_portador_em < now() - interval '24 hours'");
    expect(disp).toContain("set consulta_portador_em = now()");
    // e o disparador nunca FILTRA nem ESCREVE o resultado: a coluna so aparece
    // no comentario que explica de quem e a responsabilidade
    const dispCodigo = disp.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(dispCodigo).not.toContain("consulta_estrutura_resultado");
  });
});

describe("13b. motor: so NAO_ENCONTRADA promove", () => {
  // O ramo do fallback, inteiro, do `elsif` ate o `else` da ausencia.
  const ramo = motor.slice(
    pos(motor, "elsif v_cpf_pag is not null"),
    pos(motor, "AUSENCIA NAO E PROVA NEGATIVA"));

  it("a tentativa saiu do motor de vez", () => {
    expect(motor).not.toContain("v_tentou_oficial");
    expect(motor).not.toContain("consulta_portador_em is not null");
    // o motor nem le mais a coluna de tentativa
    expect(motor).not.toContain("consulta_portador_em");
  });

  // (5) ENCONTRADA + CPF no espelho do 166 -> nunca promove
  // (6) ERRO + CPF no espelho -> nunca promove
  // (7) NULL + CPF no espelho -> nunca promove
  // Os tres sao o MESMO teste em plpgsql: a guarda e uma igualdade a um unico
  // valor, entao qualquer outro -- e NULL, por causa do coalesce -- cai fora.
  it("a guarda e igualdade a NAO_ENCONTRADA, o que exclui ENCONTRADA, ERRO e NULL", () => {
    expect(ramo).toContain("and coalesce(v_estrutura,'') = 'NAO_ENCONTRADA' then");
    // coalesce, e nao `= 'NAO_ENCONTRADA'` cru: sem ele NULL daria NULL e o
    // `and` nao entraria -- correto por acidente, e por acidente nao serve.
    expect(ramo).not.toMatch(/and v_estrutura = 'NAO_ENCONTRADA'/);
    // e nao ha nenhum outro caminho para o estado dentro deste ramo
    expect(ramo).not.toContain("'ENCONTRADA' then");
    expect(ramo).not.toContain("'ERRO' then");
    expect(ramo).not.toContain("v_estrutura is not null");
    expect(ramo).not.toContain("v_estrutura <>");
  });

  it("ENCONTRADA, ERRO e NULL ficam em AGUARDANDO_ACORDO, cada um com o seu motivo", () => {
    const pendente = motor.slice(pos(motor, "AUSENCIA NAO E PROVA NEGATIVA"));
    expect(pendente).toContain("v_status := 'AGUARDANDO_ACORDO'");
    expect(esp(pendente)).toContain("a API oficial DEVOLVEU estrutura para este acordo");
    expect(esp(pendente)).toContain("a consulta a API oficial falhou");
    expect(esp(pendente)).toContain("a API oficial ainda nao foi consultada");
    // e nenhum deles vira o estado de confirmacao
    const ate = pendente.slice(0, pos(pendente, "elsif v_livres > 0"));
    expect(ate).not.toContain("ACORDO_CONFIRMADO_SEM_ESTRUTURA");
  });

  // (8) NAO_ENCONTRADA + 166 + Santander coerente -> promove
  it("promover exige as TRES coisas juntas: resultado, 166 e concordancia", () => {
    const cond = ramo.slice(0, pos(ramo, "if not v_concorda then"));
    // 166
    expect(cond).toContain("m.portador = 166");
    expect(cond).toContain("exists (select 1 from public.prime_portador_membro m");
    // resultado
    expect(cond).toContain("'NAO_ENCONTRADA'");
    // concordancia -- quem discorda vai para REVISAO, nao para o fallback
    const discorda = ramo.slice(pos(ramo, "if not v_concorda then"), pos(ramo, "else"));
    expect(discorda).toContain("v_status := 'REVISAO'");
    expect(discorda).not.toContain("ACORDO_CONFIRMADO_SEM_ESTRUTURA");
    // ha exatamente UMA promocao neste ramo, e ela mora depois do `else` da
    // concordancia -- nao existe atalho que chegue nela por fora das tres
    const ocorrencias = (ramo.match(/ACORDO_CONFIRMADO_SEM_ESTRUTURA/g) || []).length;
    expect(ocorrencias).toBe(1);
    expect(pos(ramo, "ACORDO_CONFIRMADO_SEM_ESTRUTURA"))
      .toBeGreaterThan(pos(ramo, "if not v_concorda then"));
  });

  it("o bloco de prova da migration aborta se a tentativa voltar a decidir", () => {
    const prova = sql.slice(pos(sql, "do $prova$"));
    expect(prova).toContain("ilike '%v_tentou_oficial%' then");
    expect(prova).toContain("not ilike '%= ''NAO_ENCONTRADA''%' then");
    expect(prova).toContain("fila_pag_consulta_estrutura_valida");
    expect(prova).toContain("conciliacao_registrar_consulta_estrutura(uuid, text)");
    expect(prova).toContain("if v_n <> 4 then");
  });

  it("o rollback remove o recorder e mantem as quatro colunas", () => {
    const rb = readFileSync(
      resolve(RAIZ, "supabase/rollbacks/20260914190000_acordo_confirmado_sem_estrutura.rollback.sql"),
      "utf8");
    expect(rb).toContain("drop function if exists public.conciliacao_registrar_consulta_estrutura(uuid, text);");
    expect(rb).toContain("consulta_estrutura_resultado");
    expect(rb).not.toMatch(/drop column[^\n]*consulta_estrutura_resultado/);
    expect(rb).toContain("'alguma das quatro colunas da fila foi apagada -- nao deveria'");
  });
});
