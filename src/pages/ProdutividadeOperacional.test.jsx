// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ProdutividadeOperacional from "./ProdutividadeOperacional";

// Fixtures ancoradas em HOJE, no fuso de quem roda o teste: a tela lê uma
// janela que termina hoje, e data fixa sairia da janela amanhã. Nada de string
// com Z -- a máquina está em BRT e o CI em UTC.
const AGORA = new Date();
const hojeAs = (h, m = 0) =>
  new Date(AGORA.getFullYear(), AGORA.getMonth(), AGORA.getDate(), h, m).toISOString();
const diasAtras = (n) => {
  const d = new Date(AGORA.getFullYear(), AGORA.getMonth(), AGORA.getDate(), 9, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString();
};
const dia = (iso) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const DD_MM_HOJE = dia(hojeAs(9));
const ONTEM_ISO = diasAtras(1).slice(0, 10);

const LUANA = "cobranca05@aelbra.com.br";
const MAURICIO = "cobranca06@aelbra.com.br";

// Luana bate ponto das 8h às 18h com 1h de almoço: jornada LÍQUIDA de 9h.
const PONTO = [
  { email: LUANA, nome: "Luana", tipo: "LOGIN", criado_em: hojeAs(8) },
  { email: LUANA, nome: "Luana", tipo: "PAUSA_ALMOCO_INICIO", criado_em: hojeAs(12) },
  { email: LUANA, nome: "Luana", tipo: "PAUSA_ALMOCO_FIM", criado_em: hojeAs(13) },
  { email: LUANA, nome: "Luana", tipo: "LOGOUT", criado_em: hojeAs(18) },
];

// 30 acionamentos da Luana hoje (3 por hora) e 1 do Mauricio, que não bateu
// ponto nenhum -- o caso que a tela precisa mostrar em vez de esconder.
const MOVS = [
  ...Array.from({ length: 30 }, () => ({
    registrado_por_email: LUANA,
    registrado_por_nome: "Luana",
    registrado_em: hojeAs(9),
  })),
  { registrado_por_email: MAURICIO, registrado_por_nome: "Mauricio", registrado_em: hojeAs(10) },
];

const ALUNOS = [
  {
    id: "a1",
    responsavel_atual_email: LUANA,
    responsavel_atual_nome: "Luana",
    responsavel_atual_em: hojeAs(7),
    data_ultimo_acionamento: diasAtras(20), // sem contato +10 dias
    data_retorno: hojeAs(9).slice(0, 10), // retorno de hoje
    status_atual: "ALUNO_EM_NEGOCIACAO_24H",
  },
  {
    id: "a2",
    responsavel_atual_email: LUANA,
    responsavel_atual_nome: "Luana",
    responsavel_atual_em: diasAtras(60),
    data_ultimo_acionamento: diasAtras(1), // em dia
    data_retorno: ONTEM_ISO, // retorno vencido
    status_atual: "ABERTO",
  },
  {
    id: "a3",
    responsavel_atual_email: MAURICIO,
    responsavel_atual_nome: "Mauricio",
    responsavel_atual_em: diasAtras(90),
    data_ultimo_acionamento: diasAtras(2),
    data_retorno: null,
    status_atual: "ABERTO",
  },
];

const USUARIOS = [
  { id: "u5", email: LUANA, apelido: "Luana" },
  { id: "u6", email: MAURICIO, apelido: "Mauricio" },
];

let emailLogado = "amanda.seibel@aelbra.com.br";
const lidas = [];

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { email: emailLogado } }, error: null }),
    },
    // A foto de perfil é resolvida por Edge Function; o avatar cai no fallback
    // da inicial e a tela não depende disso.
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    from(tabela) {
      lidas.push(tabela);
      const porTabela = {
        aluno_movimentacoes: MOVS,
        alunos: ALUNOS,
        ponto_operadores: PONTO,
        usuarios: USUARIOS,
      };
      const encadeador = {
        select: () => encadeador,
        in: () => encadeador,
        not: () => encadeador,
        gte: () => encadeador,
        order: () => encadeador,
        range: () => Promise.resolve({ data: porTabela[tabela] || [], error: null }),
        // `usuarios` é lido sem paginação (lista curta), então o select já
        // precisa resolver como promessa.
        then: (ok) => Promise.resolve({ data: porTabela[tabela] || [], error: null }).then(ok),
      };
      return encadeador;
    },
  },
}));

