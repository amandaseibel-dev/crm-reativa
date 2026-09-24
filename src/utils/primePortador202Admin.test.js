import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// WRAPPER ADMINISTRATIVO DA COLETA DO 202.
//
// O risco que este desenho evita (levantado pela Amanda em 24/09/2026, antes
// de qualquer linha ser escrita): `prime_portador_202_coletar` e SECURITY
// DEFINER com owner `postgres`. Dentro dela, `current_user` e SEMPRE o owner
// -- logo um gate `current_user = 'postgres'` deixaria passar QUALQUER
// chamador, inclusive `anon`. Seria um bypass total.
//
// A solucao nao usa condicao dentro da funcao: usa GRANT, que o Postgres
// verifica ANTES de executar. E o wrapper e SECURITY INVOKER de proposito --
// se fosse DEFINER rodaria como postgres e alcancaria o nucleo mesmo invocado
// por outro papel.
//
// Privilegios conferidos em producao com has_function_privilege apos aplicar:
//   wrapper admin -> postgres SIM | authenticated NAO | anon NAO | service_role NAO
//   nucleo        -> postgres SIM | service_role SIM  | authenticated NAO | anon NAO

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");
const nome = readdirSync(MIGRACOES).find((n) => n.endsWith("_prime_portador_202_wrapper_admin.sql"));
const sql = nome ? readFileSync(join(MIGRACOES, nome), "utf8") : "";
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

function corpoDe(fn) {
  const i = codigo.indexOf(`function public.${fn}`);
  if (i < 0) return "";
  const j = codigo.indexOf("$function$;", i);
  return codigo.slice(i, j < 0 ? undefined : j);
}

describe("wrapper administrativo do portador 202", () => {
  it("a migration existe", () => expect(nome).toBeTruthy());

  it("o wrapper e SECURITY INVOKER -- nunca DEFINER", () => {
    const c = corpoDe("prime_portador_202_coletar_admin");
    expect(c).toMatch(/security invoker/i);
    expect(c).not.toMatch(/security definer/i);
  });

  it("postgres consegue disparar: e o unico com EXECUTE concedido", () => {
    expect(codigo).toMatch(/grant execute on function public\.prime_portador_202_coletar_admin\(boolean\)\s*\n?\s*to postgres;/i);
  });

  it("authenticated nao consegue: EXECUTE revogado por nome", () => {
    expect(codigo).toMatch(/revoke all on function public\.prime_portador_202_coletar_admin\(boolean\) from authenticated;/i);
    // e a segunda barreira: o nucleo tambem lhe e negado
    expect(codigo).toMatch(/revoke all on function public\._prime_portador_202_disparar\(text, boolean\) from authenticated;/i);
  });

  it("anon nao consegue: EXECUTE revogado por nome", () => {
    expect(codigo).toMatch(/revoke all on function public\.prime_portador_202_coletar_admin\(boolean\) from anon;/i);
    expect(codigo).toMatch(/revoke all on function public\._prime_portador_202_disparar\(text, boolean\) from anon;/i);
  });

  it("revogar de PUBLIC nao basta -- cada papel e revogado por nome", () => {
    // o schema tem default privileges que concedem EXECUTE a authenticated,
    // entao `revoke ... from public` sozinho deixaria a porta aberta.
    for (const papel of ["public", "anon", "authenticated", "service_role"]) {
      expect(codigo, `falta revogar de ${papel}`)
        .toMatch(new RegExp(`revoke all on function public\\.prime_portador_202_coletar_admin\\(boolean\\) from ${papel};`, "i"));
    }
  });

  it("a funcao normal continua exigindo usuario_e_gestao()", () => {
    const c = corpoDe("prime_portador_202_coletar");
    expect(c).toMatch(/usuario_e_gestao/);
    expect(c).toMatch(/SEM_PERMISSAO/);
    // e o gate vem antes de qualquer delegacao ao nucleo
    expect(c.indexOf("SEM_PERMISSAO")).toBeLessThan(c.indexOf("_prime_portador_202_disparar"));
  });

  it("nenhum gate usa current_user -- seria bypass em SECURITY DEFINER", () => {
    expect(codigo).not.toMatch(/current_user\s*=\s*'postgres'/i);
    expect(codigo).not.toMatch(/if\s+current_user/i);
  });

  it("o wrapper nao recebe portador e nao dispara outro", () => {
    const c = corpoDe("prime_portador_202_coletar_admin");
    expect(c).not.toMatch(/p_portador/);
    expect(c).toMatch(/_prime_portador_202_disparar\(/);
    // 202 e literal no nucleo, uma unica vez, no corpo da chamada HTTP
    const n = corpoDe("_prime_portador_202_disparar");
    expect(n).toMatch(/'portador',\s*202/);
    expect(n).not.toMatch(/'portador',\s*(166|195)\b/);
  });

  it("os dois caminhos geram a mesma auditoria", () => {
    const n = corpoDe("_prime_portador_202_disparar");
    for (const motivo of ["SISTEMA_SOB_CARGA", "SEGREDO_AUSENTE", "FALHA_DISPARO_HTTP"]) {
      expect(n).toContain(`'${motivo}'`);
    }
    expect(n).toMatch(/_prime_portador_202_auditar\(p_usuario, 'DISPARADA'/);
    expect(corpoDe("prime_portador_202_coletar")).toMatch(/_prime_portador_202_auditar/);
  });

  it("nao altera titulos, saldos, acordos nem filas", () => {
    for (const t of ["acordos_titulos","acordos","parcelas","alunos","casos","pagamentos","carteira_operador"]) {
      expect(codigo, `nao pode escrever em ${t}`)
        .not.toMatch(new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?${t}\\b`, "i"));
    }
    const inserts = codigo.match(/insert\s+into\s+(public\.)?(\w+)/gi) || [];
    expect(inserts.length).toBe(0); // o insert de auditoria mora na funcao auxiliar, de outra migration
    expect(codigo).not.toContain("titulo_reativar");
  });
});
