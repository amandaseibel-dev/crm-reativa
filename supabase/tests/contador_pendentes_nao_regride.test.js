// CATRACA DO CONTADOR `pendentes` — estática, sobre os ARQUIVOS do repositório.
//
// POR QUE ELA EXISTE. `20261024170000_conciliacao_saida_terminal` corrige o
// contador `v_pend` de `fluxo_pagamentos_incremental` por patch ancorado, para
// que pagamento já encerrado sem efeito financeiro pare de ser publicado como
// pendente. Quem faz `create or replace function` nessa função com o corpo
// inteiro apaga essa correção -- e apaga EM SILÊNCIO: nada falha, nenhum erro
// aparece, e `fluxo_pagamentos_execucoes.resultado->>'pendentes'` volta a mentir.
//
// Esta catraca é a proteção contra isso, e é só isto: régua sobre texto de
// arquivo. Não liga no banco, não lê credencial, não consulta produção -- o CI
// deste projeto não tem segredo nenhum e precisa continuar assim (mesmo
// princípio de `scripts/ci/catraca-migrations.mjs`).
//
// A REGRA, em duas metades:
//
//   1. Toda migration POSTERIOR à correção que recrie a função precisa TRAZER o
//      predicado. Sem exceção, sem lista.
//   2. Toda migration ANTERIOR à correção que recrie a função sem o predicado
//      precisa estar DECLARADA abaixo, com o seu estado. Arquivo novo que
//      apareça sem declaração reprova -- é assim que a 5ª não passa em silêncio.
//
// POR QUE AS ANTERIORES PODEM FICAR SEM O PREDICADO. Três delas já rodaram em
// produção, e o patch de 20261024170000 se assenta EM CIMA do corpo que elas
// deixaram. Reaplicá-las não está no caminho de ninguém, e alterá-las é proibido
// pela catraca das migrations ("migration que já existia no branch base foi
// modificada"). A quarta -- a #738 -- é a única perigosa, porque é a única que
// ainda NÃO rodou: ela está BLOQUEADA para aplicação, e o desbloqueio tem
// caminho próprio, versionado em `supabase/propostas/`.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

const DIR_MIGRATIONS = "supabase/migrations";
const PROPOSTA = "supabase/propostas/PROPOSTA_contador_pendentes_apos_reserva_738.sql";
const DOC = "docs/CONCILIACAO-INTELIGENTE-2026-10-24.md";

// A correção, e a marca que ela deixa.
const CORRECAO = "20261024170000";
const PREDICADO = "ENCERRADO_SEM_EFEITO_FINANCEIRO";
const RECRIA = "create or replace function public.fluxo_pagamentos_incremental";
// A âncora que o patch exige. Tem de existir no corpo de qualquer arquivo que
// recrie a função, senão o patch não encaixa e a migration falha fechada.
const ANCORA = "where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';";

// AS EXCEÇÕES CONHECIDAS, com o estado de cada uma. `APLICADA` = rodou em
// produção antes da correção, o patch se assenta em cima. `BLOQUEADA` = NÃO
// rodou e NÃO pode rodar enquanto puder sobrescrever a correção.
const DECLARADAS = {
  "20261021195950_fluxo_pagamentos_incremental.sql": "APLICADA",
  "20261021210416_fluxo_incremental_previa_sem_escrita.sql": "APLICADA",
  "20261021223117_fluxo_incremental_espera_nao_exclui.sql": "APLICADA",
  // #738. Conferido em produção em 24/10/2026, por três ângulos: a versão
  // 20261023004500 não existe em `schema_migrations`; o corpo vivo tem
  // md5(prosrc) = 11c14ef5bcbc4283357de8ef2d798c5e, que é o corpo pós-ESPERA; e
  // `position('v_reserva')` no corpo vivo é 0.
  "20261023004500_fluxo_incremental_reserva_bloqueado.sql": "BLOQUEADA",
};

const versaoDe = (arquivo) => (arquivo.match(/^(\d{14})_/) || [])[1] || "";

const migrations = readdirSync(resolve(RAIZ, DIR_MIGRATIONS))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const queRecriam = migrations.filter((f) => ler(`${DIR_MIGRATIONS}/${f}`).includes(RECRIA));

describe("a régua encontra o que precisa reger", () => {
  it("existe ao menos uma migration que recria a rodada", () => {
    expect(queRecriam.length).toBeGreaterThan(0);
  });

  it("a migration da correção existe e NÃO recria a função -- ela patcheia", () => {
    const arquivo = migrations.find((f) => versaoDe(f) === CORRECAO);
    expect(arquivo).toBeTruthy();
    const corpo = ler(`${DIR_MIGRATIONS}/${arquivo}`);
    expect(corpo).not.toContain(RECRIA);
    expect(corpo).toContain("internal.patch_funcao_ancorada");
    expect(corpo).toContain(PREDICADO);
  });
});

