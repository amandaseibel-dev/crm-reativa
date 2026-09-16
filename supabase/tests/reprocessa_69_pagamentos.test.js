// REPROCESSAMENTO CONTROLADO DOS 69 -- ESTRUTURA.
//
// O comportamento esta provado em reprocessa_69_pagamentos_comportamento.test.js,
// contra o motor real. Aqui ficam as garantias que dependem do TEXTO da
// migration: valores aprovados, o que ela pode chamar e o que ela nao pode fazer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(resolve(AQUI, "..", "..",
  "supabase/migrations/20260916150000_reprocessa_69_pagamentos_do_backfill_392.sql"), "utf8");

// Codigo sem comentarios de linha: proibicoes nao podem tropecar no cabecalho.
// `--` dentro de string (as mensagens de raise usam) NAO e comentario.
function semComentarios(sql) {
  let saida = "", emTexto = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (emTexto) {
      saida += c;
      if (c === "'") emTexto = false;
    } else if (c === "'") {
      emTexto = true;
      saida += c;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      saida += "\n";
    } else {
      saida += c;
    }
  }
  return saida;
}
const CODIGO = semComentarios(SQL);
// e sem os textos das mensagens, para as buscas de comando
const SEM_TEXTO = CODIGO.replace(/'[^']*'/g, "''");

