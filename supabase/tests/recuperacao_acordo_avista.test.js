// RECUPERACAO DE ACORDO PAGO SEM IMPORTACAO -- ESTRUTURA.
//
// O comportamento esta provado em recuperacao_acordo_avista_comportamento.test.js
// (PGlite, motor real). Aqui ficam as garantias de TEXTO que o comportamento
// nao pega: o que a migration nao pode tocar, a ordem do portao, as permissoes e
// o rollback. Comentarios sao removidos antes de proibir palavra.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const sql = readFileSync(resolve(RAIZ, "supabase/migrations/20260916230000_recuperacao_acordo_pago_sem_importacao.sql"), "utf8").replace(/\r/g, "");
const rb = readFileSync(resolve(RAIZ, "supabase/rollbacks/20260916230000_recuperacao_acordo_pago_sem_importacao.rollback.sql"), "utf8").replace(/\r/g, "");

const semComentario = (t) => t.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const codigo = semComentario(sql);
const esp = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

function corpo(nome, tag) {
  const i = sql.indexOf(`function public.${nome}(`);
  if (i < 0) throw new Error(`nao achei ${nome}`);
  const d = sql.slice(i);
  const a = d.indexOf(tag);
  const b = d.indexOf(tag, a + tag.length);
  return semComentario(d.slice(a + tag.length, b));
}
const previa = corpo("acordo_avista_previa", "$previa$");
const registrar = corpo("acordo_avista_registrar", "$fn$");
const trava = corpo("pagamentos_trava", "$fn$");

