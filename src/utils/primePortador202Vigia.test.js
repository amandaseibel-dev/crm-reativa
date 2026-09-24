import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// VIGIA DO CICLO DIARIO DO 202, em dois niveis.
//
//   NIVEL 1  portador_202_ciclo_diario          -- falha aparece NO MESMO DIA
//   NIVEL 2  portador_202_desatualizado_critico -- degradacao > 72h
//
// O 72h NUNCA LIBERA NADA (Amanda, 24/09/2026): "qualquer futura decisao de
// reativacao continuara exigindo snapshot completo e com no maximo 24h. O
// limite de 72h nunca podera liberar titulo ou servir como evidencia de saida
// do juridico." As 72h so graduam o alerta.
//
// A REGRA E PURA (`prime_portador_202_anomalias`): recebe os fatos, devolve os
// motivos, nao consulta tabela. Por isso cada cenario pode ser provado sem
// depender do estado do banco. Os sete cenarios foram rodados em producao
// (leitura pura, com a logica inline) antes de qualquer aplicacao:
//
//   coleta de hoje concluida ............... []
//   snapshot valido de ONTEM, sem coleta ... [SEM_DISPARO_DIARIO,
//                                             SEM_CONCLUSAO_DIARIA,
//                                             SNAPSHOT_FORA_DO_CICLO]
//   disparo sem conclusao .................. [SEM_CONCLUSAO_DIARIA]
//   conferencia com erro HTTP .............. [CONFERENCIA_FALHOU:ERRO_HTTP,
//                                             SNAPSHOT_INVALIDO:CICLO_INCOMPLETO]
//   snapshot invalido ...................... [SNAPSHOT_INVALIDO:SEM_COLETA]
//   request_id divergente .................. [REQUEST_ID_DIVERGENTE]
//   vigia rodado antes da hora ............. []

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");
const nome = readdirSync(MIGRACOES).find((n) => n.endsWith("_prime_portador_202_vigia.sql"));
const sql = nome ? readFileSync(join(MIGRACOES, nome), "utf8") : "";
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

function corpoDe(fn) {
  const i = codigo.indexOf(`function public.${fn}`);
  if (i < 0) return "";
  const j = codigo.indexOf("$function$;", i);
  return codigo.slice(i, j < 0 ? undefined : j);
}

const MOTIVOS = [
  "PORTADOR_202_SEM_DISPARO_DIARIO",
  "PORTADOR_202_SEM_CONCLUSAO_DIARIA",
  "PORTADOR_202_CONFERENCIA_FALHOU",
  "PORTADOR_202_SNAPSHOT_INVALIDO",
  "PORTADOR_202_SNAPSHOT_FORA_DO_CICLO",
  "PORTADOR_202_REQUEST_ID_DIVERGENTE",
  "PORTADOR_202_DESATUALIZADO_CRITICO",
];

describe("vigia do ciclo diario do portador 202", () => {
  it("a migration existe", () => expect(nome).toBeTruthy());

  it("a regra de decisao e PURA: immutable e sem consulta a tabela", () => {
    const c = corpoDe("prime_portador_202_anomalias");
    expect(c).toMatch(/\bimmutable\b/i);
    expect(c).not.toMatch(/\bfrom\s+public\./i);
    expect(c).not.toMatch(/\bselect\b[\s\S]{0,80}\bfrom\b/i);
  });

  it("os sete motivos sao explicitos", () => {
    for (const m of MOTIVOS) expect(codigo, `falta ${m}`).toContain(m);
  });

  it("nivel 1 usa a janela do ciclo (24h), nunca 72h", () => {
    const c = corpoDe("prime_portador_202_vigia");
    const i = c.indexOf("portador_202_ciclo_diario");
    const antes = c.slice(0, i);
    expect(antes).toMatch(/prime_portador_snapshot_estado\(202, 24\)/);
  });

  it("nivel 2 usa 72h e so gradua alerta -- nao libera nada", () => {
    const c = corpoDe("prime_portador_202_vigia");
    expect(c).toMatch(/prime_portador_snapshot_estado\(202, 72\)/);
    // as 72h nao podem vazar para a funcao que responde sobre o juridico
    expect(codigo).not.toMatch(/prime_aluno_no_juridico/);
  });

  it("nao cobra antes da hora do ciclo", () => {
    const c = corpoDe("prime_portador_202_anomalias");
    expect(c).toMatch(/if p_agora < p_ciclo_em \+ interval '20 minutes' then\s*return '\{\}'/);
  });

  it("snapshot valido porem de ontem e anomalia", () => {
    // o caso traicoeiro: sem esta checagem o dia falhado passaria por saudavel
    const c = corpoDe("prime_portador_202_anomalias");
    expect(c).toMatch(/v_coletado is null or v_coletado < p_ciclo_em/);
    expect(c).toMatch(/PORTADOR_202_SNAPSHOT_FORA_DO_CICLO/);
  });

  it("compara request_id so quando os dois existem", () => {
    const c = corpoDe("prime_portador_202_anomalias");
    expect(c).toMatch(/p_req_disparo is not null and p_req_conferencia is not null/);
  });

  it("reaproveita o mecanismo do vigia -- nao cria sistema paralelo", () => {
    expect(codigo).toMatch(/insert into public\.invariante_resultado/);
    expect(codigo).toMatch(/insert into public\.invariante_config/);
    expect(codigo).toMatch(/from public\.invariante_config c[\s\S]{0,120}c\.ligado/);
    // e respeita o liga/desliga de cada invariante
    expect(corpoDe("prime_portador_202_vigia")).toMatch(/if exists \(select 1 from public\.invariante_config/);
  });

  it("o cron do vigia roda as duas coisas, no mesmo horario", () => {
    expect(codigo).toMatch(/cron\.schedule\('vigia_invariantes_diario',\s*'10 9 \* \* \*'/);
    expect(codigo).toMatch(/perform public\.invariantes_rodar\(\);[\s\S]{0,120}perform public\.prime_portador_202_vigia\(\)/);
  });

  it("o reagendamento preserva a guarda de carga do vigia", () => {
    // O comando do cron NAO e um `select` simples: e um bloco `do` que desiste
    // quando `sistema_sob_carga()` acusa carga. Reagendar sem ele apagaria a
    // protecao silenciosamente.
    const i = codigo.indexOf("cron.schedule('vigia_invariantes_diario'");
    const bloco = codigo.slice(i);
    expect(bloco).toMatch(/sistema_sob_carga\(\)/);
    expect(bloco).toMatch(/if coalesce\(\(v_carga->>'sob_carga'\)::boolean, false\) then return; end if;/);
  });

  it("nao reescreve invariantes_rodar", () => {
    expect(codigo).not.toMatch(/create or replace function public\.invariantes_rodar/i);
  });

  it("o vigia nao escreve em titulo, acordo, pagamento, fila nem no snapshot", () => {
    for (const t of ["acordos_titulos","acordos","parcelas","alunos","casos","pagamentos",
                     "carteira_operador","prime_portador_membro","prime_sync_cursor"]) {
      expect(codigo, `nao pode escrever em ${t}`)
        .not.toMatch(new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?${t}\\b`, "i"));
    }
    const inserts = (codigo.match(/insert\s+into\s+(public\.)?(\w+)/gi) || [])
      .map((x) => x.toLowerCase().replace(/.*\s/, "").replace(/^public\./, ""));
    expect([...new Set(inserts)].sort()).toEqual(["invariante_config", "invariante_resultado"]);
    expect(codigo).not.toContain("titulo_reativar");
  });
});
