// O MOTOR UNICO DE CONCILIACAO.
//
// LIMITE DESTE TESTE, DITO DE FRENTE: o CI nao tem banco. Estes testes NAO
// executam SQL -- eles provam ESTRUTURA sobre o texto da migration: que a trava
// existe, que ela esta ANTES da escrita, que o escopo esta no WHERE, que nao ha
// DML fora do caminho de aplicacao. Um teste de comportamento de verdade exige
// um Postgres; enquanto nao houver, a compilacao dos corpos plpgsql acontece no
// `apply_migration` (check_function_bodies esta on em producao) e o bloco DO de
// prova no fim da propria migration aborta a aplicacao se a estrutura mudar.
//
// Cada `it` abaixo corresponde a um dos casos exigidos na revisao de 14/09.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIGRATION = resolve(RAIZ, "supabase/migrations/20260914170000_motor_unico_de_conciliacao.sql");
const sql = readFileSync(MIGRATION, "utf8").replace(/\r/g, "");

function corpo(nome, tag) {
  const i = sql.indexOf(`function public.${nome}(`);
  if (i < 0) throw new Error(`nao achei ${nome}`);
  const d = sql.slice(i);
  const a = d.indexOf(tag);
  const b = d.indexOf(tag, a + tag.length);
  if (a < 0 || b < 0) throw new Error(`nao achei o corpo de ${nome}`);
  return d.slice(a + tag.length, b);
}

const motor = corpo("pagamento_conciliar_um", "$motor$");
const reproc = corpo("conciliacao_reprocessar", "$fn$");
const gatilho = corpo("_pagamento_conciliar", "$fn$");
const relatorio = corpo("baixa_pelo_relatorio_pagamento", "$fn$");

const pos = (t, s) => t.indexOf(s);
const espacos = (s) => s.replace(/\s+/g, " ").trim();

