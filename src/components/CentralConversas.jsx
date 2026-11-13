// Visão de conversas da Central ULBRA (duas colunas, estilo WhatsApp Web).
// SÓ APRESENTA. Quem decide a fila e o recorte é o banco (ulbra_central_operador);
// a ordem vem de listaPrioridade. Responsável no ReATIVA e atendente na
// Mensageria são campos separados. "Abrir ficha" só com CPF confirmado
// (aluno_id). O envio fica bloqueado: esta tela não tem conexão individual.
import { Link } from "react-router-dom";
import ConversaUlbra from "./ConversaUlbra";
import { fmtEspera, hrefFicha, nomeCurto } from "../utils/ulbraCentral";

const ROTULO_TIPO = {
  resposta: "Resposta aguardando ação",
  sem_interacao: "Sem interação válida",
  novo: "Novo atendimento",
};

const TOM_TIPO = { resposta: "vermelho", sem_interacao: "ambar", novo: "azul" };

function rotuloTempo(i) {
  if (i.tipo === "sem_interacao") {
    return i.dias_sem_acionamento == null ? "nunca acionado" : `${i.dias_sem_acionamento} dias`;
  }
  return i.espera_min == null ? "sem data" : fmtEspera(i.espera_min);
}

function rotuloTempoLongo(i) {
  if (i.tipo === "sem_interacao") {
    return i.dias_sem_acionamento == null ? "nunca acionado" : `${i.dias_sem_acionamento} dias sem acionamento`;
  }
  return i.espera_min == null ? "sem data de espera" : `aguardando há ${fmtEspera(i.espera_min)}`;
}

function Selo({ tom = "cinza", children }) {
  return <span className={`ulbra-etiqueta ulbra-etiqueta--${tom}`}>{children}</span>;
}

function EstadoHistorico({ historico }) {
  const { estado, erro, onTentar, onCarregarAnteriores, total } = historico;
  if (estado === "carregando") {
    return <div role="status" data-estado="carregando" className="ulbra-texto-desativado">Carregando a conversa…</div>;
  }
  if (estado === "indisponivel") {
    return (
      <div data-estado="indisponivel" className="ulbra-aviso ulbra-aviso--cinza">
        <strong>Histórico ainda não ligado nesta etapa.</strong> Nada foi lido da Mensageria para esta conversa.
      </div>
    );
  }
  if (estado === "erro") {
    return (
      <div role="alert" data-estado="erro" className="ulbra-aviso ulbra-aviso--vermelho">
        Não foi possível carregar o histórico{erro ? `: ${erro}` : ""}.{" "}
        {onTentar ? <button type="button" className="ulbra-link" onClick={onTentar}>Tentar de novo</button> : null}
      </div>
    );
  }
  if (estado === "vazio") {
    return <div data-estado="vazio" className="ulbra-bloco-vazio">Nenhuma mensagem nesta conversa.</div>;
  }
  if (estado === "parcial") {
    return (
      <div data-estado="parcial" className="ulbra-aviso ulbra-aviso--ambar">
        <strong>Histórico parcial.</strong> Mostrando as últimas {historico.mensagens.length}
        {total ? ` de ${total}` : ""} mensagens. Há mensagens anteriores não carregadas.{" "}
        {onCarregarAnteriores ? (
          <button type="button" className="ulbra-link" onClick={onCarregarAnteriores}>Carregar anteriores</button>
        ) : null}
      </div>
    );
  }
  return null;
}

