// Probe ÚNICO e portátil de meu_acesso (somente leitura, 1 chamada, sem repetição).
// Uso: ULBRA_MCP_TOKEN deve estar no ambiente (nunca na linha de comando nem no chat).
// Saída: APENAS limites, saldo (restam) e data da medição. Nunca imprime token nem identidade.
const token = process.env.ULBRA_MCP_TOKEN;
if (!token) {
  console.error("Defina ULBRA_MCP_TOKEN no ambiente antes de rodar. Nenhuma chamada foi feita.");
  process.exit(2);
}
const controle = new AbortController();
const relogio = setTimeout(() => controle.abort(), 20000);
let resp;
try {
  resp = await fetch("https://crm.ulbra.ai/api/mcp", {
    method: "POST",
    signal: controle.signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "meu_acesso", arguments: {} } }),
  });
} catch (e) {
  // A chamada pode ter sido contada: NÃO repetir automaticamente.
  console.error(`FALHA_DE_REDE (${e.name}). A chamada pode ter sido contada. Não repetir.`);
  process.exit(3);
} finally {
  clearTimeout(relogio);
}
if (resp.status === 429) {
  const ra = resp.headers.get("retry-after");
  console.error(`ULBRA_LIMITE (429). Retry-After: ${ra ?? "não informado"}. Parar; não repetir.`);
  process.exit(4);
}
if (!resp.ok) {
  console.error(`ULBRA_HTTP_${resp.status}. Parar; não repetir.`);
  process.exit(5);
}
const texto = await resp.text();
let corpo = texto;
if ((resp.headers.get("content-type") || "").includes("event-stream")) {
  const linhas = texto.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  corpo = linhas[linhas.length - 1] || "";
}
let env;
try { env = JSON.parse(corpo); } catch { console.error("RESPOSTA_ILEGIVEL. Parar; não repetir."); process.exit(6); }
if (env.error || env.result?.isError) {
  console.error("MCP_ERRO. Parar; não repetir.");
  process.exit(6);
}
let dados;
try { dados = JSON.parse(env.result.content[0].text); } catch { console.error("CONTEUDO_ILEGIVEL. Parar; não repetir."); process.exit(7); }
const limites = dados.limites ?? null;
const saldo = limites?.pessoaPorDia?.restam ?? null;
console.log(JSON.stringify({ chamadas_contadas: 1, saldo_restam_pessoa_dia: saldo, limites, medido_em: new Date().toISOString() }, null, 2));
