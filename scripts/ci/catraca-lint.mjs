// CATRACA DO LINT — por que não é `eslint` puro travando o merge:
//
// O projeto tem 807 erros de lint herdados (quase todos variável declarada e
// não usada). Exigir zero hoje pararia todo mundo por causa de dívida antiga,
// e o CI acabaria desligado — que é o pior dos mundos.
//
// Então a régua é o SALDO: pode entrar código, não pode piorar. Se o número
// cair, o script avisa para baixar a linha de base — a catraca só anda para a
// frente.
//
// Para baixar a base depois de uma faxina:  node scripts/ci/catraca-lint.mjs --gravar
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = "scripts/ci/lint-base.json";

let saida = "[]";
try {
  saida = execFileSync("npx", ["eslint", ".", "-f", "json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  // eslint sai com código 1 quando encontra erro. A saída em JSON é o que
  // interessa e vem no stdout do mesmo jeito.
  saida = e.stdout || "";
  if (!saida) {
    console.error("não foi possível rodar o eslint:", e.message);
    process.exit(1);
  }
}

const relatorio = JSON.parse(saida);
const erros = relatorio.reduce((total, arquivo) => total + arquivo.errorCount, 0);

if (process.argv.includes("--gravar")) {
  writeFileSync(BASE, `${JSON.stringify({ erros }, null, 2)}\n`);
  console.log(`linha de base gravada: ${erros} erros`);
  process.exit(0);
}

if (!existsSync(BASE)) {
  console.error(`falta ${BASE}. Rode: node scripts/ci/catraca-lint.mjs --gravar`);
  process.exit(1);
}

const base = JSON.parse(readFileSync(BASE, "utf8")).erros;

if (erros > base) {
  console.error(`\n✗ lint piorou: ${base} → ${erros} (+${erros - base}).`);
  console.error("  Rode `npm run lint` e limpe o que este ramo introduziu.\n");
  process.exit(1);
}

if (erros < base) {
  console.log(`\n✓ lint melhorou: ${base} → ${erros}. Faxina feita.`);
  console.log("  Baixe a linha de base: node scripts/ci/catraca-lint.mjs --gravar\n");
  process.exit(0);
}

console.log(`✓ lint estável em ${erros} erros herdados (não piorou).`);
