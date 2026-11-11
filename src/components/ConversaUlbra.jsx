import { useRef, useState } from "react";

// Conversa da Mensageria dentro da Central/ficha. Só apresenta: o portão de
// identidade e de permissão é do servidor (leitura.ts/historico.ts) e do envio
// (envio.ts), sempre com a conexão INDIVIDUAL do operador.
//
// Envio em DUAS etapas, por decisão da gestão (11/11/2026):
//   1. "Ver prévia": a Mensageria calcula custo e janela de 24 h — nada sai;
//   2. "Confirmar envio": uma chave por clique; enquanto o pedido está em curso
//      o botão fica bloqueado e o mesmo clique não gera segundo envio.
// Mudar o texto depois da prévia invalida a prévia.

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

function fmtUsd(v) {
  return typeof v === "number" ? `US$ ${v.toFixed(4)}` : "não informado";
}

export default function ConversaUlbra({
  mensagens = [],
  carregando = false,
  erro = null,
  podeEnviar = false,
  antesDe = null,
  onCarregarAnteriores,
  onPrevia,
  onEnviar,
}) {
  const [texto, setTexto] = useState("");
  const [previa, setPrevia] = useState(null); // { ok, custo_usd, janela_aberta, recusa, em, texto }
  const [etapa, setEtapa] = useState("escrevendo"); // escrevendo | previa | enviando
  const [aviso, setAviso] = useState(null);
  // Chave do pedido em curso: o mesmo clique repetido reaproveita esta chave.
  const chaveEmCurso = useRef(null);
  const ocupado = etapa === "enviando";

  function mudarTexto(v) {
    setTexto(v);
    // prévia vale só para o texto que a gerou
    if (previa && previa.texto !== v) { setPrevia(null); setEtapa("escrevendo"); }
  }

  async function verPrevia(evento) {
    evento.preventDefault();
    if (ocupado || !podeEnviar || !onPrevia) return;
    const conteudo = texto.trim();
    if (!conteudo) return;
    setAviso(null);
    setEtapa("enviando");
    try {
      const r = await onPrevia(conteudo);
      setPrevia({ ...r, texto });
      setEtapa("previa");
      if (r && r.ok === false) setAviso(`A Mensageria não aceita este envio: ${r.recusa || "sem motivo informado"}`);
    } catch {
      setAviso("Falha ao pedir a prévia. Nada foi enviado.");
      setEtapa("escrevendo");
    }
  }

  async function confirmar() {
    if (ocupado || !podeEnviar || !onEnviar || !previa || previa.ok === false) return;
    const conteudo = texto.trim();
    if (!conteudo) return;
    if (!chaveEmCurso.current) chaveEmCurso.current = novaChave();
    setEtapa("enviando");
    setAviso(null);
    try {
      const resultado = await onEnviar(conteudo, chaveEmCurso.current, previa);
      const status = resultado?.envio?.status ?? resultado?.situacao;
      if (resultado?.situacao === "BLOQUEADO") {
        setAviso(`Envio bloqueado: ${(resultado.motivos ?? []).join(", ")}`);
        setEtapa("previa");
      } else if (resultado?.situacao === "JA_PROCESSADO" || status === "ENVIADO") {
        setTexto("");
        setPrevia(null);
        chaveEmCurso.current = null;
        setAviso(resultado?.situacao === "JA_PROCESSADO" ? "Este envio já tinha sido processado; nada foi reenviado." : "Mensagem enviada em seu nome.");
        setEtapa("escrevendo");
      } else {
        setAviso(STATUS_ENVIO[status] ?? "Envio não concluído.");
        // Só a recusa libera uma nova chave. Falha incerta mantém a chave.
        if (status === "RECUSADO") chaveEmCurso.current = null;
        setEtapa("previa");
      }
    } catch {
      setAviso("Falha de comunicação. O envio pode não ter saído: confira antes de reenviar.");
      setEtapa("previa");
    }
  }

  return (
    <section className="ulbra-conversa" aria-label="Conversa na Mensageria ULBRA">
      {erro && <p role="alert" className="ulbra-aviso">{erro}</p>}
      {carregando && <p>Carregando conversa…</p>}

      {antesDe && (
        <button type="button" className="ulbra-botao" onClick={() => onCarregarAnteriores?.(antesDe)}>
          Carregar mensagens anteriores (1 chamada)
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

      <form onSubmit={verPrevia} data-etapa={etapa}>
        <label htmlFor="ulbra-resposta">Resposta</label>
        <textarea
          id="ulbra-resposta"
          value={texto}
          maxLength={4096}
          disabled={!podeEnviar || ocupado}
          onChange={(e) => mudarTexto(e.target.value)}
        />
        {!previa || previa.texto !== texto ? (
          <button type="submit" className="ulbra-botao" disabled={!podeEnviar || ocupado || !texto.trim()}>
            {ocupado ? "Pedindo prévia…" : "Ver prévia (1 chamada da sua cota)"}
          </button>
        ) : null}
      </form>

      {previa && previa.texto === texto ? (
        <div className="ulbra-aviso ulbra-aviso--ambar" data-campo="previa" data-ok={String(previa.ok !== false)}>
          <strong>Prévia da Mensageria.</strong>{" "}
          Custo estimado: <span data-campo="previa-custo">{fmtUsd(previa.custo_usd)}</span> ·{" "}
          janela de 24 h: <span data-campo="previa-janela">{previa.janela_aberta === true ? "aberta" : previa.janela_aberta === false ? "fechada (só template)" : "não informada"}</span>.
          {previa.ok !== false ? (
            <>
              {" "}Sai em seu nome; não tem volta.{" "}
              <button type="button" className="ulbra-botao ulbra-botao--primario" data-campo="confirmar" disabled={ocupado} onClick={confirmar}>
                {ocupado ? "Enviando…" : "Confirmar envio"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {aviso && <p role="status" className="ulbra-aviso">{aviso}</p>}
    </section>
  );
}
