import { memo } from "react";

/*
  CardAluno
  ---------
  Card padrão ÚNICO para as filas (Minha Carteira, Alunos, Confirmação de
  Pagamento e Fila de Baixa). Não busca dados: recebe tudo por props, para que
  cada fila continue com a sua própria query de lista. O visual é o mesmo em
  todas as telas; o clique abre a ficha unificada.

  Props:
    nome        -> título (nome do aluno)
    subtitulo   -> linha secundária (ex.: telefone)
    cpf         -> string
    operador    -> nome do operador responsável (mensalidades)
    situacao    -> texto do badge azul (situação operacional)
    statusPrazo -> { label, cor } opcional (bolinha colorida à direita)
    linhas      -> [{ rot, val }] campos extras (datas, valores, parcelas...)
    ativo       -> destaca o card (selecionado)
    onClick     -> abre a ficha
    acoes       -> nó React opcional (botões de contexto da fila)
    children    -> conteúdo extra opcional (obs, link, comprovante...)
*/
function CardAluno({
  nome,
  subtitulo,
  cpf,
  operador,
  situacao,
  statusPrazo,
  linhas = [],
  ativo = false,
  onClick,
  acoes = null,
  children = null,
}) {
  return (
    <div
      style={{ ...S.card, ...(ativo ? S.cardAtivo : {}) }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <div style={S.topo}>
        <div style={{ minWidth: 0 }}>
          <div style={S.nome}>{nome || "Aluno sem nome"}</div>
          {subtitulo ? <div style={S.sub}>{subtitulo}</div> : null}
          <div style={S.metaLinha}>
            {cpf ? <span style={S.meta}>CPF: {cpf}</span> : null}
            {operador ? <span style={S.meta}>Operador: {operador}</span> : null}
          </div>
        </div>

        <div style={S.badgesDir}>
          {situacao ? <span style={S.badgeSituacao}>{situacao}</span> : null}
          {statusPrazo ? (
            <span style={{ ...S.badgeStatus, color: statusPrazo.cor }}>
              <span style={{ ...S.bolinha, background: statusPrazo.cor }} />
              {statusPrazo.label}
            </span>
          ) : null}
        </div>
      </div>

      {linhas.length > 0 && (
        <div style={S.linhas}>
          {linhas.map((l, i) =>
            l && l.val != null && l.val !== "" ? (
              <div key={i} style={S.linha}>
                <span style={S.rot}>{l.rot}</span>
                <span style={S.val}>{l.val}</span>
              </div>
            ) : null
          )}
        </div>
      )}

      {children}

      {acoes ? (
        <div style={S.acoes} onClick={(e) => e.stopPropagation()}>
          {acoes}
        </div>
      ) : null}
    </div>
  );
}

const S = {
  card: {
    background: "#fff",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    borderLeft: "4px solid #e2e8f0",
    cursor: "pointer",
    transition: "box-shadow .15s, border-color .15s",
  },
  cardAtivo: { borderLeftColor: "#2563eb", boxShadow: "0 0 0 2px #bfdbfe" },
  topo: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  nome: { fontWeight: 700, color: "#0f172a", fontSize: 15 },
  sub: { fontSize: 12.5, color: "#94a3b8", marginTop: 2 },
  metaLinha: { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 },
  meta: { fontSize: 12.5, color: "#64748b" },
  badgesDir: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 },
  badgeSituacao: {
    display: "inline-block", padding: "3px 9px", borderRadius: 999,
    background: "#e0edff", color: "#1d4ed8", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
  },
  badgeStatus: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" },
  bolinha: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  linhas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "4px 16px", marginTop: 12 },
  linha: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "2px 0" },
  rot: { color: "#64748b" },
  val: { color: "#0f172a", fontWeight: 600, textAlign: "right" },
  acoes: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 },
};

export default memo(CardAluno);
