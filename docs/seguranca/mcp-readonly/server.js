#!/usr/bin/env node
import { createServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { TABELAS_AUTORIZADAS, validarTabela } from "./tabelas.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  process.stderr.write("SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórios.\n");
  process.exit(1);
}

function lerRefreshToken() {
  try {
    return execSync(
      "security find-generic-password -s reativa-mcp -a refresh_token -w",
      { stdio: ["pipe", "pipe", "ignore"] }
    ).toString().trim();
  } catch { return null; }
}

function salvarRefreshToken(token) {
  try {
    execSync(
      `security add-generic-password -s reativa-mcp -a refresh_token -U -w "${token}"`,
      { stdio: "ignore" }
    );
  } catch { /* rotação não-crítica; próximo uso tenta novamente */ }
}

async function inicializarSessao() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: true, persistSession: false },
  });

  const refreshToken = lerRefreshToken();
  if (!refreshToken) {
    throw new Error(
      "Sessão não encontrada no Keychain. Execute: node auth.mjs para autenticar."
    );
  }

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    throw new Error(
      `Sessão expirada ou inválida: ${error?.message}. Execute: node auth.mjs`
    );
  }

  // Rotação automática: persiste o novo refresh_token
  salvarRefreshToken(data.session.refresh_token);

  return supabase;
}

const server = createServer({
  name: "reativa-readonly",
  version: "2.0.0",
  capabilities: { tools: {} },
});

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "select_tabela",
      description:
        "Consulta somente leitura em uma das tabelas autorizadas do CRM ReATIVA One. " +
        "Executa como o usuário de gestão autenticado — RLS aplicado. " +
        "Tabelas disponíveis: " + [...TABELAS_AUTORIZADAS].join(", ") + ". " +
        "Não aceita SQL arbitrário, INSERT, UPDATE, DELETE, RPCs nem DDL.",
      inputSchema: {
        type: "object",
        properties: {
          tabela: {
            type: "string",
            enum: [...TABELAS_AUTORIZADAS],
            description: "Tabela a consultar.",
          },
          colunas: {
            type: "string",
            default: "*",
            description: "Colunas a retornar, separadas por vírgula. Padrão: *.",
          },
          filtros: {
            type: "object",
            description: "Filtros de igualdade como {coluna: valor}.",
            additionalProperties: true,
          },
          limite: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            default: 100,
            description: "Número máximo de linhas (1–1000).",
          },
          ordenar_por: {
            type: "string",
            description: "Coluna com direção, ex: 'created_at.desc' ou 'nome.asc'.",
          },
        },
        required: ["tabela"],
      },
    },
  ],
}));

let _supabase = null;

server.setRequestHandler("tools/call", async (req) => {
  if (req.params.name !== "select_tabela") {
    return {
      content: [{ type: "text", text: "Ferramenta desconhecida." }],
      isError: true,
    };
  }

  const { tabela, colunas = "*", filtros = {}, limite = 100, ordenar_por } =
    req.params.arguments ?? {};

  try {
    validarTabela(tabela);
  } catch (err) {
    return {
      content: [{ type: "text", text: err.message }],
      isError: true,
    };
  }

  try {
    if (!_supabase) _supabase = await inicializarSessao();

    let query = _supabase.from(tabela).select(colunas);

    for (const [col, val] of Object.entries(filtros ?? {})) {
      query = query.eq(col, val);
    }

    query = query.limit(Math.max(1, Math.min(Number(limite) || 100, 1000)));

    if (ordenar_por) {
      const [col, dir] = ordenar_por.split(".");
      query = query.order(col, { ascending: dir !== "desc" });
    }

    const { data, error } = await query;

    if (error) {
      return {
        content: [{ type: "text", text: `[ERRO] ${error.message}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { tabela, rowCount: data?.length ?? 0, rows: data },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    _supabase = null;
    return {
      content: [{ type: "text", text: `[ERRO SESSÃO] ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
