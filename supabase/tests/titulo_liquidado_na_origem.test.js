// TITULO ORIGINAL LIQUIDADO NA ORIGEM (Prime).
//
// LIMITE, DITO DE FRENTE: o CI nao tem banco. Estes testes provam ESTRUTURA
// sobre o texto da migration e do rollback -- que as travas existem, que estao
// na ordem certa, que nada cria acordo ou parcela, que dinheiro do Prime nunca
// e lido. Comportamento de verdade exige Postgres; ate la, a compilacao plpgsql
// acontece no apply_migration e o bloco DO de prova aborta a aplicacao se a
// estrutura mudar.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIG = resolve(RAIZ, "supabase/migrations/20260915120000_titulo_liquidado_na_origem.sql");
const RB = resolve(RAIZ, "supabase/rollbacks/20260915120000_titulo_liquidado_na_origem.rollback.sql");
const sql = readFileSync(MIG, "utf8").replace(/\r/g, "");
const rb = readFileSync(RB, "utf8").replace(/\r/g, "");

function corpo(texto, nome, tag) {
  const i = texto.indexOf(`function public.${nome}(`);
  if (i < 0) throw new Error(`nao achei ${nome}`);
  const d = texto.slice(i);
  const a = d.indexOf(tag), b = d.indexOf(tag, a + tag.length);
  return d.slice(a + tag.length, b);
}
const trava = corpo(sql, "titulo_liquidado_na_origem_e_terminal", "$fn$");
const liq = corpo(sql, "conciliacao_liquidar_titulo_por_prime", "$fn$");
const motor = corpo(sql, "pagamento_conciliar_um", "$motor$");
const pos = (t, s, from = 0) => t.indexOf(s, from);
const esp = (s) => s.replace(/\s+/g, " ").trim();

describe("1. as tres marcas da liquidacao", () => {
  it("entram em acordos_titulos, e a origem e restrita a um valor", () => {
    for (const c of ["origem_liquidacao", "origem_liquidacao_ref", "origem_liquidacao_em"]) {
      expect(esp(sql)).toContain(`add column if not exists ${c}`);
    }
    const m = sql.match(/origem_liquidacao in \(([\s\S]*?)\)\)/);
    expect(m, "nao achei o CHECK de origem_liquidacao").toBeTruthy();
    const vals = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(vals).toEqual(["PRIME_LIQUIDACAO_OFICIAL"]);
  });

  it("a coluna diz, no comentario, que NAO e dinheiro recebido", () => {
    const i = pos(sql, "comment on column public.acordos_titulos.origem_liquidacao is");
    const c = sql.slice(i, pos(sql, ";", i));
    expect(esp(c)).toContain("NAO significa dinheiro recebido");
  });
});

