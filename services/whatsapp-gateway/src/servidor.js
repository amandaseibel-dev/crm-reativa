// API de controle. Quem chama é a Edge Function do CRM, nunca o navegador do
// operador — o token abaixo jamais chega ao frontend.
//
// SEM TLS AQUI DE PROPÓSITO: o container publica só em 127.0.0.1 e quem termina
// HTTPS é o proxy reverso da VPS (Caddy/nginx). Ver README.
import { createServer } from "node:http";
import { config } from "./config.js";
import { tokenDeComandoConfere } from "./crm.js";
import { log } from "./log.js";
import { tamanhoDaFila } from "./outbox.js";

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(texto);
}

async function lerCorpo(req) {
  const partes = [];
  let bytes = 0;
  for await (const parte of req) {
    bytes += parte.length;
    if (bytes > 1_000_000) throw new Error("corpo grande demais");
    partes.push(parte);
  }
  const bruto = Buffer.concat(partes).toString("utf8");
  return bruto ? JSON.parse(bruto) : {};
}

export function iniciarServidor(sessoes) {
  const porChave = new Map(sessoes.map((s) => [s.chave, s]));

  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, "http://interno");
    const caminho = url.pathname;

    try {
      // Saúde é aberto: é o healthcheck do Docker, e não conta nada sensível.
      if (caminho === "/saude") {
        const algumaOnline = sessoes.some((s) => s.estado().conectado);
        return json(res, 200, {
          ok: true,
          sessoes: sessoes.map((s) => s.estado()),
          fila_pendente: tamanhoDaFila(),
          alguma_conectada: algumaOnline,
        });
      }

      const autorizacao = req.headers.authorization || "";
      if (!tokenDeComandoConfere(autorizacao.replace(/^Bearer\s+/i, ""))) {
        return json(res, 401, { erro: "nao autorizado" });
      }

      if (caminho === "/sessoes" && req.method === "GET") {
        return json(res, 200, { sessoes: sessoes.map((s) => s.estado()) });
      }

      if (caminho === "/enviar" && req.method === "POST") {
        const corpo = await lerCorpo(req);
        const sessao = porChave.get(String(corpo.sessao || "").toLowerCase());
        if (!sessao) return json(res, 404, { erro: `sessao desconhecida: ${corpo.sessao}` });
        if (!corpo.telefone || !corpo.texto) {
          return json(res, 400, { erro: "telefone e texto sao obrigatorios" });
        }
        const r = await sessao.enviarTexto(corpo.telefone, corpo.texto);
        return json(res, 200, { ok: true, wamid: r.wamid });
      }

      const comando = caminho.match(/^\/sessao\/([a-z0-9_-]+)\/(reconectar|desconectar|logout)$/);
      if (comando && req.method === "POST") {
        const sessao = porChave.get(comando[1]);
        if (!sessao) return json(res, 404, { erro: `sessao desconhecida: ${comando[1]}` });

        if (comando[2] === "reconectar") await sessao.reconectar();
        if (comando[2] === "desconectar") await sessao.desconectar();
        if (comando[2] === "logout") await sessao.sair();

        log.info({ sessao: comando[1], comando: comando[2] }, "comando recebido do CRM");
        return json(res, 200, { ok: true, estado: sessao.estado() });
      }

      return json(res, 404, { erro: "rota inexistente" });
    } catch (erro) {
      log.error({ caminho, erro: String(erro?.message || erro) }, "erro na API de controle");
      return json(res, 500, { erro: String(erro?.message || erro) });
    }
  });

  // Falha ao abrir a porta e FATAL, e precisa matar o processo.
  //
  // POR QUE: `listen` reporta erro por EVENTO, nao por excecao. Sem este
  // tratamento o erro caia no `uncaughtException`, que registra e segue em
  // frente — e o servico ficava vivo, conectado ao WhatsApp, porem SEM API de
  // controle: recebia mensagem mas ninguem conseguia responder nem comandar a
  // sessao, e o /saude era respondido por outro processo. Meio-quebrado em
  // silencio e pior do que morrer. Morrer deixa o `restart` do Docker agir.
  servidor.on("error", (erro) => {
    log.fatal(
      { porta: config.porta, erro: String(erro?.message || erro) },
      "nao foi possivel abrir a porta de controle - encerrando",
    );
    process.exit(1);
  });

  servidor.listen(config.porta, () => {
    log.info({ porta: config.porta }, "API de controle no ar");
  });

  return servidor;
}
