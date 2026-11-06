// CRM — a opção "Ler no servidor" está OCULTA enquanto a Edge Function
// publicada estiver desatualizada.
//
// MEDIDO EM PRODUÇÃO em 05/11/2026, e é por isso que estes casos existem:
//   · `santander-previa` está na versão 3 (22/10). O `LinhaNormalizada` dela
//     tem 13 campos e a desestruturação descarta a coluna F — não preserva
//     `convenio_bancario`.
//   · `santander-importar` NÃO EXISTE em produção (`Function not found`).
//
// Marcar a caixa, nesse estado, dava prévia que lia e confirmação que falhava
// com 404 — fail-closed, nada gravado, mas um botão para um beco sem saída. E
// pior: a prévia do servidor devolveria linhas SEM `convenio_bancario`,
// enquanto o caminho de hoje devolve COM. Duas formas de dado conforme a caixa.
//
// O que esta mudança NÃO faz, e os casos abaixo travam: não remove o caminho do
// servidor, não altera a normalização, não altera a RPC, não toca em
// conciliação, baixa ou valor.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fonte = readFileSync(fileURLToPath(new URL("./ProjecaoHoraHora.jsx", import.meta.url)), "utf8");

describe('a caixa "Ler no servidor" está oculta', () => {
  it("existe a trava explícita, e está desligada", () => {
    expect(fonte).toMatch(/const SERVIDOR_DISPONIVEL = false;/);
  });

  it("a caixa só renderiza sob a trava — não é só desabilitada", () => {
    // Desabilitar deixaria uma caixa cinza na tela, convidando a pergunta "por
    // que não posso marcar?". Não renderizar é a resposta honesta enquanto o
    // caminho não existe.
    expect(fonte).toMatch(/\{SERVIDOR_DISPONIVEL && \(\s*<label/);
  });

  it("o rótulo da opção não aparece fora da trava", () => {
    const ocorrencias = fonte.match(/Ler no servidor \(novo\)/g) || [];
    expect(ocorrencias).toHaveLength(1);
    const posicaoTrava = fonte.indexOf("{SERVIDOR_DISPONIVEL && (");
    const posicaoRotulo = fonte.indexOf("Ler no servidor (novo)");
    expect(posicaoTrava).toBeGreaterThan(-1);
    expect(posicaoRotulo).toBeGreaterThan(posicaoTrava);
  });

  it("o motivo está escrito junto da trava, com a medição que o sustenta", () => {
    // Trava sem motivo escrito vira trava que ninguém sabe se pode remover.
    const trecho = fonte.slice(
      fonte.indexOf("const [lerNoServidor"),
      fonte.indexOf("const SERVIDOR_DISPONIVEL")
    );
    expect(trecho).toMatch(/santander-previa/);
    expect(trecho).toMatch(/santander-importar/);
    expect(trecho).toMatch(/convenio_bancario/);
  });
});

describe("o caminho do servidor foi OCULTADO, não removido", () => {
  it("a prévia pelo servidor continua no arquivo", () => {
    expect(fonte).toMatch(/async function previaPeloServidor\(/);
    expect(fonte).toMatch(/functions\/v1\/santander-previa/);
  });

  it("a importação pelo servidor continua no arquivo", () => {
    expect(fonte).toMatch(/async function importarPeloServidor\(/);
    expect(fonte).toMatch(/functions\/v1\/santander-importar/);
  });

  it("a checagem de digital divergente continua intacta", () => {
    expect(fonte).toMatch(/DIGITAL_DIVERGENTE/);
  });

  it("o caminho de religar está escrito", () => {
    expect(fonte).toMatch(/Religar e trocar esta constante para true/);
  });
});

describe("o fluxo padrão de importação segue intacto", () => {
  it("a confirmação continua chamando a RPC projecao_importar_pagamentos", () => {
    expect(fonte).toMatch(/await supabase\.rpc\("projecao_importar_pagamentos"/);
  });

  it("a RPC continua recebendo as linhas normalizadas no navegador", () => {
    expect(fonte).toMatch(/p_linhas: linhasPreview/);
  });

  it("o interruptor entre os dois caminhos continua sendo digitalServidor", () => {
    // Com a caixa oculta, `digitalServidor` nunca é preenchido, então o
    // ternário sempre cai no lado da RPC. A estrutura fica, o caminho é um só.
    expect(fonte).toMatch(/digitalServidor\s*\?\s*await importarPeloServidor/);
  });

  it("a checagem de duplicidade por (competência, arquivo) continua", () => {
    expect(fonte).toMatch(/projecao_checar_importacao_existente/);
  });
});

describe("a captura do convênio da coluna F segue preservada", () => {
  it("convenio_bancario continua no normalizador do navegador", () => {
    expect(fonte).toMatch(/convenio_bancario/);
  });

  it("a coluna F continua sendo lida, não descartada", () => {
    // O defeito antigo era a vírgula vazia na posição 6 da desestruturação, que
    // jogava o convênio fora. Se alguém reintroduzir isso, este caso cai.
    const normalizador = fonte.slice(
      fonte.indexOf("export function normalizarLinhaSantander"),
      fonte.indexOf("export function linhaTemDado")
    );
    expect(normalizador).toMatch(/convenio/i);
    expect(normalizador).toMatch(/convenio_bancario:/);
  });
});

describe("nada financeiro foi tocado", () => {
  it("não há chamada de baixa, quitação ou conciliação introduzida aqui", () => {
    // A tela nunca decidiu baixa nem conciliação — quem decide é o motor, pelos
    // gatilhos de `pagamentos`. Este caso trava a fronteira.
    expect(fonte).not.toMatch(/rpc\("pagamento_conciliar_um"/);
    expect(fonte).not.toMatch(/rpc\("baixa_/);
    expect(fonte).not.toMatch(/rpc\("quitar_/);
  });
});