function secao(regex) {
  return screen.getByText(regex).closest("section");
}

function linhaDe(tabela, nome) {
  const celula = within(tabela).getAllByText(nome)[0];
  return celula.closest("tr");
}

beforeEach(() => {
  emailLogado = "amanda.seibel@aelbra.com.br";
  lidas.length = 0;
});
afterEach(cleanup);

describe("Produtividade Operacional — quem entra", () => {
  it("operador não entra: a tela é da gestão", async () => {
    emailLogado = "cobranca05@aelbra.com.br";
    render(<ProdutividadeOperacional />);
    await waitFor(() => expect(screen.getByText(/restrito à gestão/i)).toBeTruthy());
    // e não leu nada do banco antes de recusar
    expect(lidas).toEqual([]);
  });

  it("gestão entra e a tela lê só as três tabelas previstas (mais usuarios)", async () => {
    render(<ProdutividadeOperacional />);
    await waitFor(() => expect(screen.getByText(/1 · Presença × produção/)).toBeTruthy());
    expect(new Set(lidas)).toEqual(
      new Set(["aluno_movimentacoes", "alunos", "ponto_operadores", "usuarios"]),
    );
  });
});

describe("Produtividade Operacional — números", () => {
  beforeEach(async () => {
    render(<ProdutividadeOperacional />);
    await waitFor(() => expect(screen.getByText(/5 · Evolução no período/)).toBeTruthy());
  });

  it("resumo soma acionamentos, carteira e pendências", () => {
    const kpi = (rot) => screen.getByText(rot).parentElement.textContent;
    expect(kpi(/Acionamentos em 7 dias/)).toContain("31");
    expect(kpi(/Operadores com produção/)).toContain("2");
    expect(kpi(/Carteira com dono/)).toContain("3");
    expect(kpi(/Sem contato \+10 dias/)).toContain("1");
    expect(kpi(/Retornos vencidos/)).toContain("1");
    expect(kpi(/Retornos de hoje/)).toContain("1");
  });

  it("presença × produção: jornada líquida desconta o almoço e divide por ela", () => {
    const bloco = secao(/1 · Presença × produção/);
    const linha = linhaDe(bloco, "Luana");
    expect(linha.textContent).toContain(DD_MM_HOJE);
    expect(linha.textContent).toContain("Almoço 1h"); // pausa registrada
    expect(linha.textContent).toContain("9h"); // 8h→18h menos 1h de almoço
    expect(linha.textContent).toContain("30"); // acionamentos
    expect(linha.textContent).toContain("3,3"); // 30 em 9h, decimal com vírgula
  });

  it("quem acionou sem bater ponto aparece marcado, não some da tabela", () => {
    const bloco = secao(/1 · Presença × produção/);
    const linha = linhaDe(bloco, "Mauricio");
    expect(linha.textContent).toMatch(/sem batida de ponto/i);
    // sem jornada medida não existe "por hora": fica travessão, não zero
    expect(within(linha).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("série diária quebra por operador e fecha o total do dia", () => {
    const bloco = secao(/2 · Acionamentos por operador e por dia/);
    expect(within(bloco).getByText(DD_MM_HOJE)).toBeTruthy();
    expect(linhaDe(bloco, "Luana").textContent).toContain("30");
    expect(linhaDe(bloco, "Mauricio").textContent).toContain("1");
    expect(linhaDe(bloco, "Total do dia").textContent).toContain("31");
  });

  it("pendências por operador usam a carteira de cada um como base do %", () => {
    const bloco = secao(/3 · Pendências por operador/);
    const luana = linhaDe(bloco, "Luana").textContent;
    expect(luana).toContain("50%"); // 1 de 2
    const total = linhaDe(bloco, "Total").textContent;
    expect(total).toContain("33%"); // 1 de 3
  });

  it("retornos mostram hoje e vencido, e dizem por que não há 'cumpridos'", () => {
    const bloco = secao(/4 · Retornos/);
    expect(linhaDe(bloco, "Luana").textContent).toMatch(/1.*1/);
    expect(bloco.textContent).toMatch(/0 de 18\.435/);
    expect(bloco.textContent).toMatch(/Meu Dia/);
  });

  it("evolução mostra evento, não saldo, e diz isso na tela", () => {
    const bloco = secao(/5 · Evolução no período/);
    expect(bloco.textContent).toContain("Entradas na carteira");
    expect(bloco.textContent).toMatch(/snapshot diário/i);
    const linha = linhaDe(bloco, DD_MM_HOJE);
    expect(linha.textContent).toContain("31"); // acionamentos de hoje
    expect(linha.textContent).toContain("1"); // 1 entrada na carteira hoje
  });
});

describe("App.jsx — ligação da tela e do Painel Geral", () => {
  const App = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");

  it("a rota existe e passa por RotaProtegida", () => {
    expect(App).toContain('path="/produtividade"');
    expect(App).toContain('<RotaProtegida usuario={usuario} rota="/produtividade">');
    expect(App).toContain("<ProdutividadeOperacional />");
  });

  it("a porta é podeVerTudo por e-mail, não lista nova nem perfil novo", () => {
    expect(App).toContain("import { podeGerirFinanceiro, podeVerTudo }");
    const de = App.indexOf('if (rota === "/produtividade")');
    expect(de).toBeGreaterThan(0);
    const guarda = App.slice(de, de + 400);
    expect(guarda).toContain("podeVerTudo(");
    // nenhuma allowlist de e-mail escrita à mão em volta da porta
    expect(guarda).not.toMatch(/@aelbra\.com\.br/);
  });

  it("o item de menu usa a MESMA regra da porta", () => {
    const de = App.indexOf('if (item.rota === "/produtividade")');
    expect(de).toBeGreaterThan(0);
    expect(App.slice(de, de + 300)).toContain("podeVerTudo(");
  });

  it("a tela de ponto foi absorvida: sumiu o import morto e o arquivo", () => {
    // havia um lazy() de PainelOperadores sem nenhuma <Route> que o usasse
    expect(App).not.toContain('import("./pages/PainelOperadores")');
    // a rota sai das listas de permissão (entrada com vírgula); o comentário
    // que explica a remoção pode continuar citando o nome dela
    expect(App).not.toContain('"/painel-operadores",');
  });

  it("Painel Geral ganhou item de menu sem mudar rota, permissão nem tela", () => {
    const itens = App.match(/\{ rota: "\/painel-geral"[^}]*\}/g) || [];
    expect(itens).toHaveLength(1); // item único: nada de duplicata no menu
    expect(itens[0]).toContain('secao: "Gestão"');
    // a rota e a <Route> continuam as que já existiam
    expect(App).toContain('<Route path="/painel-geral" element={<PainelGeral />} />');
    // e segue nas MESMAS duas listas por perfil de antes (gerência e
    // supervisor), que são exatamente os dois e-mails que a RPC aceita
    const permissoes = App.slice(
      App.indexOf("const permissoes = {"),
      App.indexOf("\n  };", App.indexOf("const permissoes = {")),
    );
    expect(permissoes.length).toBeGreaterThan(100);
    expect((permissoes.match(/"\/painel-geral",/g) || []).length).toBe(2);
    // o item novo é de menu, não de permissão: a tela não ganhou perfil novo
    expect(permissoes).not.toContain('"/produtividade",');
  });
});
