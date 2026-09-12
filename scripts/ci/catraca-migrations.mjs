// CATRACA DAS MIGRATIONS — por que existe, e por que ela não fala com o banco:
//
// Medido em 12/09/2026: produção tem 1.238 versões em `schema_migrations`, o
// repositório tem 451 versões de arquivo, e a interseção é 41. São duas trilhas
// quase disjuntas. Exigir paridade hoje pararia todo mundo por dívida antiga —
// e o CI acabaria desligado, que é o pior dos mundos (é o mesmo raciocínio da
// `catraca-lint.mjs`, que já existe aqui e funciona).
//
// Então a régua é: **o legado é tolerado, nenhum PR novo pode piorá-lo.**
//
// PRINCÍPIO: esta verificação roda SÓ sobre o checkout Git. Não liga no
// Supabase, não lê credencial, não consulta produção, não abre
// `schema_migrations` nem `.temp/linked-project.json`. O CI do projeto não tem
// segredo nenhum e precisa continuar assim.
//
// POR QUE SEM ARQUIVO DE LINHA DE BASE: a validação estrutural é mais forte que
// contagem. Em vez de guardar "22 duplicidades conhecidas" e comparar o total,
// a catraca indexa as versões que JÁ EXISTEM no branch base e recusa qualquer
// arquivo novo que reutilize uma delas. Com isso a 23ª duplicidade é bloqueada
// mesmo que o total geral continue 22 — o que uma contagem não pegaria.
//
// QUAL E A BASE, POR EVENTO:
//   pull_request -> GITHUB_BASE_REF (o branch de destino). Funciona direto.
//   push em main -> `origin/main` JA APONTA PARA O PROPRIO HEAD depois do push,
//                   e a catraca sairia sem olhar o commit que acabou de entrar.
//                   Por isso o workflow passa CATRACA_BASE=${{ github.event.before }},
//                   o SHA anterior ao push. Em pull_request esse valor vem VAZIO,
//                   e vazio NAO intercepta o fallback.
//
// Base invalida ou inexistente FALHA FECHADO (exit 1). Nunca passa em silencio:
// verificacao que some sem avisar e pior que verificacao que nao existe.
//
// Uso local:   npm run check:migrations
// Base manual: CATRACA_BASE=origin/main npm run check:migrations
import { execFileSync } from "node:child_process";

const MIGRATIONS = "supabase/migrations/";
const LEDGER = "supabase/ledger/";

// `.sql` nestes diretórios é auxiliar (rollback, reparo, teste, auditoria,
// pendência) e NÃO segue a regra de migration. `rollbacks/` em especial usa de
// propósito o MESMO timestamp da migration que desfaz — por isso estes
// diretórios ficam fora do índice de versões.
const AUXILIARES = [
  "supabase/rollbacks/",
  "supabase/recovery/",
  "supabase/tests/",
  "supabase/audits/",
  "supabase/aguardando_aprovacao/",
];