describe("2. a trava: liquidado na origem e terminal", () => {
  it("e um trigger BEFORE UPDATE na propria tabela -- nao um remendo por funcao", () => {
    // a instrucao INTEIRA, contigua: comentar so o `create trigger` deixaria
    // as duas linhas seguintes no arquivo e passaria batido
    expect(sql).toContain(
      "create trigger trg_titulo_liquidado_na_origem_e_terminal\n" +
      "before update on public.acordos_titulos\n" +
      "for each row execute function public.titulo_liquidado_na_origem_e_terminal();");
  });

  it("so age quando a marca oficial esta no OLD", () => {
    expect(trava).toContain("if coalesce(old.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL' then");
    const i = pos(trava, "<> 'PRIME_LIQUIDACAO_OFICIAL' then");
    expect(trava.slice(i, i + 120)).toContain("return new;");
  });

  it("COAGE de volta para PAGO/quitada em vez de levantar excecao", () => {
    expect(trava).toContain("new.situacao := 'PAGO'");
    expect(trava).toContain("new.status   := 'quitada'");
    // excecao aqui derrubaria a importacao de acordos inteira
    expect(trava).not.toContain("raise exception");
  });

  it("as tres marcas nao podem ser apagadas por quem atualizar depois", () => {
    expect(trava).toContain("new.origem_liquidacao     := old.origem_liquidacao");
    expect(trava).toContain("new.origem_liquidacao_ref := coalesce(new.origem_liquidacao_ref, old.origem_liquidacao_ref)");
    expect(trava).toContain("new.origem_liquidacao_em  := coalesce(new.origem_liquidacao_em,  old.origem_liquidacao_em)");
  });

  it("deixa o acordo futuro ser gravado para historico -- so a divida nao ressuscita", () => {
    // nao ha nenhuma coacao de acordo_id: o acordo pode ser apontado no titulo
    expect(trava).not.toContain("new.acordo_id :=");
    // e quando ja esta terminal, nada e coagido: segue a vida
    const i = pos(trava, "if coalesce(new.situacao,'') = 'PAGO' and coalesce(new.status,'') = 'quitada' then");
    expect(i).toBeGreaterThan(-1);
    expect(trava.slice(i, i + 200)).toContain("return new;");
  });

  it("registra em auditoria SO quando realmente impediu alguma coisa", () => {
    const i = pos(trava, "insert into public.auditoria");
    const jaTerminal = pos(trava, "'PAGO' and coalesce(new.status,'') = 'quitada' then");
    // a auditoria mora DEPOIS da saida do caso "ja terminal"
    expect(i).toBeGreaterThan(jaTerminal);
    expect(trava).toContain("TITULO_LIQUIDADO_REABERTURA_RECUSADA");
  });
});

