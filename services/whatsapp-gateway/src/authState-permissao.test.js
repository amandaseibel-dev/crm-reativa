// A credencial É a sessão do WhatsApp: quem lê o arquivo clona o número.
//
// POR QUE ESTE ARQUIVO EXISTE: em 20/08/2026 os dois canais estavam com
// `piloto.json` e `comercial.json` em 0644 — legíveis por qualquer processo do
// Mac. `chmod` manual não resolve: o arquivo é reescrito centenas de vezes por
// minuto durante um sync, e cada gravação recriava o modo padrão do processo.
//
// Estes testes exercitam a gravação REAL (mesmo caminho do gateway), não uma
// simulação, e cobrem os dois casos que importam: arquivo novo e arquivo que
// já existia frouxo.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = mkdtempSync(join(tmpdir(), "authstate-perm-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://localhost:0";
process.env.CRM_SEGREDO = "teste";
process.env.GATEWAY_TOKEN = "teste";
process.env.SESSOES = "perm";

const { usarAuthStatePostgres } = await import("./authState.js");

const DIR = join(base, "sessoes");
const modo = (p) => (statSync(p).mode & 0o777).toString(8);

after(() => rmSync(base, { recursive: true, force: true }));

describe("credencial nunca fica legivel por outros", () => {
  test("o diretorio de sessoes e 700", () => {
    assert.equal(modo(DIR), "700", "diretorio de credenciais aberto");
  });

  test("arquivo NOVO nasce 600", async () => {
    const auth = await usarAuthStatePostgres("nova");
    auth.salvarCredenciais();
    const arq = join(DIR, "nova.json");
    assert.ok(existsSync(arq), "credencial nao foi gravada");
    assert.equal(modo(arq), "600", "credencial nova nasceu legivel por outros");
  });

  test("REGRAVACAO nao devolve 644 - era exatamente o bug", async () => {
    const auth = await usarAuthStatePostgres("regrava");
    auth.salvarCredenciais();
    const arq = join(DIR, "regrava.json");
    assert.equal(modo(arq), "600");

    // Simula o estado real encontrado em producao: alguem/algo deixou 644.
    chmodSync(arq, 0o644);
    assert.equal(modo(arq), "644", "pre-condicao do teste");

    // Uma nova gravacao (o que acontece a cada chave nova durante o sync)
    // precisa CORRIGIR, nao perpetuar.
    await auth.state.keys.set({ "lid-mapping": { "123_reverse": "5551999998888" } });
    await auth.descarregar().catch(() => {});
    assert.equal(modo(arq), "600", "regravacao deixou a credencial aberta de novo");
  });

  test("arquivo pre-existente frouxo e corrigido na primeira gravacao", async () => {
    const arq = join(DIR, "legado.json");
    writeFileSync(arq, JSON.stringify({ creds: {}, chaves: {} }), { mode: 0o644 });
    chmodSync(arq, 0o644);
    assert.equal(modo(arq), "644", "pre-condicao");

    const auth = await usarAuthStatePostgres("legado");
    auth.salvarCredenciais();
    assert.equal(modo(arq), "600", "credencial legada continuou aberta");
  });

  test("o temporario nao deixa brecha: nao sobra .tmp aberto", async () => {
    const auth = await usarAuthStatePostgres("tmpcheck");
    auth.salvarCredenciais();
    assert.ok(!existsSync(join(DIR, "tmpcheck.json.tmp")), "sobrou temporario");
  });
});

describe("chavesBrutas expoe o store para a semeadura de LID", () => {
  test("devolve o balde de chaves persistido", async () => {
    const auth = await usarAuthStatePostgres("store");
    await auth.state.keys.set({ "lid-mapping": { "999_reverse": "5551977776666" } });
    const chaves = auth.chavesBrutas();
    assert.equal(chaves["lid-mapping"]["999_reverse"], "5551977776666");
  });
});
