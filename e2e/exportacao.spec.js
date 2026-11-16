// Teste de navegador da exportacao de Acoes Massivas.
// Dados ficticios. Supabase interceptado (host .invalid). Nenhuma requisicao a producao e possivel:
// qualquer origem fora de localhost e abortada e registrada.
import { test, expect } from "@playwright/test";
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const SUPA = "https://supa-teste.invalid";
const CHAVE_SESSAO = "sb-supa-teste-auth-token";
const EMAIL = "gestao.teste@teste.local";
const ALUNO_ID = "00000000-0000-4000-8000-000000000001";
const RESP_EMAIL = "operador.teste@teste.local";
const CONTATO = { aluno_id: ALUNO_ID, nome: "Aluno Ficticio 1", telefone: "51900000001", email: "a1@teste.local" };

const ABORTAR = Symbol("abortar");
const NAO_PREVISTA = Symbol("nao-prevista");
// Casca da aplicacao (cabecalho, avisos, presenca): chamadas globais, respostas minimas e nomeadas.
const TABELAS_CASCA = {
  ponto_operadores: [],
  email_templates: [],
  sugestoes: [],
  notificacoes: [],
  avisos_leituras: [],
  avisos: [],
};
const RPCS_CASCA = {
  registrar_acesso_sistema: null,
  acesso_permitido_agora: true,
  contadores_cabecalho: {},
  listar_minhas_solicitacoes: [],
  avisos_nao_lidos_count: 0,
};
// RPCs de carregamento da tela, esperadas na montagem; respondem lista vazia explicitamente.
const NAO_PREVISTA_LISTA = ["acoes_massivas_filtros", "acoes_massivas_borderos", "acoes_massivas_lotes_pendentes", "acoes_massivas_lotes_whatsapp", "saude_da_base", "acoes_massivas_retornos", "acoes_massivas_por_dia"];
// Registro do teste corrente. Qualquer requisicao externa, RPC ou tabela nao prevista REPROVA o teste.
let registroAtual = { bloqueadas: [], naoPrevistas: [] };
const previstasExternas = [];

