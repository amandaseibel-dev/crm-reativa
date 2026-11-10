import { useRef, useState } from "react";

// Conversa da Mensageria dentro da ficha do aluno. Só apresenta: o portão de
// identidade e de permissão é do servidor (leitura.ts) e do envio (envio.ts).
// Cada clique gera UMA chave de envio; enquanto o pedido está em curso, o botão
// fica bloqueado e o mesmo clique não gera segundo envio.

const DIRECAO = {
  ENTRADA: { rotulo: "Aluno", classe: "ulbra-conversa-entrada" },
  SAIDA: { rotulo: "Operador", classe: "ulbra-conversa-saida" },
  AUTOMATICA: { rotulo: "Automática", classe: "ulbra-conversa-auto" },
  SISTEMA: { rotulo: "Sistema", classe: "ulbra-conversa-auto" },
};

const STATUS_ENVIO = {
  ENVIADO: null,
  RECUSADO: "A Mensageria recusou a mensagem. Ela não foi enviada.",
  FALHA_INCERTA:
    "Não foi possível confirmar o envio. A mensagem pode ter saído: confira na Mensageria antes de enviar de novo.",
};

function formatarHora(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

function novaChave() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chave-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function ConversaUlbra({
  mensagens = [],
  carregando = false,
  erro = null,
  podeEnviar = false,
  antesDe = null,
  onCarregarAnteriores,
  onEnviar,
}) {
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState(null);
  // Chave do pedido em curso: o mesmo clique repetido reaproveita esta chave.
  const chaveEmCurso = useRef(null);

  async function enviar(evento) {
    evento.preventDefault();
    if (enviando || !podeEnviar) return;
    const conteudo = texto.trim();
    if (!conteudo) return;
    if (!chaveEmCurso.current) chaveEmCurso.current = novaChave();
    setEnviando(true);
    setAviso(null);
    try {
      const resultado = await onEnviar(conteudo, chaveEmCurso.current);
      const status = resultado?.envio?.status ?? resultado?.situacao;
      if (resultado?.situacao === "BLOQUEADO") {
        setAviso(`Envio bloqueado: ${(resultado.motivos ?? []).join(", ")}`);
      } else if (status === "ENVIADO" || status === "JA_PROCESSADO") {
        setTexto("");
        chaveEmCurso.current = null;
        setAviso(null);
      } else {
        setAviso(STATUS_ENVIO[status] ?? "Envio não concluído.");
        // Só a recusa libera uma nova chave. Falha incerta mantém a chave.
        if (status === "RECUSADO") chaveEmCurso.current = null;
      }
    } catch {
      setAviso("Falha de comunicação. O envio pode não ter saído: confira antes de reenviar.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="ulbra-conversa" aria-label="Conversa na Mensageria ULBRA">
      {erro && <p role="alert" className="ulbra-aviso">{erro}</p>}
      {carregando && <p>Carregando conversa…</p>}

      {antesDe && (
        <button type="button" className="ulbra-botao" onClick={() => onCarregarAnteriores?.(antesDe)}>
          Carregar mensagens anteriores
        </button>
      )}

      <ol className="ulbra-conversa-lista">
        {mensagens.map((m, i) => {
          const d = DIRECAO[m.direcao] ?? DIRECAO.SISTEMA;
          return (
            <li key={`${m.em}-${i}`} className={d.classe}>
              <div>
                <strong>{d.rotulo}</strong>
                {m.autor ? ` · ${m.autor}` : ""}
                <span> · {formatarHora(m.em)}</span>
              </div>
              {m.texto && <p>{m.texto}</p>}
              {m.anexos?.length > 0 && <p>Anexos: {m.anexos.join(", ")}</p>}
            </li>
          );
        })}
      </ol>

      {!podeEnviar && (
        <p className="ulbra-aviso ulbra-aviso--cinza">
          Para responder, conecte sua conta da Mensageria ULBRA. Sem conexão individual, o envio fica bloqueado.
        </p>
      )}

      <form onSubmit={enviar}>
        <label htmlFor="ulbra-resposta">Resposta</label>
        <textarea
          id="ulbra-resposta"
          value={texto}
          maxLength={1000}
          disabled={!podeEnviar || enviando}
          onChange={(e) => setTexto(e.target.value)}
        />
        <button type="submit" className="ulbra-botao" disabled={!podeEnviar || enviando || !texto.trim()}>
          {enviando ? "Enviando…" : "Enviar resposta"}
        </button>
      </form>

      {aviso && <p role="status" className="ulbra-aviso">{aviso}</p>}
    </section>
  );
}
