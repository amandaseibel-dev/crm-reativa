// P4 (23/10/2026): o Manual tinha um botao "Agenda" apontando para
// `/agenda-operacional`. A rota NAO existe em App.jsx e o `path="*"` manda
// para a home, entao o clique parecia nao fazer nada -- porta falsa, mesmo
// padrao da Fila de Confirmacao de Pagamento em 2026-09-23.
//
// Teste de LEITURA DO FONTE, como PainelCarteira.meuDia.test.js: o que precisa
// ser garantido e a ausencia do caminho morto e a correspondencia entre o que o
// Manual manda abrir e o que o App realmente roteia -- nenhuma das duas coisas
// depende de montar a pagina.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MANUAL = readFileSync(resolve(AQUI, "ManualOperacao.jsx"), "utf8");
const APP = readFileSync(resolve(AQUI, "../App.jsx"), "utf8");

// Rota que o Manual ainda oferece e que o App NAO roteia. Encontrada ao
// escrever este teste, em 23/10/2026: `/alunos-unificados` ("Pesquisar
// Alunos") esta morto pelo mesmo motivo que `/agenda-operacional` estava.
// Nao foi removida aqui porque o que a gestao autorizou nesta PR foi o botao
// da Agenda; a decisao sobre este segundo botao e dela. A lista existe para
// que a pendencia fique VISIVEL e para que nenhuma rota morta NOVA entre sem
// reprovar o teste -- quando o botao sair, a lista fica vazia.
const ROTAS_MORTAS_CONHECIDAS = ["/alunos-unificados"];

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

describe("ManualOperacao: nenhuma rota morta nova", () => {
  it("todo botao vai para uma rota do App, tirando as mortas ja conhecidas", () => {
    const rotas = rotasDoManual();
    expect(rotas.length).toBeGreaterThan(0);
    const mortas = rotas.filter((r) => !APP.includes(`path="${r}"`));
    expect(mortas.sort()).toEqual([...ROTAS_MORTAS_CONHECIDAS].sort());
  });

  it("a lista de mortas conhecidas nao guarda rota que ja existe", () => {
    // Quando a rota passar a existir (ou o botao sair), a entrada tem de sair
    // da lista -- senao ela viraria uma permissao permanente.
    for (const r of ROTAS_MORTAS_CONHECIDAS) {
      expect(APP, `${r} agora existe: tire da lista`).not.toContain(`path="${r}"`);
      expect(rotasDoManual(), `${r} nao e mais usada: tire da lista`).toContain(r);
    }
  });
});