test.afterEach(() => {
  expect(registroAtual.bloqueadas, "requisicoes externas inesperadas (bloqueadas)").toEqual([]);
  expect(registroAtual.naoPrevistas, "RPCs/tabelas nao previstas no mock").toEqual([]);
});
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "11111111-1111-4111-8111-111111111111", role: "authenticated", email: EMAIL, exp: 4102444800 })}.teste`;

function sessao() {
  return {
    access_token: JWT,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 4102444800,
    refresh_token: "refresh-ficticio",
    user: { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: EMAIL },
  };
}

/** Configura o mock de cada cenario e registra todas as chamadas RPC e rede. */
async function prepararPagina(page, cenario) {
  const rpc = [];
  const bloqueadas = [];
  const naoPrevistas = [];
  registroAtual = { bloqueadas, naoPrevistas };
  const ctrl = {
    exportar: cenario.exportar ?? "ok", // ok | perdida | erro_validacao
    historico: cenario.historico ?? "ok", // ok | erro
    arquivoFalha: cenario.arquivoFalha ?? false,
  };

  await page.addInitScript(
    ({ chave, sess, falha }) => {
      localStorage.setItem(chave, JSON.stringify(sess));
      localStorage.setItem("rv_tour_novidades_2026-07-31", "1"); // preferencia de visualizacao, nao dado de negocio
      if (falha) {
        // Falha simulada do arquivo: a geracao do download levanta excecao. Guarda o original para restaurar.
        window.__urlCreateObjectURLOriginal = window.URL.createObjectURL;
        window.URL.createObjectURL = () => {
          throw new Error("download bloqueado no teste");
        };
      }
    },
    { chave: CHAVE_SESSAO, sess: sessao(), falha: ctrl.arquivoFalha },
  );

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://localhost") || url.startsWith("ws://localhost")) {
      return route.continue();
    }
    if (url.startsWith("https://fonts.googleapis.com/") || url.startsWith("https://fonts.gstatic.com/")) {
      // Excecao PREVISTA: folha de fontes. Resposta vazia; nenhum dado sai ou entra.
      previstasExternas.push(url.split("?")[0]);
      return url.includes("fonts.googleapis") ? route.fulfill({ status: 200, contentType: "text/css", body: "" }) : route.fulfill({ status: 204, body: "" });
    }
    if (url.startsWith(SUPA)) {
      const caminho = new URL(url).pathname;
      const corpo = route.request().postDataJSON?.() ?? null;
      if (caminho.startsWith("/rest/v1/rpc/")) {
        const nome = caminho.replace("/rest/v1/rpc/", "");
        rpc.push(nome);
        const r = respostaRpc(nome, corpo, ctrl, rpc);
        if (r === ABORTAR) return route.abort("failed"); // resposta perdida
        if (r && r.__erro) {
          return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify(r.__erro) });
        }
        if (r === NAO_PREVISTA) {
          naoPrevistas.push(`rpc:${nome}`);
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "NAO_PREVISTO", message: nome }) });
        }
        return responder(route, r);
      }
      if (caminho.startsWith("/rest/v1/usuarios")) {
        return responder(route, [{ email: EMAIL, nome: "Gestão Teste", perfil: "gestao", ativo: true }]);
      }
      const tabela = TABELAS_CASCA[caminho.replace("/rest/v1/", "")];
      if (tabela !== undefined) {
        return responder(route, tabela);
      }
      if (caminho.startsWith("/auth/v1/user")) {
        return responder(route, sessao().user);
      }
      naoPrevistas.push(`rest:${caminho}`);
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "NAO_PREVISTO", message: caminho }) });
    }
    bloqueadas.push(url);
    return route.abort("blockedbyclient");
  });

  return { rpc, bloqueadas, ctrl };
}

function responder(route, corpo) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(corpo) });
}

function respostaRpc(nome, corpo, ctrl, rpc) {
  switch (nome) {
    case "usuario_e_gestao":
      return true;
    case "acoes_massivas_previa":
      return {
        previa_id: "previa-teste-1",
        operador_email: String(corpo?.p_operador_email ?? "todos").toLowerCase(),
        tipo_cobranca: corpo?.p_tipo_cobranca,
        resumo: { elegiveis: 1 },
        elegiveis: [{ id: ALUNO_ID, nome: "Aluno Ficticio 1", tem_telefone: true, valor: 100, tem_responsavel: false }],
        excluidos_confirmacao: [],
      };
    case "acoes_massivas_exportar":
      if (ctrl.exportar === "perdida") {
        return ABORTAR; // resposta perdida: a conexao cai sem devolver nada
      }
      if (ctrl.exportar === "erro_validacao") {
        return { __erro: { code: "22023", message: "recusado" } }; // erro de validacao
      }
      return {
        lote_id: "lote-teste-1",
        exportados: 1,
        selecionados: 1,
        registrados: 1,
        contatos: [CONTATO],
        registro_automatico: true,
      };
    case "acoes_massivas_lotes_registro":
      return ctrl.historico === "erro" ? { __erro: { code: "XX000", message: "indisponivel" } } : [];
    case "registrar_acesso_sistema":
    case "acesso_permitido_agora":
    case "contadores_cabecalho":
    case "listar_minhas_solicitacoes":
    case "avisos_nao_lidos_count":
      return RPCS_CASCA[nome];
    case "acoes_massivas_responsaveis":
      return [{ email: RESP_EMAIL, nome: "Operador Teste", casos: 1, acordos: 1 }];
    case "acoes_massivas_filtros":
    case "acoes_massivas_borderos":
    case "acoes_massivas_lotes_pendentes":
    case "acoes_massivas_lotes_whatsapp":
    case "saude_da_base":
    case "acoes_massivas_retornos":
    case "acoes_massivas_por_dia":
      return NAO_PREVISTA_LISTA.includes(nome) ? [] : NAO_PREVISTA;
    default:
      return NAO_PREVISTA;
  }
}

test.describe("exportacao de Acoes Massivas no navegador (dados ficticios, sem producao)", () => {
  async function abrirEPrevisar(page) {
    await page.goto("/acoes-massivas");
    const select = page.locator("select", { has: page.locator("option", { hasText: "Mensalidades e acordos" }) }).first();
    await select.selectOption({ label: "Mensalidades e acordos" });
    await page.getByTestId("resp-caso").getByRole("checkbox").first().check();
    // Modalidade com acordo exige tambem o responsavel pelo acordo (regra explicita da tela).
    await page.getByTestId("resp-acordo").getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Buscar prévia" }).click();
    await expect(page.getByText("Aluno Ficticio 1").first()).toBeVisible();
  }

  test("1. sucesso: arquivo baixado com o conteudo esperado", async ({ page }) => {
    const { rpc, bloqueadas } = await prepararPagina(page, { exportar: "ok" });
    await abrirEPrevisar(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Exportar planilha/ }).click(),
    ]);
    const caminho = await download.path();
    const lido = XLSX.read(readFileSync(caminho), { type: "buffer" });
    expect(lido.SheetNames).toEqual(["Ação Massiva"]);
    const linhas = XLSX.utils.sheet_to_json(lido.Sheets["Ação Massiva"]);
    expect(linhas).toEqual([{ "Nome do aluno": "Aluno Ficticio 1", Telefone: "5551900000001" }]);
    expect(rpc.filter((n) => n === "acoes_massivas_exportar")).toHaveLength(1);
    expect(bloqueadas).toEqual([]); // nenhuma origem externa tentou
  });

  test("2. falha do arquivo apos RPC concluida: lote registrado, arquivo nao baixado, exportar bloqueado", async ({ page }) => {
    const { rpc } = await prepararPagina(page, { exportar: "ok", arquivoFalha: true });
    await abrirEPrevisar(page);
    await page.getByRole("button", { name: /Exportar planilha/ }).click();
    await expect(page.getByText(/Lote registrado, arquivo não baixado/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Exportar planilha/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "⬇️ Baixar planilha novamente" })).toBeVisible();
    expect(rpc.filter((n) => n === "acoes_massivas_exportar")).toHaveLength(1);
  });

  test("3. Baixar planilha novamente baixa sem nova chamada de exportacao", async ({ page }) => {
    const { rpc } = await prepararPagina(page, { exportar: "ok", arquivoFalha: true });
    await abrirEPrevisar(page);
    await page.getByRole("button", { name: /Exportar planilha/ }).click();
    await expect(page.getByText(/Lote registrado, arquivo não baixado/)).toBeVisible();
    // Libera a geracao do arquivo (a falha foi so do navegador no primeiro passo).
    await page.evaluate(() => {
      window.URL.createObjectURL = window.__urlCreateObjectURLOriginal; // restaura a funcao nativa
    });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "⬇️ Baixar planilha novamente" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^acao-massiva-whatsapp.*\.xlsx$/);
    expect(rpc.filter((n) => n === "acoes_massivas_exportar")).toHaveLength(1);
  });

  test("4. resposta perdida: resultado incerto, sem repeticao automatica nem clique repetido", async ({ page }) => {
    const { rpc } = await prepararPagina(page, { exportar: "perdida" });
    await abrirEPrevisar(page);
    await page.getByRole("button", { name: /Exportar planilha/ }).click();
    await expect(page.getByText(/Resultado do registro desconhecido/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Exportar planilha/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "⬇️ Baixar planilha novamente" })).toHaveCount(0);
    await page.waitForLoadState("networkidle"); // sem retry automatico em rede ociosa
    expect(rpc.filter((n) => n === "acoes_massivas_exportar")).toHaveLength(1);
  });

  test("5. historico indisponivel: nao libera nova exportacao pela interface", async ({ page }) => {
    await prepararPagina(page, { exportar: "perdida", historico: "erro" });
    await abrirEPrevisar(page);
    await page.getByRole("button", { name: /Exportar planilha/ }).click();
    await expect(page.getByText(/Resultado do registro desconhecido/).first()).toBeVisible();
    await page.getByRole("button", { name: "Consultar histórico de lotes" }).click();
    await expect(page.getByText(/Histórico indisponível/)).toBeVisible();
    // Nao existe controle de liberacao na interface: nenhum checkbox, nenhum botao de liberar.
    await expect(page.getByLabel(/Confirmo, por minha conta/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Liberar nova exportação/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Exportar planilha/ })).toBeDisabled();
  });

  test("6. resultado incerto: historico conferido nao libera; recarregar perde o bloqueio local (limite declarado)", async ({ page }) => {
    await prepararPagina(page, { exportar: "perdida", historico: "ok" });
    await abrirEPrevisar(page);
    await page.getByRole("button", { name: /Exportar planilha/ }).click();
    await expect(page.getByText(/Resultado do registro desconhecido/).first()).toBeVisible();
    await page.getByRole("button", { name: "Consultar histórico de lotes" }).click();
    // Mesmo com o historico consultado, a interface nao libera: nao ha liberacao por caixa.
    await expect(page.getByRole("button", { name: /Exportar planilha/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Liberar nova exportação/ })).toHaveCount(0);
    // Limite declarado: o bloqueio e so local. Recarregar a pagina o perde; nao ha prova de servidor.
    await page.reload();
    // Apos recarregar a previa some: e preciso gerar uma nova para ver o botao de exportar.
    await abrirEPrevisar(page);
    await expect(page.getByRole("button", { name: /Exportar planilha/ })).toBeEnabled();
  });
});
