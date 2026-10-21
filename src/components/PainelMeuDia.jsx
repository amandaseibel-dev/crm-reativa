// Bloco "Meu dia" do topo da tela inicial do operador (/painel-carteira):
// os retornos que ele agendou e os boletos de acordo que vencem nos proximos
// dias. Componente PURO -- recebe tudo por prop e nao consulta o banco; o
// recorte dos dados mora em src/utils/painelMeuDia.js.
//
// Antes disto as duas informacoes existiam mas nao apareciam: o retorno ficava
// atras de um clique no card "Agenda (retornos)" (e la misturado com o prazo
// automatico da tabulacao, centenas de linhas) e o vencimento proximo existia
// so como filtro do Foco do Dia (D+2) e como alerta D-2 por rotina.
//
// Desenho enxuto a pedido da gestao ("nao quero deixar a pagina poluida",
// 15/10/2026): uma linha por pessoa, cinco linhas visiveis por coluna, o resto
// atras de "ver todos". A semana inteira de retornos fica atras do botao
// "Semana", agrupada por dia -- a tela abre sempre em "Hoje".
import { useState } from "react";
import { formatarDataBR, formatarValorBRL, rotuloDiasRestantes, chaveAlerta } from "../utils/alertasParcela";
import { situacaoAcionamento } from "../utils/acionamentoAlerta";
import {
  JANELA_BOLETOS_DIAS,
  agruparRetornosPorDia,
  fimDaJanela,
  retornosDoDia,
  retornosPendentes,
  somaBoletos,
} from "../utils/painelMeuDia";

const MOSTRAR_INICIAL = 5;

