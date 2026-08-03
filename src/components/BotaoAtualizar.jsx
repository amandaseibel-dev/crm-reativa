// Botao unico para analiticas SOB DEMANDA (ver useAnaliticaSobDemanda).
// Mostra o estado (Atualizar / Atualizando) e quando foi a ultima atualizacao.
// Enquanto carrega fica desabilitado; o cooldown vive no hook.
export default function BotaoAtualizar({ carregando, ultimaEm, onClick, rotulo = "Atualizar" }) {
  return (
    <div style={S.wrap}>
      <button
        type="button"
        onClick={onClick}
        disabled={carregando}
        style={{ ...S.btn, ...(carregando ? S.btnOff : null) }}
      >
        {carregando ? "Atualizando…" : `↻ ${rotulo}`}
      </button>
      <span style={S.info}>
        {ultimaEm
          ? `Atualizado às ${ultimaEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
          : "Dados sob demanda — clique para carregar"}
      </span>
    </div>
  );
}

const S = {
  wrap: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  btn: {
    background: "#1e40af",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  btnOff: { background: "#94a3b8", cursor: "default" },
  info: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
};