describe("valores aprovados pela gestao", () => {
  const constante = (nome) => {
    const m = new RegExp(`${nome}\\s+constant\\s+[\\w\\[\\]]+\\s+:=\\s+('[^']*'|[^;']+);`).exec(CODIGO);
    return m && m[1].trim();
  };
  it.each([
    ["c_lote_hash", "'53d4b1a0169952ca51c979e10f36fa66a31bd33ac1bce7ad5c97ff68dd08cc73'"],
    ["c_lote_qtd", "748"],
    ["c_alvo_hash", "'bddd4d68c2da14e24f9f0c95c56629c1ca275bad1b91b1cf1ffaa6cd96c332eb'"],
    ["c_qtd", "69"],
    ["c_valor", "40831.07"],
    ["c_parcelas", "69"],
    ["c_acordos", "23"],
    ["c_alunos", "23"],
    ["c_quitados", "21"],
    ["c_sem_status", "95"],
    ["c_fila_outros", "'AGUARDANDO_ACORDO=38;PARCELA_JA_PAGA=6'"],
    ["c_motor_md5", "'fa3d64add73e0e73e587e16f0c0624d1'"],
  ])("%s = %s", (nome, valor) => {
    expect(constante(nome)).toBe(valor);
  });

  it("c_lote_trilha tem 748 ids inteiros, distintos e em ordem", () => {
    const m = /c_lote_trilha\s+constant bigint\[\]\s+:=\s+'\{([^}]*)\}';/.exec(CODIGO);
    expect(m).not.toBeNull();
    const ids = m[1].split(",").map((s) => s.trim());
    expect(ids).toHaveLength(748);
    expect(ids.every((s) => /^\d+$/.test(s))).toBe(true);
    const n = ids.map(Number);
    expect(new Set(n).size).toBe(748);
    expect([...n].sort((a, b) => a - b)).toEqual(n);
  });

  it("nenhum UUID literal: o conjunto sai de criterio, nao de lista de pagamentos", () => {
    expect(SQL).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("o que a migration chama", () => {
  it("o motor aparece exatamente duas vezes: previa (false) e aplicacao (true)", () => {
    const chamadas = SEM_TEXTO.match(/pagamento_conciliar_um\s*\([^)]*\)/g) || [];
    expect(chamadas).toEqual([
      "pagamento_conciliar_um(r.pagamento_id, false)",
      "pagamento_conciliar_um(r.pagamento_id, true)",
    ]);
    expect(CODIGO.indexOf("pagamento_conciliar_um(r.pagamento_id, false)"))
      .toBeLessThan(CODIGO.indexOf("pagamento_conciliar_um(r.pagamento_id, true)"));
  });

  it("as duas passadas seguem a ordem da fila do motor (data_pagamento, id)", () => {
    expect(CODIGO).toMatch(/row_number\(\) over \(order by g\.data_pagamento, g\.id\) as ordem/);
    expect((CODIGO.match(/for r in select \* from _alvo order by ordem loop/g) || [])).toHaveLength(2);
  });

  it.each([
    "baixa_por_documento_aplicar", "conciliacao_reprocessar", "baixa_pelo_relatorio_pagamento",
    "conciliacao_consultar_portador_pendentes", "fluxo_pagamentos_rodar", "parcelas_amarrar_boleto",
    "acordos_pos_importacao", "recalcular_situacao_aluno", "set_config", "session_replication_role",
  ])("nao chama %s", (nome) => {
    expect(CODIGO).not.toContain(nome);
  });
});

describe("o que a migration nao faz", () => {
  it("nenhum UPDATE, INSERT, DELETE, TRUNCATE, ALTER, DROP ou CREATE FUNCTION proprio", () => {
    expect(SEM_TEXTO).not.toMatch(/\bupdate\s+(only\s+)?(public\.)?\w+(\s+\w+)?\s+set\b/i);
    expect(SEM_TEXTO).not.toMatch(/\binsert\s+into\b/i);
    expect(SEM_TEXTO).not.toMatch(/\bdelete\s+from\b/i);
    expect(SEM_TEXTO).not.toMatch(/\btruncate\b/i);
    expect(SEM_TEXTO).not.toMatch(/\balter\s+(table|function|trigger)\b/i);
    expect(SEM_TEXTO).not.toMatch(/\bdrop\s+(table|function|trigger|index|view|policy|schema)\b/i);
    expect(SEM_TEXTO).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/i);
  });

  it("nao desliga gatilho nem infere por XID", () => {
    expect(CODIGO).not.toMatch(/disable\s+trigger/i);
    expect(CODIGO).not.toMatch(/\bxmin\b|pg_xact_status|pg_current_xact_id|xid8/i);
  });

  it("zero pagamentos aborta: zero nao prova aplicacao anterior", () => {
    expect(CODIGO).toMatch(/if v_n = 0 then\s+raise exception 'ABORTADO: 0 pagamentos no conjunto/);
  });
});

describe("ordem das protecoes", () => {
  const pos = (trecho) => {
    const i = CODIGO.indexOf(trecho);
    if (i < 0) throw new Error("trecho ausente: " + trecho);
    return i;
  };
  it("lock_timeout curto e a primeira acao", () => {
    expect(pos("set local lock_timeout = '3s';")).toBeLessThan(pos("from pg_proc p"));
  });
  it("motor auditado e fluxo pausado sao exigidos antes de montar o conjunto", () => {
    expect(pos("corpo de pagamento_conciliar_um mudou")).toBeLessThan(pos("create temp table _lote"));
    expect(pos("baixa_pelo_relatorio nao esta desligada")).toBeLessThan(pos("create temp table _lote"));
    expect(pos("baixa_por_documento nao esta desligada")).toBeLessThan(pos("create temp table _lote"));
    expect(pos("consulta_portador nao esta desligada")).toBeLessThan(pos("create temp table _lote"));
  });
  it("todas as travas de conjunto vem antes das travas de linha, e estas antes do motor", () => {
    const travaLinha = pos("for no key update of g");
    for (const t of ["SHA256 do lote", "pagamentos no conjunto (% distintos)", "valor do conjunto",
      "SHA256 do conjunto", "fora do conjunto aprovado", "pagamentos do lote sem status_conciliacao",
      "restante da fila"]) {
      expect(pos(t)).toBeLessThan(travaLinha);
    }
    expect(travaLinha).toBeLessThan(pos("pagamento_conciliar_um(r.pagamento_id, false)"));
  });
  it("os 69 pagamentos, suas fila, os acordos e as parcelas dos acordos sao travados para escrita", () => {
    expect(CODIGO).toMatch(/from public\.pagamentos g\s+where g\.id in \(select pagamento_id from _alvo\) for no key update of g;/);
    expect(CODIGO).toMatch(/from public\.fila_pagamento_sem_vinculo f\s+where f\.pagamento_id in \(select pagamento_id from _alvo\) for no key update of f;/);
    expect(CODIGO).toMatch(/from public\.acordos a\s+where a\.id in \(select acordo_id from _alvo\) for no key update of a;/);
    expect(CODIGO).toMatch(/from public\.parcelas p\s+where p\.acordo_id in \(select acordo_id from _alvo\) for no key update of p;/);
    expect(CODIGO).toMatch(/for share of g;/);
  });
  it("os PRE sao capturados antes da previa, e os POS conferidos depois da aplicacao", () => {
    const previa = pos("pagamento_conciliar_um(r.pagamento_id, false)");
    const aplica = pos("pagamento_conciliar_um(r.pagamento_id, true)");
    for (const pre of ["into v_sem_status_pre", "into v_fila_outros_pre", "into v_config_pre", "into v_alvo_parc_pre", "into v_parc_acordo_pre"]) {
      expect(pos(pre)).toBeLessThan(previa);
    }
    for (const posv of ["into v_sem_status_pos", "into v_fila_outros_pos", "into v_config_pos", "into v_alvo_parc_pos", "into v_parc_acordo_pos", "into v_quitados_pos"]) {
      expect(pos(posv)).toBeGreaterThan(aplica);
    }
  });
});