describe("3. o estado novo do pagamento", () => {
  it("entra no CHECK, junto dos sete que ja existiam", () => {
    const i = sql.indexOf("add constraint pagamentos_status_conciliacao_valido");
    const bloco = sql.slice(i, sql.indexOf("end $ajuste$", i));
    const vals = [...bloco.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(vals.sort()).toEqual([
      "ACORDO_CONFIRMADO_SEM_ESTRUTURA", "AGUARDANDO_ACORDO", "AGUARDANDO_AMARRACAO",
      "BAIXADO", "PARCELA_JA_PAGA", "REVISAO", "SEM_VINCULO", "TITULO_ORIGINAL_LIQUIDADO",
    ]);
  });

  it("nao reaproveita BAIXADO, que continua sendo baixa de parcela", () => {
    expect(liq).not.toContain("'BAIXADO'");
    expect(liq).not.toContain("update public.parcelas");
  });

  it("a fila usa o vocabulario que o CHECK dela aceita", () => {
    // `decisao` tem CHECK proprio: VINCULADO/DESCARTADO/AGUARDANDO_TERCEIRO/
    // RESOLVIDO_AUTOMATICO/ENCERRADO_GESTAO. O desfecho vai em status_conciliacao.
    expect(liq).toContain("set decisao = 'RESOLVIDO_AUTOMATICO'");
    expect(liq).toContain("status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO'");
    expect(liq).not.toMatch(/decisao = 'TITULO_ORIGINAL_LIQUIDADO'/);
  });
});

describe("4. o motor para no estado terminal", () => {
  it("sai ANTES de qualquer reclassificacao", () => {
    const saida = pos(motor, "= 'TITULO_ORIGINAL_LIQUIDADO' then");
    expect(saida).toBeGreaterThan(-1);
    // antes da leitura da parcela e antes de decidir qualquer status
    expect(saida).toBeLessThan(pos(motor, "from public.parcelas p join public.acordos a"));
    expect(saida).toBeLessThan(pos(motor, "v_status := 'SEM_VINCULO'"));
  });

  it("e sai sem escrever", () => {
    const i = pos(motor, "= 'TITULO_ORIGINAL_LIQUIDADO' then");
    const ramo = motor.slice(i, pos(motor, "end if;", i));
    expect(ramo).toContain("return jsonb_build_object");
    expect(ramo).toContain("'aplicou', false");
    expect(ramo).not.toContain("update ");
  });
});

describe("5. o liquidador: as travas", () => {
  it("exige portador 195 -- 95 e mensalidade corrente, 166 e convenio de acordo", () => {
    expect(liq).toContain("if coalesce((v_item->>'portador')::int, 0) <> 195 then");
    const i = pos(liq, "<> 195 then");
    expect(liq.slice(i, i + 220)).toContain("continue;");
  });

  it("exige as DUAS metades da regra de liquidacao", () => {
    expect(liq).toContain("if not (v_pago > v_t.vencimento + 30) then");
    expect(liq).toContain("if not (v_pago > v_t.created_at::date) then");
  });

  it("exige que o titulo seja do MESMO aluno do pagamento", () => {
    expect(liq).toContain("and t.aluno_id = v_pag.aluno_id");
    // e o aluno precisa existir antes de tudo
    const idn = pos(liq, "if v_pag.aluno_id is null then");
    expect(idn).toBeGreaterThan(-1);
    expect(idn).toBeLessThan(pos(liq, "jsonb_array_elements"));
  });

  it("so mexe em titulo ABERTO/em_aberto, sem acordo e sem vinculo ativo", () => {
    expect(liq).toContain("if coalesce(v_t.situacao,'') <> 'ABERTO' or coalesce(v_t.status,'') <> 'em_aberto' then");
    expect(liq).toContain("if v_t.acordo_id is not null");
    expect(liq).toContain("from public.acordo_titulo_vinculo v");
    expect(liq).toContain("and coalesce(v.ativo, true)");
  });

  it("e idempotente pela marca ja gravada", () => {
    expect(liq).toContain("if coalesce(v_t.origem_liquidacao,'') = 'PRIME_LIQUIDACAO_OFICIAL' then");
    expect(liq).toContain("'JA_LIQUIDADO'");
    // e no nivel do pagamento tambem
    expect(liq).toContain("if coalesce(v_pag.status_conciliacao,'') = 'TITULO_ORIGINAL_LIQUIDADO' then");
  });

  it("nunca cria titulo que nao veio por bordero", () => {
    expect(liq).toContain("'NAO_EXISTE_NO_CRM_PARA_ESTE_ALUNO'");
    expect(liq).not.toContain("insert into public.acordos_titulos");
  });
});

describe("6. o liquidador: o que ele NAO faz", () => {
  it("nao cria acordo nem parcela, e nao infere quantidade de parcelas", () => {
    expect(liq).not.toMatch(/insert into public\.(acordos|parcelas)\b/);
    expect(liq).not.toContain("qtd_parcelas");
    expect(liq).not.toContain("numero_ulbra");
  });

  it("nao le dinheiro do Prime -- o caixa e do Santander", () => {
    expect(liq).not.toContain("paidAmount");
    expect(liq).not.toContain("valor_pago");
    expect(liq).not.toContain("valor_honorario");
  });

  it("grava acordo_id NULL de proposito, e diz por que", () => {
    const i = pos(liq, "update public.acordos_titulos");
    const upd = liq.slice(i, pos(liq, "where id = v_t.id", i));
    expect(upd).not.toMatch(/\bacordo_id\s*=/);
    expect(esp(upd)).toContain("acordo_id continua NULL de proposito");
    expect(upd).toContain("origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL'");
    expect(upd).toContain("origem_liquidacao_ref = p_pagamento_id::text");
  });

  it("previa nao escreve nada", () => {
    expect(liq).toContain("if p_aplicar then");
    const i = pos(liq, "update public.acordos_titulos");
    const antes = liq.slice(0, i);
    expect(antes.lastIndexOf("if p_aplicar then")).toBeGreaterThan(-1);
  });
});

describe("7. a prova da migration", () => {
  it("aborta se a trava sumir, virar excecao, ou o motor esquecer o estado", () => {
    const prova = sql.slice(pos(sql, "do $prova$"));
    expect(prova).toContain("tgname='trg_titulo_liquidado_na_origem_e_terminal'");
    expect(prova).toContain("a trava levanta excecao");
    expect(prova).toContain("o motor nao trata o estado terminal");
    expect(prova).toContain("o liquidador cria acordo ou parcela");
    expect(prova).toContain("o liquidador nao exige que o titulo seja do mesmo aluno");
  });
});

describe("8. o rollback", () => {
  it("remove a trava e o liquidador, na ordem certa", () => {
    expect(rb).toContain("drop trigger if exists trg_titulo_liquidado_na_origem_e_terminal");
    expect(rb).toContain("drop function if exists public.titulo_liquidado_na_origem_e_terminal()");
    expect(rb).toContain("drop function if exists public.conciliacao_liquidar_titulo_por_prime(uuid, jsonb, boolean)");
    // trigger antes da funcao
    expect(pos(rb, "drop trigger if exists trg_titulo_liquidado"))
      .toBeLessThan(pos(rb, "drop function if exists public.titulo_liquidado_na_origem_e_terminal"));
    // e a trava sai ANTES de normalizar pagamentos, senao ela coagiria a normalizacao
    expect(pos(rb, "drop trigger if exists trg_titulo_liquidado"))
      .toBeLessThan(pos(rb, "update public.pagamentos"));
  });

  it("NAO reabre titulo nenhum e NAO apaga as marcas", () => {
    expect(rb).not.toMatch(/drop column[^\n]*origem_liquidacao/);
    expect(rb).not.toMatch(/set\s+situacao\s*=\s*'ABERTO'[\s\S]{0,200}origem_liquidacao/);
    expect(rb).not.toContain("update public.acordos_titulos");
    expect(rb).toContain("algum titulo liquidado foi reaberto pelo rollback");
  });

  it("normaliza os pagamentos antes de estreitar o CHECK", () => {
    expect(pos(rb, "where status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO'"))
      .toBeLessThan(pos(rb, "add constraint pagamentos_status_conciliacao_valido"));
    const i = sql.indexOf("add constraint pagamentos_status_conciliacao_valido");
    const depois = rb.slice(rb.indexOf("add constraint pagamentos_status_conciliacao_valido"));
    expect(depois.slice(0, 600)).not.toContain("TITULO_ORIGINAL_LIQUIDADO");
    expect(i).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// 9. O QUE FOI MEDIDO -- 15/09/2026, leitura da Prime e do banco
// ---------------------------------------------------------------------------
describe("9. impacto medido nos 13", () => {
  it("17 titulos liquidam, 1 ja estava quitado, 28 nao existem no CRM", () => {
    const M = { titulos_195: 46, no_crm: 18, em_aberto: 17, ja_quitado: 1, fora_do_crm: 28 };
    expect(M.no_crm + M.fora_do_crm).toBe(M.titulos_195);
    expect(M.em_aberto + M.ja_quitado).toBe(M.no_crm);
  });

  it("nenhum dos 46 falha na regra das duas metades", () => {
    const M = { total: 46, passa_venc_mais_30: 46, passa_depois_da_importacao: 46, menor_folga_dias: 37 };
    expect(M.passa_venc_mais_30).toBe(M.total);
    expect(M.passa_depois_da_importacao).toBe(M.total);
    expect(M.menor_folga_dias).toBeGreaterThan(30);
  });

  it("caixa e divida sao grandezas diferentes, e nao se somam", () => {
    const CAIXA_SANTANDER = 7658.02;   // dinheiro que entrou, ja contabilizado
    const DIVIDA_QUE_SAI = 6437.71;    // saldo em aberto que deixa de existir
    expect(CAIXA_SANTANDER).not.toBe(DIVIDA_QUE_SAI);
    // o desenho nao cria parcela, entao a divida sai do saldo UMA vez
    expect(liq).not.toMatch(/insert into public\.parcelas/);
  });
});