describe("o que a migration não toca", () => {
  it("não redefine motor, vínculos, importação, amarração nem cron", () => {
    for (const nome of ["pagamento_conciliar_um", "pagamento_vincular_aluno", "vincular_titulos_acordo",
      "importar_acordos", "parcelas_amarrar_boleto", "baixa_pelo_relatorio_pagamento", "conciliacao_reprocessar",
      "conciliacao_consultar_portador_pendentes", "fluxo_pagamentos_rodar"]) {
      expect(esp(codigo)).not.toContain(`function public.${nome}(`);
    }
    expect(esp(codigo)).not.toMatch(/cron\.(schedule|unschedule)/);
    expect(esp(codigo)).not.toContain("fluxo_pagamentos_config");
  });

  it("não escreve dado nenhum ao ser aplicada: só cria funções", () => {
    const fora = esp(codigo.replace(/\$previa\$[\s\S]*?\$previa\$/g, "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "").replace(/\$prova\$[\s\S]*?\$prova\$/g, ""));
    expect(fora).not.toMatch(/\b(insert into|update public\.|delete from|alter table|create table|create trigger)\b/);
  });
});

describe("a prévia", () => {
  it("é SQL puro, STABLE, e não escreve", () => {
    expect(esp(sql)).toMatch(/function public\.acordo_avista_previa\([\s\S]*?language sql stable security definer/);
    expect(esp(previa)).not.toMatch(/\b(insert|update|delete)\b/);
  });

  it("não é porta de entrada: revogada de authenticated", () => {
    expect(esp(sql)).toContain("revoke all on function public.acordo_avista_previa(uuid, uuid[]) from public, anon, authenticated");
  });

  it("identifica o aluno por matrícula E nome, e trava o que a gestão pediu", () => {
    for (const cod of ["BOLETO_PARCELA_0001", "UNICO_BOLETO_DO_ACORDO", "NUMERO_ULBRA_INEXISTENTE",
      "MATRICULA_E_NOME_MESMO_ALUNO", "TITULOS_ELEGIVEIS", "SOMA_ATE_O_VALOR_PAGO",
      "DIFERENCA_DENTRO_DA_MARGEM_SEGURA", "AUSENCIA_EXPLICADA",
      "TITULO_DE_OUTRO_ALUNO", "TITULO_LIGADO_A_OUTRO_ACORDO"]) {
      expect(previa).toContain(`'${cod}'`);
    }
    expect(esp(previa)).toContain("pc.registration = b.matricula");
    expect(esp(previa)).toContain("am.aluno_id = an.aluno_id");
  });

  it("margem segura de 1,15 definida num lugar só, e 1,30 não existe mais", () => {
    expect(esp(previa)).toContain("select 1.15::numeric as margem_segura");
    expect(previa).not.toMatch(/1[.,]30?\b(?!\d)/);
    expect(esp(previa)).toContain("b.valor_pago <= tot.soma * regra.margem_segura + 0.005");
    expect(esp(previa)).toContain("tot.soma <= b.valor_pago + 0.005");
    expect(previa).toContain("a diferença excede a margem segura");
  });

  it("não existe liberação manual de trava nesta versão", () => {
    expect(esp(codigo)).not.toContain("confirmacao_operacional");
    expect(esp(sql)).toMatch(/function public\.acordo_avista_previa\( p_pagamento_id uuid, p_titulo_ids uuid\[\] default null \)/);
    expect(esp(sql)).toMatch(/function public\.acordo_avista_registrar\( p_pagamento_id uuid, p_titulo_ids uuid\[\] default null, p_confirmar boolean default false \)/);
  });
});

describe("o registro", () => {
  it("o portão da gestão é a primeira coisa, e é portão interno (EXECUTE fica com authenticated)", () => {
    expect(registrar.indexOf("usuario_e_gestao")).toBeGreaterThan(-1);
    expect(registrar.indexOf("usuario_e_gestao")).toBeLessThan(registrar.indexOf("acordo_avista_previa"));
    expect(esp(sql)).toContain("grant execute on function public.acordo_avista_registrar(uuid, uuid[], boolean) to authenticated");
    expect(esp(sql)).not.toMatch(/revoke all on function public\.acordo_avista_registrar\([^)]*\) from [^;]*authenticated/);
  });

  it("simulação é o padrão, e confirmar sem mensalidades escolhidas não chega a gravar", () => {
    expect(esp(sql)).toMatch(/p_confirmar boolean default false/);
    const i = registrar.indexOf("if not coalesce(p_confirmar, false) then");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(registrar.indexOf("insert into public.acordos"));
    const semEscolha = registrar.indexOf("cardinality(v_titulos) = 0");
    expect(semEscolha).toBeGreaterThan(i);
    expect(semEscolha).toBeLessThan(registrar.indexOf("insert into public.acordos"));
  });

  it("refaz a prévia sob cadeado e só grava aprovado", () => {
    const cadeado = registrar.indexOf("pg_advisory_xact_lock");
    const previaSobCadeado = registrar.indexOf("acordo_avista_previa", cadeado);
    const aprovado = registrar.indexOf("'aprovado'", previaSobCadeado);
    const insercao = registrar.indexOf("insert into public.acordos");
    expect(cadeado).toBeGreaterThan(-1);
    expect(previaSobCadeado).toBeGreaterThan(cadeado);
    expect(aprovado).toBeGreaterThan(previaSobCadeado);
    expect(insercao).toBeGreaterThan(aprovado);
  });

  it("a baixa é do motor: nunca escreve parcela ou pagamento por conta própria", () => {
    expect(esp(registrar)).not.toContain("update public.parcelas");
    expect(esp(registrar)).not.toContain("update public.pagamentos");
    expect(registrar).toContain("public.vincular_titulos_acordo(");
    expect(registrar).toContain("public.pagamento_vincular_aluno(");
  });

  it("estado final diferente do simulado aborta tudo", () => {
    expect(registrar).toMatch(/<> 'BAIXADO' then\s+raise exception 'RECUPERACAO_ABORTADA/);
    expect(registrar).toMatch(/raise exception 'RECUPERACAO_ABORTADA: o estado final difere do simulado/);
  });

  it("o responsável do acordo é o operador do pagamento, e a origem vai para a auditoria", () => {
    expect(registrar).toContain("v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email'");
    expect(esp(previa)).toContain("'operador_responsavel_email', op.email");
    expect(esp(previa)).toContain("lower(u.email) = lower(b.operador_email)");
    expect(registrar).toContain("'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO', 'acordos', v_acordo_id");
    for (const campo of ["'confirmado_por'", "'confirmado_em'", "'pagamento_id'", "'acordo_id'", "'parcela_id'",
      "'titulo_ids'", "'operador_original'", "'estado_antes'", "'estado_depois'"]) {
      expect(registrar).toContain(campo);
    }
  });
});

describe("pagamentos_trava", () => {
  it("o 71752 (ausência não explicada) não recebe a ação normal", () => {
    expect(trava).toContain("'ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA'");
    const naoExplicada = trava.indexOf("'ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA'");
    expect(naoExplicada).toBeLessThan(trava.indexOf("else 'ACORDO_AVISTA_AUSENTE'"));
  });

  it("é só leitura e só da gestão", () => {
    expect(esp(trava)).not.toMatch(/\b(insert|update|delete)\b/);
    expect(trava.indexOf("usuario_e_gestao")).toBeLessThan(trava.indexOf("acordo_avista_previa"));
  });
});

describe("rollback", () => {
  it("derruba as três funções e não desfaz registro em lote", () => {
    for (const assinatura of ["public.pagamentos_trava(uuid[])", "public.acordo_avista_registrar(uuid, uuid[], boolean)",
      "public.acordo_avista_previa(uuid, uuid[])"]) {
      expect(rb).toContain(`drop function if exists ${assinatura};`);
    }
    expect(esp(semComentario(rb))).not.toMatch(/\b(delete|update|insert)\b/);
  });
});
