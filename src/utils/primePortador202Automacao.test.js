import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// AUTOMACAO DA COLETA DO 202: dispara as 08h40 UTC, confere as 08h55.
//
// A conferencia existe porque a Edge e assincrona (Amanda, 24/09/2026: "nao
// quero que uma coleta disparada as 08h40 so seja classificada como sucesso ou
// falha na execucao do dia seguinte"). Ela SO OBSERVA: a validade do snapshot
// continua derivada de `prime_portador_snapshot_estado`, e em falha o snapshot
// segue invalido -- nao existe carimbo de "valido" que alguem possa escrever.

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");
const nome = readdirSync(MIGRACOES).find((n) => n.endsWith("_prime_portador_202_automacao.sql"));
const sql = nome ? readFileSync(join(MIGRACOES, nome), "utf8") : "";
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

function corpoDe(fn) {
  const i = codigo.indexOf(`function public.${fn}`);
  if (i < 0) return "";
  const j = codigo.indexOf("$function$;", i);
  return codigo.slice(i, j < 0 ? undefined : j);
}

describe("automacao do portador 202", () => {
  it("a migration existe", () => expect(nome).toBeTruthy());

  it("a rotina nao recebe parametro: nao da para pedir outro portador", () => {
    expect(codigo).toMatch(/create or replace function public\.prime_portador_202_rotina\(\)/);
    const c = corpoDe("prime_portador_202_rotina");
    expect(c).not.toMatch(/p_portador/);
    // e delega ao nucleo, onde 202 e literal
    expect(c).toMatch(/_prime_portador_202_disparar\('cron@sistema', false\)/);
  });

  it("advisory lock transacional -- erro no meio nao deixa cadeado preso", () => {
    const c = corpoDe("prime_portador_202_rotina");
    expect(c).toMatch(/pg_try_advisory_xact_lock/);
    expect(c).not.toMatch(/pg_try_advisory_lock\(/); // o de sessao exigiria unlock
  });

  it("protege contra disparo duplicado", () => {
    const c = corpoDe("prime_portador_202_rotina");
    // Ancora na CONDICAO, nao so nas strings: trocar `v_recente > 0` por
    // `false` desliga a guarda sem apagar nenhuma das mensagens -- uma mutacao
    // passou exatamente assim.
    expect(c).toMatch(/select count\(\*\) into v_recente[\s\S]{0,300}interval '10 minutes'/);
    expect(c).toMatch(/if v_recente > 0 then/);
    expect(c).toMatch(/_prime_portador_202_auditar\('cron@sistema', 'RECUSADA', 'DISPARO_RECENTE'/);
    expect(c).toMatch(/return jsonb_build_object\('ok', false, 'motivo', 'DISPARO_RECENTE'\)/);
  });

  it("a protecao de carga continua valendo, pelo nucleo", () => {
    // a rotina delega; quem checa carga e `_prime_portador_202_disparar`
    expect(corpoDe("prime_portador_202_rotina")).toMatch(/_prime_portador_202_disparar/);
  });

  it("a conferencia cobre as seis condicoes do ciclo", () => {
    const c = corpoDe("prime_portador_202_conferir_ciclo");
    for (const motivo of ["SEM_DISPARO_NO_CICLO", "ERRO_HTTP", "ERRO_EDGE",
                          "CICLO_INCOMPLETO", "SNAPSHOT_INVALIDO", "COLETA_NAO_CORRESPONDE_AO_CICLO"]) {
      expect(c, `falta a checagem ${motivo}`).toContain(motivo);
    }
    // liga o disparo a resposta HTTP pelo request_id
    expect(c).toMatch(/net\._http_response r where r\.id = v_req/);
  });

  it("a conferencia usa tolerancia do ciclo (24h), nao o limite generico", () => {
    expect(corpoDe("prime_portador_202_conferir_ciclo")).toMatch(/prime_portador_snapshot_estado\(202, 24\)/);
  });

  it("registra CONCLUIDA so quando nao ha motivo de falha", () => {
    const c = corpoDe("prime_portador_202_conferir_ciclo");
    expect(c).toMatch(/if v_motivo is null then[\s\S]{0,300}'CONCLUIDA'/);
    expect(c).toMatch(/'FALHOU', v_motivo/);
    // as duas acoes existem no mapeamento da auditoria
    expect(codigo).toMatch(/PRIME_PORTADOR_202_COLETA_CONCLUIDA/);
    expect(codigo).toMatch(/PRIME_PORTADOR_202_COLETA_FALHOU/);
  });

  it("a conferencia NAO marca snapshot como valido -- so observa", () => {
    const c = corpoDe("prime_portador_202_conferir_ciclo");
    expect(c).not.toMatch(/(insert|update|delete)\s+(into\s+)?(public\.)?prime_portador_membro/i);
    expect(c).not.toMatch(/(insert|update|delete)\s+(into\s+)?(public\.)?prime_sync_cursor/i);
    expect(c).not.toMatch(/\bvalido\b\s*:=/);
  });

  it("os crons sao dedicados e nao tocam o mutirao de 166/195", () => {
    expect(codigo).toMatch(/cron\.schedule\('prime_portador_202_diario',\s*'40 8 \* \* \*'/);
    expect(codigo).toMatch(/cron\.schedule\('prime_portador_202_conferir',\s*'55 8 \* \* \*'/);
    expect(codigo).not.toMatch(/prime_portador_mutirao/);
    // a conferencia vem depois do disparo
    expect(codigo.indexOf("'40 8 * * *'")).toBeLessThan(codigo.indexOf("'55 8 * * *'"));
  });

  it("as duas rotinas sao negadas a anon e authenticated", () => {
    for (const fn of ["prime_portador_202_rotina\\(\\)", "prime_portador_202_conferir_ciclo\\(\\)"]) {
      for (const papel of ["public", "anon", "authenticated"]) {
        expect(codigo, `falta revogar ${fn} de ${papel}`)
          .toMatch(new RegExp(`revoke all on function public\\.${fn} from ${papel};`, "i"));
      }
    }
  });

  it("nao altera titulo, saldo, acordo, fila nem efetividade", () => {
    for (const t of ["acordos_titulos","acordos","parcelas","alunos","casos","pagamentos","carteira_operador"]) {
      expect(codigo, `nao pode escrever em ${t}`)
        .not.toMatch(new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?${t}\\b`, "i"));
    }
    const inserts = codigo.match(/insert\s+into\s+(public\.)?(\w+)/gi) || [];
    expect(inserts.length).toBe(1);
    expect(inserts[0].toLowerCase()).toContain("auditoria");
    expect(codigo).not.toContain("titulo_reativar");
  });
});