const PADRAO_MIGRATION = /^(\d{14})_(?!_)(.+)\.sql$/;
const PADRAO_LEDGER = /^(\d{14})__(.+)\.sql$/;
const COMECA_COM_TIMESTAMP = /^(\d{14})_/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
// `stdio` silencia o stderr do git: quando a base não existe, `merge-base`
// imprime "fatal: ..." e isso apareceria no log do CI antes da nossa mensagem,
// dando a impressão de dois erros diferentes.
function gitOuNulo(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Qual é a base da comparação. Precisa funcionar em PR, em push e na mão.
// ---------------------------------------------------------------------------
const SHA_ZERO = /^0{40}$/;

function resolverBase() {
  // trim ANTES de decidir: no evento pull_request o workflow passa
  // CATRACA_BASE="" (github.event.before vem vazio), e string vazia ou só espaço
  // tem de cair no fallback, não virar uma "base explícita" inválida.
  const explicita = (process.env.CATRACA_BASE || "").trim();
  if (explicita) return { ref: explicita, explicita: true };

  // Em PR o GitHub Actions expõe o nome do branch de destino.
  const baseRef = (process.env.GITHUB_BASE_REF || "").trim();
  if (baseRef) {
    const ref = `origin/${baseRef}`;
    if (gitOuNulo(["rev-parse", "--verify", "--quiet", ref])) return { ref, explicita: false };
  }
  for (const cand of ["origin/main", "main", "HEAD^"]) {
    if (gitOuNulo(["rev-parse", "--verify", "--quiet", cand])) return { ref: cand, explicita: false };
  }
  return { ref: null, explicita: false };
}

const { ref: baseBruta, explicita: baseExplicita } = resolverBase();

// SHA de zeros: o GitHub manda isso quando o push CRIOU o ref — não existe
// "antes". Falha fechado de propósito: em `main`, que já existe, isso significa
// algo fora do comum (force-push, branch recriado) e merece olho humano.
if (baseBruta && SHA_ZERO.test(baseBruta)) {
  console.error("\n✗ catraca das migrations: a base recebida é o SHA de zeros.");
  console.error("  Acontece quando o push criou o ref e não existe commit anterior.");
  console.error("  Rode com base explícita: CATRACA_BASE=<sha ou ref> npm run check:migrations\n");
  process.exit(1);
}

if (!baseBruta) {
  console.error("\n✗ catraca das migrations: não há base para comparar e nenhuma foi informada.");
  console.error("  Informe uma: CATRACA_BASE=<sha ou ref> npm run check:migrations\n");
  process.exit(1);
}

// O ponto de bifurcação é o que importa: sem ele, commits que entraram na base
// depois do fork apareceriam como se este ramo os tivesse apagado.
const baseSha = (
  gitOuNulo(["merge-base", baseBruta, "HEAD"]) ||
  gitOuNulo(["rev-parse", "--verify", "--quiet", `${baseBruta}^{commit}`]) ||
  ""
).trim();
if (!baseSha) {
  console.error(`\n✗ catraca das migrations: não consegui resolver a base "${baseBruta}"${baseExplicita ? " (informada em CATRACA_BASE)" : ""}.`);
  console.error("  Em CI, garanta `fetch-depth: 0` no checkout — com clone raso o commit anterior pode não existir localmente.");
  console.error("  Local: CATRACA_BASE=<sha ou ref> npm run check:migrations\n");
  process.exit(1);
}

const headSha = (gitOuNulo(["rev-parse", "HEAD"]) || "").trim();
if (baseSha === headSha) {
  // Acontece de propósito ao rodar na mão estando no próprio branch base. NÃO
  // deve acontecer no CI: no push em main a base vem de github.event.before.
  console.log(`✓ catraca das migrations: a base "${baseBruta}" é o próprio HEAD (${headSha.slice(0, 8)}). Nada novo para verificar.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Índice das versões que JÁ EXISTEM no branch base.
// Só `migrations/` e `ledger/` entram: são as duas trilhas onde a versão é
// identidade. Auxiliares ficam fora (ver comentário em AUXILIARES).
// ---------------------------------------------------------------------------
const arquivosBase = (gitOuNulo(["ls-tree", "-r", "--name-only", baseSha]) || "").split("\n").filter(Boolean);

const versoesBase = new Map(); // versao -> [caminhos]
const sqlBase = new Set();
for (const caminho of arquivosBase) {
  const emMigrations = caminho.startsWith(MIGRATIONS) && caminho.endsWith(".sql");
  const emLedger = caminho.startsWith(LEDGER) && caminho.endsWith(".sql");
  if (!emMigrations && !emLedger) continue;
  sqlBase.add(caminho);
  const nome = caminho.slice(caminho.lastIndexOf("/") + 1);
  const m = COMECA_COM_TIMESTAMP.exec(nome);
  if (!m) continue;
  if (!versoesBase.has(m[1])) versoesBase.set(m[1], []);
  versoesBase.get(m[1]).push(caminho);
}

// ---------------------------------------------------------------------------
// O que este ramo mudou.
// ---------------------------------------------------------------------------
const diff = (gitOuNulo(["diff", "--name-status", "-M", `${baseSha}`, headSha]) || "")
  .split("\n")
  .filter(Boolean)
  .map((linha) => {
    const partes = linha.split("\t");
    const estado = partes[0];
    if (estado.startsWith("R")) return { estado: "R", de: partes[1], para: partes[2] };
    return { estado: estado[0], para: partes[1] };
  });

const problemas = [];
function falhar(arquivo, versao, regra, motivo, correcao) {
  problemas.push({ arquivo, versao, regra, motivo, correcao });
}

const novosPorVersao = new Map(); // versao -> [arquivos novos]

for (const m of diff) {
  const caminho = m.para;
  const nome = caminho.slice(caminho.lastIndexOf("/") + 1);
  const emMigrations = caminho.startsWith(MIGRATIONS);
  const emLedger = caminho.startsWith(LEDGER);
  const eSql = caminho.endsWith(".sql");

  // ----- imutabilidade: o que já estava na base não se reescreve -----
  if (m.estado === "M" && eSql && (emMigrations || emLedger) && sqlBase.has(caminho)) {
    falhar(
      caminho,
      (COMECA_COM_TIMESTAMP.exec(nome) || [])[1] || "—",
      emMigrations ? "I1-MIGRATION-ALTERADA" : "I4-LEDGER-SQL-ALTERADO",
      emMigrations
        ? "migration que já existia no branch base foi modificada"
        : "SQL histórico do ledger foi modificado — o md5 dele é a prova de que aquilo rodou em produção",
      emMigrations
        ? "reverta o arquivo e escreva uma migration NOVA com a correção: `git checkout <base> -- " + caminho + "`"
        : "reverta o arquivo: `git checkout <base> -- " + caminho + "`. Explicação e correção vão em arquivo .md ao lado",
    );
  }
  if (m.estado === "D" && eSql && (emMigrations || emLedger) && sqlBase.has(caminho)) {
    falhar(
      caminho,
      (COMECA_COM_TIMESTAMP.exec(nome) || [])[1] || "—",
      emMigrations ? "I2-MIGRATION-APAGADA" : "I5-LEDGER-SQL-APAGADO",
      "arquivo que já existia no branch base foi apagado",
      "restaure o arquivo: `git checkout <base> -- " + caminho + "`. Para desfazer um efeito no banco, escreva uma migration nova",
    );
  }
  if (m.estado === "R" && m.de && (m.de.startsWith(MIGRATIONS) || m.de.startsWith(LEDGER)) && m.de.endsWith(".sql")) {
    falhar(
      `${m.de} → ${m.para}`,
      (COMECA_COM_TIMESTAMP.exec(m.de.slice(m.de.lastIndexOf("/") + 1)) || [])[1] || "—",
      m.de.startsWith(MIGRATIONS) ? "I3-MIGRATION-RENOMEADA" : "I6-LEDGER-SQL-RENOMEADO",
      "arquivo histórico foi renomeado — a versão é identidade e não pode mudar de nome",
      "restaure o nome original: `git checkout <base> -- " + m.de + "` e remova o arquivo novo",
    );
    continue;
  }

  if (m.estado !== "A") continue;

  // ----- migration nova -----
  if (emMigrations && eSql) {
    // subdiretório dentro de migrations/ não existe neste projeto e confundiria
    // a ordenação do CLI
    if (caminho.slice(MIGRATIONS.length).includes("/")) {
      falhar(caminho, "—", "M8-SUBDIRETORIO",
        "migration dentro de subdiretório de supabase/migrations/",
        "mova o arquivo para a raiz de supabase/migrations/");
      continue;
    }
    if (/^\d{14}__/.test(nome)) {
      const versao = nome.slice(0, 14);
      const noLedger = (versoesBase.get(versao) || []).some((p) => p.startsWith(LEDGER));
      falhar(caminho, versao, "M4-UNDERSCORE-DUPLO",
        noLedger
          ? "arquivo com `__` em supabase/migrations/ — e esta versão já existe no ledger: é registro histórico copiado para a trilha executável"
          : "arquivo com `__` em supabase/migrations/ — `__` é a convenção do ledger, não da migration",
        "ledger fica em supabase/ledger/YYYY-MM/. Migration usa UM underscore: `<14 dígitos>_<descricao>.sql`");
      continue;
    }
    const casa = PADRAO_MIGRATION.exec(nome);
    if (!casa) {
      const digitos = (/^(\d+)/.exec(nome) || [])[1];
      if (digitos && digitos.length !== 14) {
        falhar(caminho, digitos, "M2-VERSAO-14-DIGITOS",
          `a versão tem ${digitos.length} dígitos; o padrão é exatamente 14 (YYYYMMDDHHMMSS)`,
          "renomeie para 14 dígitos, ex.: `20260913143000_minha_mudanca.sql`");
      } else if (/^\d{14}\.sql$/.test(nome) || /^\d{14}_\.sql$/.test(nome)) {
        falhar(caminho, nome.slice(0, 14), "M3-SEM-DESCRICAO",
          "falta descrição depois do timestamp",
          "acrescente o que a migration faz: `<14 dígitos>_o_que_ela_faz.sql`");
      } else {
        falhar(caminho, "—", "M1-NOME-FORA-DO-PADRAO",
          "nome fora do padrão `YYYYMMDDHHMMSS_descricao.sql`",
          "renomeie, ex.: `20260913143000_minha_mudanca.sql`");
      }
      continue;
    }
    const versao = casa[1];
    const jaNaBase = versoesBase.get(versao);
    if (jaNaBase) {
      falhar(caminho, versao, "M5-VERSAO-JA-EXISTE",
        `a versão ${versao} já existe no branch base em: ${jaNaBase.join(", ")}`,
        "escolha um timestamp novo. `version` é PRIMARY KEY em supabase_migrations.schema_migrations: duas migrations com a mesma versão nunca podem ser as duas registradas — uma não roda e ninguém é avisado");
      continue;
    }
    if (!novosPorVersao.has(versao)) novosPorVersao.set(versao, []);
    novosPorVersao.get(versao).push(caminho);
    continue;
  }

  // ----- ledger novo -----
  if (emLedger && eSql) {
    if (!PADRAO_LEDGER.test(nome)) {
      falhar(caminho, (COMECA_COM_TIMESTAMP.exec(nome) || [])[1] || "—", "L1-NOME-FORA-DO-PADRAO",
        "SQL de ledger fora do padrão `YYYYMMDDHHMMSS__descricao.sql` (dois underscores)",
        "renomeie usando o `name` que produção registrou, ex.: `20260913143000__minha_mudanca.sql`");
      continue;
    }
    const versao = nome.slice(0, 14);
    const jaNaBase = versoesBase.get(versao);
    if (jaNaBase) {
      falhar(caminho, versao, "L2-VERSAO-JA-EXISTE",
        `a versão ${versao} já existe no branch base em: ${jaNaBase.join(", ")}`,
        "uma versão aplicada tem UM registro no ledger. Se é complemento, use arquivo .md ao lado");
      continue;
    }
    if (!novosPorVersao.has(versao)) novosPorVersao.set(versao, []);
    novosPorVersao.get(versao).push(caminho);
    continue;
  }

  // ----- .sql com cara de migration fora do lugar -----
  if (eSql && COMECA_COM_TIMESTAMP.test(nome) && !AUXILIARES.some((d) => caminho.startsWith(d))) {
    falhar(caminho, nome.slice(0, 14), "M7-FORA-DE-MIGRATIONS",
      "`.sql` com timestamp de 14 dígitos fora de supabase/migrations/ e fora dos diretórios auxiliares",
      `migration executável vai em ${MIGRATIONS}. Registro histórico vai em ${LEDGER}YYYY-MM/. Script de apoio vai em ${AUXILIARES.join(", ")}`);
  }
}

// ----- duas versões iguais DENTRO deste mesmo ramo -----
for (const [versao, arquivos] of novosPorVersao) {
  if (arquivos.length > 1) {
    falhar(arquivos.join(" + "), versao, "M6-VERSAO-REPETIDA-NO-PR",
      `${arquivos.length} arquivos novos compartilham a versão ${versao}`,
      "dê um timestamp único a cada um. O CLI deriva a versão dos 14 dígitos: arquivos com a mesma versão são a mesma versão para ele");
  }
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const novasMigrations = [...novosPorVersao.entries()].filter(([, a]) => a.some((p) => p.startsWith(MIGRATIONS)));
const novosLedger = [...novosPorVersao.entries()].filter(([, a]) => a.some((p) => p.startsWith(LEDGER)));

if (problemas.length === 0) {
  console.log(`✓ catraca das migrations: nada piorou (base ${baseBruta} = ${baseSha.slice(0, 8)}).`);
  console.log(`  migrations novas: ${novasMigrations.length} · ledger novo: ${novosLedger.length} · versões no índice da base: ${versoesBase.size}`);
  process.exit(0);
}

console.error(`\n✗ catraca das migrations: ${problemas.length} violação(ões). Base: ${baseBruta} = ${baseSha.slice(0, 8)}\n`);
for (const p of problemas) {
  console.error(`  ${p.regra}`);
  console.error(`    arquivo : ${p.arquivo}`);
  console.error(`    versão  : ${p.versao}`);
  console.error(`    motivo  : ${p.motivo}`);
  console.error(`    corrigir: ${p.correcao}\n`);
}
console.error("  O legado existente é tolerado de propósito. O que a catraca impede é PIORAR.");
console.error("  Detalhes da arquitetura: supabase/ledger/LEIA-ME.md e supabase/ledger/DUAS-TRILHAS.md\n");
process.exit(1);
