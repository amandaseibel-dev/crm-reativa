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
const ROLLBACK = resolve(
  RAIZ,
  "supabase/rollbacks/20260914170000_motor_unico_de_conciliacao.rollback.sql",
);
const rollback = readFileSync(ROLLBACK, "utf8").replace(/\r/g, "");

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

  it("a delegação do relatório não tem porta para o histórico", () => {
    // Nao existe parametro opcional para incluir historico: a unica varredura
    // possivel e a prospectiva, porque e a unica que o reprocessador faz.
    expect(relatorio).toContain("public.conciliacao_reprocessar");
    expect(relatorio).not.toMatch(/historic/i);
    expect(sql).not.toContain("p_incluir_historicos");
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
    const upd = motor.match(/update public\.parcelas[\s\S]*?where id = v_parcela_id[\s\S]*?;/);
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

  it("a migration NÃO redefine nem altera importar_acordos", () => {
    // Chamar a conciliacao dentro da transacao da importacao faria uma falha de
    // conciliacao reverter a importacao inteira de acordos. Quem reavalia e o
    // fluxo horario, depois de parcelas_amarrar_boleto e acordos_pos_importacao.
    expect(sql).not.toMatch(/create or replace function public\.importar_acordos/);
    expect(sql).not.toContain("do $cirurgia$");
    // a unica mencao permitida a importar_acordos e a prova de que ela NAO foi
    // tocada -- nenhum `execute format` reescrevendo corpo de funcao
    expect(sql).not.toMatch(/execute\s+format\(\s*\n?\s*'create or replace function/);
    expect(sql).toContain("esta migration nao deve toca-la");
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
    const upd = motor.match(/update public\.parcelas[\s\S]*?where id = v_parcela_id[\s\S]*?;/)[0];
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

// ---------------------------------------------------------------------------
// Correcoes da revisao de 14/09 -- bloqueios de runtime que os testes
// estruturais anteriores nao detectavam.
// ---------------------------------------------------------------------------

describe("9. uma única assinatura de baixa_pelo_relatorio_pagamento", () => {
  it("mantém a assinatura de dois argumentos, sem criar sobrecarga", () => {
    // Criar (boolean, date, boolean) nao substituiria (boolean, date): o
    // fluxo_pagamentos_rodar chama com dois argumentos e continuaria caindo no
    // motor antigo.
    expect(sql).toContain(
      "create or replace function public.baixa_pelo_relatorio_pagamento(\n  p_confirmar boolean default false,\n  p_desde date default '2026-07-01'::date\n)",
    );
    expect(sql).not.toContain("p_incluir_historicos");
  });

  it("derruba qualquer sobrecarga de três argumentos antes de recriar", () => {
    const drop = pos(sql, "drop function if exists public.baixa_pelo_relatorio_pagamento(boolean, date, boolean)");
    const create = pos(sql, "create or replace function public.baixa_pelo_relatorio_pagamento(");
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(create);
  });

  it("a prova da migration exige exatamente uma assinatura", () => {
    expect(sql).toContain("p.proname='baixa_pelo_relatorio_pagamento'");
    expect(sql).toContain("o cron pode chamar a antiga");
  });

  it("histórico continua fora, e não há parâmetro para trazê-lo de volta", () => {
    expect(relatorio).toContain("public.conciliacao_reprocessar");
    expect(relatorio).not.toContain("historico");
  });
});

describe("10. lock → releitura → decisão → UPDATE, nessa ordem", () => {
  it("relê status e origem_baixa_ref depois do lock e antes do UPDATE", () => {
    const lock = pos(motor, "pg_advisory_xact_lock");
    const releitura = pos(motor, "into v_re_status, v_re_ref");
    const decisao = pos(motor, "if v_re_status = 'PAGO' then");
    const update = pos(motor, "update public.parcelas");
    expect(lock).toBeGreaterThan(-1);
    expect(releitura).toBeGreaterThan(lock);
    expect(decisao).toBeGreaterThan(releitura);
    expect(update).toBeGreaterThan(decisao);
  });

  it("a releitura lê da tabela, não da foto tomada antes do lock", () => {
    // A LISTA DO SELECT importa tanto quanto o FROM: ler `v_parcela.status`
    // "from public.parcelas" compila, passa por qualquer checagem de ordem, e
    // continua usando a foto de ANTES do lock -- ou seja, nao corrige nada.
    const alvo = pos(motor, "into v_re_status, v_re_ref");
    expect(alvo, "nao achei a releitura").toBeGreaterThan(-1);
    // do ULTIMO `select` antes do into: senao a captura engole o select da
    // parcela la de cima e o teste passa a olhar o texto errado.
    const ini = motor.lastIndexOf("select", alvo);
    const lista = espacos(motor.slice(ini + "select".length, alvo));
    const resto = espacos(motor.slice(alvo, motor.indexOf(";", alvo)));
    expect(lista).toContain("p.status");
    expect(lista).toContain("p.origem_baixa_ref");
    expect(lista).not.toContain("v_parcela.");
    expect(resto).toContain("from public.parcelas p where p.id = v_parcela_id");
  });

  it("sob o lock, PAGO por mim mesmo é BAIXADO sem nova escrita", () => {
    const i = pos(motor, "if v_re_ref = p_pagamento_id::text then");
    const j = pos(motor, "        v_status := 'PARCELA_JA_PAGA';");
    expect(i).toBeGreaterThan(-1);
    expect(motor.slice(i, j)).toContain("v_status := 'BAIXADO'");
    expect(motor.slice(i, j)).not.toContain("update public.parcelas");
  });
});

describe("11. duas baixas concorrentes: a segunda não vira BAIXADO", () => {
  it("PAGO por outro, sob o lock, vira PARCELA_JA_PAGA — nunca BAIXADO", () => {
    const ini = pos(motor, "if v_re_ref = p_pagamento_id::text then");
    const fim = pos(motor, "    else\n      update public.parcelas");
    const ramo = motor.slice(ini, fim);
    expect(ramo).toContain("v_status := 'PARCELA_JA_PAGA'");
    expect(espacos(ramo)).toContain("foi baixada por outro pagamento entre a decisao e a escrita");
    expect(espacos(ramo)).toContain("Nenhuma segunda baixa foi feita");
  });

  it("e esse caminho NÃO fecha a fila automaticamente", () => {
    // so o ramo BAIXADO fecha; PARCELA_JA_PAGA fica para conferencia humana
    expect(motor).not.toMatch(/CORRIDA_NA_BAIXA[\s\S]{0,600}RESOLVIDO_AUTOMATICO/);
  });

  it("UPDATE com zero linhas nunca é chamado de BAIXADO", () => {
    const i = pos(motor, "      if found then");
    const fim = motor.indexOf("end if;", pos(motor, "estado inesperado, nada foi escrito"));
    const ramo = motor.slice(i, fim);
    // o `else` do `if found` tem de classificar como pendencia, nao como baixa
    const elseIdx = ramo.indexOf("      else");
    expect(elseIdx).toBeGreaterThan(-1);
    expect(ramo.slice(elseIdx)).toContain("v_status := 'PARCELA_JA_PAGA'");
    expect(ramo.slice(elseIdx)).not.toContain("v_status := 'BAIXADO'");
  });
});

describe("12. conciliacao_encerrar aceita somente PARCELA_JA_PAGA", () => {
  const enc = () => corpo("conciliacao_encerrar", "$fn$");

  it("recusa qualquer outro estado, com motivo", () => {
    expect(espacos(enc())).toContain("if v_st <> 'PARCELA_JA_PAGA' then");
    expect(enc()).toContain("'SO_PARCELA_JA_PAGA'");
  });

  it("a recusa vem ANTES de escrever na fila", () => {
    const guarda = pos(enc(), "v_st <> 'PARCELA_JA_PAGA'");
    const escrita = pos(enc(), "update public.fila_pagamento_sem_vinculo");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(escrita);
  });

  it("explica por que os outros estados não podem ser encerrados", () => {
    expect(espacos(enc())).toContain("tiraria o pagamento do reprocessamento automatico");
  });

  it("os quatro estados pendentes ficam de fora por construção", () => {
    for (const st of ["AGUARDANDO_ACORDO", "AGUARDANDO_AMARRACAO", "REVISAO", "SEM_VINCULO"]) {
      // nenhum deles pode aparecer como valor aceito dentro da funcao
      expect(enc()).not.toContain(`'${st}'`);
    }
  });
});

describe("13. o rollback é executável", () => {
  it("não contém meta-comando de psql", () => {
    expect(rollback).not.toContain("\\echo");
    expect(rollback).not.toMatch(/reaplique/i);
  });

  it("restaura os três corpos completos, não referências a eles", () => {
    for (const f of [
      "public._pagamento_conciliar()",
      "public.baixa_pelo_relatorio_pagamento(",
      "public.pagamento_vincular_aluno(",
    ]) {
      expect(rollback).toContain(`create or replace function ${f}`);
    }
    // corpo completo: a escada antiga tem de estar de volta no gatilho
    expect(rollback).toContain("update public.parcelas");
    expect(rollback).toContain("documento_casa_com_parcela");
  });

  it("devolve o CHECK da fila aos três valores originais", () => {
    expect(rollback).toContain("check (decisao is null or decisao in ('VINCULADO','DESCARTADO','AGUARDANDO_TERCEIRO'))");
    // e normaliza as linhas novas antes, senao o CHECK nao volta
    const norm = pos(rollback, "set decisao = 'DESCARTADO'");
    const check = pos(rollback, "add constraint fila_pagamento_sem_vinculo_decisao_check");
    expect(norm).toBeGreaterThan(-1);
    expect(norm).toBeLessThan(check);
  });

  it("não mexe em importar_acordos, que a migration também não toca", () => {
    expect(rollback).not.toMatch(/create or replace function public\.importar_acordos/);
    expect(rollback).not.toContain("do $cirurgia$");
    // `execute format` aparece no corpo restaurado (tabela de backup, drop do
    // constraint por nome dinamico) -- o que nao pode e reescrever funcao.
    expect(rollback).not.toMatch(/execute\s+format\(\s*\n?\s*'create or replace function/);
  });

  it("tem prova própria no fim", () => {
    expect(rollback).toContain("do $prova$");
    expect(rollback).toContain("ficou com % assinaturas");
  });
});