const S = {
  grade: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start", margin: "0 0 14px" },
  coluna: {
    flex: "1 1 320px",
    minWidth: 280,
    border: "1px solid var(--rv-borda)",
    borderRadius: 12,
    background: "var(--rv-card)",
    padding: "10px 12px",
  },
  topo: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  titulo: { margin: 0, fontSize: 13.5, fontWeight: 800, color: "var(--rv-azul-texto)" },
  apoio: { fontSize: 11.5, color: "var(--rv-texto-suave)", fontWeight: 600, margin: "2px 0 4px" },
  abas: { display: "flex", background: "var(--rv-fundo-suave)", borderRadius: 8, padding: 2, gap: 2 },
  aba: {
    border: "none",
    borderRadius: 6,
    padding: "4px 9px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
    background: "transparent",
    color: "var(--rv-texto-suave)",
  },
  abaAtiva: { background: "var(--rv-superficie)", color: "var(--rv-azul)", boxShadow: "0 1px 2px rgba(16,24,40,0.08)" },
  dias: { display: "flex", gap: 6, flexWrap: "wrap", margin: "2px 0 2px" },
  diaChip: {
    border: "1px solid var(--rv-borda)",
    borderRadius: 999,
    padding: "3px 9px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
    background: "var(--rv-fundo)",
    color: "var(--rv-texto-suave)",
    whiteSpace: "nowrap",
  },
  diaChipAtivo: { background: "var(--rv-azul)", border: "1px solid var(--rv-azul)", color: "#fff" },
  item: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--rv-borda)" },
  itemTratado: { opacity: 0.55 },
  linha1: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  nome: {
    background: "none",
    border: "none",
    padding: 0,
    fontWeight: 700,
    color: "var(--rv-texto)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
  },
  meta: { fontSize: 11.5, color: "var(--rv-texto-suave)", marginTop: 1 },
  chip: { fontSize: 11, fontWeight: 800, color: "var(--rv-roxo)", background: "rgba(124,58,237,0.12)", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" },
  chipHoje: { fontSize: 11, fontWeight: 800, color: "var(--rv-vermelho)", background: "var(--rv-vermelho-fundo)", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" },
  chipPrioridade: { fontSize: 11, fontWeight: 800, color: "var(--rv-ambar-texto)", background: "var(--rv-ambar-fundo)", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" },
  chipOk: { fontSize: 11, fontWeight: 800, color: "var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" },
  check: {
    border: "1px solid var(--rv-borda)",
    borderRadius: 7,
    width: 30,
    height: 28,
    background: "var(--rv-fundo)",
    color: "var(--rv-texto-suave)",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 13,
    lineHeight: 1,
    flexShrink: 0,
  },
  checkFeito: { color: "var(--rv-verde-ok-texto)", border: "1px solid var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)" },
  vazio: { fontSize: 12, color: "var(--rv-texto-suave)", margin: "8px 0 2px", fontWeight: 600 },
  rodape: { marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--rv-borda)", fontSize: 11.5, color: "var(--rv-texto-suave)", fontWeight: 600, display: "flex", gap: 6, flexWrap: "wrap" },
  link: { background: "none", border: "none", padding: 0, color: "var(--rv-azul)", fontWeight: 800, cursor: "pointer", fontSize: 11.5 },
};

function BotaoCheck({ item, confirmandoRetornoId, onConfirmarRetorno }) {
  const emCurso = String(confirmandoRetornoId || "") === String(item.id);
  return (
    <button
      type="button"
      style={{ ...S.check, ...(item.tratado ? S.checkFeito : {}) }}
      disabled={emCurso}
      aria-pressed={item.tratado}
      onClick={() => onConfirmarRetorno && onConfirmarRetorno(item.id, !item.tratado)}
      title={item.tratado ? "Contato feito — clique para desmarcar" : "Marcar contato como feito"}
    >
      {emCurso ? "…" : "✓"}
    </button>
  );
}

function LinhaRetorno({ item, mostrarResponsavel, onAbrirFicha, confirmandoRetornoId, onConfirmarRetorno }) {
  return (
    <div style={{ ...S.item, ...(item.tratado ? S.itemTratado : {}) }} data-testid="meu-dia-retorno-item">
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={S.linha1}>
          {item.prioritario && (
            <span style={S.chipPrioridade} title="Marcado como prioritário na tabulação">
              ⭐ prioridade
            </span>
          )}
          {item.hora_retorno ? <span style={S.chip}>{item.hora_retorno}</span> : null}
          <button type="button" style={S.nome} onClick={() => onAbrirFicha && onAbrirFicha(item)} title="Abrir ficha do aluno">
            {item.nome}
          </button>
        </div>
        <div style={S.meta}>
          {item.telefone ? `${item.telefone} · ` : ""}
          {formatarValorBRL(item.valor_em_aberto)}
          {mostrarResponsavel && item.responsavel_email ? ` · ${item.responsavel_email}` : ""}
        </div>
      </div>
      <BotaoCheck item={item} confirmandoRetornoId={confirmandoRetornoId} onConfirmarRetorno={onConfirmarRetorno} />
    </div>
  );
}

export default function PainelMeuDia({
  acionamentoPorAluno = null,
  hoje,
  retornos = [],
  retornoAutomaticoHoje = 0,
  boletos = [],
  janelaDias = JANELA_BOLETOS_DIAS,
  mostrarResponsavel = false,
  confirmandoRetornoId = null,
  onAbrirFicha,
  onConfirmarRetorno,
  onVerRetornosNaFila,
}) {
  // A tela sempre abre no dia; a semana e uma escolha de quem esta olhando.
  const [visaoSemana, setVisaoSemana] = useState(false);
  const [diaEscolhido, setDiaEscolhido] = useState("");
  const [verTodosRetornos, setVerTodosRetornos] = useState(false);
  const [verTodosBoletos, setVerTodosBoletos] = useState(false);

  const doDia = retornosDoDia(retornos, hoje);
  const pendentesDoDia = retornosPendentes(doDia).length;
  const pendentesSemana = retornosPendentes(retornos).length;

  // Na semana a lista NAO vira um rolo de todos os dias juntos: os dias viram
  // chips com o que falta em cada um e a lista mostra o dia escolhido (o
  // primeiro com retorno, por padrao). Foi assim que a semana coube na tela
  // sem empurrar a carteira para baixo.
  const grupos = agruparRetornosPorDia(retornos, hoje);
  const diaAtivo = grupos.some((g) => g.data === diaEscolhido) ? diaEscolhido : grupos[0]?.data || "";
  const listaBase = visaoSemana ? grupos.find((g) => g.data === diaAtivo)?.itens || [] : doDia;
  const visiveis = verTodosRetornos ? listaBase : listaBase.slice(0, MOSTRAR_INICIAL);

  const listaBoletos = verTodosBoletos ? boletos : boletos.slice(0, MOSTRAR_INICIAL);
  const vencemHoje = boletos.filter((b) => Number(b.dias_restantes) === 0).length;

  const propsLinha = { mostrarResponsavel, onAbrirFicha, confirmandoRetornoId, onConfirmarRetorno };

  return (
    <section style={S.grade} aria-label="Meu dia" data-testid="painel-meu-dia">
      <div style={S.coluna} data-testid="meu-dia-retornos">
        <div style={S.topo}>
          <h3 style={S.titulo}>🗓️ Retornos · {visaoSemana ? pendentesSemana : pendentesDoDia}</h3>
          <div style={S.abas} role="tablist" aria-label="Período dos retornos">
            <button
              type="button"
              role="tab"
              aria-selected={!visaoSemana}
              style={{ ...S.aba, ...(!visaoSemana ? S.abaAtiva : {}) }}
              onClick={() => { setVisaoSemana(false); setVerTodosRetornos(false); }}
            >
              Hoje ({pendentesDoDia})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={visaoSemana}
              style={{ ...S.aba, ...(visaoSemana ? S.abaAtiva : {}) }}
              onClick={() => { setVisaoSemana(true); setVerTodosRetornos(false); }}
            >
              Semana ({pendentesSemana})
            </button>
          </div>
        </div>
        <p style={S.apoio}>Agendados por você · ✓ marca o contato como feito</p>

        {visaoSemana && grupos.length > 0 && (
          <div style={S.dias} role="tablist" aria-label="Dias com retorno">
            {grupos.map((g) => (
              <button
                key={g.data}
                type="button"
                role="tab"
                aria-selected={g.data === diaAtivo}
                data-testid="meu-dia-chip-dia"
                style={{ ...S.diaChip, ...(g.data === diaAtivo ? S.diaChipAtivo : {}) }}
                onClick={() => { setDiaEscolhido(g.data); setVerTodosRetornos(false); }}
              >
                {g.rotulo} · {g.pendentes}
              </button>
            ))}
          </div>
        )}

        {listaBase.length === 0 ? (
          <p style={S.vazio}>{visaoSemana ? "Nenhum retorno agendado para os próximos dias." : "Nenhum retorno agendado para hoje."}</p>
        ) : (
          visiveis.map((r) => <LinhaRetorno key={r.id} item={r} {...propsLinha} />)
        )}

        {listaBase.length > MOSTRAR_INICIAL && (
          <button type="button" style={{ ...S.link, marginTop: 6 }} onClick={() => setVerTodosRetornos((v) => !v)}>
            {verTodosRetornos ? "Ver menos" : `Ver todos (${listaBase.length})`}
          </button>
        )}

        {retornoAutomaticoHoje > 0 && (
          <div style={S.rodape} data-testid="meu-dia-retorno-automatico">
            <span>+{retornoAutomaticoHoje} com prazo de tabulação vencendo hoje</span>
            <button type="button" style={S.link} onClick={() => onVerRetornosNaFila && onVerRetornosNaFila()}>
              ver na fila
            </button>
          </div>
        )}
      </div>

      <div style={S.coluna} data-testid="meu-dia-boletos">
        <div style={S.topo}>
          <h3 style={S.titulo}>💳 Boletos a vencer · {boletos.length}</h3>
          {vencemHoje > 0 && <span style={S.chipHoje}>{vencemHoje} vence(m) hoje</span>}
        </div>
        <p style={S.apoio}>
          Parcela de acordo ativo até {formatarDataBR(fimDaJanela(hoje, janelaDias))}
          {boletos.length > 0 ? ` · ${formatarValorBRL(somaBoletos(boletos))}` : ""}
        </p>

        {boletos.length === 0 ? (
          <p style={S.vazio}>Nenhum boleto de acordo vencendo nesta janela.</p>
        ) : (
          listaBoletos.map((b) => (
            <div key={chaveAlerta(b)} style={S.item} data-testid="meu-dia-boleto-item">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={S.linha1}>
                  <button type="button" style={S.nome} onClick={() => onAbrirFicha && onAbrirFicha(b)} title="Abrir ficha do aluno">
                    {b.aluno_nome}
                  </button>
                  <span style={Number(b.dias_restantes) === 0 ? S.chipHoje : S.chip}>{rotuloDiasRestantes(b.dias_restantes)}</span>
                  {b.tem_alerta && <span style={S.chipOk}>🔔</span>}
                </div>
                <div style={S.meta}>
                  {formatarDataBR(b.vencimento)} · {formatarValorBRL(b.valor)} · parc. {b.numero_parcela}
                  {b.numero_acordo != null ? ` do acordo #${b.numero_acordo}` : ""}
                  {b.boleto ? ` · boleto ${b.boleto}` : ""}
                  {mostrarResponsavel && b.responsavel_email ? ` · ${b.responsavel_email}` : ""}
                </div>
                {/* Situacao do acionamento do ALUNO -- nunca da parcela. Nao ha
                    registro que ligue contato a parcela; ver o cabecalho de
                    utils/acionamentoAlerta.js. Aqui a parcela ainda VAI vencer,
                    entao o que interessa e se ja houve aviso preventivo. */}
                {acionamentoPorAluno && (
                  <div style={S.meta} data-testid="meu-dia-boleto-acionamento">
                    {situacaoAcionamento({
                      dua: acionamentoPorAluno.get?.(String(b.aluno_id))?.dua,
                      vencimento: b.vencimento,
                      hoje,
                      temCaso: Boolean(acionamentoPorAluno.get?.(String(b.aluno_id))),
                    }).texto}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {boletos.length > MOSTRAR_INICIAL && (
          <button type="button" style={{ ...S.link, marginTop: 6 }} onClick={() => setVerTodosBoletos((v) => !v)}>
            {verTodosBoletos ? "Ver menos" : `Ver todos (${boletos.length})`}
          </button>
        )}
      </div>
    </section>
  );
}