describe("1. histórico com status_conciliacao NULL nunca é reprocessado", () => {
  it("o reprocessador filtra por status_conciliacao IS NOT NULL", () => {
    expect(espacos(reproc)).toContain("where p.status_conciliacao is not null");
    expect(espacos(reproc)).toContain("and p.status_conciliacao <> 'BAIXADO'");
  });

  it("não existe outra varredura de pagamentos sem esse filtro", () => {
    const froms = [...reproc.matchAll(/from\s+public\.pagamentos/g)];
    expect(froms).toHaveLength(1);
  });

  it("o que a gestão já decidiu não volta sozinho para a fila", () => {
    expect(espacos(reproc)).toContain("f.pagamento_id = p.id and f.decisao is not null");
  });

  it("a delegação do relatório não pode virar backfill histórico", () => {
    expect(relatorio).toContain("p_incluir_historicos");
    // pedir historico levanta erro em vez de varrer os ~9.000 antigos
    const i = pos(relatorio, "p_incluir_historicos, false");
    const j = pos(relatorio, "raise exception 'Varredura historica");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});

describe("2. o mesmo pagamento reprocessado duas vezes gera uma baixa só", () => {
  it("a trava de idempotência é por origem_baixa_ref = pagamento_id", () => {
    expect(espacos(motor)).toContain(
      "coalesce(v_parcela.origem_baixa_ref,'') = p_pagamento_id::text",
    );
  });

  it("a trava vem ANTES de qualquer ramo que possa escrever", () => {
    const trava = pos(motor, "origem_baixa_ref,'') = p_pagamento_id::text");
    const update = pos(motor, "update public.parcelas");
    const jaPaga = pos(motor, "v_status := 'PARCELA_JA_PAGA'");
    expect(trava).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(update);
    // e antes do ramo de "outro baixou": senao a propria baixa viraria pendencia
    expect(trava).toBeLessThan(jaPaga);
  });

  it("o UPDATE da parcela ainda se protege sozinho contra rebaixar", () => {
    const upd = motor.match(/update public\.parcelas[\s\S]*?where id = v_parcela\.id[\s\S]*?;/);
    expect(upd).toBeTruthy();
    expect(espacos(upd[0])).toContain("upper(coalesce(status,'')) <> 'PAGO'");
  });

  it("e a baixa só é contada quando o UPDATE realmente pegou a linha", () => {
    const i = pos(motor, "where id = v_parcela.id");
    const j = pos(motor, "if found then");
    expect(j).toBeGreaterThan(i);
    expect(espacos(motor.slice(j, j + 120))).toContain("v_baixou := true");
  });
});

describe("3. parcela já PAGO nunca baixa de novo", () => {
  it("o ramo de PAGO por outro classifica e não escreve em parcelas", () => {
    const ini = pos(motor, "elsif v_parcela.status = 'PAGO' then");
    const fim = pos(motor, "elsif upper(coalesce(v_parcela.status_acordo,''))");
    expect(ini).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(ini);
    expect(motor.slice(ini, fim)).not.toContain("update public.parcelas");
    expect(motor.slice(ini, fim)).toContain("v_status := 'PARCELA_JA_PAGA'");
  });

  it("não fecha sozinha: só BAIXADO fecha a fila automaticamente", () => {
    const fecha = motor.match(/if v_status = 'BAIXADO' then[\s\S]*?decisao = 'RESOLVIDO_AUTOMATICO'/);
    expect(fecha).toBeTruthy();
    expect(motor).not.toMatch(/PARCELA_JA_PAGA[\s\S]{0,400}RESOLVIDO_AUTOMATICO/);
  });

  it("computa a evidência da baixa anterior e a suspeita de duplicidade", () => {
    const ini = pos(motor, "elsif v_parcela.status = 'PAGO' then");
    const fim = pos(motor, "elsif upper(coalesce(v_parcela.status_acordo,''))");
    const ramo = motor.slice(ini, fim);
    expect(ramo).toContain("from public.baixas_pagamento");
    expect(ramo).toContain("'tem_evidencia'");
    expect(ramo).toContain("pagamentos_iguais_na_base");
  });

  it("existe caminho humano de encerramento, e ele não baixa nada", () => {
    const enc = corpo("conciliacao_encerrar", "$fn$");
    expect(enc).toContain("'ENCERRADO_GESTAO'");
    expect(enc).not.toContain("update public.parcelas");
    expect(enc).toContain("usuario_e_gestao");
  });
});

describe("4 e 5. amarração fraca exige candidata única", () => {
  const ini = () => pos(motor, "elsif not coalesce(v_parcela.boleto_confiavel, false) then");
  const fim = () => pos(motor, "\n    else\n      v_status := 'BAIXA';");

  it("o ramo existe e só vale para boleto_confiavel = false", () => {
    expect(ini()).toBeGreaterThan(-1);
    expect(fim()).toBeGreaterThan(ini());
  });

  it("conta candidatas no MESMO acordo, por vencimento ±3 e faixa de valor", () => {
    const ramo = espacos(motor.slice(ini(), fim()));
    expect(ramo).toContain("c.acordo_id = v_parcela.acordo_id");
    expect(ramo).toContain("abs(c.vencimento - v_venc) <= 3");
    expect(ramo).toContain("v_pag.valor_pago >= c.valor - 0.05");
    expect(ramo).toContain("v_pag.valor_pago <= c.valor * 1.15");
    expect(ramo).toContain(
      "upper(coalesce(c.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')",
    );
  });

  it("UMA candidata, e sendo a própria parcela do boleto: pode baixar", () => {
    const ramo = espacos(motor.slice(ini(), fim()));
    expect(ramo).toContain("if v_cand = 1 and v_cand_id = v_parcela.id then v_status := 'BAIXA';");
  });

  it("DUAS ou mais candidatas: REVISAO, e o motivo diz que é ambíguo", () => {
    const ramo = motor.slice(ini(), fim());
    expect(ramo).toContain("v_status := 'REVISAO'");
    expect(espacos(ramo)).toContain("when v_cand > 1 then v_cand || ' parcelas do acordo batem: ambiguo por desenho'");
  });

  it("ZERO candidatas — inclusive arquivo sem vencimento — também é REVISAO", () => {
    const ramo = espacos(motor.slice(ini(), fim()));
    // sem vencimento nenhuma candidata qualifica: a condicao exige v_venc
    expect(ramo).toContain("and v_venc is not null");
    expect(ramo).toContain("when v_cand = 0 then 'nenhuma parcela do acordo bate");
  });

  it("boleto_confiavel = true preserva a regra anterior, sem a exigência nova", () => {
    // o ramo `else` final e o caminho da amarracao ancorada: baixa direto
    const resto = motor.slice(fim());
    expect(espacos(resto).startsWith("else v_status := 'BAIXA'; end if;")).toBe(true);
  });
});

describe("6. acordo ausente → acordo entra sem boleto → AGUARDANDO_AMARRACAO", () => {
  it("sem acordo no CRM o estado é AGUARDANDO_ACORDO", () => {
    expect(espacos(motor)).toContain("if v_acordos = 0 then v_status := 'AGUARDANDO_ACORDO';");
  });

  it("com acordo e parcela livre sem boleto, o estado é AGUARDANDO_AMARRACAO", () => {
    expect(espacos(motor)).toContain("elsif v_livres > 0 then v_status := 'AGUARDANDO_AMARRACAO';");
    expect(espacos(motor)).toContain("and p.boleto is null");
  });

  it("importar_acordos reavalia no fim, por substituição cirúrgica", () => {
    expect(sql).toContain("do $cirurgia$");
    expect(sql).toContain("perform public.conciliacao_reprocessar(true, 2000)");
    // aborta em vez de reescrever a funcao inteira se o marcador nao existir
    expect(sql).toContain("abortando sem tocar a funcao");
  });

  it("o reprocessamento NÃO força baixa: ele não escreve em parcelas", () => {
    expect(reproc).not.toContain("update public.parcelas");
    expect(reproc).toContain("public.pagamento_conciliar_um(v_id, p_aplicar)");
  });
});

describe("7. acordo entra com boleto seguro → chega a BAIXADO", () => {
  it("achar a parcela pelo boleto exato é o único caminho para a baixa", () => {
    expect(espacos(motor)).toContain("where p.boleto = v_chave limit 1");
    const atribuicoes = [...motor.matchAll(/v_status := 'BAIXA';/g)];
    // exatamente dois: o ramo da amarracao unica e o ramo da amarracao ancorada
    expect(atribuicoes).toHaveLength(2);
  });

  it("a baixa carimba a evidência canônica, com o pagamento como referência", () => {
    const upd = motor.match(/update public\.parcelas[\s\S]*?where id = v_parcela\.id[\s\S]*?;/)[0];
    expect(espacos(upd)).toContain("origem_baixa = 'GATILHO_IMPORTACAO'");
    expect(espacos(upd)).toContain("origem_baixa_ref = v_pag.id::text");
    expect(espacos(upd)).toContain("origem_baixa_em = now()");
  });

  it("e NÃO grava em baixas_pagamento — decisão da gestão em 14/09", () => {
    expect(motor).not.toContain("insert into public.baixas_pagamento");
    expect(sql).not.toContain("insert into public.baixas_pagamento");
  });

  it("toma lock por parcela antes de aplicar", () => {
    const lock = pos(motor, "pg_advisory_xact_lock");
    const upd = pos(motor, "update public.parcelas");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(upd);
  });
});

describe("8. a prévia não faz nenhum DML", () => {
  const DML = [...motor.matchAll(/(insert into public\.[a-z_]+|update public\.[a-z_]+)/g)];

  it("o motor tem exatamente as cinco escritas conhecidas", () => {
    expect(DML.map((m) => m[1])).toEqual([
      "insert into public.auditoria",
      "update public.parcelas",
      "update public.pagamentos",
      "update public.fila_pagamento_sem_vinculo",
      "insert into public.fila_pagamento_sem_vinculo",
    ]);
  });

  it("cada escrita está atrás de um portão de p_aplicar", () => {
    for (const m of DML) {
      const antes = motor.slice(0, m.index);
      const temSaidaAntecipada = /if not p_aplicar then\s*\n?\s*return/.test(antes);
      const dentroDoPortao = /if p_aplicar then[^]*$/.test(antes) && antes.lastIndexOf("if p_aplicar then") > antes.lastIndexOf("end if;");
      expect(
        temSaidaAntecipada || dentroDoPortao,
        `escrita sem portao de p_aplicar: ${m[1]}`,
      ).toBe(true);
    }
  });

  it("o registro em auditoria da recusa também respeita a prévia", () => {
    const i = pos(motor, "if p_aplicar then");
    const j = pos(motor, "insert into public.auditoria");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("a prévia devolve o estado que teria sido gravado, sem gravar", () => {
    expect(motor).toMatch(/if not p_aplicar then[\s\S]*?'aplicou', false, 'baixou', false/);
  });
});

describe("o desenho aprovado ficou de pé", () => {
  it("o gatilho do INSERT é casca e não tem regra própria", () => {
    expect(gatilho).toContain("pagamento_conciliar_um(new.id, true)");
    expect(gatilho).not.toContain("update public.parcelas");
    expect(espacos(gatilho).length).toBeLessThan(160);
  });

  it("baixa_pelo_relatorio_pagamento deixou de ter regra própria", () => {
    expect(relatorio).not.toContain("update public.parcelas");
    expect(relatorio).not.toContain("documento_casa_com_parcela");
    expect(relatorio).toContain("public.conciliacao_reprocessar");
  });

  it("parcelas_amarrar_boleto não é redefinida em lugar nenhum", () => {
    expect(sql).not.toMatch(/create or replace function public\.parcelas_amarrar_boleto/);
  });

  it("o motor não é chamável de fora", () => {
    expect(sql).toContain(
      "revoke all on function public.pagamento_conciliar_um(uuid, boolean) from public, anon, authenticated;",
    );
  });

  it("o vínculo manual da gestão também termina no motor", () => {
    const v = corpo("pagamento_vincular_aluno", "$fn$");
    expect(v).toContain("public.pagamento_conciliar_um(p_pagamento_id, true)");
    // so fecha a fila se a conciliacao terminou
    expect(espacos(v)).toContain("if coalesce(v_r->>'status','') = 'BAIXADO' then");
  });
});
