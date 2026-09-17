// PAGAMENTOS_TRAVA USA O RESULTADO DA PREVIA -- ESTRUTURA.
//
// O comportamento esta provado em recuperacao_acordo_avista_comportamento.test.js
// (PGlite, uma trava por motivo real da auditoria de 17/09/2026). Aqui ficam as
// garantias de TEXTO: a migration so troca o corpo de pagamentos_trava, nao
// reescreve regra financeira, nao faz simulacao nova, nao busca combinacao e nao
// mexe em permissao. Comentarios sao removidos antes de proibir palavra.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8").replace(/\r/g, "");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const sql = ler("supabase/migrations/20260917100000_pagamentos_trava_usa_resultado_da_previa.sql");
const rb = ler("supabase/rollbacks/20260917100000_pagamentos_trava_usa_resultado_da_previa.rollback.sql");

const semComentario = (t) => t.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const esp = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const entre = (t, tag) => {
  const a = t.indexOf(tag);
  return t.slice(a + tag.length, t.indexOf(tag, a + tag.length));
};

const codigo = semComentario(sql);
const trava = semComentario(entre(sql, "$fn$"));
// o que sobra fora do corpo e do bloco de prova: os comandos da migration
const comandos = esp(codigo.replace(/\$fn\$[\s\S]*?\$fn\$/g, "").replace(/\$prova\$[\s\S]*?\$prova\$/g, ""));

describe("escopo da migration", () => {
  it("só troca o corpo de pagamentos_trava, com a mesma assinatura e o mesmo retorno", () => {
    expect(esp(codigo).match(/create or replace function/g)).toHaveLength(1);
    expect(esp(codigo)).toContain(
      "create or replace function public.pagamentos_trava(p_pagamento_ids uuid[]) " +
      "returns table(pagamento_id uuid, trava text, aluno_id uuid, aluno_nome text, numero_ulbra text)",
    );
  });

  it("não mexe em permissão, tabela, dado nem cron", () => {
    expect(comandos).not.toMatch(/\b(grant|revoke|drop|alter|insert into|update public\.|delete from|create table|create trigger)\b/);
    expect(comandos).not.toMatch(/cron\.(schedule|unschedule)/);
  });

  it("não toca motor de baixa, vínculo, importação, portador, configuração do fluxo nem a prévia", () => {
    for (const nome of ["pagamento_conciliar_um", "pagamento_vincular_aluno", "vincular_titulos_acordo",
      "importar_acordos", "parcelas_amarrar_boleto", "baixa_pelo_relatorio_pagamento", "conciliacao_reprocessar",
      "conciliacao_consultar_portador_pendentes", "fluxo_pagamentos_rodar", "fluxo_pagamentos_config",
      "acordo_avista_registrar"]) {
      expect(esp(codigo)).not.toContain(nome);
    }
    expect(esp(codigo)).not.toMatch(/function public\.acordo_avista_previa\s*\(/);
  });
});

describe("o corpo novo", () => {
  it("continua só leitura e atrás do portão da gestão", () => {
    expect(esp(trava)).not.toMatch(/\b(insert|update|delete)\b/);
    expect(trava.indexOf("usuario_e_gestao")).toBeGreaterThan(-1);
    expect(trava.indexOf("usuario_e_gestao")).toBeLessThan(trava.indexOf("acordo_avista_previa"));
  });

  it("reutiliza a prévia que já executava: uma chamada por pagamento, nenhuma simulação nova", () => {
    expect(trava.match(/acordo_avista_previa\(/g)).toHaveLength(1);
    expect(trava).toContain("public.acordo_avista_previa(v_id, null)");
    expect(trava).toContain("v_p ->> 'aprovado'");
    expect(trava).toContain("v_p -> 'bloqueios'");
  });

  it("não reescreve regra financeira: nem margem, nem soma, nem valor pago", () => {
    // os codigos de bloqueio sao nomes vindos da previa, nao regra
    const semCodigos = trava.replace(/'[A-Z_]+'/g, "''");
    expect(semCodigos).not.toMatch(/1[.,]15|margem|soma|valor_pago|valor_parcela|saldo|titulos'/i);
  });

  it("não busca combinação menor de mensalidades nesta versão", () => {
    expect(esp(trava)).not.toContain("with recursive");
    // nao le as mensalidades da previa para montar outra escolha
    expect(trava).not.toMatch(/'titulos'|'candidatos'|'selecionados'/);
    expect(trava.match(/acordo_avista_previa\(v_id, null\)/g)).toHaveLength(1);
  });

  it("recusada pela prévia, cada motivo vira uma trava sem ação; só a aprovada segue ACORDO_AVISTA_AUSENTE", () => {
    const bloco = trava.slice(trava.indexOf("if trava = 'ACORDO_AVISTA_AUSENTE' and not"));
    for (const nova of ["ACORDO_AVISTA_ALUNO_ENCERRADO", "ACORDO_AVISTA_OPERADOR_NAO_CADASTRADO",
      "ACORDO_AVISTA_OUTRO_BLOQUEIO", "ACORDO_AVISTA_SEM_MENSALIDADE_ELEGIVEL",
      "ACORDO_AVISTA_FORA_DA_MARGEM", "ACORDO_AVISTA_SEM_COMBINACAO_SEGURA"]) {
      expect(bloco).toContain(`'${nova}'`);
    }
    expect(bloco).not.toContain("then 'ACORDO_AVISTA_AUSENTE'");
  });
});

describe("rollback", () => {
  it("recria o corpo exato que produção tem hoje, sem escrever dado", () => {
    // md5 do prosrc de pagamentos_trava em producao em 17/09/2026
    expect(md5(entre(rb, "$fn$"))).toBe("482299bf8488c74018f201279614302c");
    const rbComandos = esp(semComentario(rb).replace(/\$fn\$[\s\S]*?\$fn\$/g, ""));
    expect(rbComandos).not.toMatch(/\b(grant|revoke|drop|delete|update|insert)\b/);
  });
});
