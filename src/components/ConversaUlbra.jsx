import { useRef, useState } from "react";

// Conversa da Mensageria dentro da Central/ficha. Só apresenta: o portão de
// identidade e de permissão é do servidor (leitura.ts/historico.ts) e do envio
// (envio.ts), sempre com a conexão INDIVIDUAL do operador.
//
// Envio em DUAS etapas, por decisão da gestão (11/11/2026):
//   1. "Ver prévia": a Mensageria calcula custo e janela de 24 h (o comportamento de envio da prévia NÃO foi verificado com a ULBRA);
//   2. "Confirmar envio": uma chave por clique; enquanto o pedido está em curso
//      o botão fica bloqueado e o mesmo clique não gera segundo envio.
// Mudar o texto, o template ou as variáveis depois da prévia invalida a prévia.
//
// Template fora da janela: só é oferecido quando a lista de templates aprovados
// (vinda do servidor) não está vazia. A lista local apenas restringe o uso; a
// aprovação e a disponibilidade são as informadas pela ULBRA.

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

/** Variáveis digitadas separadas por ";", sem vazios nas pontas. */
export function variaveisDe(texto) {
  return String(texto ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** Identidade do pedido: se qualquer parte muda, a prévia anterior deixa de valer. */
export function chaveDoPedido(texto, template) {
  return JSON.stringify({ texto: texto.trim(), template: template ? { nome: template.nome, variaveis: template.variaveis } : null });
}

export default function ConversaUlbra({
  mensagens = [],
  carregando = false,
  erro = null,
  podeEnviar = false,
  antesDe = null,
  templatesAprovados = [],
  // Envio por template só liga quando a prévia de template estiver verificada com a ULBRA. Padrão: desligado.
  templateVerificado = false,
  onCarregarAnteriores,
  onPrevia,
  onEnviar,
}) {
  const [texto, setTexto] = useState("");
  const [templateNome, setTemplateNome] = useState("");
  const [variaveisTexto, setVariaveisTexto] = useState("");
  const [previa, setPrevia] = useState(null); // { ok, custo_usd, janela_aberta, recusa, em, chave }
  const [etapa, setEtapa] = useState("escrevendo"); // escrevendo | previa | enviando
  const [aviso, setAviso] = useState(null);
  // Chave do pedido em curso: o mesmo clique repetido reaproveita esta chave.
  const chaveEmCurso = useRef(null);
  const ocupado = etapa === "enviando";

  const semTemplates = templatesAprovados.length === 0;
  const template = templateNome ? { nome: templateNome, variaveis: variaveisDe(variaveisTexto) } : null;
  const chaveAtual = chaveDoPedido(texto, template);
  const previaValida = previa !== null && previa.chave === chaveAtual;

  function invalidarSePrecisar(proximoTexto, proximoTemplate) {
    const proxima = chaveDoPedido(proximoTexto, proximoTemplate);
    if (previa && previa.chave !== proxima) { setPrevia(null); setEtapa("escrevendo"); }
  }

  function mudarTexto(v) {
    setTexto(v);
    invalidarSePrecisar(v, template);
  }

  function mudarTemplate(nome) {
    // Com template, o texto livre não sai: limpa-o para não ficar gravado como se tivesse saído.
    setTexto("");
    setTemplateNome(nome);
    invalidarSePrecisar(texto, nome ? { nome, variaveis: variaveisDe(variaveisTexto) } : null);
  }

  function mudarVariaveis(v) {
    setVariaveisTexto(v);
    invalidarSePrecisar(texto, templateNome ? { nome: templateNome, variaveis: variaveisDe(v) } : null);
  }

  function podeMontarPedido() {
    if (template) return true;
    return texto.trim() !== "";
  }

  async function verPrevia(evento) {
    evento.preventDefault();
    if (ocupado || !podeEnviar || !onPrevia) return;
    if (!podeMontarPedido()) return;
    setAviso(null);
    setEtapa("enviando");
    const chave = chaveAtual;
    try {
      const r = template ? await onPrevia(texto.trim(), template) : await onPrevia(texto.trim());
      setPrevia({ ...r, chave });
      setEtapa("previa");
      if (r && r.ok === false) setAviso(`A Mensageria não aceita este envio: ${r.recusa || "sem motivo informado"}`);
    } catch {
      setAviso("Falha ao pedir a prévia. Nada foi enviado.");
      setEtapa("escrevendo");
    }
  }

  async function confirmar() {
    if (ocupado || !podeEnviar || !onEnviar || !previaValida || previa.ok === false) return;
    if (!podeMontarPedido()) return;
    if (!chaveEmCurso.current) chaveEmCurso.current = novaChave();
    setEtapa("enviando");
    setAviso(null);
    try {
      const resultado = template
        ? await onEnviar(texto.trim(), chaveEmCurso.current, previa, template)
        : await onEnviar(texto.trim(), chaveEmCurso.current, previa);
      const status = resultado?.envio?.status ?? resultado?.situacao;
      if (resultado?.situacao === "BLOQUEADO") {
        setAviso(`Envio bloqueado: ${(resultado.motivos ?? []).join(", ")}`);
        setEtapa("previa");
      } else if (resultado?.situacao === "JA_PROCESSADO" || status === "ENVIADO") {
        setTexto("");
        setTemplateNome("");
        setVariaveisTexto("");
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

  const janelaFechada = previa?.janela_aberta === false;

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
          disabled={!podeEnviar || ocupado || template !== null}
          onChange={(e) => mudarTexto(e.target.value)}
        />

        <fieldset className="ulbra-template" disabled={!podeEnviar || ocupado}>
          <legend>Template (uso fora da janela de 24 h)</legend>
          {!templateVerificado ? (
            <p className="ulbra-aviso ulbra-aviso--cinza" data-campo="template-pendente">
              Envio por template aguarda a verificação da prévia de template pela ULBRA. Por enquanto, fora da janela de 24 h o envio fica bloqueado.
            </p>
          ) : semTemplates ? (
            <p className="ulbra-aviso ulbra-aviso--cinza" data-campo="sem-templates">
              Nenhum template aprovado está disponível para a equipe. Fora da janela de 24 h, o envio fica bloqueado.
            </p>
          ) : (
            <>
              <label htmlFor="ulbra-template-nome">Escolher template</label>
              <select
                id="ulbra-template-nome"
                data-campo="template-select"
                value={templateNome}
                disabled={!templateVerificado}
                onChange={(e) => mudarTemplate(e.target.value)}
              >
                <option value="">Sem template (texto livre)</option>
                {templatesAprovados.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {templateNome ? (
                <>
                  <label htmlFor="ulbra-template-variaveis">Variáveis (separadas por ;)</label>
                  <input
                    id="ulbra-template-variaveis"
                    data-campo="template-variaveis"
                    value={variaveisTexto}
                    onChange={(e) => mudarVariaveis(e.target.value)}
                  />
                </>
              ) : null}
            </>
          )}
        </fieldset>

        {!previaValida ? (
          <button type="submit" className="ulbra-botao" disabled={!podeEnviar || ocupado || !podeMontarPedido()}>
            {ocupado ? "Pedindo prévia…" : "Ver prévia (1 chamada da sua cota)"}
          </button>
        ) : null}
      </form>

      {previa && previa.chave === chaveAtual ? (
        <div className="ulbra-aviso ulbra-aviso--ambar" data-campo="previa" data-ok={String(previa.ok !== false)}>
          <strong>Prévia da Mensageria.</strong>{" "}
          Custo estimado: <span data-campo="previa-custo">{fmtUsd(previa.custo_usd)}</span> ·{" "}
          janela de 24 h: <span data-campo="previa-janela">{previa.janela_aberta === true ? "aberta" : previa.janela_aberta === false ? "fechada (só template)" : "não informada"}</span>.
          {janelaFechada && !template ? <> <span data-campo="previa-sem-template">Escolha um template aprovado para enviar.</span></> : null}
          {previa.ok !== false && (!janelaFechada || template) ? (
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
