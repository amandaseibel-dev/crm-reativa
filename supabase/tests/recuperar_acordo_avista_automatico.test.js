// ESTRUTURA da migration 20260917230000 (recuperacao automatica do acordo a
// vista): o que ela pode e o que ela nao pode tocar. O comportamento esta em
// recuperar_acordo_avista_automatico_comportamento.test.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ler = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const MIGRATION = ler("supabase/migrations/20260917230000_recuperar_acordo_avista_automatico.sql");
const ROLLBACK = ler("supabase/rollbacks/20260917230000_recuperar_acordo_avista_automatico.rollback.sql");

function corpo(texto, nome) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*[(\\s]`, "gi");
  const achados = [...texto.matchAll(re)];
  expect(achados, `${nome} definida uma vez`).toHaveLength(1);
  const resto = texto.slice(achados[0].index);
  const ini = resto.indexOf("as $fn$") + "as $fn$".length;
  return resto.slice(ini, resto.indexOf("$fn$", ini));
}
const semComentario = (s) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const linhas = (s) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
function removidas(antes, depois) {
  const sobra = new Map();
  for (const l of linhas(depois)) sobra.set(l, (sobra.get(l) ?? 0) + 1);
  const fora = [];
  for (const l of linhas(antes)) {
    if (sobra.get(l)) sobra.set(l, sobra.get(l) - 1);
    else fora.push(l);
  }
  return fora;
}

// corpos EXATOS de producao em 17/09/2026 (md5 lido no banco)
const PRODUCAO = {
  acordo_avista_registrar: "beb45df8924d4e37a79a17d2f66fc26b",
  vincular_titulos_acordo: "47125b28f3af3db88d4bee721bcde130",
  pagamento_vincular_aluno: "341df31bd28fcdda6028fef621db27fc",
  fluxo_pagamentos_rodar: "07044729c1bb7f482802fa741b037237",
  _pagamentos_baixar_lote: "6df42e17d0c25a9675177f824bc0e8a8",
};
const NOVAS = ["acordo_avista_porta_interna", "acordo_avista_recuperar_um", "acordo_avista_recuperar_pendentes"];
const FINANCEIRAS =
  /\b(insert\s+into|update|delete\s+from)\s+public\.(parcelas|acordos|pagamentos|acordos_titulos|baixas_pagamento|acordo_titulo_vinculo)\b/i;
const PORTA = "reativa.recuperacao_avista";

describe("o que a migration define", () => {
  it("só as três funções novas e as cinco trocadas; prévia e motor ficam de fora", () => {
    const nomes = [...MIGRATION.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)]
      .map((m) => m[1]).sort();
    expect(nomes).toEqual([...NOVAS, ...Object.keys(PRODUCAO)].sort());
    expect(semComentario(MIGRATION)).not.toMatch(
      /function\s+public\.(acordo_avista_previa|pagamento_conciliar_um|parcela_paga_antes_\w+|conciliacao_ja_paga_\w+|reposicao_\w+)\s*\(/i,
    );
    expect(semComentario(MIGRATION)).not.toMatch(/create\s+(or\s+replace\s+)?trigger|alter\s+table|cron\./i);
  });

  it("fora dos corpos, a única escrita é a etapa nova, DESLIGADA", () => {
    const fora = semComentario(MIGRATION)
      .replace(/\$fn\$[\s\S]*?\$fn\$/g, "")
      .replace(/\$prova\$[\s\S]*?\$prova\$/g, "");
    expect(fora.match(/\b(insert|update|delete)\b/gi)).toEqual(["insert"]);
    expect(fora).toMatch(
      /insert into public\.fluxo_pagamentos_config \(etapa, ligado, observacao, alterado_em, alterado_por\)\s+values \('recuperar_acordo_avista', false,/,
    );
    expect(fora).toMatch(/on conflict \(etapa\) do nothing;/);
    for (const f of ["acordo_avista_porta_interna()", "acordo_avista_recuperar_um(uuid, boolean)",
      "acordo_avista_recuperar_pendentes(integer)"]) {
      expect(fora).toContain(`revoke all on function public.${f} from public, anon, authenticated;`);
    }
    // o botao da gestao nao e revogado aqui
    expect(fora).not.toMatch(/revoke[^\n]*acordo_avista_registrar/);
    expect(fora).not.toMatch(/revoke[^\n]*pagamento_vincular_aluno/);
  });
});

describe("a etapa automática não inventa regra nem escreve dado financeiro", () => {
  it("as funções novas só leem a prévia, chamam o registrador e tocam fila e auditoria", () => {
    for (const nome of NOVAS) {
      const c = semComentario(corpo(MIGRATION, nome));
      expect(c, nome).not.toMatch(FINANCEIRAS);
      const dml = c.match(/\b(insert\s+into|update|delete\s+from)\s+public\.\w+/gi) ?? [];
      for (const d of dml) {
        expect(d.toLowerCase(), `${nome}: ${d}`).toMatch(/public\.(fila_pagamento_sem_vinculo|auditoria)$/);
      }
      expect(c, nome).not.toMatch(/\bset\s+(status|pago_em|origem_baixa\w*|saldo|valor|valor_total|qtd_parcelas)\s*=/i);
    }
  });

  it("a prévia do botão é a única fonte de verdade, e a lista de mensalidades sai dela", () => {
    const c = semComentario(corpo(MIGRATION, "acordo_avista_recuperar_um"));
    expect(c).toMatch(/v_previa := public\.acordo_avista_previa\(p_pagamento_id, null\);/);
    expect(c).toMatch(/from jsonb_array_elements\(v_previa -> 'titulos' -> 'selecionados'\) t\s+where t ->> 'impedimento' is null;/);
    // nenhuma regra de valor, margem ou identidade reescrita aqui: fora do
    // mapa de descricoes (que so traduz o codigo da previa para o operador),
    // o corpo nao compara valor nenhum
    const semDescricoes = c.replace(/v_desc := case v_cod[\s\S]*?else '[^']*' end;/, "");
    expect(semDescricoes).not.toMatch(/1\.15|valor_pago|valor_total|margem/i);
    expect(c).toMatch(/public\.acordo_avista_registrar\(p_pagamento_id, v_ids, true\)/);
  });

  it("recusa não decide nada: grava só o motivo, e só quando aplica", () => {
    const c = semComentario(corpo(MIGRATION, "acordo_avista_recuperar_um"));
    expect(c.match(/update public\.fila_pagamento_sem_vinculo/g)).toHaveLength(1);
    expect(c).toMatch(/set motivo = v_prefixo/);
    expect(c).not.toMatch(/set decisao|decisao =/);
    expect(c).toMatch(/and f\.decisao is null/);
    expect(c).toMatch(/if coalesce\(p_aplicar, false\) then/);
    // o prefixo proprio e trocado, nunca empilhado
    expect(c).toMatch(/regexp_replace\(f\.motivo, '\^\(ACORDO_AVISTA_\[A-Z_\]\+: \[\^\|\]\* \\\| \)\+', ''\)/);
    expect(c).toMatch(/not starts_with\(f\.motivo, v_prefixo\)/);
  });

  it("o lote isola a falha de um pagamento e não engole o erro", () => {
    const c = semComentario(corpo(MIGRATION, "acordo_avista_recuperar_pendentes"));
    expect(c).toMatch(/exception when others then/);
    expect(c).toMatch(/'RECUPERACAO_AVISTA_FALHOU'/);
    expect(c).toMatch(/limit greatest\(coalesce\(p_limite, 25\), 0\)/);
    // so o que esta etapa sabe tratar
    expect(c).toMatch(/g\.status_conciliacao = 'AGUARDANDO_ACORDO'/);
    expect(c).toMatch(/~ '\^5\\d\{6\}0001\$'/);
    expect(c).toMatch(/not exists \(select 1 from public\.parcelas q/);
    expect(c).toMatch(/not exists \(select 1 from public\.acordos a/);
    expect(c).toMatch(/f\.decisao is not null\)/);
  });
});

describe("a porta de máquina", () => {
  it("só o wrapper acende, e ele apaga nos dois caminhos", () => {
    const c = semComentario(corpo(MIGRATION, "acordo_avista_recuperar_um"));
    expect(c.match(new RegExp(`set_config\\('${PORTA}', 'on', true\\)`, "g"))).toHaveLength(1);
    expect(c.match(new RegExp(`set_config\\('${PORTA}', 'off', true\\)`, "g"))).toHaveLength(2);
    expect(c).toMatch(/exception when others then\s+perform set_config\('reativa\.recuperacao_avista', 'off', true\);\s+raise;/);
  });

  it("a chave sozinha não abre nada: a porta exige também a pilha da rotina", () => {
    const porta = semComentario(corpo(MIGRATION, "acordo_avista_porta_interna"));
    expect(porta).toMatch(new RegExp(`current_setting\\('${PORTA}', true\\)`));
    expect(porta).toMatch(/get diagnostics v_ctx = pg_context;/);
    expect(porta).toMatch(/position\('function acordo_avista_recuperar_um\(uuid,boolean\)' in v_ctx\) > 0/);
    // a chave e lida SO na porta; ninguem mais compara a GUC
    const outras = [...MIGRATION.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)]
      .map((m) => m[1]).filter((n) => n !== "acordo_avista_porta_interna");
    for (const n of outras) {
      expect(semComentario(corpo(MIGRATION, n)), n).not.toMatch(new RegExp(`current_setting\\('${PORTA}'`));
    }
  });

  it("as três portas chamam a mesma função, sempre como condição ADICIONAL", () => {
    for (const nome of ["acordo_avista_registrar", "vincular_titulos_acordo", "pagamento_vincular_aluno"]) {
      const c = semComentario(corpo(MIGRATION, nome));
      expect(c, nome).toMatch(/public\.acordo_avista_porta_interna\(\)/);
    }
    const reg = semComentario(corpo(MIGRATION, "acordo_avista_registrar"));
    expect(reg).toMatch(/if not coalesce\(public\.usuario_e_gestao\(\), false\)\s+and not public\.acordo_avista_porta_interna\(\) then/);
    const pag = semComentario(corpo(MIGRATION, "pagamento_vincular_aluno"));
    expect(pag).toMatch(/and coalesce\(auth\.role\(\),''\) <> 'service_role'\s+and not public\.acordo_avista_porta_interna\(\) then/);
    // o portao continua antes de qualquer escrita
    expect(reg.indexOf("usuario_e_gestao")).toBeLessThan(reg.indexOf("insert into public.acordos"));
    expect(pag.indexOf("usuario_e_gestao")).toBeLessThan(pag.indexOf("update public.pagamentos"));
  });

  it("nenhuma outra função acende a chave", () => {
    const acendem = [...MIGRATION.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)]
      .map((m) => m[1])
      .filter((n) => new RegExp(`set_config\\('${PORTA}', 'on'`).test(corpo(MIGRATION, n)));
    expect(acendem).toEqual(["acordo_avista_recuperar_um"]);
  });
});

describe("diff mínimo contra produção", () => {
  it("o rollback carrega os cinco corpos exatos de produção e remove as funções novas", () => {
    for (const [nome, h] of Object.entries(PRODUCAO)) expect(md5(corpo(ROLLBACK, nome)), nome).toBe(h);
    for (const f of ["acordo_avista_recuperar_pendentes(integer)", "acordo_avista_recuperar_um(uuid, boolean)"]) {
      expect(ROLLBACK).toContain(`drop function if exists public.${f};`);
    }
    expect(ROLLBACK).toContain("delete from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista';");
  });

  it("vincular_titulos_acordo, fluxo e lote só ganham linhas", () => {
    for (const nome of ["vincular_titulos_acordo", "fluxo_pagamentos_rodar", "_pagamentos_baixar_lote"]) {
      expect(removidas(corpo(ROLLBACK, nome), corpo(MIGRATION, nome)), nome).toEqual([]);
    }
  });

  it("registrador e vínculo do pagamento só perdem a linha do portão antigo", () => {
    expect(removidas(corpo(ROLLBACK, "acordo_avista_registrar"), corpo(MIGRATION, "acordo_avista_registrar"))
      .filter((l) => !l.startsWith("--")))
      .toEqual(["if not coalesce(public.usuario_e_gestao(), false) then"]);
    expect(removidas(corpo(ROLLBACK, "pagamento_vincular_aluno"), corpo(MIGRATION, "pagamento_vincular_aluno"))
      .filter((l) => !l.startsWith("--")))
      .toEqual([
        "and coalesce(auth.role(),'') <> 'service_role' then",
        "v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');",
      ]);
  });

  it("a etapa nova entra depois das que já existiam na rodada horária e na importação", () => {
    const fluxo = semComentario(corpo(MIGRATION, "fluxo_pagamentos_rodar"));
    expect(fluxo.indexOf("acordo_avista_recuperar_pendentes(25)"))
      .toBeGreaterThan(fluxo.indexOf("conciliacao_ja_paga_encerrar_pendentes(50)"));
    expect(fluxo).toMatch(/etapa='recuperar_acordo_avista'/);
    const lote = semComentario(corpo(MIGRATION, "_pagamentos_baixar_lote"));
    expect(lote.indexOf("acordo_avista_recuperar_pendentes(25)"))
      .toBeGreaterThan(lote.indexOf("parcela_paga_antes_reconstruir_pendentes(50)"));
    // falha da etapa nao derruba a importacao
    expect(lote).toMatch(/'RECUPERACAO_AVISTA_LOTE_FALHOU'/);
  });
});