export default function CentralConversas({
  itens = [],
  selecionadoChave = "",
  onSelecionar,
  onVoltar,
  historico = { estado: "indisponivel", mensagens: [] },
  aoAbrirFicha,
  vazio = "nenhum item na fila",
  // Histórico SOB DEMANDA (1 chamada por página): só com clique, nunca ao selecionar.
  onCarregarHistorico,
  // Conexão individual do operador: { estado, pessoa, envioReal }. Sem ATIVA/EXPIRANDO, não há envio.
  conexao = null,
  onConectar,
  onDesconectar,
  // Envio em duas etapas: prévia (custo/janela) e confirmação (chave idempotente).
  onPrevia,
  onEnviar,
}) {
  const sel = itens.find((i) => i.chave === selecionadoChave) || null;
  const mostra = sel ? "conversa" : "lista";
  const mostraConversa = sel && (historico.estado === "parcial" || historico.estado === "ok");
  const podeEnviar = Boolean(conexao && (conexao.estado === "ATIVA" || conexao.estado === "EXPIRANDO") && sel?.alunoId && onPrevia && onEnviar);

  return (
    <div className="ulbra-conv" data-testid="visao-conversas" data-mostra={mostra}>
      <aside className="ulbra-conv-coluna" aria-label="Conversas por prioridade">
        <header className="ulbra-conv-cabecalho">
          <strong>Conversas por prioridade</strong> <Selo>{itens.length}</Selo>
        </header>
        {itens.length === 0 ? (
          <div className="ulbra-bloco-vazio" data-testid="conv-vazio">{vazio}</div>
        ) : (
          <ul className="ulbra-conv-lista-itens">
            {itens.map((i) => (
              <li key={i.chave}>
                <button
                  type="button"
                  className={`ulbra-conv-item${i.chave === selecionadoChave ? " ulbra-conv-item--ativo" : ""}`}
                  aria-current={i.chave === selecionadoChave ? "true" : undefined}
                  data-linha={i.tipo}
                  onClick={() => onSelecionar?.(i.chave)}
                >
                  <span className="ulbra-conv-item-topo">
                    <span className="ulbra-conv-item-nome">{i.nome}</span>
                    <span className="ulbra-conv-item-tempo">{rotuloTempo(i)}</span>
                  </span>
                  {i.previa ? <span className="ulbra-conv-item-previa">“{i.previa}”</span> : null}
                  <span className="ulbra-conv-item-meta">
                    <Selo tom={TOM_TIPO[i.tipo]}>{ROTULO_TIPO[i.tipo]}</Selo>
                    <span>Reativa: {nomeCurto(i.responsavelReativa) || "sem responsável"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="ulbra-conv-painel" aria-label="Conversa selecionada">
        {!sel ? (
          <div className="ulbra-conv-vazio">Escolha uma conversa na lista para ver o histórico.</div>
        ) : (
          <>
            <header className="ulbra-conv-cabecalho ulbra-conv-cabecalho--painel">
              <button type="button" className="ulbra-conv-voltar" onClick={onVoltar} aria-label="Voltar para a lista">
                ← Voltar
              </button>
              <div className="ulbra-conv-identidade">
                <strong data-campo="nome">{sel.nome}</strong>
                <span className="ulbra-conv-resp">
                  <span data-campo="responsavel-reativa">responsável no ReATIVA: <strong>{nomeCurto(sel.responsavelReativa) || "ninguém"}</strong></span>
                  <span data-campo="atendente-mensageria">atendente na Mensageria: <strong>{sel.atendenteUlbra || "não informado"}</strong></span>
                </span>
                <span className="ulbra-conv-tempo">
                  {rotuloTempoLongo(sel)}
                </span>
              </div>
              {sel.alunoId ? (
                <Link className="ulbra-botao" to={hrefFicha(sel.alunoId)} onClick={aoAbrirFicha}>
                  Abrir ficha
                </Link>
              ) : (
                <span className="ulbra-texto-desativado" data-campo="ficha-bloqueada">
                  Ficha indisponível: CPF não confirmado
                </span>
              )}
            </header>

            <div className="ulbra-conv-historico">
              <EstadoHistorico historico={historico} />
              {historico.estado === "indisponivel" && onCarregarHistorico ? (
                sel.alunoId ? (
                  <button type="button" className="ulbra-botao" data-campo="carregar-historico" onClick={() => onCarregarHistorico(sel)}>
                    Carregar histórico (1 chamada à Mensageria)
                  </button>
                ) : (
                  <span className="ulbra-texto-desativado" data-campo="historico-bloqueado">Histórico só com CPF confirmado.</span>
                )
              ) : null}
              {(mostraConversa || historico.estado === "vazio") && podeEnviar ? (
                <ConversaUlbra
                  mensagens={historico.mensagens}
                  antesDe={historico.antesDe || null}
                  onCarregarAnteriores={historico.onCarregarAnteriores}
                  podeEnviar
                  onPrevia={(texto) => onPrevia(sel, texto)}
                  onEnviar={(texto, chave, previa) => onEnviar(sel, texto, chave, previa)}
                />
              ) : mostraConversa ? (
                <ConversaUlbra mensagens={historico.mensagens} antesDe={historico.antesDe || null} onCarregarAnteriores={historico.onCarregarAnteriores} podeEnviar={false} />
              ) : null}
            </div>

            <div className="ulbra-conv-envio-aviso" data-campo="conexao" data-estado={conexao?.estado || "SEM_CONEXAO"}>
              {!conexao || conexao.estado === "SEM_CONEXAO" || conexao.estado === "EXPIRADA" || conexao.estado === "REVOGADA" ? (
                <>
                  <span data-campo="envio-bloqueado">
                    Envio bloqueado: {conexao?.estado === "EXPIRADA" ? "sua conexão expirou." : conexao?.estado === "REVOGADA" ? "sua conexão foi desfeita." : "não há conexão individual da sua conta."}{" "}
                    Responder exige a sua própria conta da Mensageria (autoria sua).
                  </span>
                  {onConectar ? (
                    <button type="button" className="ulbra-link" data-campo="conectar" onClick={onConectar}>
                      Conectar minha conta da Mensageria (abre a ULBRA; 1 chamada da sua cota)
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <span data-campo="conexao-ativa">
                    Conectado como <strong>{conexao.pessoa || "você"}</strong>{conexao.envioReal === false ? " · envio real desligado nesta etapa (só prévia)" : ""}.
                  </span>
                  {onDesconectar ? <button type="button" className="ulbra-link" data-campo="desconectar" onClick={onDesconectar}>Desconectar</button> : null}
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
