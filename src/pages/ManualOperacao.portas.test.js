// PORTAS DO MANUAL (23/10/2026). O Manual tinha DOIS botoes apontando para
// rota inexistente: "Agenda" -> `/agenda-operacional` (P4) e "Pesquisar
// Alunos" -> `/alunos-unificados` (autorizado em seguida, depois de conferir
// que a rota esta inativa e que a busca de alunos continua funcionando em
// `/aluno`). Em `App.jsx` o `path="*"` manda para a home, entao os dois
// cliques pareciam nao fazer nada -- mesmo padrao da Fila de Confirmacao de
// Pagamento em 2026-09-23.
//
// Teste de LEITURA DO FONTE, como PainelCarteira.meuDia.test.js: o que precisa
// ser garantido e a ausencia dos caminhos mortos e a correspondencia entre o
// que o Manual manda abrir e o que o App realmente roteia -- nenhuma das duas
// coisas depende de montar a pagina.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MANUAL = readFileSync(resolve(AQUI, "ManualOperacao.jsx"), "utf8");
const APP = readFileSync(resolve(AQUI, "../App.jsx"), "utf8");

// Rota que o Manual ainda oferece e que o App NAO roteia. Hoje: nenhuma. A
// lista existe para que uma pendencia desse tipo fique VISIVEL enquanto durar e
// para que nenhuma rota morta NOVA entre sem reprovar o teste.
//
// Fora do Manual ainda ha um botao para `/alunos-unificados` em
// src/pages/MinhaFilaQuitacao.jsx (~linha 224). Nao entra aqui porque este
// teste e do Manual, e porque o autorizado em 23/10/2026 foi so o Manual.
const ROTAS_MORTAS_CONHECIDAS = [];

function rotasDoManual() {
  return [...MANUAL.matchAll(/navigate\("(\/[^"]*)"\)/g)].map((m) => m[1]);
}

describe("ManualOperacao: a porta da Agenda antiga", () => {
  it("o botao da Agenda Operacional antiga saiu, e a rota nao voltou por outro nome", () => {
    // Nem botao, nem o caminho impresso no corpo do manual como instrucao.
    // (A rota ainda e CITADA no comentario do topo do arquivo, que explica por
    // que o botao saiu -- comentario nao navega e nao vai para a tela.)
    expect(MANUAL).not.toMatch(/navigate\("\/agenda-operacional"\)/);
    expect(MANUAL).not.toMatch(/blocoLink\}>\/agenda-operacional/);
    expect(APP).not.toMatch(/path="\/agenda-operacional"/);
    // A pagina continua no repositorio, sem importador: apagar arquivo nao era
    // o pedido, e revive-la e decisao da gestao (precisaria de rota).
    expect(APP).not.toMatch(/AgendaOperacional/);
  });

  it("o manual aponta para a agenda que esta no ar", () => {
    expect(MANUAL).toMatch(/painel-carteira/);
    expect(APP).toMatch(/path="\/painel-carteira"/);
  });
});

// A segunda porta. As duas condicoes que a gestao pediu para confirmar antes de
// remover o botao ficam AQUI, em forma de teste: (1) a rota esta mesmo inativa e
// (2) existe outra forma funcional de consultar alunos.
describe("ManualOperacao: a porta de Pesquisar Alunos", () => {
  it("o botao saiu e a rota continua sem existir em lugar nenhum do App", () => {
    expect(MANUAL).not.toMatch(/navigate\("\/alunos-unificados"\)/);
    expect(MANUAL).not.toMatch(/blocoLink\}>\/alunos-unificados/);
    // Nem <Route>, nem item de menu, nem entrada na lista de permissoes: a
    // string inteira nao aparece no App.
    expect(APP).not.toMatch(/alunos-unificados/);
  });

  it("a busca de alunos que FUNCIONA segue de pe, e e para ela que o manual aponta", () => {
    // Rota roteada, protegida e liberada para o perfil operador.
    expect(APP).toMatch(/path="\/aluno"/);
    expect(APP).toMatch(/rota="\/aluno"/);
    expect(APP).toMatch(/\{ rota: "\/aluno", label: "Base"/);
    // A pagina da busca nao foi tocada: o campo continua la.
    const ALUNO = readFileSync(resolve(AQUI, "Aluno.jsx"), "utf8");
    expect(ALUNO).toMatch(/Buscar aluno por nome ou CPF/);
    expect(ALUNO).toMatch(/placeholder="Digite nome, CPF ou telefone"/);
    // E o manual manda para la.
    expect(MANUAL).toMatch(/blocoLink\}>\/aluno</);
  });
});

describe("ManualOperacao: nenhuma rota morta nova", () => {
  it("todo botao vai para uma rota do App, tirando as mortas ja conhecidas", () => {
    const rotas = rotasDoManual();
    expect(rotas.length).toBeGreaterThan(0);
    const mortas = rotas.filter((r) => !APP.includes(`path="${r}"`));
    expect(mortas.sort()).toEqual([...ROTAS_MORTAS_CONHECIDAS].sort());
  });

  it("nao ha pendencia aberta: a lista de mortas conhecidas esta vazia", () => {
    // Enquanto houver entrada aqui, ela tem de ser de verdade -- nem rota que
    // ja existe, nem rota que o Manual nao usa mais (senao a lista viraria uma
    // permissao permanente em vez de uma pendencia).
    expect(ROTAS_MORTAS_CONHECIDAS).toEqual([]);
    for (const r of ROTAS_MORTAS_CONHECIDAS) {
      expect(APP, `${r} agora existe: tire da lista`).not.toContain(`path="${r}"`);
      expect(rotasDoManual(), `${r} nao e mais usada: tire da lista`).toContain(r);
    }
  });

  it("os caminhos IMPRESSOS no manual tambem existem", () => {
    // O manual nao navega so por botao: cada secao termina com o caminho em
    // destaque, e era por ali que `/agenda-operacional` e `/alunos-unificados`
    // continuavam sendo ensinados depois de os botoes sairem.
    const impressos = [...MANUAL.matchAll(/blocoLink\}>(\/[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(impressos.length).toBeGreaterThan(0);
    for (const rota of impressos) {
      expect(APP, `o manual ensina ${rota}, que nao tem <Route>`).toContain(`path="${rota}"`);
    }
  });
});
