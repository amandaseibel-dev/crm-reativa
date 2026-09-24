import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// TODA CHAMADA DE `prime_portador_202_coletar` DEIXA RASTRO.
//
// O furo que isto trava (24/09/2026): a primeira versao so auditava o caminho
// feliz. `SISTEMA_SOB_CARGA` e `SEGREDO_AUSENTE` davam `return` antes do
// insert, entao uma recusa era indistinguivel de "a funcao nunca foi chamada"
// -- e foi exatamente o que aconteceu: a coleta nao rodou e nao havia como
// saber por que.
//
// Os testes abaixo leem os CAMINHOS DE SAIDA da funcao, um a um. Nao basta a
// palavra "auditar" existir no arquivo: cada `return` de recusa precisa ter uma
// chamada de auditoria ANTES dele, e nenhum caminho de recusa pode alcancar o
// disparo HTTP.

const RAIZ = new URL("../..", import.meta.url).pathname;
const MIGRACOES = join(RAIZ, "supabase", "migrations");

const nome = readdirSync(MIGRACOES).find((n) => n.endsWith("_prime_portador_202_auditar_recusas.sql"));
const sql = nome ? readFileSync(join(MIGRACOES, nome), "utf8") : "";
const codigo = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// Corpo da funcao de disparo, sem a funcao auxiliar de auditoria.
const iniColetar = codigo.indexOf("function public.prime_portador_202_coletar");
const corpo = iniColetar >= 0 ? codigo.slice(iniColetar) : "";

const MOTIVOS = ["SEM_PERMISSAO", "SISTEMA_SOB_CARGA", "SEGREDO_AUSENTE", "FALHA_DISPARO_HTTP"];

