// TRAVA DE TESTES SIMULTÂNEOS — só na máquina de quem desenvolve.
//
// POR QUE EXISTE: com várias sessões do Claude abertas no mesmo repositório, é
// fácil duas delas rodarem `npm test` ao mesmo tempo sem saber uma da outra.
// Medido em 09/10/2026 num Mac de 8 GB: uma única rodada já sobe 5 workers e
// 2,5 GB; duas rodadas juntas levam o swap acima de 4 GB, que é o ponto onde a
// carga medida salta de 2,4 para 19 e a máquina congela.
//
// O limite de workers (vitest.config.js) resolve uma rodada. Esta trava resolve
// o caso de DUAS. São problemas diferentes e precisam das duas peças.
//
// O QUE ELA NÃO FAZ: não mata processo nenhum, não espera em fila, não apaga
// nada. Ela recusa a segunda rodada com uma mensagem dizendo quem está rodando,
// e quem pediu decide. Preferi recusar a enfileirar: fila silenciosa deixa a
// pessoa olhando um terminal parado sem saber por quê.
//
// NO CI NÃO RODA: cada job é um runner novo e descartável, não existe
// concorrência entre sessões, e falhar ali seria quebrar a catraca por nada.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Fora do CI apenas. GitHub Actions define CI=true.
if (process.env.CI) process.exit(0);

// Uma escapatória explícita, para quem sabe o que está fazendo:
//   SEM_TRAVA_TESTES=1 npm test
if (process.env.SEM_TRAVA_TESTES) {
  console.error("trava de testes ignorada por SEM_TRAVA_TESTES=1");
  process.exit(0);
}

// A trava vive em /tmp, não no repositório: nada de arquivo novo aparecendo no
// `git status` de ninguém.
//
// A chave NÃO pode ser o cwd. As sessões do Claude trabalham em worktrees
// (.claude/worktrees/..., /private/tmp/claude-501/wt-...), e cada worktree tem
// cwd próprio — com cwd como chave, duas sessões em worktrees do mesmo
// repositório não se travariam, que é exatamente o caso que esta trava existe
// para cobrir. A chave é o diretório git COMUM, igual para o repo principal e
// todos os seus worktrees. Clones independentes seguem com travas separadas,
// como deve ser.
const raizGit = () => {
  const dotGit = join(process.cwd(), ".git");
  try {
    const st = readFileSync(dotGit, "utf8");
    // Em worktree, `.git` é um arquivo: "gitdir: /caminho/repo/.git/worktrees/nome"
    const m = st.match(/^gitdir:\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/\/\.git\/worktrees\/[^/]+\/?$/, "");
  } catch {
    // `.git` é diretório (repo principal) ou ilegível: o cwd já é a raiz.
  }
  return process.cwd();
};

const dir = join(tmpdir(), "crm-reativa-travas");
const id = createHash("sha256").update(raizGit()).digest("hex").slice(0, 12);
const trava = join(dir, `testes-${id}.json`);

const vivo = (pid) => {
  try {
    // Sinal 0 não envia nada: só pergunta se o processo existe.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// O pid que interessa é o do `npm`, não o deste script — este morre em
// milissegundos. process.ppid vive enquanto a rodada durar.
const meuPid = process.ppid;

// `--liberar` é o modo usado pelo `posttest`: apaga a trava se ela for nossa.
// Separar aquisição de liberação é essencial: este script roda como `pretest` e
// morre em seguida, então liberar na saída do próprio processo apagaria a trava
// no mesmo instante em que ela foi criada.
if (process.argv.includes("--liberar")) {
  try {
    const atual = JSON.parse(readFileSync(trava, "utf8"));
    if (atual.pid === meuPid) unlinkSync(trava);
  } catch {
    /* já liberada, ilegível ou de outra rodada */
  }
  process.exit(0);
}

const comando = process.argv.filter((a) => a !== "--liberar").slice(2).join(" ") || "npm test";

if (existsSync(trava)) {
  let dono = null;
  try {
    dono = JSON.parse(readFileSync(trava, "utf8"));
  } catch {
    // Trava corrompida (máquina desligou no meio, por exemplo) não deve
    // bloquear ninguém para sempre.
    dono = null;
  }

  if (dono && vivo(dono.pid) && dono.pid !== meuPid) {
    const minutos = Math.round((Date.now() - dono.desde) / 60000);
    console.error(`
✗ já existe uma rodada de testes nesta máquina (pid ${dono.pid}, há ${minutos} min)
    ${dono.comando}

  Rodar duas ao mesmo tempo passa dos 4 GB de swap e congela a máquina.

  Opções:
    • esperar a rodada atual terminar
    • rodar só o arquivo que você mexeu, que é mais rápido e mais leve:
        npx vitest run caminho/do/arquivo.test.jsx
    • se tem certeza de que quer as duas:
        SEM_TRAVA_TESTES=1 npm test
`);
    process.exit(1);
  }
  // Dono morto ou trava ilegível: assume.
}

mkdirSync(dir, { recursive: true });
writeFileSync(
  trava,
  `${JSON.stringify({ pid: meuPid, desde: Date.now(), comando, cwd: process.cwd() }, null, 2)}\n`,
);

// A liberação acontece no `posttest` (`--liberar` acima). Se ela não rodar —
// Ctrl-C, falha de teste, kill -9, queda de energia — a trava fica no disco com
// o pid de um processo morto, e a próxima rodada assume: é isso que o
// `vivo(dono.pid)` acima garante. Nunca fica presa.
