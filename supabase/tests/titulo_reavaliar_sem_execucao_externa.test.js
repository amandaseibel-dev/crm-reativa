// CATRACA DE ACL: `titulo_reavaliar` nao pode voltar a ser chamavel de fora.
//
// POR QUE ESTA CATRACA E ESTATICA. O CI deste projeto nao tem segredo nenhum e
// nao liga no Supabase -- e a mesma premissa da catraca das migrations. Entao a
// verificacao nao consulta a ACL de producao: ela le o proprio historico de
// `.sql` do repositorio e recusa qualquer arquivo que, DEPOIS do revoke,
// devolva EXECUTE a PUBLIC/anon/authenticated.
//
// A janela e por versao: so interessa o que roda DEPOIS do revoke. Um grant de
// 2026-07 nao reabre nada, porque o revoke de 20260913233000 roda por cima.
//
// TRES VETORES DE REABERTURA, todos cobertos:
//   1. grant direto na funcao;
//   2. grant em lote (`grant execute on all functions in schema public to ...`),
//      que pega esta funcao junto;
//   3. `drop function` + recriar -- porque criar uma funcao do zero devolve
//      EXECUTE a PUBLIC pelo default do PostgreSQL. `create or replace` NAO
//      mexe em privilegio, entao nao entra aqui (e por isso a migration da
//      guarda de CANCELADA, que e create or replace, convive com esta).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");

const VERSAO_REVOKE = "20260913233000";
const ARQUIVO_REVOKE = `${VERSAO_REVOKE}_titulo_reavaliar_sem_execucao_externa.sql`;
const MIGRATION = resolve(RAIZ, "supabase/migrations", ARQUIVO_REVOKE);

const PAPEIS_PROIBIDOS = ["public", "anon", "authenticated"];

// Todo .sql de migration/ledger, com a versao de 14 digitos do nome.
function sqlVersionados() {
  const achados = [];
  for (const base of ["supabase/migrations", "supabase/ledger"]) {
    const raiz = resolve(RAIZ, base);
    const pilha = [raiz];
    while (pilha.length) {
      const dir = pilha.pop();
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) { pilha.push(caminho); continue; }
        if (!nome.endsWith(".sql")) continue;
        const versao = basename(nome).match(/^(\d{14})/);
        if (!versao) continue;
        achados.push({ caminho, nome, versao: versao[1], sql: readFileSync(caminho, "utf8") });
      }
    }
  }
  return achados;
}

// Comentario `--` nao e comando: uma migration pode explicar o que NAO fazer.
function semComentarios(sql) {
  return sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
}

const arquivos = sqlVersionados();
const posteriores = arquivos.filter((a) => a.versao >= VERSAO_REVOKE);

describe("catraca de ACL: titulo_reavaliar sem execucao externa", () => {
  it("a migration do revoke existe e tem exatamente as duas linhas", () => {
    const corpo = semComentarios(readFileSync(MIGRATION, "utf8"));
    const comandos = corpo.split(";").map((c) => c.trim()).filter(Boolean);
    expect(comandos).toEqual([
      "revoke execute on function public.titulo_reavaliar(uuid) from public",
      "revoke execute on function public.titulo_reavaliar(uuid) from authenticated",
    ]);
  });

  it("o revoke nao mexe em corpo, owner, seguranca, service_role nem em dado", () => {
    const corpo = semComentarios(readFileSync(MIGRATION, "utf8"));
    for (const proibido of [
      /create\s+(or\s+replace\s+)?function/i,
      /drop\s+function/i,
      /alter\s+function/i,
      /security\s+(definer|invoker)/i,
      /owner\s+to/i,
      /service_role/i,
      /\b(insert|update|delete|truncate)\b/i,
      /create\s+trigger/i,
      /\bgrant\b/i,
    ]) {
      expect(corpo).not.toMatch(proibido);
    }
  });

  it("nenhum .sql posterior devolve EXECUTE direto na funcao", () => {
    const culpados = [];
    for (const a of posteriores) {
      const corpo = semComentarios(a.sql);
      for (const papel of PAPEIS_PROIBIDOS) {
        const re = new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+(public\\.)?titulo_reavaliar[^;]*\\bto\\b[^;]*\\b${papel}\\b`,
          "i",
        );
        if (re.test(corpo)) culpados.push(`${a.nome} -> ${papel}`);
      }
    }
    expect(culpados).toEqual([]);
  });

  it("nenhum .sql posterior devolve EXECUTE em lote no schema public", () => {
    const culpados = [];
    for (const a of posteriores) {
      const corpo = semComentarios(a.sql);
      for (const papel of PAPEIS_PROIBIDOS) {
        const re = new RegExp(
          `grant\\s+execute\\s+on\\s+all\\s+functions\\s+in\\s+schema\\s+public[^;]*\\bto\\b[^;]*\\b${papel}\\b`,
          "i",
        );
        if (re.test(corpo)) culpados.push(`${a.nome} -> ${papel}`);
      }
    }
    expect(culpados).toEqual([]);
  });

  it("nenhum .sql posterior faz drop da funcao (recriar devolve EXECUTE a PUBLIC)", () => {
    const culpados = posteriores
      .filter((a) => /drop\s+function\s+(if\s+exists\s+)?(public\.)?titulo_reavaliar/i.test(semComentarios(a.sql)))
      .map((a) => a.nome);
    expect(culpados).toEqual([]);
  });

  it("a janela da catraca cobre a propria migration do revoke e o que vier depois", () => {
    // Se o nome/versao do revoke mudar sem atualizar a constante, a catraca
    // passaria a olhar para o vazio -- e isso tem de quebrar, nao passar batido.
    expect(posteriores.map((a) => a.nome)).toContain(ARQUIVO_REVOKE);
  });
});