// Cada ponto onde a funcao devolve resultado.
function saidas() {
  const achados = [];
  const re = /return jsonb_build_object\(\s*'ok',\s*(true|false)/g;
  let m;
  while ((m = re.exec(corpo)) !== null) achados.push({ pos: m.index, ok: m[1] === "true" });
  return achados;
}

describe("auditoria da coleta do portador 202", () => {
  it("a migration existe e reescreve a funcao de disparo", () => {
    expect(nome, "migration de auditoria nao encontrada").toBeTruthy();
    expect(corpo).toBeTruthy();
  });

  // B. RECUSA GERA AUDITORIA
  it("todo caminho de saida audita antes de devolver", () => {
    const pontos = saidas();
    expect(pontos.length, "nenhuma saida encontrada").toBeGreaterThanOrEqual(5);
    // A auditoria tem de estar DENTRO do proprio caminho: olhar "N caracteres
    // atras" encontraria a auditoria do caminho ANTERIOR e deixaria passar um
    // return mudo -- foi o que uma mutacao revelou. A janela de cada saida
    // comeca no fim da saida anterior.
    let inicio = 0;
    for (const p of pontos) {
      const bloco = corpo.slice(inicio, p.pos);
      expect(bloco, `saida em ${p.pos} (ok=${p.ok}) nao audita dentro do proprio caminho`)
        .toMatch(/_prime_portador_202_auditar\(/);
      inicio = p.pos;
    }
  });

  it("os quatro motivos de recusa sao distinguidos", () => {
    for (const motivo of MOTIVOS) {
      expect(corpo, `falta o motivo ${motivo}`).toContain(`'${motivo}'`);
      // e cada motivo aparece numa chamada de auditoria, nao so no retorno
      const naAuditoria = new RegExp(`_prime_portador_202_auditar\\([^;]{0,200}'${motivo}'`, "s");
      expect(corpo, `${motivo} nao chega a auditoria`).toMatch(naAuditoria);
    }
  });

  it("a auditoria distingue DISPARADA de RECUSADA", () => {
    expect(codigo).toMatch(/PRIME_PORTADOR_202_COLETA_DISPARADA/);
    expect(codigo).toMatch(/PRIME_PORTADOR_202_COLETA_RECUSADA/);
    expect(corpo).toMatch(/_prime_portador_202_auditar\(\s*v_usuario,\s*'DISPARADA'/);
  });

  it("registra usuario, portador 202, request_id e momento", () => {
    const aux = codigo.slice(codigo.indexOf("function public._prime_portador_202_auditar"));
    expect(aux).toMatch(/'portador',\s*202/);
    expect(aux).toMatch(/'request_id',\s*p_request_id/);
    expect(aux).toMatch(/'em',\s*now\(\)/);
    expect(aux).toMatch(/p_usuario/);
  });

  // C. RECUSA NAO INICIA COLETA
  it("nenhum caminho de recusa alcanca o disparo HTTP", () => {
    const posHttp = corpo.indexOf("net.http_post");
    expect(posHttp).toBeGreaterThan(-1);
    // o disparo e unico: conta CHAMADA (com parentese), nao a mensagem de erro
    // que cita o nome da funcao em texto.
    expect((corpo.match(/net\.http_post\s*\(/g) || []).length).toBe(1);
    // e vem DEPOIS de todas as recusas
    for (const motivo of ["SEM_PERMISSAO", "SISTEMA_SOB_CARGA", "SEGREDO_AUSENTE"]) {
      const posRecusa = corpo.indexOf(`'${motivo}'`);
      expect(posRecusa, `${motivo} precisa ser avaliado antes do disparo`).toBeLessThan(posHttp);
    }
    // e cada recusa termina em `return` antes de seguir
    for (const motivo of ["SEM_PERMISSAO", "SISTEMA_SOB_CARGA", "SEGREDO_AUSENTE"]) {
      const trecho = corpo.slice(corpo.indexOf(`'${motivo}'`), posHttp);
      expect(trecho, `${motivo} precisa interromper o fluxo`).toMatch(/return jsonb_build_object/);
    }
  });

  // D. ACEITA DISPARA SOMENTE O 202
  it("o disparo é do portador 202 e de mais nenhum", () => {
    const disparo = corpo.slice(corpo.indexOf("net.http_post"), corpo.indexOf("net.http_post") + 600);
    expect(disparo).toMatch(/'portador',\s*202/);
    expect(disparo).not.toMatch(/'portador',\s*(166|195)\b/);
    expect(disparo).toMatch(/functions\/v1\/prime-portador/);
  });

  it("o caminho feliz audita DISPARADA com o request_id", () => {
    const pos = corpo.indexOf("'DISPARADA'");
    expect(pos).toBeGreaterThan(corpo.indexOf("net.http_post"));
    expect(corpo.slice(pos, pos + 120)).toMatch(/v_req/);
  });

  // 1. NAO AFROUXA A PROTECAO DE CARGA
  it("a protecao de carga continua abortando o disparo", () => {
    expect(corpo).toMatch(/v_carga\s*:=\s*public\.sistema_sob_carga\(\)/);
    const posCarga = corpo.indexOf("sistema_sob_carga");
    expect(posCarga).toBeLessThan(corpo.indexOf("net.http_post"));
    expect(corpo).toMatch(/if coalesce\(\(v_carga->>'sob_carga'\)::boolean, false\) then/);
  });

  // 2. NAO AFROUXA PERMISSAO
  it("continua restrita a gestao ou service_role", () => {
    expect(corpo).toMatch(/usuario_e_gestao/);
    expect(corpo).toMatch(/service_role/);
    const posPerm = corpo.indexOf("SEM_PERMISSAO");
    expect(posPerm).toBeLessThan(corpo.indexOf("net.http_post"));
    // o GRANT nao foi ampliado
    expect(codigo).toMatch(/grant execute on function public\.prime_portador_202_coletar\(boolean\)\s*\n?\s*to authenticated, service_role;/);
    // \bto: sem a fronteira, "into public.auditoria" casaria com "to public".
    expect(codigo).not.toMatch(/\bto\s+public\b/i);
  });

  it("nao grava segredo na auditoria", () => {
    // o valor dos segredos nunca entra no jsonb; so a existencia
    const chamadas = corpo.match(/_prime_portador_202_auditar\([\s\S]{0,400}?\);/g) || [];
    for (const c of chamadas) {
      expect(c, "segredo vazando para a auditoria").not.toMatch(/\bv_url\b(?!\s+is)/);
      expect(c, "segredo vazando para a auditoria").not.toMatch(/\bv_token\b(?!\s+is)/);
    }
    expect(corpo).toMatch(/'tem_projeto_url',\s*v_url is not null/);
  });

  // 3, 4, 5, 6: escopo
  it("nao toca Edge, mutirao, nem regra operacional", () => {
    expect(codigo).not.toMatch(/create or replace function public\.prime_portador_mutirao/i);
    expect(codigo).not.toMatch(/cron\.(schedule|alter_job|unschedule)/i);
    for (const t of ["acordos_titulos", "alunos", "casos", "parcelas", "acordos", "pagamentos"]) {
      expect(codigo, `nao pode escrever em ${t}`)
        .not.toMatch(new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?${t}\\b`, "i"));
    }
    expect(codigo).not.toContain("titulo_reativar");
  });

  it("o unico insert e em auditoria", () => {
    const inserts = codigo.match(/insert\s+into\s+(public\.)?(\w+)/gi) || [];
    expect(inserts.length).toBe(1);
    expect(inserts[0].toLowerCase()).toContain("auditoria");
  });
});
