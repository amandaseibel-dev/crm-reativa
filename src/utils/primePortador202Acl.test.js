import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ACL DA INFRAESTRUTURA DO PORTADOR 202 -- menor privilegio.
//
// De onde vinha o excesso: o schema `public` tem default privileges que
// concedem EXECUTE a `authenticated`, e a ACL padrao de uma funcao nova ja
// inclui PUBLIC. Ninguem decidiu abrir estas funcoes -- elas nasceram abertas.
//
// POR QUE REVOGAR NAO QUEBRA AS CADEIAS. Dependencias levantadas NO BANCO
// (pg_proc / cron.job / views / triggers), nao por busca textual:
//   _prime_portador_202_auditar    <- _disparar, _coletar, _conferir_ciclo, _rotina
//   _prime_portador_202_disparar   <- _coletar, _coletar_admin, _rotina
//   prime_portador_snapshot_estado <- _disparar, aluno_no_juridico, _coletar, _conferir_ciclo
//   prime_portador_202_anomalias   <- vigia
//   prime_aluno_no_juridico        <- ninguem
//   prime_portador_202_coletar     <- ninguem
// TODAS as chamadoras sao SECURITY DEFINER com owner `postgres`, e em SECURITY
// DEFINER o EXECUTE da funcao interna e verificado contra o OWNER. Por isso
// `postgres` e mantido em todas -- e por isso nenhum REVOKE rompe cadeia.

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");
const sql = readdirSync(MIGRACOES)
  .filter((n) => /_prime_portador_(202|membro)/.test(n))
  .sort()
  .map((n) => readFileSync(join(MIGRACOES, n), "utf8"))
  .join("\n");
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// Assinatura -> quem PRECISA executar no fim.
const MATRIZ = {
  "prime_portador_202_coletar(boolean)":                 { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
  "prime_portador_202_coletar_admin(boolean)":           { nega: ["public","anon","authenticated","service_role"], permite: ["postgres"] },
  "_prime_portador_202_disparar(text, boolean)":         { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
  "_prime_portador_202_auditar(text, text, text, bigint, jsonb)": { nega: ["authenticated"], permite: ["postgres","service_role"] },
  "prime_portador_202_rotina()":                         { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
  "prime_portador_202_conferir_ciclo()":                 { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
  "prime_portador_202_vigia()":                          { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
  "prime_aluno_no_juridico(text)":                       { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
  "prime_portador_snapshot_estado(integer, integer)":    { nega: ["public","anon","authenticated"], permite: ["postgres","service_role"] },
};
const ANOMALIAS = "prime_portador_202_anomalias(timestamptz, timestamptz, timestamptz, bigint, text, bigint, text, jsonb)";

function temRevoke(assinatura, papel) {
  const esc = assinatura.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return new RegExp(`revoke all on function public\\.${esc}\\s*from ${papel};`, "i").test(codigo);
}
function temGrant(assinatura, papel) {
  const esc = assinatura.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return new RegExp(`grant execute on function public\\.${esc}\\s*\\n?\\s*to [^;]*\\b${papel}\\b`, "i").test(codigo);
}

describe("ACL do portador 202", () => {
  it("anon nao executa NENHUMA funcao da infraestrutura do 202", () => {
    for (const assinatura of Object.keys(MATRIZ)) {
      const m = MATRIZ[assinatura];
      if (!m.nega.includes("anon")) continue;
      expect(temRevoke(assinatura, "anon"), `anon nao foi revogado de ${assinatura}`).toBe(true);
      expect(temGrant(assinatura, "anon"), `anon recebeu grant em ${assinatura}`).toBe(false);
    }
    expect(temRevoke(ANOMALIAS, "anon")).toBe(true);
  });

  it("PUBLIC nao concede execucao indiretamente", () => {
    for (const assinatura of Object.keys(MATRIZ)) {
      if (!MATRIZ[assinatura].nega.includes("public")) continue;
      expect(temRevoke(assinatura, "public"), `PUBLIC nao foi revogado de ${assinatura}`).toBe(true);
    }
    expect(temRevoke(ANOMALIAS, "public")).toBe(true);
    // e nenhum grant amplo escapou
    expect(codigo).not.toMatch(/grant execute on function[^;]*\bto\s+public\b/i);
  });

  it("authenticated so fica onde ha caso de uso real -- hoje, em nenhuma", () => {
    for (const assinatura of Object.keys(MATRIZ)) {
      if (!MATRIZ[assinatura].nega.includes("authenticated")) continue;
      expect(temRevoke(assinatura, "authenticated"), `authenticated nao foi revogado de ${assinatura}`).toBe(true);
    }
    expect(temRevoke(ANOMALIAS, "authenticated")).toBe(true);
  });

  it("service_role mantem os caminhos server-side", () => {
    for (const [assinatura, m] of Object.entries(MATRIZ)) {
      if (!m.permite.includes("service_role")) continue;
      expect(temGrant(assinatura, "service_role"), `service_role perdeu ${assinatura}`).toBe(true);
    }
  });

  it("postgres mantem TODOS os caminhos -- e o que sustenta as chamadas internas", () => {
    for (const assinatura of Object.keys(MATRIZ)) {
      expect(temGrant(assinatura, "postgres"), `postgres perdeu ${assinatura}`).toBe(true);
    }
    expect(temGrant(ANOMALIAS, "postgres")).toBe(true);
    // postgres nunca pode ser revogado sem reconceder
    const revokesPostgres = codigo.match(/revoke all on function[^;]*from postgres;/gi) || [];
    expect(revokesPostgres.length).toBe(0);
  });

  it("nenhum REVOKE impede chamada interna: as chamadoras sao DEFINER com owner postgres", () => {
    // Se uma chamadora virasse INVOKER, a interna passaria a ser verificada
    // contra o chamador -- e ai o revoke de authenticated quebraria a cadeia.
    for (const fn of ["_prime_portador_202_disparar", "prime_portador_202_coletar",
                      "prime_portador_202_rotina", "prime_portador_202_conferir_ciclo",
                      "prime_portador_202_vigia", "prime_aluno_no_juridico",
                      "prime_portador_snapshot_estado", "_prime_portador_202_auditar"]) {
      // Ancora na DEFINICAO, nao em qualquer mencao: `lastIndexOf("function
      // public.X(")` acharia o `grant execute on function ...` da migration de
      // hardening. E o parentese e obrigatorio porque
      // `prime_portador_202_coletar` e prefixo de `..._coletar_admin`.
      const i = codigo.lastIndexOf(`create or replace function public.${fn}(`);
      expect(i, `${fn} nao encontrada`).toBeGreaterThan(-1);
      const cab = codigo.slice(i, i + 400);
      expect(cab, `${fn} precisa ser SECURITY DEFINER`).toMatch(/security definer/i);
    }
    // a unica INVOKER do conjunto so e executavel por postgres
    const admin = codigo.slice(codigo.lastIndexOf("create or replace function public.prime_portador_202_coletar_admin("));
    expect(admin.slice(0, 400)).toMatch(/security invoker/i);
    expect(temGrant("prime_portador_202_coletar_admin(boolean)", "postgres")).toBe(true);
  });

  it("a rotina, a conferencia e o vigia continuam executaveis pelo cron (postgres)", () => {
    for (const assinatura of ["prime_portador_202_rotina()", "prime_portador_202_conferir_ciclo()",
                              "prime_portador_202_vigia()"]) {
      expect(temGrant(assinatura, "postgres"), `o cron perderia ${assinatura}`).toBe(true);
    }
  });

  it("o hardening e migration separada -- nao reescreve migration aplicada", () => {
    const nomes = readdirSync(MIGRACOES).filter((n) => /_prime_portador_202/.test(n)).sort();
    const hardening = nomes.find((n) => n.endsWith("_prime_portador_202_hardening_acl.sql"));
    expect(hardening, "falta a migration de hardening").toBeTruthy();
    // ela e a mais nova do conjunto
    expect(nomes[nomes.length - 1]).toBe(hardening);
    // e nao recria funcao nenhuma: so mexe em privilegio
    const txt = readFileSync(join(MIGRACOES, hardening), "utf8");
    expect(txt).not.toMatch(/create or replace function/i);
    expect(txt).not.toMatch(/(insert|update|delete)\s+/i);
  });
});