describe("1. migration POSTERIOR à correção que recria a função traz o predicado", () => {
  const posteriores = queRecriam.filter((f) => versaoDe(f) > CORRECAO);

  it("nenhuma posterior recria a função sem o predicado", () => {
    const faltando = posteriores.filter((f) => !ler(`${DIR_MIGRATIONS}/${f}`).includes(PREDICADO));
    expect(faltando).toEqual([]);
  });

  it("e toda posterior preserva a âncora, para o patch ainda encaixar", () => {
    const semAncora = posteriores.filter((f) => {
      const corpo = ler(`${DIR_MIGRATIONS}/${f}`);
      return !corpo.includes(ANCORA) && !corpo.includes(PREDICADO);
    });
    expect(semAncora).toEqual([]);
  });
});

describe("2. migration ANTERIOR sem o predicado tem de estar declarada", () => {
  const anteriores = queRecriam.filter((f) => versaoDe(f) < CORRECAO);

  it("não há arquivo anterior sem declaração -- o 5º caso não passa calado", () => {
    const indeclarados = anteriores
      .filter((f) => !ler(`${DIR_MIGRATIONS}/${f}`).includes(PREDICADO))
      .filter((f) => !(f in DECLARADAS));
    expect(indeclarados).toEqual([]);
  });

  it("toda declaração aponta para um arquivo que existe", () => {
    const fantasmas = Object.keys(DECLARADAS).filter(
      (f) => !existsSync(resolve(RAIZ, DIR_MIGRATIONS, f))
    );
    expect(fantasmas).toEqual([]);
  });

  it("nenhuma exceção está morta: declarada é declarada porque falta o predicado", () => {
    // Se alguém conseguir pôr o predicado num desses arquivos, a exceção perdeu
    // a razão de existir e tem de sair da lista. A catraca cobra a limpeza.
    const mortas = Object.keys(DECLARADAS).filter((f) =>
      ler(`${DIR_MIGRATIONS}/${f}`).includes(PREDICADO)
    );
    expect(mortas).toEqual([]);
  });

  it("os estados declarados são só APLICADA ou BLOQUEADA", () => {
    const invalidos = Object.entries(DECLARADAS).filter(
      ([, estado]) => estado !== "APLICADA" && estado !== "BLOQUEADA"
    );
    expect(invalidos).toEqual([]);
  });
});

describe("a #738 é a única BLOQUEADA, e o bloqueio tem registro e saída", () => {
  const bloqueadas = Object.entries(DECLARADAS)
    .filter(([, e]) => e === "BLOQUEADA")
    .map(([f]) => f);

  it("há exatamente uma BLOQUEADA, e é a #738", () => {
    expect(bloqueadas).toEqual(["20261023004500_fluxo_incremental_reserva_bloqueado.sql"]);
  });

  it("toda BLOQUEADA está registrada no documento da frente, pela versão", () => {
    const doc = ler(DOC);
    for (const f of bloqueadas) {
      expect(doc).toContain(versaoDe(f));
      expect(doc).toContain("BLOQUEADA");
    }
  });

  it("a âncora existe no corpo da #738 -- é o que torna o desbloqueio possível", () => {
    for (const f of bloqueadas) {
      expect(ler(`${DIR_MIGRATIONS}/${f}`)).toContain(ANCORA);
    }
  });

  it("existe a proposta de desbloqueio, com o mesmo patch e a mesma âncora", () => {
    expect(existsSync(resolve(RAIZ, PROPOSTA))).toBe(true);
    const p = ler(PROPOSTA);
    expect(p).toContain("internal.patch_funcao_ancorada");
    expect(p).toContain(ANCORA);
    expect(p).toContain(PREDICADO);
    // e ela NÃO é migration: não tem timestamp de 14 dígitos no nome
    expect(PROPOSTA.split("/").pop()).not.toMatch(/^\d{14}_/);
  });

  it("a proposta não mora em supabase/migrations -- ninguém a aplica por engano", () => {
    expect(migrations).not.toContain("PROPOSTA_contador_pendentes_apos_reserva_738.sql");
    const promovida = migrations.filter((f) => f.includes("contador_pendentes_apos_reserva"));
    expect(promovida).toEqual([]);
  });
});
